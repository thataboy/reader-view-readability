// offscreen.js
//
// Offscreen is the single TTS engine.
// Content sends a desired window of segments [startIndex..endIndex].
// Offscreen decides how to:
// - stream/play the current segment
// - serialize prefetches (STRICTLY one at a time)
// - reuse cache / inFlight downloads
// - abort on stop; clear cache on cleanup
//
// Background is a message relay only.

function emit(tabId, type, payload) {
  chrome.runtime.sendMessage({
    type: "tts.forwardToTab",
    payload: { tabId, type, payload },
  }).catch()
}

// --------------------------
// Server definitions + sanitization
// --------------------------
const Server = Object.freeze({
  MY_KOKORO: 1,
  VOX_ANE: 2,
  SUPERTONIC: 3,
  POCKET: 4,
  CANDLE: 5,
  MLX: 6,
});

const SERVER_IP = navigator.userAgent.includes("Mac OS X")
  ? "127.0.0.1"
  : "192.168.1.11";


const SERVERS = new Map([
  [Server.MY_KOKORO, { port: 9090, min_len: 2, streamable: false }],
  [
    Server.VOX_ANE,
    { port: 9000, min_len: 5, streamable: true },
  ],
  [
    Server.SUPERTONIC,
    { port: 8001, min_len: 5, sanitizer: sanitizeSupertonic, streamable: true },
  ],
  [
    Server.POCKET,
    { port: 9800, min_len: 1, sanitizer: sanitizePocket, streamable: true },
  ],
  [
    Server.CANDLE,
    {
      port: 9900, min_len: 1, sanitizer: sanitizePocket, streamable: true,
    },
  ],
  [
    Server.MLX,
    {
      port: 9700, min_len: 1, sanitizer: sanitizePocket, streamable: false,
    },
  ],
]);

// function sanitizeCommon(text) {
//   return String(text || "")
//     .replace(/\s+/g, " ")
//     .replace(/[\u2018\u2019]/g, "'")
//     .replace(/[\u201C\u201D]/g, '"')
//     .trim();
// }

