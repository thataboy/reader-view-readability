let current = null; // { streamId, abort, player }

function uint8ToBase64(u8) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < u8.length; i += chunkSize) {
    const sub = u8.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

function concatChunks(chunks, totalLen) {
  const full = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    full.set(c, off);
    off += c.length;
  }
  return full;
}

function parseMediaType(contentType) {
  const ct = (contentType || "").toLowerCase();

  // WAV if header says so
  const isWav = ct.includes("audio/wav") || ct.includes("audio/x-wav") || ct.includes("wav");

  if (isWav) {
    return { kind: "wav" };
  }

  // Otherwise assume raw PCM s16le mono and extract rate=...
  let rate = 24000;
  const m = ct.match(/rate\s*=\s*(\d+)/i);
  if (m) {
    const r = parseInt(m[1], 10);
    if (Number.isFinite(r) && r > 0) rate = r;
  }

  return { kind: "pcm_s16le", sampleRate: rate, numChannels: 1 };
}

// Robust-ish WAV parser: find "fmt " and "data" chunks
// Returns { sampleRate, numChannels, bitsPerSample, dataOffset } or null if insufficient / invalid.
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
    const id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
    const size = dv.getUint32(pos + 4, true);
    const dataPos = pos + 8;

    // For non-data chunks, we must have the whole chunk payload before reading it
    if (id !== "data") {
      if (dataPos + size > u8.length) return null;
    } else {
      // For streaming WAV, we only need to know where PCM starts.
      // We do NOT require the full "data" chunk payload to be present.
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

    // word align
    pos = dataPos + size + (size % 2);
  }

  if (!fmt || dataOffset == null) return null;

  return {
    audioFormat: fmt.audioFormat,
    numChannels: fmt.numChannels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    dataOffset
  };
}

function makeWavHeader({ sampleRate, numChannels, dataBytes }) {
  const blockAlign = numChannels * 2;
  const byteRate = sampleRate * blockAlign;
  const riffSize = 36 + dataBytes;

  const header = new Uint8Array(44);
  const dv = new DataView(header.buffer);

  // RIFF
  header[0] = 0x52; header[1] = 0x49; header[2] = 0x46; header[3] = 0x46;
  dv.setUint32(4, riffSize, true);

  // WAVE
  header[8] = 0x57; header[9] = 0x41; header[10] = 0x56; header[11] = 0x45;

  // fmt
  header[12] = 0x66; header[13] = 0x6d; header[14] = 0x74; header[15] = 0x20;
  dv.setUint32(16, 16, true);     // fmt chunk size
  dv.setUint16(20, 1, true);      // PCM
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);

  // data
  header[36] = 0x64; header[37] = 0x61; header[38] = 0x74; header[39] = 0x61;
  dv.setUint32(40, dataBytes, true);

  return header;
}

class StreamingPcmPlayer {
  constructor({ sampleRate }) {
    const AudioCtx = self.AudioContext || self.webkitAudioContext;
    this.ctx = new AudioCtx({ latencyHint: "playback", sampleRate });
    this.queue = [];
    this.queueOffset = 0;
    this.samplesBuffered = 0;

    // Deprecated but reliable; warning is ok.
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

        out.set(cur.subarray(this.queueOffset, this.queueOffset + take), written);
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

  async stop() {
    try { this.proc.disconnect(); } catch {}
    try { await this.ctx.close(); } catch {}
  }
}

function pcm16leToFloat32(u8) {
  // u8 length must be even
  const i16 = new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength / 2);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  return f32;
}

