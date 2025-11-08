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

// ===== TTS (local server, WebAudio, in-memory) =====
const TTS_SERVER = "http://127.0.0.1:9090";

const tts = {
  audioCtx: null,
  manifestId: null,
  segments: [],
  index: 0,
  playing: false,
  decoded: new Map(),
  compressed: new Map(),
  prefetchAhead: 3,
  keepBehind: 1,
};

function ttsKey(i){ return `${tts.manifestId}:${i}`; }
function ttsUrl(i){ const seg = tts.segments[i]; return seg ? (TTS_SERVER + seg.url) : null; }
function ensureCtx(){
  if (!tts.audioCtx || tts.audioCtx.state === "closed") {
    tts.audioCtx = new (self.AudioContext || self.webkitAudioContext)({ sampleRate: 24000 });
  }
  return tts.audioCtx;
}
async function fetchCompressed(i){
  const k = ttsKey(i);
  if (tts.compressed.has(k)) return tts.compressed.get(k);
  const url = ttsUrl(i); if (!url) throw new Error("no url");
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch ${i} failed`);
  const buf = await r.arrayBuffer();
  tts.compressed.set(k, buf);
  return buf;
}
async function decodeBuffer(i){
  const k = ttsKey(i);
  if (tts.decoded.has(k)) return tts.decoded.get(k);
  const buf = await fetchCompressed(i);
  const ctx = ensureCtx();
  const ab = await ctx.decodeAudioData(buf.slice(0));
  tts.decoded.set(k, ab);
  return ab;
}
function sendToTab(type, payload){
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type, payload });
  });
}
async function scheduleAt(index){
  tts.index = index;
  const ctx = ensureCtx();
  const cur = await decodeBuffer(index);
  const src = ctx.createBufferSource();
  src.buffer = cur;
  src.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.12;
  src.start(t0);
  tts.playing = true;
  sendToTab("tts.stateChanged", "playing");
  sendToTab("tts.positionChanged", { index });
  const start = Math.max(0, index - tts.keepBehind);
  const end = Math.min(tts.segments.length - 1, index + tts.prefetchAhead);
  for (let i = start; i <= end; i++) decodeBuffer(i).catch(()=>{});
  for (const k of Array.from(tts.decoded.keys())) {
    const idx = parseInt(k.split(":")[1], 10);
    if (idx < index - tts.keepBehind - 2) tts.decoded.delete(k);
  }
  src.onended = () => {
    if (!tts.playing) return;
    const next = index + 1;
    if (next < tts.segments.length) scheduleAt(next);
    else { tts.playing = false; sendToTab("tts.stateChanged", "stopped"); }
  };
}
function stopPlayback(state="stopped"){
  if (tts.audioCtx && tts.audioCtx.state !== "closed") { try { tts.audioCtx.close(); } catch {} }
  tts.audioCtx = null; tts.playing = false; sendToTab("tts.stateChanged", state);
}
chrome.runtime.onMessage.addListener((msg, _s, respond) => {
  (async () => {
    if (!msg || !msg.type) return;
    if (msg.type === "tts.prepare") {
      const r = await fetch(`${TTS_SERVER}/synthesize_batch`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: msg.voice, speed: msg.speed, sample_rate: 24000, bitrate: 24000, vbr: "constrained", sentences: msg.sentences })
      });
      if (!r.ok) throw new Error("batch synth failed");
      const j = await r.json();
      tts.manifestId = j.manifest_id; tts.segments = j.segments;
      tts.decoded.clear(); tts.compressed.clear();
      respond?.({ ok:true, manifestId: tts.manifestId, count: tts.segments.length });
      sendToTab("tts.ready", { manifestId: tts.manifestId });
      return;
    }
    if (msg.type === "tts.play")  { await scheduleAt(msg.startIndex ?? 0); respond?.({ ok:true }); return; }
    if (msg.type === "tts.pause") { stopPlayback("paused"); respond?.({ ok:true }); return; }
    if (msg.type === "tts.stop")  { stopPlayback("stopped"); respond?.({ ok:true }); return; }
    if (msg.type === "tts.jumpTo"){ stopPlayback("jump"); await scheduleAt(msg.index); respond?.({ ok:true }); return; }
  })().catch(err => { console.error("TTS error:", err); sendToTab("tts.error", { message: String(err) }); respond?.({ ok:false, error: String(err) }); });
  return true;
});
