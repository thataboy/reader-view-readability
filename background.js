async function injectAndToggle(tabId) {
  try {
    // Always inject content + (if available) readability.js
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    // Try to inject bundled readability.js (no-op if missing)
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
