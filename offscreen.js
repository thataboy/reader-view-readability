let current = null; // { streamId, abort, player }

function uint8ToBase64(u8) {
  // Safe for modest sized segments, which you said you have.
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < u8.length; i += chunkSize) {
    const sub = u8.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

function readWavHeader(view) {
  // Expect at least 44 bytes for classic PCM WAV header
  if (view.byteLength < 44) return null;

  const riff = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
  );
  const wave = String.fromCharCode(
    view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)
  );
  if (riff !== "RIFF" || wave !== "WAVE") return null;

  const fmt = String.fromCharCode(
    view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15)
  );
  if (fmt !== "fmt ") return null;

  const audioFormat = view.getUint16(20, true);
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  // Assume data starts at 44 for PCM
  return {
    audioFormat,
    numChannels,
    sampleRate,
    bitsPerSample,
    dataOffset: 44
  };
}

class StreamingPcmPlayer {
  constructor({ sampleRate }) {
    const AudioCtx = self.AudioContext || self.webkitAudioContext;
    this.ctx = new AudioCtx({ latencyHint: "playback", sampleRate });
    this.queue = [];
    this.queueOffset = 0;
    this.samplesBuffered = 0;

    // ScriptProcessor is deprecated but simplest and works reliably in offscreen
    this.proc = this.ctx.createScriptProcessor(4096, 0, 1);
    this.proc.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      let written = 0;

      while (written < out.length) {
        if (this.queue.length === 0) {
          // underrun
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
    this.started = false;
    this.ended = false;
    this.onEnded = null;
  }

  async start() {
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    this.started = true;
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

async function streamAndPlay({ streamId, endpoint, body, signature, token, index }) {
  // Cancel any existing stream
  if (current) {
    try { current.abort.abort(); } catch {}
    try { await current.player.stop(); } catch {}
    current = null;
  }

  const abort = new AbortController();
  const allChunks = [];
  let allLen = 0;

  let headerBuf = new Uint8Array(0);
  let header = null;

  let leftover = new Uint8Array(0);

  // The server guarantees 24000 Hz s16le WAV, 1ch
  const player = new StreamingPcmPlayer({ sampleRate: 24000 });

  current = { streamId, abort, player };

  function sendToBackground(type, payload) {
    try { chrome.runtime.sendMessage({ type, payload }); } catch {}
  }

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal
    });

    if (!resp.ok) {
      throw new Error(`Stream HTTP ${resp.status} ${resp.statusText}`);
    }
    if (!resp.body) {
      throw new Error("Missing response body stream");
    }

    const reader = resp.body.getReader();

    // Start audio context now, actual audible output begins once queue has enough buffered
    await player.start();

    let notifiedPlaying = false;
    const startThresholdSec = 0.2;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      // Save for full WAV return
      allChunks.push(value);
      allLen += value.length;

      // Build header until parsed
      if (!header) {
        const combined = new Uint8Array(headerBuf.length + value.length);
        combined.set(headerBuf, 0);
        combined.set(value, headerBuf.length);
        headerBuf = combined;

        if (headerBuf.length >= 44) {
          const dv = new DataView(headerBuf.buffer, headerBuf.byteOffset, headerBuf.byteLength);
          header = readWavHeader(dv);
          if (!header) throw new Error("Invalid WAV header");

          // Validate what you said the server sends
          if (header.audioFormat !== 1) throw new Error("WAV not PCM");
          if (header.numChannels !== 1) throw new Error("WAV not mono");
          if (header.sampleRate !== 24000) throw new Error("Unexpected sample rate");
          if (header.bitsPerSample !== 16) throw new Error("Unexpected bits per sample");

          // Any bytes after header are audio data
          const afterHeader = headerBuf.subarray(header.dataOffset);
          headerBuf = headerBuf.subarray(0, header.dataOffset); // keep only header in headerBuf

          if (afterHeader.length > 0) {
            // fallthrough to data handling
            value = afterHeader;
          } else {
            continue;
          }
        } else {
          continue;
        }
      }

      // At this point, value is PCM bytes (may be reassigned above)
      let pcmBytes = value;

      if (leftover.length > 0) {
        const combined = new Uint8Array(leftover.length + pcmBytes.length);
        combined.set(leftover, 0);
        combined.set(pcmBytes, leftover.length);
        pcmBytes = combined;
        leftover = new Uint8Array(0);
      }

      // Ensure even number of bytes for int16
      if (pcmBytes.length % 2 === 1) {
        leftover = pcmBytes.subarray(pcmBytes.length - 1);
        pcmBytes = pcmBytes.subarray(0, pcmBytes.length - 1);
      }

      if (pcmBytes.length > 0) {
        const i16 = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2);
        const f32 = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) {
          f32[i] = i16[i] / 32768;
        }
        player.pushFloat32(f32);
      }

      if (!notifiedPlaying && player.bufferedSeconds() >= startThresholdSec) {
        notifiedPlaying = true;
        sendToBackground("offscreen.tts.streamPlaying", {
          streamId,
          index,
          signature,
          token
        });
      }
    }

    // Download finished, return full WAV to background
    const full = new Uint8Array(allLen);
    let off = 0;
    for (const c of allChunks) {
      full.set(c, off);
      off += c.length;
    }
    const base64 = uint8ToBase64(full);

    sendToBackground("offscreen.tts.streamAudioReady", { streamId, base64 });

    // Wait for playback to drain
    const waitDrain = async () => {
      // If we never hit threshold, still notify playing once we have anything
      if (!notifiedPlaying) {
        notifiedPlaying = true;
        sendToBackground("offscreen.tts.streamPlaying", {
          streamId,
          index,
          signature,
          token
        });
      }

      while (true) {
        if (abort.signal.aborted) return;
        if (player.queue.length === 0 && player.samplesBuffered <= 0) break;
        await new Promise(r => setTimeout(r, 25));
      }
    };

    await waitDrain();

    sendToBackground("offscreen.tts.streamEnded", {
      streamId,
      index,
      signature,
      token
    });

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
    try { await player.stop(); } catch {}
    if (current && current.streamId === streamId) current = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "offscreen.tts.stream") {
    streamAndPlay(msg.payload || {});
    // Fire and forget, results are delivered via runtime messages
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