// fix a bunch of weird quirks with VoxCPM
function sanitizeVox(text) {
  // Vox freaks out if text is all caps
  if (/^[^a-z]*[A-Z][^a-z]*$/.test(text)) text = text.toLowerCase();
  return text
    .replace(/[()[\]|~`/…]/g, ' ')
    // .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[“”"]/g, ' ')
    .replace(/\!{2,}/g, '!')
    // .replace(/[‘’]/g, "'")
    .replace(/(\.|\*|\-){3,}/g, ' ')
    // .replace(/-(?![a-zA-Z])|(?<![a-zA-Z])-/g, ' ')
    // .replace(/[—:;]/g, ', ')
    // .replace(/[^\n\x20-\x7E]/g, ' ').replace(/ +/g, ' ').trim();
    .replace(/([,.])\s*[.,]/g, '$1 ')
    .replace(/^[,.]\s*/, '')
    .replace(/(\s*(\.))+$/, '$1')
    .replace(/\s+([,.])/g, '$1')
    // .replace(/(["”’'])\s*\.?\s*$/, '')
    // .replace(/\s+([”’])/g, '$1')
    // .replace(/([‘“])\s+/g, '$1')
    // .replace(/(\s*[,!:;]\s*)+$/, '')
    // .replace(/^(\s*[,!:;]\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * Normalizes a string by converting special characters/accents
 * to their closest ASCII equivalents.
 */
const manualMap = {
  'ø': 'o', 'Ø': 'O',
  'æ': 'ae', 'Æ': 'AE',
  'œ': 'oe', 'Œ': 'OE',
  'ß': 'ss', 'ł': 'l', 'Ł': 'L'
};

function sanitizeSupertonic(str) {
  return str
    .replace(/[><()\[\]^]/g, ' ')
    // remove emojis
    // .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    // normalize special chars
    .replace(/[øØæÆœŒßłŁ]/g, match => manualMap[match])
    // Use NFD normalization to decompose accents (e.g., 'é' -> 'e' + '´')
    // .normalize("NFD")
    // Use Regex to remove the "Combining Diacritical Marks" (the accents)
    // .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function sanitizePocket(text) {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[[\]!]/g, "")
    .replace(/(\d)\.(\d)/g, '$1 point $2')
    .replace(/([a-z]{2,3})\.([a-z]{2,3}\d)/g, '$1 dot $2')
    // remove extraneous punctuation after . ?
    .replace(/([\.\?])[^\s\p{L}\p{N}]+/gu, '$1 ')
    .replace(/\$\s?([\d,]+(?:\.\d{2})?)/g, '$1 dollars')
    .replace(/No\.\s*(\d+)/g, 'number $1')
    // drop . from middle initial
    .replace(/\s([A-Z])\.\s/g, ' $1 ')
    // replace V.I.P. with VIP
    .replace(/([A-Z]\.){3,}/g, (match) => {  return match.replace(/\./g, ""); } )
    .trim()
    // don't end sentence with , ;
    .replace(/[,;]+$/, '')
    ;
}

function sanitizeCommon(text) {
  if (!text) return '';
  return text
    // Remove URLs (TTS engines usually mangle these)
    .replace(/(https?:\/\/[^\s]+)/g, '')

    // Whitelist: Keep letters (\p{L}), numbers (\p{N}),
    // basic punctuation (\p{P}), and spaces (\s).
    .replace(/[^\p{L}\p{N}\p{P}\p{S}\s]/gu, '')

    // Arrows, dingbats, geometric shapes, miscellaneous symbols, etc.
    .replace(/[\u2190-\u21FF\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF]+/g, '')

    // !!! and ???
    .replace(/([!?.])\1+/g, '$1')

    .replace(/\s+/g, ' ')
    .trim();
}

// Initialized once in the outer scope
const ABBREVIATION_MAP = {
  "Mr.": "Mister",
  "Mrs.": "Misses",
  "Ms.": "Miss",
  "Dr.": "Doctor",
  "V.": "versus",
  "v.": "versus",
  "A.I.": "eigh eye",
  "AI": "eigh eye",
  "MacOS": "mac oh ess",
  "lbs.": "pounds",
  "lbs": "pounds",
  "Prof.": "Professor",
  "Bros.": "Brothers",
  "Sr.": "Senior",
  "Jr.": "Junior",
  "Det.": "Detective",
  "Capt.": "Captain",
  "Maj.": "Major",
  "Gen.": "General",
  "Col.": "Colonel",
  "Lt.": "Lieutenant",
  "Fig.": "Figure",
  "St.": "Saint"
};

// Escape dots and join keys into a single regex pattern
const ABBR_REGEX = new RegExp(
  '(?<=\\s|^)(' +
  Object.keys(ABBREVIATION_MAP)
    .map(k => k.replace('.', '\\.'))
    .join('|')
  + ')(?=\\s|$|\\b)',
  'g'
);

function expandAbbreviations(text) {
  if (!text) return text;
  return text.replace(ABBR_REGEX, (matched) => ABBREVIATION_MAP[matched]);
}

function endpointFor(serverId, route) {
  const cfg = SERVERS.get(serverId);
  if (!cfg) throw new Error("Unknown server");
  return `http://${SERVER_IP}:${cfg.port}${route}`;
}

function buildBody(serverId, { text, voice, speed, lang }) {
  const cfg = SERVERS.get(serverId);
  if (!cfg) throw new Error("Unknown server");

  text = sanitizeCommon(text)
  const sanitizer = cfg.sanitizer;
  if (sanitizer) text = sanitizer(text);
  text = expandAbbreviations(text)

  return {
    text,
    voice,
    speed,
    lang,
    ...(cfg.extra_params || {}),
  };
}

async function fetchVoices(serverId, refresh) {
  const path = '/voices' + (refresh ? '/refresh' : '');
  const r = await fetch(endpointFor(serverId, path));
  if (!r.ok) throw new Error(`${path} failed: ${r.status} ${r.statusText}`);
  const j = await r.json();
  return j.voices;
}

// --------------------------
// Audio utilities
// --------------------------

// WAV parser (kept as-is from the working version style)
function tryParseWavHeader(u8) {
  if (u8.length < 12) return null;

  const riff = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  const wave = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
  if (riff !== "RIFF" || wave !== "WAVE") throw new Error("Invalid WAV");

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  let pos = 12;
  let fmt = null;
  let dataOffset = null;

  while (pos + 8 <= u8.length) {
    const id = String.fromCharCode(
      u8[pos],
      u8[pos + 1],
      u8[pos + 2],
      u8[pos + 3],
    );
    const size = dv.getUint32(pos + 4, true);
    const dataPos = pos + 8;

    if (id !== "data") {
      if (dataPos + size > u8.length) return null;
    } else {
      dataOffset = dataPos;
      break;
    }

    if (id === "fmt ") {
      if (size < 16) throw new Error("Invalid fmt chunk");
      const audioFormat = dv.getUint16(dataPos + 0, true);
      const numChannels = dv.getUint16(dataPos + 2, true);
      const sampleRate = dv.getUint32(dataPos + 4, true);
      const bitsPerSample = dv.getUint16(dataPos + 14, true);
      fmt = { audioFormat, numChannels, sampleRate, bitsPerSample };
    }

    pos = dataPos + size + (size % 2);
  }

  if (!fmt || dataOffset == null) return null;

  return {
    audioFormat: fmt.audioFormat,
    numChannels: fmt.numChannels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    dataOffset,
  };
}

class StreamingPlayer {
  constructor(defaultSampleRate = null) {
    const AudioCtx = self.AudioContext;
    this.ctx = new AudioCtx({ latencyHint: "playback" });

    // If null, we'll wait for a WAV header to define it
    this.sampleRate = defaultSampleRate;
    this.numChannels = 1;

    this.pcmData = new Uint8Array(0);
    this.nextStartTime = 0;
    this.minBufferSize = 16384;
    this.didStartPlayback = false;
    this._lastSrc = null;

    // Header parsing state
    this.headerFound = false;
    this.headerBuf = [];
    this.headerLen = 0;
  }

  async start() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  _appendBytes(newData) {
    if (!newData || newData.length === 0) return;
    const merged = new Uint8Array(this.pcmData.length + newData.length);
    merged.set(this.pcmData, 0);
    merged.set(newData, this.pcmData.length);
    this.pcmData = merged;
  }

  async addChunk(chunk) {
    if (!chunk || chunk.length === 0) return;

    // Phase 1: Determine Audio Parameters
    if (!this.sampleRate && !this.headerFound) {
      this.headerBuf.push(chunk);
      this.headerLen += chunk.length;

      const tmp = new Uint8Array(this.headerLen);
      let off = 0;
      for (const h of this.headerBuf) { tmp.set(h, off); off += h.length; }

      const parsed = tryParseWavHeader(tmp);
      if (parsed) {
        this.sampleRate = parsed.sampleRate;
        this.headerFound = true;
        // Seed PCM data with anything following the WAV header
        this._appendBytes(tmp.subarray(parsed.dataOffset));
        this.headerBuf = []; // clear memory
      } else if (this.headerLen > 1024) {
        // Fallback: If we've seen 1KB and no WAV header, it's likely raw
        // but we don't have a sample rate. This shouldn't happen with the route logic.
        throw new Error("Could not determine sample rate from stream");
      }
    } else {
      // Phase 2: Standard PCM ingestion
      this._appendBytes(chunk);
    }

    if (this.sampleRate) this._tryPlayBuffer();
  }

  _tryPlayBuffer() {
    // Need 2 bytes for a single Int16 sample
    const bytesPerFrame = 2;
    if (this.pcmData.length < (this.didStartPlayback ? bytesPerFrame : this.minBufferSize)) return;

    const framesToPlay = Math.floor(this.pcmData.length / bytesPerFrame);
    const bytesToPlay = framesToPlay * bytesPerFrame;
    const dataToPlay = this.pcmData.subarray(0, bytesToPlay);
    this.pcmData = this.pcmData.subarray(bytesToPlay);

    const audioBuffer = this.ctx.createBuffer(1, framesToPlay, this.sampleRate);
    const int16 = new Int16Array(dataToPlay.buffer, dataToPlay.byteOffset, framesToPlay);
    const out = audioBuffer.getChannelData(0);

    for (let i = 0; i < framesToPlay; i++) {
      out[i] = int16[i] / 32768;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    const startTime = Math.max(now, this.nextStartTime);
    src.start(startTime);

    this._lastSrc = src;
    this.nextStartTime = startTime + audioBuffer.duration;
    this.didStartPlayback = true;
  }

  async finish({ timeoutMs = 15000 } = {}) {
    if (!this.sampleRate) return;

    // Flush the remainder
    this.minBufferSize = 2;
    this._tryPlayBuffer();

    if (!this._lastSrc) return;

    await new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this._lastSrc.onended = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  async stop() {
    try {
      if (this.ctx.state !== "closed") await this.ctx.close();
    } catch {}
  }
}

class CachePlayer {
  constructor({ ctx }) {
    this.ctx = ctx;
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.source = null;
    this.ended = null;
  }

  async startFromAudioBuffer(audioBuffer) {
    if (this.ctx.state === "suspended") await this.ctx.resume();

    const src = this.ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.gain);
    this.source = src;

    this.ended = new Promise((resolve) => {
      src.onended = resolve;
    });

    src.start(0);
  }

  async waitEnded(signal) {
    if (!this.ended) return;
    if (!signal) return await this.ended;

    await Promise.race([
      this.ended,
      new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      }),
    ]);
  }

  async stop() {
    try {
      this.source?.stop(0);
    } catch {}
    try {
      this.source?.disconnect();
    } catch {}
    try {
      this.gain?.disconnect();
    } catch {}
    // IMPORTANT: do NOT close ctx here (shared per-tab)
  }
}

// --------------------------
// Per-tab engine state
// --------------------------

const tabs = new Map();
// tabId -> {
//   signature: string,
//   server: number, voice: string, speed: number, lang: string,
//   texts: Map<number,string>,
//   cache: Map<string, { sampleRate:number, pcmU8:Uint8Array } | { audioBuffer: AudioBuffer }>,
//   decodeCtx: AudioContext | null,
//   aborts: Map<string, AbortController>,    // key -> controller
//   inFlight: Map<string, Promise<void>>,    // key -> promise that stores cache
//   queue: string[],
//   queued: Set<string>,
//   prefetchRunning: boolean,
// }

let current = null; // { tabId, key, signature, index, abort, player }

function getTab(tabId) {
  let st = tabs.get(tabId);
  if (!st) {
    st = {
      signature: "",
      server: null,
      voice: null,
      speed: 1.0,
      lang: "en",
      texts: new Map(),
      cache: new Map(),
      decodeCtx: null,
      aborts: new Map(),
      inFlight: new Map(),
      queue: [],
      queued: new Set(),
      prefetchRunning: false,
      prefetchGateOpened: false,
      playTask: null,
    };
    tabs.set(tabId, st);
  }
  return st;
}

function sig(st) {
  return `${st.server}|${st.voice}|${st.speed}|${st.lang}`;
}

function cacheKey(st, index) {
  return `${index}:${sig(st)}`;
}

function getDecodeCtx(st) {
  if (st.decodeCtx) return st.decodeCtx;
  const AudioCtx = self.AudioContext;
  st.decodeCtx = new AudioCtx({ latencyHint: "playback" });
  return st.decodeCtx;
}

function isTooShortForServer(cfg, body) {
  const minLen = cfg.min_len ?? 0;
  const textLen = (body.text ?? "").length;
  return minLen > 0 && textLen < minLen;
}

async function stopCurrent(reason = "stopped") {
  if (!current) return;

  const c = current;
  current = null;

  const { tabId, index } = c;

  try {
    c.abort?.abort();
  } catch {}
  try {
    await c.player?.stop();
  } catch {}

  emit(tabId, "tts.ended", { index, reason });
}

function abortAll(st) {
  for (const ac of st.aborts.values()) {
    try {
      ac.abort();
    } catch {}
  }
  st.aborts.clear();
  st.inFlight.clear();
}

function clearQueue(st) {
  st.queued.clear();
  st.prefetchRunning = false;
}

// --------------------------
// Fetch primitives
// --------------------------

async function synthesizeToCache(st, key, index) {
  if (st.cache.has(key)) return;
  if (st.inFlight.has(key)) return st.inFlight.get(key);

  const text = st.texts.get(index) || "";
  const serverId = st.server;
  const voice = st.voice;
  const speed = st.speed;
  const lang = st.lang;

  const cfg = SERVERS.get(serverId);
  if (!cfg) throw new Error("Unknown server");

  const body = buildBody(serverId, { text, voice, speed, lang });

  if (isTooShortForServer(cfg, body)) throw new Error("Too short");

  const url = endpointFor(serverId, "/synthesize");

  const ac = new AbortController();
  st.aborts.set(key, ac);

  const task = (async () => {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);

      const ctype = (r.headers.get("content-type") || "").toLowerCase();
      if (!ctype.includes("audio/")) {
        throw new Error(
          `Unsupported synthesize content-type: ${ctype || "(none)"}`,
        );
      }

      const buf = await r.arrayBuffer();
      // decodeAudioData can detach the input buffer in some implementations.
      // Pass a copy to be safe.
      const ctx = getDecodeCtx(st);
      const audioBuffer = await ctx.decodeAudioData(buf.slice(0));
      st.cache.set(key, { audioBuffer });
    } finally {
      st.aborts.delete(key);
      st.inFlight.delete(key);
    }
  })();

  st.inFlight.set(key, task);
  return task;
}

