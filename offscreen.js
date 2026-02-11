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

function emit(tabId, eventType, payload) {
  try {
    chrome.runtime.sendMessage({
      type: "offscreen.tts.event",
      payload: { tabId, eventType, payload },
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

function sanitizeCommon(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim();
}

const SERVERS = new Map([
  [Server.MY_KOKORO, { port: 9090, min_len: 2, streamable: false }],
  [
    Server.VOX_ANE,
    { port: 9000, min_len: 5, sanitizer: sanitizeCommon, streamable: true },
  ],
  [
    Server.SUPERTONIC,
    { port: 8001, min_len: 5, sanitizer: sanitizeCommon, streamable: true },
  ],
  [
    Server.POCKET,
    { port: 9800, min_len: 2, sanitizer: sanitizeCommon, streamable: true },
  ],
  [
    Server.CANDLE,
    {
      port: 9900,
      min_len: 2,
      sanitizer: sanitizeCommon,
      streamable: true,
      extra_params: { model: "pocket-tts" },
    },
  ],
  [
    Server.MLX,
    {
      port: 9700,
      min_len: 2,
      sanitizer: sanitizeCommon,
      streamable: false,
    },
  ],
]);

function endpointFor(serverId, route) {
  const cfg = SERVERS.get(serverId);
  if (!cfg) throw new Error("Unknown server");
  return `http://${SERVER_IP}:${cfg.port}${route}`;
}

function buildBody(serverId, { text, voice, speed, lang }) {
  const cfg = SERVERS.get(serverId);
  if (!cfg) throw new Error("Unknown server");

  const sanitizer = cfg.sanitizer;
  const input = sanitizer ? sanitizer(text) : String(text || "");

  return {
    input,
    voice,
    speed,
    lang,
    ...(cfg.extra_params || {}),
  };
}

async function fetchVoices(serverId) {
  const r = await fetch(endpointFor(serverId, "/voices"));
  if (!r.ok) throw new Error(`/voices failed: ${r.status} ${r.statusText}`);
  const j = await r.json();
  return j.voices;
}

// --------------------------
// Audio utilities
// --------------------------

function pcm16leToFloat32(u8) {
  const i16 = new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength / 2);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  return f32;
}

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

class StreamingPcmPlayer {
  constructor({ sampleRate }) {
    const AudioCtx = self.AudioContext || self.webkitAudioContext;
    this.ctx = new AudioCtx({ latencyHint: "playback", sampleRate });
    this.queue = [];
    this.queueOffset = 0;
    this.samplesBuffered = 0;

    // Deprecated but reliable; keep for now.
    this.proc = this.ctx.createScriptProcessor(4096, 0, 1);
    this.proc.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      let written = 0;

      while (written < out.length) {
        if (this.queue.length === 0) {
          for (; written < out.length; written++) out[written] = 0;
          return;
        }

        const cur = this.queue[0];
        const available = cur.length - this.queueOffset;
        const need = out.length - written;
        const take = Math.min(available, need);

        out.set(
          cur.subarray(this.queueOffset, this.queueOffset + take),
          written,
        );
        written += take;
        this.queueOffset += take;
        this.samplesBuffered -= take;

        if (this.queueOffset >= cur.length) {
          this.queue.shift();
          this.queueOffset = 0;
        }
      }
    };

    this.proc.connect(this.ctx.destination);
  }

  async start() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  pushFloat32(f32) {
    if (!f32 || f32.length === 0) return;
    this.queue.push(f32);
    this.samplesBuffered += f32.length;
  }

  bufferedSeconds() {
    return this.samplesBuffered / this.ctx.sampleRate;
  }

  // ScriptProcessor output is blocky. When our queue drains to ~0, there may still be
  // up to one block already inside the output buffer that hasn't reached the speakers yet.
  // Waiting ~1 block avoids end-of-utterance clipping ("wisd" vs "wisdom").
  playoutGraceMs() {
    const bs = this.proc?.bufferSize || 4096;
    return (bs / this.ctx.sampleRate) * 1000;
  }

  async stop() {
    try {
      this.proc.disconnect();
    } catch {}
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
      signature: "",
      token: 0,
      server: Server.SUPERTONIC,
      voice: "",
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

  // add grace period to avoid end clipping
  if (reason === "natural") {
    try {
      const ms = Math.ceil((c.player?.playoutGraceMs() || 0) + 20);
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    } catch {}
  }

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

function shouldIgnoreWindow(st, token) {
  // Ignore old windows (stale token). Token is monotonic per content playback session.
  return token < st.token;
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
  const streamable = cfg?.streamable ?? true;

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

  // WAV streaming header parse buffer
  let headerBuf = [];
  let headerLen = 0;
  let headerParsed = false;
  let dataOffset = 0;
  let sampleRate = 24000;

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

    const reader = r.body.getReader();

    // Determine sample rate for raw PCM streams, if provided.
    // Some servers return raw PCM with Content-Type including rate=44100.
    if (!isWav) {
      const m = ctype.match(/rate\s*=\s*(\d+)/i);
      if (m && m[1]) {
        const r0 = parseInt(m[1], 10);
        if (Number.isFinite(r0) && r0 > 0) sampleRate = r0;
      }
    }

    // Create player after we know sampleRate
    player = new StreamingPcmPlayer({ sampleRate });
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
    current.player = player;

    await player.start();

    // Raw PCM streams may split int16 samples across chunks. Keep a carry byte to preserve alignment.
    let pendingPcmByte = null;
    let firstPcmPush = true;

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

      if (isWav && !headerParsed) {
        headerBuf.push(value);
        headerLen += value.length;

        if (headerLen >= 4096) {
          const tmp = new Uint8Array(headerLen);
          let off = 0;
          for (const h of headerBuf) {
            tmp.set(h, off);
            off += h.length;
          }
          const header = tryParseWavHeader(tmp);
          if (header) {
            if (header.audioFormat !== 1)
              throw new Error("WAV: only PCM supported");
            if (header.numChannels !== 1)
              throw new Error("WAV: only mono supported");
            if (header.bitsPerSample !== 16)
              throw new Error("WAV: only 16-bit PCM supported");

            sampleRate = header.sampleRate;
            dataOffset = header.dataOffset;
            headerParsed = true;

            // Switch player sampleRate by recreating (simple + reliable)
            await player.stop();
            const newPlayer = new StreamingPcmPlayer({ sampleRate });
            await newPlayer.start();
            current.player = newPlayer;

            const pcmStart = tmp.subarray(dataOffset);
            if (pcmStart.length > 0) {
              chunks.push(pcmStart);
              total += pcmStart.length;
              newPlayer.pushFloat32(pcm16leToFloat32(pcmStart));
            }

            if (!notifiedPlaying) {
              notifiedPlaying = true;
              emit(tabId, "tts.playing", { signature, token, index });
              st.prefetchGateOpened = true;
              ensurePrefetchLoop(st);
            }
          }
        }
        continue;
      }

      // PCM chunks
      let chunk = value;
      if (!isWav) {
        // Ensure int16 alignment across chunk boundaries.
        if (pendingPcmByte != null) {
          const merged = new Uint8Array(chunk.length + 1);
          merged[0] = pendingPcmByte;
          merged.set(chunk, 1);
          chunk = merged;
          pendingPcmByte = null;
        }
        if (chunk.length % 2 === 1) {
          pendingPcmByte = chunk[chunk.length - 1];
          chunk = chunk.subarray(0, chunk.length - 1);
        }
        if (chunk.length === 0) continue;
      }

      chunks.push(chunk);
      total += chunk.length;

      const f32 = pcm16leToFloat32(chunk);
      // SuperT raw PCM stream can pop at start if the first sample is not near zero.
      // Apply a tiny fade-in on the first push only (about 5ms).
      if (!isWav && firstPcmPush) {
        firstPcmPush = false;
        const fadeSamples = Math.min(
          f32.length,
          Math.floor(sampleRate * 0.005),
        );
        for (let i = 0; i < fadeSamples; i++) {
          f32[i] *= i / fadeSamples;
        }
      }
      current.player.pushFloat32(f32);

      if (!notifiedPlaying) {
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

    // Cache what we downloaded (PCM bytes)
    if (total > 0) {
      const pcmU8 = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        pcmU8.set(c, off);
        off += c.length;
      }
      st.cache.set(key, { sampleRate, pcmU8 });
    }
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

  // Drain then end naturally
  try {
    while (
      current &&
      current.tabId === tabId &&
      current.token === token &&
      current.player.bufferedSeconds() > 0.0
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch {}

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

  if (shouldIgnoreWindow(st, token)) {
    return;
  }

  // Signature change: clear cache (audio unlikely useful now)
  if (st.signature && signature !== st.signature) {
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
    try {
      await st.decodeCtx.close();
    } catch {}
    st.decodeCtx = null;
  }
}

// --------------------------
// Message handlers
// --------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "offscreen.tts.window") {
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

  if (msg.type === "offscreen.tts.listVoices") {
    (async () => {
      try {
        const serverId = msg.payload?.server;
        const voices = await fetchVoices(serverId);
        sendResponse?.({ ok: true, voices });
      } catch (e) {
        sendResponse?.({ ok: false, error: String(e && (e.message || e)) });
      }
    })();
    return true;
  }
});
