// Reader View (Readability-only) with persisted font size + page width
// Assumes readability.js has been injected first so window.Readability exists.

(function () {
  if (window.__readerViewInstalled) return;
  window.__readerViewInstalled = true;

  // --------------------------
  // Storage helpers
  // --------------------------
  const STORAGE_KEY = "rv_prefs_v1";
  const defaults = { fontSize: 17, maxWidth: 860 };  // px
  async function loadPrefs() {
    try {
      const out = await chrome.storage.local.get(STORAGE_KEY);
      return { ...defaults, ...(out[STORAGE_KEY] || {}) };
    } catch {
      // fallback to page localStorage (not cross-site, but a backup)
      try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }; }
      catch { return { ...defaults }; }
    }
  }
  async function savePrefs(prefs) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: prefs });
    } catch {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch {}
    }
  }

  // --------------------------
  // Toggle hooks
  // --------------------------
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "toggleReader") toggle();
    });
  } catch (_) {}
  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "r") { e.preventDefault(); toggle(); }
  }, true);

  function setIcon(btn_id, file) {
    const btn = document.getElementById(btn_id)
    const img = btn && btn.querySelector("img");
    if (img) img.src = chrome.runtime.getURL(`icons/${file}`);
  }

  // --------------------------
  // UI + overlay
  // --------------------------
  function buildOverlay(articleHTML, title, byline) {
    const container = document.createElement("div");
    container.id = "reader-view-overlay";
    container.innerHTML = `
      <style>
        #reader-view-overlay { position: relative; z-index: 2147483647; }
        #rv-surface { position: fixed; inset: 0; overflow: auto; background: var(--rv-bg); color: var(--rv-fg);
          font: var(--rv-font-size, 17px)/1.7 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
        #rv-content { max-width: var(--rv-maxw, 860px); margin: 24px auto; padding: 4px 16px; }
        #rv-content img { max-width: 100%; height: auto; }
        #rv-content p { margin: 1em 0; white-space: normal; }
        #rv-content h1, #rv-content h2, #rv-content h3 { line-height: 1.25; margin: 1.2em 0 .6em; }
        #rv-content table { width: 100%; border-collapse: collapse; }
        #rv-content th, #rv-content td { border: 1px solid var(--rv-border); padding: 6px 8px; }
        :root { --rv-bg:#0b0d10; --rv-fg:#e6e8eb; --rv-border:#2b2f36; --rv-panel:#12151a; }
        @media (prefers-color-scheme: light) {
          :root { --rv-bg:#f8f9fb; --rv-fg:#101418; --rv-border:#dfe3e8; --rv-panel:#ffffff; }
        }
        /* Keep toolbar compact */
        #rv-toolbar {
          gap: 4px;
          font: 14px/1.2 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        }

        /* Make buttons hug their text and ignore page CSS */
        #rv-toolbar .rv-btn {
          all: unset;                 /* wipe inherited site styles */
          display: inline-flex;
          align-items: center;
          justify-content: center;

          /* your look */
          border: 1px solid var(--rv-border);
          border-radius: 8px;
          padding: 4px 8px;
          cursor: pointer;

          /* critical anti-stretch guards */
          width: auto !important;
          min-width: 0 !important;
          max-width: none !important;
          flex: 0 0 auto !important;
          box-sizing: border-box;
        }
        #rv-toolbar .rv-btn img {
          cursor: pointer;
          width: 22px; height: 22px;
          background: black;
          color: white;
        }

        /* Compact cluster for the middle controls */
        #rv-toolbar .rv-group {
          display: inline-flex;
          gap: 4px;
        }

        #rv-toolbar .rv-btn:focus-visible {
          outline: 2px solid var(--rv-border);
          outline-offset: 2px;
        }
        /* Sticky toolbar that stays at the top of the overlay's scroll */
        #rv-toolbar {
          position: sticky;
          top: 0;                        /* or: top: env(safe-area-inset-top); */
          z-index: 2;                    /* above article content */
          display: flex;
          flex-wrap: nowrap;
          align-items: center;
          gap: 4px;
          padding: 4px 10px;
          background: var(--rv-panel);
          border-bottom: 1px solid var(--rv-border);
          /* Help readability on images as you scroll */
          backdrop-filter: saturate(120%) blur(6px);
          -webkit-backdrop-filter: saturate(120%) blur(6px);
        }
        .rv-spacer {
          flex: 1 1 auto;           /* pushes “Reader View” label to the right */
          min-width: 0;
        }
        html.rv-active body > *:not(#reader-view-overlay) { user-select: none !important; -webkit-user-select: none !important; }
        /* Make #rv-surface the one true scroller and keep a stable gutter */
        #rv-surface {
          position: fixed;
          inset: 0;
          height: 100vh;
          overflow-y: scroll !important;     /* force this element to own the scrollbar */
          overflow-x: hidden !important;
          scrollbar-gutter: stable both-edges; /* reserve space so it never overlaps */
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
          z-index: 2147483647;
        }

        /* Custom scrollbar — WebKit/Blink */
        #rv-surface::-webkit-scrollbar {
          width: 12px;                       /* tweak as you like */
          background: transparent;
        }
        #rv-surface::-webkit-scrollbar-track {
          background: transparent;           /* or var(--rv-panel) */
          border-left: 1px solid var(--rv-border);
        }
        #rv-surface::-webkit-scrollbar-thumb {
          background: #888;
          border-radius: 8px;
          border: 1px solid #666;
          background-clip: content-box;
        }
        #rv-surface::-webkit-scrollbar-thumb:hover {
          background: #8a9099;               /* slightly lighter on hover */
          background-clip: content-box;
        }
        #rv-surface::-webkit-scrollbar-corner {
          background: transparent;
        }
        /* Lock background page to avoid double scrollbar (keep this) */
        html.rv-active, html.rv-active body {
          overflow: hidden !important;
        }
      </style>
      <div id="rv-surface" role="dialog" aria-label="Reader View" tabindex="-1">
        <div id="rv-toolbar">
          <button class="rv-btn" id="rv-close"><img></button>
          <span class="rv-group">
            <button class="rv-btn" id="rv-font-inc"><img></button>
            <button class="rv-btn" id="rv-font-dec"><img></button>
            <button class="rv-btn" id="rv-width-widen"><img></button>
            <button class="rv-btn" id="rv-width-narrow"><img></button>
          </span>
          <div class="rv-spacer">
            <div id="rv-tts" style="margin-left:20px;display:flex;gap:6px;align-items:center">
              <select id="rv-voice" title="Voice"></select>
              <label class="rv-inline" title="Speed">
                <input
                  id="rv-speed"
                  type="range"
                  min="0.7"
                  max="1.5"
                  step="0.05"
                  value="1.0"
                  style="width:120px"
                />
              </label>
              <button class="rv-btn" id="rv-tts-play" title="Speak"><img></button>
              <button class="rv-btn" id="rv-tts-pause" title="Pause"><img></button>
              <button class="rv-btn" id="rv-tts-stop" title="Stop"><img></button>
              <button class="rv-btn" id="rv-tts-up" title="Prev paragraph"><img></button>
              <button class="rv-btn" id="rv-tts-prev" title="Prev sentence"><img></button>
              <button class="rv-btn" id="rv-tts-next" title="Next sentence"><img></button>
              <button class="rv-btn" id="rv-tts-down" title="Next paragraph"><img></button>
            </div>
          </div>
          <label style="font-size:.9em">Reader View</label>
        </div>
        <div id="rv-content">
          ${title ? `
          <h1>${title}</h1>
          ` : ""} ${byline ? `
          <p><em>${byline}</em></p>
          ` : ""}
          <div id="rv-article-body">${articleHTML}</div>
        </div>
      </div>
    `;
    return container;
  }

  function attachOverlay(container, prefs) {
    const prior = document.getElementById("reader-view-overlay");
    if (prior) prior.remove();

    const surface = container.querySelector("#rv-surface");
    const contentHost = container.querySelector("#rv-content");

    // apply saved prefs
    applyPrefs(surface, contentHost, prefs);

    const findSelectionTarget = () =>
      contentHost.querySelector("#rv-article-body") ||
      contentHost;

    document.documentElement.classList.add("rv-active");
    const outside = Array.from(document.body.children).filter(n => n !== container);
    outside.forEach(n => { try { n.setAttribute("inert", ""); } catch(_){} });

    let current = { ...prefs };

    const selectTarget = () => {
      const target = findSelectionTarget();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      sel.removeAllRanges();
      sel.addRange(range);
    };

    function cleanup() {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("copy", onCopy, true);
      outside.forEach(n => { try { n.removeAttribute("inert"); } catch(_){} });
      document.documentElement.classList.remove("rv-active");
      container.remove();
    }

    function onKey(e) {
      const accel = (e.metaKey || e.ctrlKey);
      if (accel && e.key.toLowerCase() === "a") { e.preventDefault(); selectTarget(); }
      if (e.key === "Escape") cleanup();
      if (e.altKey && (e.key === "+" || e.key === "=")) { // font bigger
        current.fontSize = Math.min(32, current.fontSize + 1);
        applyPrefs(surface, contentHost, current);
        savePrefs(current);
      }
      if (e.altKey && (e.key === "-" || e.key === "_")) { // font smaller
        current.fontSize = Math.max(12, current.fontSize - 1);
        applyPrefs(surface, contentHost, current);
        savePrefs(current);
      }
    }

    function onCopy(e) {
      const host = contentHost;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) return; // let normal copy outside
      e.preventDefault();
      const div = document.createElement("div");
      div.appendChild(range.cloneContents());
      e.clipboardData.setData("text/plain", sel.toString());
      e.clipboardData.setData("text/html", div.innerHTML);
    }

    // Toolbar handlers
    container.querySelector("#rv-close").addEventListener("click", cleanup);
    surface.addEventListener("click", (e) => { if (e.target === surface) cleanup(); });

    container.querySelector("#rv-font-inc").addEventListener("click", () => {
      current.fontSize = Math.min(32, current.fontSize + 1);
      applyPrefs(surface, contentHost, current); savePrefs(current);
    });
    container.querySelector("#rv-font-dec").addEventListener("click", () => {
      current.fontSize = Math.max(12, current.fontSize - 1);
      applyPrefs(surface, contentHost, current); savePrefs(current);
    });
    container.querySelector("#rv-width-widen").addEventListener("click", () => {
      current.maxWidth = Math.min(1400, current.maxWidth + 40);
      applyPrefs(surface, contentHost, current); savePrefs(current);
    });
    container.querySelector("#rv-width-narrow").addEventListener("click", () => {
      current.maxWidth = Math.max(520, current.maxWidth - 40);
      applyPrefs(surface, contentHost, current); savePrefs(current);
    });

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("copy", onCopy, true);
    document.documentElement.appendChild(container);
    surface.focus();
  }

  function applyPrefs(surface, contentHost, prefs) {
    surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
    contentHost.style.setProperty("--rv-maxw", `${prefs.maxWidth}px`);
  }

  async function toggle() {
    const existing = document.getElementById("reader-view-overlay");
    if (existing) { existing.querySelector("#rv-close")?.click(); return; }
    if (!window.Readability) { console.error("Readability not found. Inject readability.js first."); return; }

    const prefs = await loadPrefs();

    const dom = new DOMParser().parseFromString(
      "<!doctype html>" + document.documentElement.outerHTML,
      "text/html"
    );
    const article = new window.Readability(dom).parse();
    if (!article || !article.content) { console.warn("Readability returned no content."); return; }

    const overlay = buildOverlay(article.content, article.title, article.byline);
    attachOverlay(overlay, prefs);
    setIcon("rv-close", "logout.png");
    setIcon("rv-font-inc", "text_increase.png");
    setIcon("rv-font-dec", "text_decrease.png");
    setIcon("rv-width-widen", "widen.png");
    setIcon("rv-width-narrow", "shrink.png");
    setIcon("rv-tts-play", "speak.png");
    setIcon("rv-tts-pause", "pause.png");
    setIcon("rv-tts-stop", "stop.png");
    setIcon("rv-tts-up", "pprev.png");
    setIcon("rv-tts-prev", "prev.png");
    setIcon("rv-tts-next", "next.png");
    setIcon("rv-tts-down", "nnext.png");
    const contentHost=document.querySelector("#rv-content");
    if (overlay&&contentHost) setupStaticTTSControls(overlay, contentHost);
  }
})();
// ---- TTS state ----
let ttsState = { prepared:false, manifestId:null, voice:"af_sky", speed:1.0, sentences:[], paraIndexBySentence:[], activeIndex:-1 };