async function streamPlayAndCache(tabId, st, index) {
  const key = cacheKey(st, index);
  if (st.inFlight.has(key)) {
    await st.inFlight.get(key);
    if (st.cache.has(key)) return await playFromCache(tabId, st, index);
  }

  const text = st.texts.get(index) || "";
  const serverId = st.server;
  const cfg = SERVERS.get(serverId);
  const body = buildBody(serverId, { text, voice: st.voice, speed: st.speed, lang: st.lang });
  const signature = sig(st);

  if (isTooShortForServer(cfg, body)) throw new Error("Too short");

  if (!(cfg?.streamable ?? true)) {
    await synthesizeToCache(st, key, index);
    return await playFromCache(tabId, st, index);
  }

  const ac = new AbortController();
  st.aborts.set(key, ac);
  await stopCurrent("superseded");

  try {
    const r = await fetch(endpointFor(serverId, "/stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    if (!r.body) throw new Error("Missing response body stream");

    const ctype = (r.headers.get("content-type") || "").toLowerCase();
    const isWav = ctype.includes("wav");

    // Determine sample rate if it's raw PCM
    let sampleRate = null;
    if (!isWav) {
      const m = ctype.match(/rate\s*=\s*(\d+)/);
      sampleRate = m ? parseInt(m[1], 10) : 44100;
    }

    const player = new StreamingPlayer(sampleRate);
    current = { tabId, key, signature, index, abort: ac, player };
    await player.start();

    const reader = r.body.getReader();
    const chunks = [];
    let totalLen = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      // Abort if context changed
      if (!current) {
        ac.abort();
        return;
      }

      chunks.push(value);
      totalLen += value.length;
      await player.addChunk(value);

      if (player.didStartPlayback && !current.notified) {
        current.notified = true;
        emit(tabId, "tts.playing", { index });
        st.prefetchGateOpened = true;
        ensurePrefetchLoop(st);
      }
    }

    // Decode full stream to cache for future replays
    if (totalLen > 0) {
      const fullU8 = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) { fullU8.set(c, off); off += c.length; }

      const ctx = getDecodeCtx(st);
      let audioBuffer;

      if (isWav) {
        audioBuffer = await ctx.decodeAudioData(fullU8.buffer.slice(0));
      } else {
        // Handle raw PCM cache storage (assume mono)
        const frames = Math.floor(fullU8.length / 2);
        audioBuffer = ctx.createBuffer(1, frames, sampleRate || 22050);
        const i16 = new Int16Array(fullU8.buffer, 0, frames);
        const out = audioBuffer.getChannelData(0);
        for (let i = 0; i < frames; i++) out[i] = i16[i] / 32768;
      }
      st.cache.set(key, { audioBuffer });
    }

    await player.finish();
  } catch (e) {
    emit(tabId, "tts.error", { index, error: String(e.message || e) });
    await stopCurrent("error");
  } finally {
    st.aborts.delete(key);
    await stopCurrent("natural");
  }
}

