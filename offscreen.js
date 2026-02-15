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
  try {
    chrome.runtime.sendMessage({
      type: "tts.forwardToTab",
      payload: { tabId, type, payload },
    });
  } catch {}
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
    { port: 9800, min_len: 2, sanitizer: sanitizePocket, streamable: true },
  ],
  [
    Server.CANDLE,
    {
      port: 9900,
      min_len: 2,
      sanitizer: sanitizePocket,
      streamable: true,
      extra_params: { model: "pocket-tts" },
    },
  ],
  [
    Server.MLX,
    {
      port: 9700,
      min_len: 2,
      sanitizer: sanitizePocket,
      streamable: false,
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
    .replace(/[[\]]/g, "")
    .replace(/(\d)\.(\d)/g, '$1 point $2')
    .replace(/([a-z]{2,3})\.([a-z]{2,3}\d)/g, '$1 dot $2')
    // remove extraneous punctuation after . ? !
    .replace(/([\.\?!])[^\s\p{L}\p{N}]+/gu, '$1 ')
    .replace(/\$\s?([\d,]+(?:\.\d{2})?)/g, '$1 dollars')
    // drop . from middle initial
    .replace(/\s([A-Z])\.\s/g, ' $1 ')
    // replace V.I.P. with VIP
    .replace(/([A-Z]\.){3,}/g, (match) => {  return match.replace(/\./g, ""); } )
    .trim()
    ;
}

function sanitizeCommon(text) {
  if (!text) return '';
  return text
    // Remove URLs (TTS engines usually mangle these)
    .replace(/(https?:\/\/[^\s]+)/g, '')

    // Whitelist: Keep letters (\p{L}), numbers (\p{N}),
    // basic punctuation (\p{P}), and spaces (\s).
    // This automatically strips emojis, arrows, and symbols.
    .replace(/[^\p{L}\p{N}\p{P}\p{S}\s]/gu, '')

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

  let input = sanitizeCommon(text)
  const sanitizer = cfg.sanitizer;
  if (sanitizer) input = sanitizer(input);
  input = expandAbbreviations(input)

  return {
    input,
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

// Streaming WAV player (mobile friendly)
//
// Replaces ScriptProcessor streaming. We assume WAV only for streaming.
// The server may send a WAV header first, then PCM16LE audio data.
//
// Implementation is based on demo.html's StreamingWavPlayer, but uses the
// robust tryParseWavHeader() above (handles non-44-byte headers).
class StreamingWavPlayer {
  constructor() {
    const AudioCtx = self.AudioContext || self.webkitAudioContext;
    // 'playback' latencyHint encourages mobile OS to use the higher quality path.
    this.ctx = new AudioCtx({ latencyHint: "playback" });

    this.headerBuf = [];
    this.headerLen = 0;
    this.header = null; // {numChannels, sampleRate, bitsPerSample, dataOffset}

    this.pcmData = new Uint8Array(0);
    this.nextStartTime = 0;
    this.minBufferSize = 16384;
    this.firstAudioPlayed = false;
    this.didStartPlayback = false;
    this._lastSrc = null;
  }

  async start() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  // Bytes we have scheduled + bytes waiting to be scheduled.
  bufferedSeconds() {
    if (!this.header) return 0;
    const bytesPerSecond =
      this.header.sampleRate * this.header.numChannels * 2;
    const scheduled = Math.max(0, this.nextStartTime - this.ctx.currentTime);
    const queued = bytesPerSecond
      ? this.pcmData.length / bytesPerSecond
      : 0;
    return scheduled + queued;
  }

  _appendPcmData(newData) {
    if (!newData || newData.length === 0) return;
    const merged = new Uint8Array(this.pcmData.length + newData.length);
    merged.set(this.pcmData, 0);
    merged.set(newData, this.pcmData.length);
    this.pcmData = merged;
  }

  _ensureHeaderParsed() {
    if (this.header) return;
    if (this.headerLen < 12) return;

    const tmp = new Uint8Array(this.headerLen);
    let off = 0;
    for (const h of this.headerBuf) {
      tmp.set(h, off);
      off += h.length;
    }

    const parsed = tryParseWavHeader(tmp);
    if (!parsed) return;

    if (parsed.audioFormat !== 1) throw new Error("WAV: only PCM supported");
    if (parsed.bitsPerSample !== 16)
      throw new Error("WAV: only 16-bit PCM supported");
    // Stereo is ok, but most TTS is mono.
    if (parsed.numChannels !== 1 && parsed.numChannels !== 2)
      throw new Error("WAV: only mono/stereo supported");

    this.header = {
      numChannels: parsed.numChannels,
      sampleRate: parsed.sampleRate,
      bitsPerSample: parsed.bitsPerSample,
      dataOffset: parsed.dataOffset,
    };

    // Any bytes after dataOffset are PCM.
    const pcmStart = tmp.subarray(parsed.dataOffset);
    if (pcmStart.length > 0) this._appendPcmData(pcmStart);

    // Clear header buffers to free memory.
    this.headerBuf = [];
    this.headerLen = 0;
  }

  async _tryPlayBuffer() {
    if (!this.header) return;
    if (this.pcmData.length < this.minBufferSize) return;

    const numChannels = this.header.numChannels;
    const sampleRate = this.header.sampleRate;
    const bytesPerFrame = numChannels * 2;
    const framesToPlay = Math.floor(this.pcmData.length / bytesPerFrame);
    const bytesToPlay = framesToPlay * bytesPerFrame;
    if (bytesToPlay <= 0) return;

    const dataToPlay = this.pcmData.subarray(0, bytesToPlay);
    this.pcmData = this.pcmData.subarray(bytesToPlay);

    const audioBuffer = this.ctx.createBuffer(
      numChannels,
      framesToPlay,
      sampleRate,
    );
    const int16 = new Int16Array(
      dataToPlay.buffer,
      dataToPlay.byteOffset,
      framesToPlay * numChannels,
    );

    for (let ch = 0; ch < numChannels; ch++) {
      const out = audioBuffer.getChannelData(ch);
      for (let i = 0; i < framesToPlay; i++) {
        out[i] = int16[i * numChannels + ch] / 32768;
      }
    }

    const src = this.ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    const startTime = Math.max(now, this.nextStartTime);
    src.start(startTime);

    this._lastSrc = src;

    if (!this.didStartPlayback) this.didStartPlayback = true;

    // Allow a callback to fire on first audible playback (used by UI elsewhere).
    if (!this.firstAudioPlayed && self.firstAudioCallback) {
      this.firstAudioPlayed = true;
      try {
        self.firstAudioCallback();
      } catch {}
    }

    this.nextStartTime = startTime + audioBuffer.duration;

    // If we still have enough buffered, keep scheduling quickly.
    if (this.pcmData.length >= this.minBufferSize) {
      setTimeout(() => this._tryPlayBuffer(), 10);
    }
  }

  async addChunk(chunk) {
    if (!chunk || chunk.length === 0) return;

    // Header parse phase
    if (!this.header) {
      this.headerBuf.push(chunk);
      this.headerLen += chunk.length;
      // Don't let header grow without bound in pathological cases.
      if (this.headerLen > 256 * 1024) {
        throw new Error("WAV header too large / invalid stream");
      }
      this._ensureHeaderParsed();
      await this._tryPlayBuffer();
      return;
    }

    // PCM phase
    this._appendPcmData(chunk);
    await this._tryPlayBuffer();
  }


  async finish({ timeoutMs = 15000 } = {}) {
    // Flush any tail bytes that are smaller than minBufferSize.
    // At end of stream we want to schedule everything we have.
    if (!this.header) return;

    this.minBufferSize = 1;

    // Schedule until we've consumed all whole frames.
    const bytesPerFrame = this.header.numChannels * 2;
    while (this.pcmData.length >= bytesPerFrame) {
      await this._tryPlayBuffer();
      // _tryPlayBuffer drains all currently available whole frames, so one loop is usually enough,
      // but keep this as a safety in case future changes schedule partial buffers.
      if (this.pcmData.length < bytesPerFrame) break;
    }

    // Wait for last scheduled source to end (more reliable than polling bufferedSeconds).
    if (!this._lastSrc) return;

    await new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        resolve();
      }, timeoutMs);

      try {
        this._lastSrc.addEventListener("ended", () => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve();
        }, { once: true });
      } catch {
        // If addEventListener fails, fall back to time based wait.
        // Use nextStartTime as an estimate and still enforce timeoutMs above.
        const ms = Math.max(0, Math.ceil((this.nextStartTime - this.ctx.currentTime) * 1000) + 100);
        setTimeout(() => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve();
        }, ms);
      }
    });
  }

  async stop() {
    try {
      if (this.ctx.state === "suspended") await this.ctx.resume();
    } catch {}
    try {
      if (this.ctx.state !== "closed") await this.ctx.close();
    } catch {}
  }
}


