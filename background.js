// ----- Reader View Injection -----

// track tabs whose overlay view is orphaned due to tab being closed or nevigated away
const orphaned = new Set();

async function injectAndToggle(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["readability.js"] });
    } catch {}
    await chrome.tabs.sendMessage(tabId, { type: "toggleReader" });
    orphaned.delete(tabId);
  } catch (e) {
    console.error("Reader View error:", e);
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab && tab.id) injectAndToggle(tab.id);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-reader" && tab && tab.id) injectAndToggle(tab.id);
});

const OFFSCREEN_URL = "offscreen.html";
let offscreenCreating = null;

async function ensureOffscreenDocument() {
  // Chrome allows only one offscreen document. Guard with hasDocument() to avoid race + errors.
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      const exists = await chrome.offscreen.hasDocument();
      if (exists) return;
    }
  } catch {
    // Ignore and fall through to create; older Chrome may not support hasDocument().
  }

  try {
    if (offscreenCreating) return offscreenCreating;

    offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: "Stream and play TTS audio using WebAudio in an offscreen document."
    });

    await offscreenCreating;
  } catch (e) {
    // If it already exists, ignore. Chrome may throw even if a doc exists due to races.
    const msg = String(e && (e.message || e));
    const lower = msg.toLowerCase();
    if (lower.includes("only a single offscreen document may be created") ||
        lower.includes("single offscreen document") ||
        lower.includes("already exists")) {
      return;
    }
    console.error("ensureOffscreenDocument failed:", e);
    throw e;
  } finally {
    offscreenCreating = null;
  }
}

async function hasOffscreen() {
  return chrome.offscreen.hasDocument();
}

// Best-effort cleanup when a tab is closed
chrome.tabs.onRemoved.addListener(async (tabId, _removeInfo) => {
  orphaned.add(tabId);
  if (await hasOffscreen()) {
    chrome.runtime.sendMessage({
      type: "offscreen.tts.cleanupTab",
      payload: { tabId }
    }).catch();
  }
});

// Stop TTS when a tab navigates
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  orphaned.add(details.tabId);
  if (await hasOffscreen()) {
    chrome.runtime.sendMessage({
      type: "offscreen.tts.cleanupTab",
      payload: { tabId: details.tabId },
    }).catch();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // Offscreen -> Background -> Content
  if (msg.type === "tts.forwardToTab") {
    (() => {
      const p = msg.payload || {};
      const tabId = p.tabId;

      // if overlay is orphaned, don't try to message it
      if (!tabId || orphaned.has(tabId)) return;

      chrome.tabs.sendMessage(tabId, { type: p.type, payload: p.payload }).catch();
      return;
    })();
  }

  const tabId = sender?.tab?.id;
  if (!tabId) return;
  orphaned.delete(tabId);

  // Content -> Background -> Offscreen
  if (msg.type === "tts.fetchWindow") {
    (async () => {
      try {
        await ensureOffscreenDocument();
        await chrome.runtime.sendMessage({
          type: "offscreen.tts.fetchWindow",
          payload: { tabId, ...(msg.payload || {}) }
        });
        sendResponse?.({ ok: true });
      } catch (e) {
        sendResponse?.({ ok: false, error: String(e && (e.message || e)) });
      }
    })();
    return true;
  }


  if (msg.type === "tts.stop") {
    (async () => {
      if (await hasOffscreen()) {
        chrome.runtime.sendMessage({
          type: "offscreen.tts.stop",
          payload: { tabId }
        }).catch();
      }
    })();
    return;
  }

  if (msg.type === "tts.cleanup") {
    (async () => {
      if (await hasOffscreen()) {
        chrome.runtime.sendMessage({
          type: "offscreen.tts.cleanup",
          payload: { tabId }
        }).catch();
      }
    })();
    return;
  }

  if (msg.type === "tts.listVoices" || msg.type === "tts.refreshVoices") {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const r = await chrome.runtime.sendMessage({
          type: `offscreen.${msg.type}`,
          payload: { tabId, ...(msg.payload || {}) }
        });
        sendResponse?.(r || { ok: false, error: "No response" });
      } catch (e) {
        sendResponse?.({ ok: false, error: String(e && (e.message || e)) });
      }
    })();
    return true;
  }
});