async function playFromCache(tabId, st, index) {
  const key = cacheKey(st, index);
  const entry = st.cache.get(key);
  if (!entry) return;

  await stopCurrent("superseded");

  const ac = new AbortController();
  st.aborts.set(key, ac);
  const ctx = getDecodeCtx(st);
  const player = new CachePlayer({ ctx });

  const signature = sig(st);
  current = { tabId, signature, key, index, abort: ac, player };

  await player.startFromAudioBuffer(entry.audioBuffer);
  emit(tabId, "tts.playing", { index });
  st.prefetchGateOpened = true;
  ensurePrefetchLoop(st);

  await player.waitEnded(ac.signal);

  st.aborts.delete(key);

  if (current && current.tabId === tabId) {
    await stopCurrent("natural");
  }
}

// --------------------------
// Prefetch loop (STRICTLY serialized)
// --------------------------

async function ensurePrefetchLoop(st) {
  if (!st.prefetchGateOpened) return;
  if (st.prefetchRunning) return;

  st.prefetchRunning = true;

  (async () => {
    try {
      while (st.queue.length > 0) {
        const key = st.queue.shift();
        if (!key) break;
        st.queued.delete(key);

        if (st.cache.has(key)) continue;

        // parse index from key
        const idx = Number(key.split(":").shift());

        try {
          await synthesizeToCache(st, key, idx);
        } catch {
          // Prefetch failures shouldn't stop playback; content can still stream later.
        }
      }
    } finally {
      st.prefetchRunning = false;
    }
  })();
}