class StreamingPcm16Player {
  constructor({ sampleRate }) {
    const AudioCtx = self.AudioContext || self.webkitAudioContext;
    this.ctx = new AudioCtx({ latencyHint: "playback", sampleRate });

    this.sampleRate = sampleRate;
    this.pcmData = new Uint8Array(0); // raw pcm16le bytes
    this.nextStartTime = 0;
    this.minBufferSize = 16384;
    this.firstAudioPlayed = false;
    this.didStartPlayback = false;
    this._lastSrc = null;
  }

  async start() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  _appendBytes(u8) {
    if (!u8 || u8.length === 0) return;
    const merged = new Uint8Array(this.pcmData.length + u8.length);
    merged.set(this.pcmData, 0);
    merged.set(u8, this.pcmData.length);
    this.pcmData = merged;
  }

  addChunk(u8) {
    // Expect pcm16le mono
    this._appendBytes(u8);
    this.tryPlayBuffer();
  }

  tryPlayBuffer() {
    if (this.didStartPlayback && this.ctx.state === "suspended") return;

    // Need at least 2 bytes per sample.
    const alignedLen = this.pcmData.length - (this.pcmData.length % 2);
    if (alignedLen < 2) return;

    // Respect minBufferSize during streaming to reduce overhead,
    // but we'll lower this in finish() to flush the tail.
    const playLen = Math.min(alignedLen, Math.max(this.minBufferSize, 2));
    if (alignedLen < this.minBufferSize && !this.firstAudioPlayed) return;
    if (alignedLen < this.minBufferSize && this.firstAudioPlayed) return;

    const dataToPlay = this.pcmData.subarray(0, playLen);
    this.pcmData = this.pcmData.subarray(playLen);

    const framesToPlay = dataToPlay.length / 2;

    const audioBuffer = this.ctx.createBuffer(1, framesToPlay, this.sampleRate);
    const int16 = new Int16Array(
      dataToPlay.buffer,
      dataToPlay.byteOffset,
      framesToPlay,
    );
    const out = audioBuffer.getChannelData(0);
    for (let i = 0; i < framesToPlay; i++) out[i] = int16[i] / 32768;

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (!this.didStartPlayback) {
      this.nextStartTime = Math.max(now + 0.02, this.nextStartTime);
      this.didStartPlayback = true;
    } else {
      this.nextStartTime = Math.max(this.nextStartTime, now + 0.002);
    }

    source.start(this.nextStartTime);
    this._lastSrc = source;
    this.nextStartTime += audioBuffer.duration;

    this.firstAudioPlayed = true;
  }

