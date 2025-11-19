// background.js
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

function sanitize(text) {
  if (!text) return null;
  return text.replace(/[–()[\]|~`‘“”/!]/g, ' ')
    .replace(/(\.|\*|\-){3,}/g, '.').replace(/’/g, "'").replace(/[—:;]/g, ', ')
    // .replace(/[^\n\x20-\x7E]/g, ' ').replace(/ +/g, ' ').trim();
    .replace(/\s+/g, ' ')
    .replace(/([,.])\s*[.,]/g, '$1 ')
    .replace(/\s*([,.])/g, '$1').trim()
    .replace(/^[,.]\s*/, '').replace(/(\s*[,.]\s*)+$/, '.');
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
          return
        }
        const r = (server == Server.MY_KOKORO) ?
        await fetch(`${TTS_SERVER.get(server)}/synthesize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input, voice, speed })
        }) :
        await fetch(`${TTS_SERVER.get(server)}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            "model": "voxcpm-0.5b",
            input,
            voice,
            "response_format": "opus"
          })
        });
        if (!r.ok) {
          sendResponse({ error: `/synthesize failed: ${r.status} ${r.statusText}` });
          return;
        }
        const buf = await r.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        sendResponse({ ok: true, base64: b64 });
        return;
      }

      if (msg.type === "tts.cancel") {
        const { server } = msg.payload;
        fetch(`${TTS_SERVER.get(server)}/v1/audio/speech/cancel`, { method: "POST" });
        sendResponse({ ok: true });
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