function enqueuePrefetch(st, index) {
  const key = cacheKey(st, index);
  if (st.cache.has(key)) return;
  if (st.inFlight.has(key)) return;
  if (st.queued.has(key)) return;

  st.queue.push(key);
  st.queued.add(key);
  ensurePrefetchLoop(st);
}

// --------------------------
// Window handler
// --------------------------

function pruneMap(signature, map, startIndex, endIndex, log, isAbort=false) {
  for (const key of map.keys()) {
    let [idx, sig] = key.split(":");
    idx = Number(idx);
    if (sig != signature || idx < startIndex - 1 || idx > endIndex) {
      if (isAbort) {
        const ac = map.get(key);
        try { ac.abort(); } catch {}
      }
      map.delete(key);
      // console.log(`${log} ${key}`);
    }
  }
}

function pruneOutsideOfWindow(st, startIndex, endIndex) {
  const signature = sig(st);
  pruneMap(signature, st.cache, startIndex, endIndex, "Pruning");
  pruneMap(signature, st.aborts, startIndex, endIndex, "Aborting", isAbort=true);
  pruneMap(signature, st.inFlight, startIndex, endIndex, "Cancelling");
}

async function handleWindow(p) {
  const tabId = p.tabId;
  const st = getTab(tabId);

  st.server = p.server;
  st.voice = p.voice;
  st.speed = p.speed;
  st.lang = p.lang || "en";
  signature = sig(st);

  // Signature change: clear cache (audio unlikely useful now)
  if (signature !== st.signature) {
    abortAll(st);
    st.cache.clear();
    st.signature = signature;
  }

  // Update text map
  const segs = Array.isArray(p.segments) ? p.segments : [];
  for (const s of segs) {
    if (!s) continue;
    st.texts.set(Number(s.index), String(s.text || ""));
  }

  const startIndex = Number(p.startIndex);
  const endIndex = Number(p.endIndex);

  pruneOutsideOfWindow(st, startIndex, endIndex);

  // Clear any queued prefetches that are outside the new window.
  // (Basic behavior; can harden later.)
  clearQueue(st);

  // If current playback is not exactly what we want, start it.
  const curOk =
    current &&
    current.tabId === tabId &&
    current.signature === signature &&
    // current.token === token &&
    current.index === startIndex;

  if (!curOk) {
    // stop current playback (single player)
    await stopCurrent("superseded");

    // reset prefetch gate: we only start prefetching once audio has begun playing
    st.prefetchGateOpened = false;

    const startKey = cacheKey(st, startIndex);

    // Kick playback asynchronously so we can queue prefetch immediately.
    st.playTask = (async () => {
      try {
        // Start playing startIndex, using cache/inFlight/stream as needed
        if (st.cache.has(startKey)) {
          await playFromCache(tabId, st, startIndex);
        } else {
          await streamPlayAndCache(tabId, st, startIndex);
        }
      } catch (e) {
        if (e.message === "Too short")
          emit(tabId, "tts.ended", {
            index: startIndex,
            reason: "natural"
          });
        else
          emit(tabId, "tts.error", {
            index: startIndex,
            error: String(e && (e.message || e)),
          });
      }
    })();
  }

  // Queue prefetch window strictly serialized
  for (let i = startIndex + 1; i <= endIndex; i++) {
    enqueuePrefetch(st, i);
  }

  // If audio has started, this will begin draining the queue; otherwise it will start on tts.playing.
  ensurePrefetchLoop(st);
}