function segmentSentences(rootEl) {
  const seg = (typeof Intl !== "undefined" && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: "sentence" }) : null;
  const out = []; const paraMap = [];
  const paras = Array.from(rootEl.querySelectorAll("p,li,blockquote,h1,h2,h3,h4,h5,h6"));
  let idx = 0;
  paras.forEach((el, pIndex) => {
    const text = (el.innerText || "").trim(); if (!text) return;
    const sentences = seg ? Array.from(seg.segment(text)).map(s => s.segment.trim()).filter(Boolean)
                          : text.split(/(?<=[\.\!\?]['"”’\)]*)\s+/).filter(Boolean);
    sentences.forEach(s => { out.push({ i: idx, text: s, pIndex, el }); paraMap.push(pIndex); idx++; });
  });
  return { sentences: out, paraIndexBySentence: paraMap };
}


function setupStaticTTSControls(overlay, contentHost){
  const voiceSel = overlay.querySelector("#rv-voice");
  const speedInp = overlay.querySelector("#rv-speed");
  const btnPlay  = overlay.querySelector("#rv-tts-play");
  const btnPause = overlay.querySelector("#rv-tts-pause");
  const btnStop  = overlay.querySelector("#rv-tts-stop");
  const btnPrev  = overlay.querySelector("#rv-tts-prev");
  const btnNext  = overlay.querySelector("#rv-tts-next");
  if (!voiceSel || !speedInp) return;
  voiceSel.innerHTML = "";
  const TTS_VOICES = ["af_sky","am_liam","af_alloy","af_aria","am_michael","af_nicole"];
  TTS_VOICES.forEach(v => { const o=document.createElement("option"); o.value=v; o.textContent=v; voiceSel.appendChild(o); });
  voiceSel.value = ttsState.voice;
  voiceSel.onchange = () => { ttsState.voice = voiceSel.value; ttsState.prepared = false; };
  speedInp.oninput  = () => { ttsState.speed = parseFloat(speedInp.value); ttsState.prepared = false; };
  function ensurePrepared() {
    if (ttsState.prepared && ttsState.manifestId) return Promise.resolve(true);
    const { sentences, paraIndexBySentence } = segmentSentences(contentHost);
    if (!sentences.length) return Promise.resolve(false);
    ttsState.sentences = sentences; ttsState.paraIndexBySentence = paraIndexBySentence;
    return new Promise((res) => {
      chrome.runtime.sendMessage({
        type: "tts.prepare",
        voice: ttsState.voice,
        speed: ttsState.speed,
        sentences: sentences.map(s => ({ i: s.i, text: s.text }))
      }, (resp) => { if (resp && resp.ok) { ttsState.manifestId = resp.manifestId; ttsState.prepared = true; res(true); } else { res(false); } });
    });
  }
  function highlight(i){
    if (ttsState.activeIndex === i) return;
    if (ttsState.activeIndex >= 0) {
      const prev = ttsState.sentences[ttsState.activeIndex];
      prev?.el?.classList?.remove("rv-tts-active");
    }
    ttsState.activeIndex = i;
    const cur = ttsState.sentences[i];
    if (cur?.el) { cur.el.classList.add("rv-tts-active"); cur.el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }
  btnPlay.onclick = async () => {
    const ok = await ensurePrepared();
    if (!ok) return;
    const startIndex = Math.max(0, ttsState.activeIndex);
    chrome.runtime.sendMessage({ type: "tts.play", startIndex });
  };
  btnPause.onclick = () => chrome.runtime.sendMessage({ type: "tts.pause" });
  btnStop.onclick  = () => chrome.runtime.sendMessage({ type: "tts.stop"  });
  btnPrev.onclick = () => { const idx = Math.max(0, (ttsState.activeIndex >= 0 ? ttsState.activeIndex : 0) - 1); chrome.runtime.sendMessage({ type: "tts.jumpTo", index: idx }); };
  btnNext.onclick = () => { const idx = Math.min(ttsState.sentences.length - 1, (ttsState.activeIndex >= 0 ? ttsState.activeIndex : -1) + 1); chrome.runtime.sendMessage({ type: "tts.jumpTo", index: idx }); };
  contentHost.addEventListener("click", (e) => {
    const p = e.target.closest("p,li,blockquote,h1,h2,h3,h4,h5,h6"); if (!p || !ttsState.sentences.length) return;
    const found = ttsState.sentences.find(s => s.el === p) || ttsState.sentences.find(s => s.el && s.el.contains(p));
    if (found) chrome.runtime.sendMessage({ type: "tts.jumpTo", index: found.i });
  }, true);
  try { chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === "tts.positionChanged") highlight(msg.payload.index); }); } catch (_){}
}
;