  async finish({ timeoutMs = 15000 } = {}) {
    // Flush remaining tail: drop minBufferSize, schedule whatever is left.
    this.minBufferSize = 2;

    // Keep scheduling until no more whole samples remain.
    // This is not a "drain loop"; it's just flushing remaining queued bytes
    // into scheduled AudioBufferSourceNodes.
    while (true) {
      const alignedLen = this.pcmData.length - (this.pcmData.length % 2);
      if (alignedLen < 2) break;

      const chunkLen = alignedLen; // schedule all remaining
      const dataToPlay = this.pcmData.subarray(0, chunkLen);
      this.pcmData = this.pcmData.subarray(chunkLen);

      const framesToPlay = dataToPlay.length / 2;
      const audioBuffer = this.ctx.createBuffer(1, framesToPlay, this.sampleRate);
      const int16 = new Int16Array(
        dataToPlay.buffer,
        dataToPlay.byteOffset,
        framesToPlay,
      );
      const out = audioBuffer.getChannelData(0);
      for (let i = 0; i < framesToPlay; i++) out[i] = int16[i] / 32768;

      const source = this.ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.ctx.destination);

      const now = this.ctx.currentTime;
      if (!this.didStartPlayback) {
        this.nextStartTime = Math.max(now + 0.02, this.nextStartTime);
        this.didStartPlayback = true;
      } else {
        this.nextStartTime = Math.max(this.nextStartTime, now + 0.002);
      }

      source.start(this.nextStartTime);
      this._lastSrc = source;
      this.nextStartTime += audioBuffer.duration;
      this.firstAudioPlayed = true;

      // If the remaining data was tiny, break after scheduling.
      if (this.pcmData.length < 2) break;
    }