// --------------------------
// Stop / cleanup
// --------------------------

async function handleStop(tabId) {
  // Single global player, but stop should be scoped to the requesting tab.
  // If tabId is missing (non-tab context), treat as global stop.
  if (current && (current.tabId === tabId || !tabId)) {
      await stopCurrent("stopped");
  } else {
    // Another tab requested stop. Do not stop the currently playing tab.
    // Still proceed to abort/clear requests for the requesting tab below.
  }

  const st = getTab(tabId);
  abortAll(st);
  clearQueue(st);
  st.prefetchGateOpened = false;
  st.playTask = null;
  // keep cache
}

async function handleCleanup(tabId) {
  await handleStop(tabId);
  const st = getTab(tabId);
  st.cache.clear();
  st.texts.clear();
  if (st.decodeCtx) {
    await st.decodeCtx.close().catch();
    st.decodeCtx = null;
  }
}

// --------------------------
// Message handlers
// --------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "offscreen.tts.fetchWindow") {
    (async () => {
      try {
        await handleWindow(msg.payload || {});
        sendResponse?.({ ok: true });
      } catch (e) {
        const p = msg.payload || {};
        emit(p.tabId, "tts.error", {
          index: p.startIndex,
          error: String(e && (e.message || e)),
        });
        sendResponse?.({ ok: false, error: String(e && (e.message || e)) });
      }
    })();
    return true;
  }

  if (msg.type === "offscreen.tts.stop") {
    (async () => {
      await handleStop(msg.payload?.tabId);
      sendResponse?.({ ok: true });
    })();
    return true;
  }

  if (msg.type === "offscreen.tts.cleanup") {
    (async () => {
      await handleCleanup(msg.payload?.tabId);
      tabs.delete(msg.payload?.tabId);
      sendResponse?.({ ok: true });
    })();
    return true;
  }

  if (msg.type === "offscreen.tts.listVoices" || msg.type === "offscreen.tts.refreshVoices") {
    (async () => {
      try {
        const serverId = msg.payload?.server;
        const voices = await fetchVoices(serverId, msg.type === "offscreen.tts.refreshVoices");
        sendResponse?.({ ok: true, voices });
      } catch (e) {
        sendResponse?.({ ok: false, error: String(e && (e.message || e)) });
      }
    })();
    return true;
  }
});
