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

// ----- TTS Proxy Server (simplified) -----
const TTS_SERVER = "http://127.0.0.1:9090";

chrome.runtime.onMessage.addListener((msg, sender) => {
  return (async () => {
    if (!msg || !msg.type) return { ok: false, error: "Invalid message" };

    if (msg.type === "tts.prepare") {
      console.log("sentences", msg.sentences);
      try {
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
        return { ok: true, manifest: j };
      } catch (err) {
        console.error("TTS prepare error:", err);
        return { ok: false, error: err.message };
      }
    }

    if (msg.type === "tts.fetchSegment") {
      try {
        const { manifestId, index } = msg;
        const url = `${TTS_SERVER}/audio/${manifestId}/${index}`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`Segment ${index}: ${r.status}`);
        // Return ArrayBuffer directly - this is key for proper transfer
        return await r.arrayBuffer();
      } catch (err) {
        console.error("TTS fetch error:", err);
        return { error: err.message };
      }
    }

    // Acknowledge control messages
    if (["tts.play", "tts.pause", "tts.stop", "tts.jumpTo"].includes(msg.type)) {
      return { ok: true };
    }

    return { ok: false, error: "Unknown message type" };
  })();
  // Note: No need for return true when returning a Promise
});