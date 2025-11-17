// background.js
const Server = Object.freeze({
    MY_KOKORO: 0,
    VOX_ANE: 1,
    VOX_API: 2
});

// const server = Server.MY_KOKORO;
const server = Server.VOX_ANE;
// const server = Server.VOX_API;


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


const TTS_SERVER =  (server == Server.MY_KOKORO) ? "http://127.0.0.1:9090" :
                    (server == Server.VOX_ANE) ? "http://127.0.0.1:9000" :
                    "http://127.0.0.1:8000";

// Simple in-memory cache to avoid spamming the server
let __voicesCache = null;

async function fetchVoices() {
  if (__voicesCache) return __voicesCache;
  const pref = (server == Server.VOX_API) ? "v1/" : "";
  const r = await fetch(`${TTS_SERVER}/${pref}voices`);
  if (!r.ok) throw new Error(`/voices failed: ${r.status} ${r.statusText}`);
  const j = await r.json();
  // console.log(j);
  __voicesCache = (server == Server.MY_KOKORO) ? j :
                  (server == Server.VOX_ANE) ? j.voices :
                  j.voices.map(item => item.id);
  return __voicesCache;
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

function sanitize(text) {
  return text.replace(/[-()\[\]\|~`/]/g, ' ')
    .replace(/[\.\*\-]{3,}/g, '.').replace(/’/g, "'").replace(/[—:;]/g, ', ')
    // .replace(/[^\n\x20-\x7E]/g, ' ').replace(/ +/g, ' ').trim();
    .replace(/ +/g, ' ').trim();
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
        const list = await fetchVoices();
        sendResponse({ ok: true, voices: list });
        return;
      }

      if (msg.type === "tts.synthesize") {
        const { text, voice, speed, sample_rate = 24000, bitrate = 24000, vbr = "constrained" } = msg.payload || {};
        const r = (server == Server.MY_KOKORO) ?
        await fetch(`${TTS_SERVER}/synthesize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice, speed, sample_rate, bitrate, vbr })
        }) :
        (server == Server.VOX_ANE) ?
        await fetch(`${TTS_SERVER}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            "model": "voxcpm-0.5b",
            "input": sanitize(text),
            voice,
            "response_format": "wav"
          })
        }) :
        await fetch(`${TTS_SERVER}/v1/audio/speech`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Prompt-Speech-Enhancement": "False",
            "X-Text-Normalization": "True",
            "X-CFG-Value": "2.5",
            "X-Inference-Timesteps": "10"
          },
          body: JSON.stringify({
            "model": "tts-1",
            "input": text,
            voice,
            "response_format": "wav"
          })
        });
        if (!r.ok) throw new Error(`/synthesize failed: ${r.status} ${r.statusText}`);
        const buf = await r.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        sendResponse({ ok: true, base64: b64 });
        return;
      }

      // 3) No-op controls
      if (["tts.play", "tts.pause", "tts.stop", "tts.jumpTo"].includes(msg.type)) {
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (err) {
      console.error("TTS error:", err);
      // For segment fetches, the content side expects either ArrayBuffer or {error}
      sendResponse({ error: String(err?.message || err) });
    }
  })();

  // IMPORTANT: keep the service worker alive for the async work above
  return true;
});