async function streamAndPlay({ streamId, endpoint, body, signature, token, index }) {
  // cancel any existing stream
  if (current) {
    try { current.abort.abort(); } catch {}
    try { await current.player.stop(); } catch {}
    current = null;
  }

  const abort = new AbortController();
  const sendToBackground = (type, payload) => {
    try { chrome.runtime.sendMessage({ type, payload }); } catch {}
  };

  // For returning full audio
  const allChunks = [];
  let allLen = 0;

  // For WAV parsing and PCM feeding
  let mode = null; // { kind: "wav" } | { kind:"pcm_s16le", sampleRate, numChannels }
  let wavHeader = null;         // parsed header object
  let wavHeaderBuf = new Uint8Array(0); // accumulate until header parsable
  let wavDataStarted = false;

  // For PCM feeding: handle odd byte across chunks
  let leftover = new Uint8Array(0);

  // Player is mono always; for WAV we’ll still parse sampleRate
  // We create player once we know sampleRate.
  let player = null;

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    if (!resp.body) throw new Error("Missing response body stream");

    mode = parseMediaType(resp.headers.get("content-type") || "");

    const reader = resp.body.getReader();

    let notifiedPlaying = false;
    const startThresholdSec = 0.2;

    const ensurePlayer = async (sr) => {
      if (player) return;
      player = new StreamingPcmPlayer({ sampleRate: sr });
      await player.start();
      current = { streamId, abort, player };
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      // accumulate for return
      allChunks.push(value);
      allLen += value.length;

      if (mode.kind === "wav") {
        // We need to parse WAV header to get sampleRate, then feed PCM bytes (mono) to player
        if (!wavHeader) {
          const combined = new Uint8Array(wavHeaderBuf.length + value.length);
          combined.set(wavHeaderBuf, 0);
          combined.set(value, wavHeaderBuf.length);
          wavHeaderBuf = combined;

          // Try parse header once we have enough. Allow up to 4KB for extended headers.
          const parsed = tryParseWavHeader(wavHeaderBuf);
          if (!parsed) continue;

          if (parsed.audioFormat !== 1) throw new Error("WAV not PCM");
          if (parsed.bitsPerSample !== 16) throw new Error("WAV not 16-bit PCM");

          if (parsed.numChannels !== 1) throw new Error("WAV not mono");

          wavHeader = parsed;
          await ensurePlayer(wavHeader.sampleRate);

          // Anything after dataOffset is PCM data. Note: wavHeaderBuf might contain more than header.
          const pcmStart = wavHeaderBuf.subarray(wavHeader.dataOffset);
          wavDataStarted = true;
          wavHeaderBuf = new Uint8Array(0);

          if (pcmStart.length > 0) {
            // fall through and treat as PCM bytes below
            value = pcmStart;
          } else {
            continue;
          }
        }

        // assume WAV PCM bytes are little-endian s16le
        let pcmBytes = value;
        if (leftover.length > 0) {
          const combined = new Uint8Array(leftover.length + pcmBytes.length);
          combined.set(leftover, 0);
          combined.set(pcmBytes, leftover.length);
          pcmBytes = combined;
          leftover = new Uint8Array(0);
        }
        if (pcmBytes.length % 2 === 1) {
          leftover = pcmBytes.subarray(pcmBytes.length - 1);
          pcmBytes = pcmBytes.subarray(0, pcmBytes.length - 1);
        }
        if (pcmBytes.length > 0) {
          player.pushFloat32(pcm16leToFloat32(pcmBytes));
        }
      } else {
        // pcm_s16le
        await ensurePlayer(mode.sampleRate);

        let pcmBytes = value;
        if (leftover.length > 0) {
          const combined = new Uint8Array(leftover.length + pcmBytes.length);
          combined.set(leftover, 0);
          combined.set(pcmBytes, leftover.length);
          pcmBytes = combined;
          leftover = new Uint8Array(0);
        }
        if (pcmBytes.length % 2 === 1) {
          leftover = pcmBytes.subarray(pcmBytes.length - 1);
          pcmBytes = pcmBytes.subarray(0, pcmBytes.length - 1);
        }
        if (pcmBytes.length > 0) {
          player.pushFloat32(pcm16leToFloat32(pcmBytes));
        }
      }

      if (player && !notifiedPlaying && player.bufferedSeconds() >= startThresholdSec) {
        notifiedPlaying = true;
        sendToBackground("offscreen.tts.streamPlaying", { streamId, index, signature, token });
      }
    }

    // stream finished downloading
    if (player && !notifiedPlaying) {
      // still send playing so UI updates, even if it buffered quickly at end
      notifiedPlaying = true;
      sendToBackground("offscreen.tts.streamPlaying", { streamId, index, signature, token });
    }

    // Prepare audio to return:
    // - If WAV: return the bytes as received.
    // - If PCM: wrap a WAV header around the raw PCM bytes.
    const full = concatChunks(allChunks, allLen);

    let returnWav;
    if (mode.kind === "wav") {
      returnWav = full;
    } else {
      // mono s16le PCM in full
      const header = makeWavHeader({
        sampleRate: mode.sampleRate,
        numChannels: 1,
        dataBytes: full.length
      });
      returnWav = new Uint8Array(header.length + full.length);
      returnWav.set(header, 0);
      returnWav.set(full, header.length);
    }

    sendToBackground("offscreen.tts.streamAudioReady", {
      streamId,
      base64: uint8ToBase64(returnWav)
    });

    // wait for playback to drain
    while (true) {
      if (abort.signal.aborted) return;
      if (!player) break;
      if (player.queue.length === 0 && player.samplesBuffered <= 0) break;
      await new Promise(r => setTimeout(r, 25));
    }

    sendToBackground("offscreen.tts.streamEnded", { streamId, index, signature, token });

  } catch (e) {
    if (abort.signal.aborted) {
      sendToBackground("offscreen.tts.streamCancelled", { streamId });
    } else {
      sendToBackground("offscreen.tts.streamError", {
        streamId,
        error: String(e && (e.message || e))
      });
    }
  } finally {
    try { if (player) await player.stop(); } catch {}
    if (current && current.streamId === streamId) current = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "offscreen.tts.stream") {
    streamAndPlay(msg.payload || {});
    sendResponse && sendResponse({ ok: true });
    return;
  }

  if (msg.type === "offscreen.tts.cancel") {
    const { streamId } = msg.payload || {};
    if (current && (!streamId || current.streamId === streamId)) {
      try { current.abort.abort(); } catch {}
    }
    sendResponse && sendResponse({ ok: true });
    return;
  }
});