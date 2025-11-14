// background.js

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

// background.js

const TTS_SERVER = "http://127.0.0.1:9090";

// Simple in-memory cache to avoid spamming the server
let __voicesCache = null;

async function fetchVoices() {
  if (__voicesCache) return __voicesCache;
  const r = await fetch(`${TTS_SERVER}/voices`, { cache: "no-store" });
  if (!r.ok) throw new Error(`/voices failed: ${r.status} ${r.statusText}`);
  const j = await r.json();
  __voicesCache = j;
  return j;
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
        if (!text) throw new Error("Missing text");

        const r = await fetch(`${TTS_SERVER}/synthesize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice, speed, sample_rate, bitrate, vbr })
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