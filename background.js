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
      if (msg.type === "tts.synthesizeOne") {
        const { text, voice, speed, sample_rate = 24000, bitrate = 24000, vbr = "constrained" } = msg.payload || {};
        if (!text) throw new Error("Missing text");

        const r = await fetch("http://127.0.0.1:9090/synthesize_one", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice, speed, sample_rate, bitrate, vbr })
        });
        if (!r.ok) throw new Error(`/synthesize_one failed: ${r.status} ${r.statusText}`);

        const j = await r.json();
        let url = j?.url;
        if (!url) throw new Error("No URL returned");

        // If server returns relative URL, make it absolute
        if (url.startsWith("/")) url = `http://127.0.0.1:9090${url}`;

        // Fetch the audio bytes so content.js can stay the same (base64→ArrayBuffer→decode)
        const audioRes = await fetch(url, { cache: "no-store" });
        if (!audioRes.ok) throw new Error(`Fetch audio failed: ${audioRes.status} ${audioRes.statusText}`);
        const buf = await audioRes.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);

        sendResponse({ ok: true, base64: b64 });
        return;
      }

      // 1) Prepare a batch
      if (msg.type === "tts.prepare") {
        const r = await fetch(`${TTS_SERVER}/synthesize_batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            voice: msg.voice,
            speed: msg.speed,
            sample_rate: 24000,
            bitrate: 24000,
            vbr: "constrained",
            sentences: msg.sentences
          })
        });
        if (!r.ok) throw new Error(`Server ${r.status}: ${r.statusText}`);
        const j = await r.json();

        await chrome.storage.session.set({
          [`tts_manifest_${j.manifest_id}`]: JSON.stringify(j)
        });

        sendResponse({ ok: true, manifest: j });
        return;
      }

      // 2) Fetch a single audio segment as a raw ArrayBuffer
      if (msg.type === "tts.fetchSegment") {
        const url = `${TTS_SERVER}/audio/${msg.manifestId}/${msg.index}`;
        console.log(`fetching ${url}`);
        const r = await fetch(url, { cache: "no-store" });
        console.log(`fetching response ${r.ok}`);
        if (!r.ok) throw new Error(`Segment ${msg.index}: ${r.status} ${r.statusText}`);
        const buf = await r.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        console.log('b64', b64);
        sendResponse({base64: b64});
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