    // Wait for the last scheduled source to end.
    const last = this._lastSrc;
    if (!last) return;

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        last.addEventListener("ended", finish, { once: true });
      } catch {
        // Fallback: resolve soon if event listener fails
        setTimeout(finish, 0);
      }
      setTimeout(finish, timeoutMs);
    });
  }

  async stop() {
    try {
      await this.ctx.close();
    } catch {}
  }
}

class BufferSourcePlayer {
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
//   token: number,
//   server: number, voice: string, speed: number, lang: string,
//   textByIndex: Map<number,string>,
//   cache: Map<string, { sampleRate:number, pcmU8:Uint8Array } | { audioBuffer: AudioBuffer }>,
//   decodeCtx: AudioContext | null,
//   aborts: Map<string, AbortController>,    // key -> controller
//   inFlight: Map<string, Promise<void>>,    // key -> promise that stores cache
//   queue: string[],
//   queued: Set<string>,
//   prefetchRunning: boolean,
// }

let current = null; // { tabId, key, signature, token, index, abort, player }

function getTab(tabId) {
  let st = tabs.get(tabId);
  if (!st) {
    st = {
      signature: null,
      token: 0,
      server: null,
      voice: null,
      speed: 1.0,
      lang: "en",
      textByIndex: new Map(),
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

function cacheKey(signature, index) {
  return `${signature}:${index}`;
}

function getDecodeCtx(st) {
  if (st.decodeCtx) return st.decodeCtx;
  const AudioCtx = self.AudioContext || self.webkitAudioContext;
  st.decodeCtx = new AudioCtx({ latencyHint: "playback" });
  return st.decodeCtx;
}

function makeSilenceBuffer(st, ms = 30) {
  const ctx = getDecodeCtx(st);
  const frames = Math.max(1, Math.round((ctx.sampleRate * ms) / 1000));
  // createBuffer is zero initialized, so this is silence.
  return ctx.createBuffer(1, frames, ctx.sampleRate);
}

function isTooShortForServer(cfg, body) {
  const minLen = cfg.min_len ?? 0;
  const inputLen = (body.input ?? "").length;
  return minLen > 0 && inputLen < minLen;
}

async function stopCurrent(reason = "stopped") {
  if (!current) return;

  const c = current;
  current = null;

  const { tabId, signature, token, index } = c;

  try {
    c.abort?.abort();
  } catch {}
  try {
    await c.player?.stop();
  } catch {}

  emit(tabId, "tts.ended", { signature, token, index, reason });
}

function abortAllForTab(tabId) {
  const st = getTab(tabId);
  for (const ac of st.aborts.values()) {
    try {
      ac.abort();
    } catch {}
  }
  st.aborts.clear();
  st.inFlight.clear();
}

function clearQueue(tabId) {
  const st = getTab(tabId);
  st.queue.length = 0;
  st.queued.clear();
  st.prefetchRunning = false;
}

// --------------------------
// Fetch primitives
// --------------------------

async function synthesizeToCache(st, key, index) {
  if (st.cache.has(key)) return;
  if (st.inFlight.has(key)) return st.inFlight.get(key);

  const text = st.textByIndex.get(index) || "";
  const serverId = st.server;
  const voice = st.voice;
  const speed = st.speed;
  const lang = st.lang;

  const cfg = SERVERS.get(serverId);
  if (!cfg) throw new Error("Unknown server");

  const body = buildBody(serverId, { text, voice, speed, lang });
  if (isTooShortForServer(cfg, body)) {
    st.cache.set(key, { audioBuffer: makeSilenceBuffer(st, 30) });
    return;
  }

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

async function streamPlayAndCache(tabId, st, signature, token, index) {
  const key = cacheKey(signature, index);

  // If a synthesize prefetch is in-flight for this key, wait and then play.
  if (st.inFlight.has(key)) {
    await st.inFlight.get(key);
    if (st.cache.has(key)) {
      await playFromCache(tabId, st, signature, token, index);
      return;
    }
  }

  const text = st.textByIndex.get(index) || "";
  const serverId = st.server;
  const voice = st.voice;
  const speed = st.speed;
  const lang = st.lang;

  const cfg = SERVERS.get(serverId);
  const streamable = (cfg?.streamable ?? true);  // && !isAndroid;

  if (!streamable) {
    // fallback: synthesize then play
    await synthesizeToCache(st, key, index);
    await playFromCache(tabId, st, signature, token, index);
    return;
  }

  const body = buildBody(serverId, { text, voice, speed, lang });
  if (isTooShortForServer(cfg, body)) {
    st.cache.set(key, { audioBuffer: makeSilenceBuffer(st, 30) });
    return;
  }

  const url = endpointFor(serverId, "/stream");

  const ac = new AbortController();
  st.aborts.set(key, ac);

  await stopCurrent("superseded");

  let player = null;
  current = { tabId, key, signature, token, index, abort: ac, player };

  let notifiedPlaying = false;
  const chunks = [];
  let total = 0;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });

    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);

    const ctype = (r.headers.get("content-type") || "").toLowerCase();
    const isWav =
      ctype.includes("audio/wav") ||
      ctype.includes("audio/x-wav") ||
      ctype.includes("wav");
    if (!r.body) throw new Error("Missing response body stream");

    // Stream supports either WAV (preferred) or raw PCM16LE mono.
    // For raw PCM, infer sampleRate from the Content-Type parameter: rate=(\d+)
    let streamMode = isWav ? "wav" : "pcm";
    let pcmSampleRate = null;
    if (!isWav) {
      const m = ctype.match(/rate\s*=\s*(\d+)/);
      if (!m) {
        throw new Error(`Raw PCM stream missing rate=... in content-type: ${ctype}`);
      }
      pcmSampleRate = parseInt(m[1], 10);
      if (!Number.isFinite(pcmSampleRate) || pcmSampleRate <= 0) {
        throw new Error(`Invalid PCM sample rate in content-type: ${ctype}`);
      }
    }

    const reader = r.body.getReader();

    // Create WAV streaming player
    player = streamMode === "wav" ? new StreamingWavPlayer() : new StreamingPcm16Player({ sampleRate: pcmSampleRate });
    current.player = player;
    await player.start();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      // stop / superseded
      if (
        !current ||
        current.tabId !== tabId ||
        current.token !== token ||
        current.signature !== signature
      ) {
        try {
          ac.abort();
        } catch {}
        return;
      }

      // Keep a copy for caching/decoding later.
      chunks.push(value);
      total += value.length;

      // Stream into player.
      await current.player.addChunk(value);

      if (!notifiedPlaying && current.player.didStartPlayback) {
        notifiedPlaying = true;
        emit(tabId, "tts.playing", { signature, token, index });
        st.prefetchGateOpened = true;
        ensurePrefetchLoop(st);
      }
    }

    // Ensure playing event even if we buffered quickly
    if (!notifiedPlaying) {
      notifiedPlaying = true;
      emit(tabId, "tts.playing", { signature, token, index });
      st.prefetchGateOpened = true;
      ensurePrefetchLoop(st);
    }

    // Cache what we downloaded (full WAV), decoded into an AudioBuffer.
    if (total > 0) {
      const allU8 = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        allU8.set(c, off);
        off += c.length;
      }

      const ctx = getDecodeCtx(st);
      let audioBuffer = null;

      if (streamMode === "wav") {
        audioBuffer = await ctx.decodeAudioData(allU8.buffer.slice(0));
      } else {
        // Raw PCM16LE mono
        const aligned = allU8.length - (allU8.length % 2);
        const frames = aligned / 2;
        audioBuffer = ctx.createBuffer(1, frames, pcmSampleRate);

        const i16 = new Int16Array(allU8.buffer, 0, frames);
        const out = audioBuffer.getChannelData(0);
        for (let i = 0; i < frames; i++) out[i] = i16[i] / 32768;
      }

      if (audioBuffer) st.cache.set(key, { audioBuffer });
    }


