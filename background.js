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

const TTS_SERVER = "http://127.0.0.1:9090";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: "Invalid message" });
    return; // no async work
  }

  // Wrap async logic so we can return true below
  (async () => {
    try {
      if (msg.type === "tts.prepare") {
        console.log("sending batch");
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
        console.log("batch resp", j);

        await chrome.storage.session.set({
          [`tts_manifest_${j.manifest_id}`]: JSON.stringify(j)
        });

        console.log("batch stored");
        sendResponse({ ok: true, manifest: j });
        return;
      }

      if (msg.type === "tts.fetchSegment") {
        const url = `${TTS_SERVER}/audio/${msg.manifestId}/${msg.index}`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`Segment ${msg.index}: ${r.status}`);
        const buf = await r.arrayBuffer();
        // Send the raw ArrayBuffer back to the content script
        sendResponse(buf);
        return;
      }

      if (["tts.play", "tts.pause", "tts.stop", "tts.jumpTo"].includes(msg.type)) {
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (err) {
      console.error("TTS error:", err);
      // For segment fetches, the content side expects either ArrayBuffer or {error}
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();

  // Keep the service worker alive until sendResponse is called
  return true;
});
