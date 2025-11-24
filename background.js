const Server = Object.freeze({
    MY_KOKORO: 1,
    VOX_ANE: 2
});

// ----- Reader View Injection (unchanged) -----
async function injectAndToggle(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["readability.js"] });
    } catch (_) {}
    await chrome.tabs.sendMessage(tabId, { type: "toggleReader" });
  } catch (e) {
    console.error("Reader View error:", e);
  }
}
chrome.action.onClicked.addListener(async (tab) => { if (tab && tab.id) injectAndToggle(tab.id); });
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-reader" && tab && tab.id) injectAndToggle(tab.id);
});


const TTS_SERVER = new Map([
  [Server.MY_KOKORO, 'http://127.0.0.1:9090'],
  [Server.VOX_ANE, 'http://127.0.0.1:9000']
]);

// Simple in-memory cache to avoid spamming the server
let __voicesCache = new Map();

async function fetchVoices(server) {
  const v = __voicesCache.get(server);
  if (v) return v;
  const r = await fetch(`${TTS_SERVER.get(server)}/voices`);
  if (!r.ok) throw new Error(`/voices failed: ${r.status} ${r.statusText}`);
  const j = await r.json();
  __voicesCache.set(server, j.voices);
  return j.voices;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // The btoa() function creates a Base64-encoded ASCII string
  return btoa(binary);
}

// Convert raw 16-bit PCM mono to a minimal WAV ArrayBuffer
function pcmBytesToWav(pcmBytes, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBytes.byteLength;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let offset = 0;

  function writeString(s) {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset++, s.charCodeAt(i));
    }
  }

  // RIFF header
  writeString('RIFF');
  view.setUint32(offset, 36 + dataSize, true); offset += 4;
  writeString('WAVE');

  // fmt chunk
  writeString('fmt ');
  view.setUint32(offset, 16, true); offset += 4;          // Subchunk1Size (16 for PCM)
  view.setUint16(offset, 1, true); offset += 2;           // AudioFormat (1 = PCM)
  view.setUint16(offset, numChannels, true); offset += 2; // NumChannels
  view.setUint32(offset, sampleRate, true); offset += 4;  // SampleRate
  view.setUint32(offset, byteRate, true); offset += 4;    // ByteRate
  view.setUint16(offset, blockAlign, true); offset += 2;  // BlockAlign
  view.setUint16(offset, bitsPerSample, true); offset += 2; // BitsPerSample

  // data chunk
  writeString('data');
  view.setUint32(offset, dataSize, true); offset += 4;

  // PCM data
  const outBytes = new Uint8Array(buffer, 44);
  outBytes.set(pcmBytes);

  return buffer;
}

// fix a bunch of weird quirks with VoxCPM
function sanitize(text) {
  text = text?.trim();
  if (!text) return null;
  return text
    .replace(/[()[\]|~`/]/g, ' ')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/(\.|\*|\-){3,}/g, ' ')
    // .replace(/[—:;]/g, ', ')
    // .replace(/[^\n\x20-\x7E]/g, ' ').replace(/ +/g, ' ').trim();
    .replace(/([,.])\s*[.,]/g, '$1 ')
    .replace(/^[,.]\s*/, '')
    .replace(/(\s*(\.))+$/, '$1')
    .replace(/(\s*,)+$/, '')
    .replace(/\s+([,.])/g, '$1')
    .replace(/([.,])["”’')\]]$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: "Invalid message" });
    return; // no async work to keep alive
  }

  // Wrap async logic so we can return true below
  (async () => {
    try {
      if (msg.type === "tts.listVoices") {
        const { server } = msg.payload;
        const list = await fetchVoices(server);
        sendResponse({ ok: true, voices: list });
        return;
      }

      if (msg.type === "tts.synthesize") {
        const { text, voice, speed, server } = msg.payload || {};
        let input = (server == Server.VOX_ANE) ? sanitize(text) : text?.trim();
        if (!input || server == Server.VOX_ANE && input.length < 5) {
          sendResponse({ error: '/synthesize failed: Text empty or too short' });
          return;
        }

        let r;
        if (server == Server.MY_KOKORO) {
          r = await fetch(`${TTS_SERVER.get(server)}/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input, voice, speed })
          });
        } else { // if (server == Server.VOX_ANE) {
          r = await fetch(`${TTS_SERVER.get(server)}/v1/audio/speech/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "voxcpm-0.5b",
              input,
              voice,
              inference_timesteps: 10,
              response_format: "pcm"
            })
          });
        }

        if (!r.ok) {
          sendResponse({ error: `/synthesize failed: ${r.status} ${r.statusText}` });
          return;
        }

        const sampleRateHeader = r.headers.get("X-Sample-Rate");
        const sampleRate = sampleRateHeader ? parseInt(sampleRateHeader, 10) : 24000;

        const reader = r.body && r.body.getReader ? r.body.getReader() : null;
        if (!reader) {
          sendResponse({ error: "/synthesize failed: streaming body not available" });
          return;
        }

        const chunks = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length) {
            chunks.push(value);
            total += value.length;
          }
        }

        if (!total) {
          sendResponse({ error: "/synthesize failed: empty audio stream" });
          return;
        }

        const pcmBytes = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          pcmBytes.set(c, offset);
          offset += c.length;
        }

        const wavBuffer = pcmBytesToWav(pcmBytes, sampleRate);
        const b64 = arrayBufferToBase64(wavBuffer);
        sendResponse({ ok: true, base64: b64 });
        return;
      }

      if (msg.type === "tts.cancel") {
        const { server } = msg.payload;
        try {
          fetch(`${TTS_SERVER.get(server)}/v1/audio/speech/cancel`, { method: "POST" });
        } catch {}
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "tts.warmup") {
        const { voice } = msg.payload;
        fetch(`${TTS_SERVER.get(Server.VOX_ANE)}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            "model": "voxcpm-0.5b",
            "input": "Okey dokey.",
            voice,
            "inference_timesteps": 10,
            "response_format": "wav"
          })
        });
        sendResponse({ ok: true });
        return;
      }

      // No-op controls
      if (["tts.play", "tts.pause", "tts.stop", "tts.jumpTo"].includes(msg.type)) {
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (err) {
      sendResponse({ error: String(err?.message || err) });
    }
  })();

  // IMPORTANT: keep the service worker alive for the async work above
  return true;
});