    // Wait for final tail to play out (event-driven, no drain polling).
    try {
      await player.finish();
    } catch {}
  } catch (e) {
    emit(tabId, "tts.error", {
      signature,
      token,
      index,
      error: String(e && (e.message || e)),
    });
    await stopCurrent("error");
  } finally {
    st.aborts.delete(key);
  }

  if (current && current.tabId === tabId && current.token === token) {
    await stopCurrent("natural");
  }
}

async function playFromCache(tabId, st, signature, token, index) {
  const key = cacheKey(signature, index);
  const entry = st.cache.get(key);
  if (!entry) return;

  await stopCurrent("superseded");

  const ac = new AbortController();
  st.aborts.set(key, ac);
  const ctx = getDecodeCtx(st);
  const player = new BufferSourcePlayer({ ctx });
  current = { tabId, key, signature, token, index, abort: ac, player };

  await player.startFromAudioBuffer(entry.audioBuffer);
  emit(tabId, "tts.playing", { signature, token, index });
  st.prefetchGateOpened = true;
  ensurePrefetchLoop(st);

  await player.waitEnded(ac.signal);

  st.aborts.delete(key);

  if (current && current.tabId === tabId && current.token === token) {
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

        // stop/cleanup might have cleared token/signature; still safe
        if (st.cache.has(key)) continue;

        // parse index from key
        const idx = Number(key.split(":").pop());
        if (!Number.isFinite(idx)) continue;

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

function enqueuePrefetch(st, signature, index) {
  const key = cacheKey(signature, index);
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

async function handleWindow(p) {
  const tabId = p.tabId;
  const signature = p.signature || "";
  const token = Number(p.token || 0);

  const st = getTab(tabId);

  // Ignore old windows (stale token). Token is monotonic per content playback session.
  if (token < st.token) return;

  // Signature change: clear cache (audio unlikely useful now)
  if (signature !== st.signature) {
    st.cache.clear();
  }

  // Update session fields
  st.signature = signature;
  st.token = token;
  st.server = p.server;
  st.voice = p.voice;
  st.speed = p.speed;
  st.lang = p.lang || "en";

  // Update text map
  const segs = Array.isArray(p.segments) ? p.segments : [];
  for (const s of segs) {
    if (!s) continue;
    st.textByIndex.set(Number(s.index), String(s.text || ""));
  }

  const startIndex = Number(p.startIndex);
  const endIndex = Number(p.endIndex);

  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return;

  // Clear any queued prefetches that are outside the new window.
  // (Basic behavior; can harden later.)
  clearQueue(tabId);

  // If current playback is not exactly what we want, start it.
  const curOk =
    current &&
    current.tabId === tabId &&
    current.signature === signature &&
    current.token === token &&
    current.index === startIndex;

  if (!curOk) {
    // stop current playback (single player)
    await stopCurrent("superseded");

    // reset prefetch gate: we only start prefetching once audio has begun playing
    st.prefetchGateOpened = false;

    const startKey = cacheKey(signature, startIndex);

    // Kick playback asynchronously so we can queue prefetch immediately.
    st.playTask = (async () => {
      try {
        // Start playing startIndex, using cache/inFlight/stream as needed
        if (st.cache.has(startKey)) {
          await playFromCache(tabId, st, signature, token, startIndex);
        } else {
          await streamPlayAndCache(tabId, st, signature, token, startIndex);
        }
      } catch (e) {
        emit(tabId, "tts.error", {
          signature,
          token,
          index: startIndex,
          error: String(e && (e.message || e)),
        });
      }
    })();
  }

  // Queue prefetch window strictly serialized
  for (let i = startIndex + 1; i <= endIndex; i++) {
    enqueuePrefetch(st, signature, i);
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
  if (current) {
    if (tabId == null) {
      await stopCurrent("stopped");
    } else if (current.tabId === tabId) {
      await stopCurrent("stopped");
    } else {
      // Another tab requested stop. Do not stop the currently playing tab.
      // Still proceed to abort/clear requests for the requesting tab below.
    }
  }

  const st = getTab(tabId);
  abortAllForTab(tabId);
  clearQueue(tabId);
  st.prefetchGateOpened = false;
  st.playTask = null;
  // keep cache
}

async function handleCleanup(tabId) {
  await handleStop(tabId);
  const st = getTab(tabId);
  st.cache.clear();
  st.textByIndex.clear();
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
          signature: p.signature,
          token: p.token,
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
      sendResponse?.({ ok: true });
    })();
    return true;
  }

  if (msg.type === "offscreen.tts.cleanupTab") {
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
