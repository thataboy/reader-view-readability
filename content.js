// content.js
(function () {
  if (window.__readerViewInstalled) return;
  window.__readerViewInstalled = true;

  // --------------------------
  // Storage helpers
  // --------------------------
  const STORAGE_KEY = "rv_prefs_v1";
  const defaults = { fontSize: 17, maxWidth: 860 };
  async function loadPrefs() {
    try {
      const out = await chrome.storage.local.get(STORAGE_KEY);
      return { ...defaults, ...(out[STORAGE_KEY] || {}) };
    } catch {
      try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }; }
      catch { return { ...defaults }; }
    }
  }
  async function savePrefs(prefs) {
    try { await chrome.storage.local.set({ [STORAGE_KEY]: prefs }); }
    catch { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch {} }
  }

  // --------------------------
  // TTS Playback State (moved from background)
  // --------------------------
  const tts = {
    audioCtx: null,
    manifestId: null,
    segments: [],
    texts: [],
    index: 0,
    playing: false,
    decoded: new Map(),
    inFlight: new Set(),
    currentSrc: null,
    playToken: 0,
    prefetchAhead: 4,
    keepBehind: 1,
    statusEl: null,
    meta: [],            // [{el,start,end}] parallel to tts.texts[index]
    highlightSpan: null, // active <span> wrapper for current sentence
  };

  // Voice list
  const TTS_VOICES = [
    "af_heart",
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
    "bf_alice",
    "bf_emma",
    "bf_isabella",
    "bf_lily",
    "bm_daniel",
    "bm_fable",
    "bm_george",
    "bm_lewis",
    "ff_siwis"
  ];

  function ttsKey(i){ return `seg:${i}`; }
  // function ttsKey(i){ return `${tts.manifestId}:${i}`; }
  function ensureCtx() {
    if (!tts.audioCtx || tts.audioCtx.state === "closed") {
      tts.audioCtx = new (AudioContext || webkitAudioContext)({ sampleRate: 24000 });
    }
    return tts.audioCtx;
  }

  // Show status message to user
  function setStatus(msg) {
    if (tts.statusEl) tts.statusEl.textContent = msg;
    console.log(msg);
  }

  function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    // Return the underlying ArrayBuffer
    return bytes.buffer;
  }

  // Decode Opus ArrayBuffer to AudioBuffer
  async function decodeBuffer(i, arrayBuffer) {
    const k = ttsKey(i);
    if (tts.decoded.has(k)) return tts.decoded.get(k);
    const ctx = ensureCtx();
    const ab = await ctx.decodeAudioData(arrayBuffer.slice(0));
    tts.decoded.set(k, ab);
    return ab;
  }

  // Fetch + decode a segment through background proxy
  async function fetchAndDecodeSegment(i) {
    try {
      // If already decoded, return it
      const k = ttsKey(i);
      if (tts.decoded.has(k)) return tts.decoded.get(k);
      // If a fetch for this index is already running, let that one finish
      if (tts.inFlight.has(i)) {
        // Busy-wait with micro-pauses until decoded is populated or inFlight clears
        while (tts.inFlight.has(i) && !tts.decoded.has(k)) {
          await new Promise(r => setTimeout(r, 10));
        }
        if (tts.decoded.has(k)) return tts.decoded.get(k);
      }
      tts.inFlight.add(i);
      console.log(`Converting ${i + 1}/${tts.segments.length}...`);
      const response = await chrome.runtime.sendMessage({
        type: "tts.synthesizeOne",
        payload: {
          text: tts.texts[i],
          voice: ttsUIState.voice,
          speed: ttsUIState.speed,
          sample_rate: 24000,
          bitrate: 24000,
          vbr: "constrained",
        }
      });

      if (!response?.ok) throw new Error(response?.error || "Synthesis failed");
      const buf = base64ToArrayBuffer(response.base64);
      const ab = await decodeBuffer(i, buf);
      return ab;
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      throw err;
    } finally {
      tts.inFlight.delete(i);
    }
  }
  // Main playback scheduler
  async function scheduleAt(index) {
    if (!tts.playing || !tts.segments.length) return;

    tts.index = index;
    const ctx = ensureCtx();

    // Resume context if needed (user gesture requirement)
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    try {
      const token = ++tts.playToken;
      const curP = fetchAndDecodeSegment(index);     // start fetch/decode
      const src = ctx.createBufferSource();          // create node early
      tts.currentSrc = src;

      highlightCurrent(index);

      // Attach onended BEFORE any await so we never miss it
      src.onended = () => {
        if (!tts.playing || token !== tts.playToken) return;
        tts.playToken = 0;
        tts.index = 0;
        tts.currentSrc = null;
        const next = index + 1;
        if (next < tts.segments.length) scheduleAt(next);
        else {
          tts.playing = false;
          setStatus("Finished");
          chrome.runtime.sendMessage({ type: "tts.stateChanged", payload: "stopped" });
        }
      };

      // Now await audio, set buffer, and start
      const cur = await curP;
      src.buffer = cur;
      src.connect(ctx.destination);
      const t0 = ctx.currentTime + 0.12;
      src.start(t0);
      tts.playing = true;

      setStatus(`Playing ${index + 1} / ${tts.segments.length}`);
      chrome.runtime.sendMessage({
        type: "tts.positionChanged",
        payload: { index }
      });

      // Prefetch without blocking the onended attachment/playback
      (async () => {
        const start = Math.max(0, index + 1);
        const end = Math.min(tts.segments.length - 1, index + tts.prefetchAhead);
        const fetches = [];
        for (let i = start; i <= end; i++) {
          if (!tts.decoded.has(ttsKey(i)) && !tts.inFlight.has(i)) {
            fetches.push(fetchAndDecodeSegment(i).catch(() => {}));
          }
        }
        await Promise.all(fetches);
        // Cleanup only far-behind buffers
        for (const k of Array.from(tts.decoded.keys())) {
          const idx = parseInt(k.split(":")[1], 10);
          if (Number.isFinite(idx) && idx < index - (tts.keepBehind + 3)) {
            tts.decoded.delete(k);
          }
        }
      })().catch(() => {});

    } catch (err) {
      console.error("Playback error:", err);
      setStatus(`Playback failed: ${err.message}`);
      tts.playing = false;
    }
  }

  function stopPlayback(state = "stopped") {
    if (tts.audioCtx && tts.audioCtx.state !== "closed") {
      try { tts.audioCtx.close(); } catch {}
    }
    tts.audioCtx = null;
    tts.playing = false;
    setStatus(state === "stopped" ? "Ready" : "Paused");
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
    const btn = document.getElementById(btn_id);
    const img = btn && btn.querySelector("img");
    if (img) img.src = chrome.runtime.getURL(`icons/${file}`);
  }

  function addTTSHighlightStyle() {
    if (document.getElementById("rv-tts-style")) return;
    const st = document.createElement("style");
    st.id = "rv-tts-style";
    st.textContent = `
      .rv-tts-highlight{
        background: rgba(230, 255, 0, .35);
        border-radius: 4px;
        box-shadow: 2px 2px rgba(230, 255, 0, .45);
        transition: background .2s ease;
      }
    `;
    document.head.appendChild(st);
  }

  function clearHighlight() {
    const span = tts.highlightSpan;
    if (span && span.parentNode) {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
    tts.highlightSpan = null;
  }

  function rangeFromOffsets(el, start, end) {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let cur = 0, startNode=null, startOff=0, endNode=null, endOff=0, n;
    while ((n = tw.nextNode())) {
      const len = n.nodeValue.length, next = cur + len;
      if (startNode == null && start >= cur && start <= next) { startNode = n; startOff = start - cur; }
      if (endNode == null && end >= cur && end <= next) { endNode = n; endOff = end - cur; }
      cur = next;
      if (startNode && endNode) break;
    }
    const r = document.createRange();
    if (!startNode || !endNode) { r.selectNodeContents(el); return r; }
    r.setStart(startNode, Math.max(0, Math.min(startOff, startNode.nodeValue.length)));
    r.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue.length)));
    return r;
  }

  function highlightCurrent(index) {
    clearHighlight();
    const m = tts.meta && tts.meta[index];
    if (!m) return;

    const r = rangeFromOffsets(m.el, m.start, m.end);
    const span = document.createElement("span");
    span.className = "rv-tts-highlight";
    try {
      r.surroundContents(span);
    } catch(_){};

    tts.highlightSpan = span;

    m.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function offsetInElementFromPoint(el, clientX, clientY) {
    // Build a collapsed range at the click point
    let r = null;
    if (document.caretRangeFromPoint) {
      r = document.caretRangeFromPoint(clientX, clientY);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(clientX, clientY);
      if (pos) {
        r = document.createRange();
        r.setStart(pos.offsetNode, pos.offset);
        r.collapse(true);
      }
    }
    if (!r) return null;

    // Ensure the caret is inside `el`; if not, snap to start of el
    if (!el.contains(r.startContainer)) {
      const snap = document.createRange();
      snap.selectNodeContents(el);
      snap.collapse(true);
      r = snap;
    }

    // Sum lengths of text nodes up to the caret
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let cur = 0, n;
    while ((n = tw.nextNode())) {
      if (n === r.startContainer) {
        return cur + Math.min(r.startOffset, n.nodeValue.length);
      }
      cur += n.nodeValue.length;
    }
    return cur; // fallback (end)
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
        #rv-toolbar {
          position: sticky;
          top: 0;
          z-index: 2;
          display: flex;
          flex-wrap: nowrap;
          align-items: center;
          gap: 4px;
          padding: 4px 10px;
          background: var(--rv-panel);
          border-bottom: 1px solid var(--rv-border);
          backdrop-filter: saturate(120%) blur(6px);
          -webkit-backdrop-filter: saturate(120%) blur(6px);
        }
        #rv-toolbar .rv-btn {
          all: unset;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid var(--rv-border);
          border-radius: 8px;
          padding: 4px 8px;
          cursor: pointer;
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
        #rv-toolbar .rv-group {
          display: inline-flex;
          gap: 4px;
        }
        #rv-toolbar .rv-btn:focus-visible {
          outline: 2px solid var(--rv-border);
          outline-offset: 2px;
        }
        .rv-spacer {
          flex: 1 1 auto;
          min-width: 0;
        }
        html.rv-active body > *:not(#reader-view-overlay) { user-select: none !important; -webkit-user-select: none !important; }
        #rv-surface {
          position: fixed;
          inset: 0;
          height: 100vh;
          overflow-y: scroll !important;
          overflow-x: hidden !important;
          scrollbar-gutter: stable both-edges;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
          z-index: 2147483647;
        }
        #rv-surface::-webkit-scrollbar {
          width: 12px;
          background: transparent;
        }
        #rv-surface::-webkit-scrollbar-track {
          background: transparent;
          border-left: 1px solid var(--rv-border);
        }
        #rv-surface::-webkit-scrollbar-thumb {
          background: #888;
          border-radius: 8px;
          border: 1px solid #666;
          background-clip: content-box;
        }
        #rv-surface::-webkit-scrollbar-thumb:hover {
          background: #8a9099;
          background-clip: content-box;
        }
        #rv-surface::-webkit-scrollbar-corner {
          background: transparent;
        }
        html.rv-active, html.rv-active body {
          overflow: hidden !important;
        }
        .rv-tts-active {
          background: rgba(255, 255, 0, 0.2) !important;
          transition: background 0.3s ease;
        }
        #rv-tts-status, #rv-speed-label {
          font-size: 12px;
          color: var(--rv-fg);
          opacity: 0.9;
          margin-left: 8px;
        }
        #rv-speed-label {
          width: 3em;
          margin: 0 2px 0 4px;
        }
      </style>
      <div id="rv-surface" role="dialog" aria-label="Reader View" tabindex="-1">
        <div id="rv-toolbar">
          <button class="rv-btn" id="rv-close" title="Close"><img></button>
          <span class="rv-group">
            <button class="rv-btn" id="rv-font-inc" title="Increase font"><img></button>
            <button class="rv-btn" id="rv-font-dec" title="Decrease font"><img></button>
            <button class="rv-btn" id="rv-width-widen" title="Widen page"><img></button>
            <button class="rv-btn" id="rv-width-narrow" title="Narrow page"><img></button>
          </span>
          <div class="rv-spacer">
            <div id="rv-tts" style="margin-left:20px;display:flex;gap:6px;align-items:center">
              <select id="rv-voice" title="Voice"></select>
              <label class="rv-inline" title="Speed">
                <input id="rv-speed" type="range" min="0.7" max="1.5" step="0.05" value="1.0" style="width:120px" />
              </label>
              <span id="rv-speed-label"></span>
              <button class="rv-btn" id="rv-tts-play" title="Play"><img></button>
              <button class="rv-btn" id="rv-tts-pause" title="Pause"><img></button>
              <button class="rv-btn" id="rv-tts-stop" title="Stop"><img></button>
              <button class="rv-btn" id="rv-tts-prevp" title="Previous paragraph"><img></button>
              <button class="rv-btn" id="rv-tts-prev" title="Previous sentence"><img></button>
              <button class="rv-btn" id="rv-tts-next" title="Next sentence"><img></button>
              <button class="rv-btn" id="rv-tts-nextp" title="Next paragraph"><img></button>
              <span id="rv-tts-status"></span>
            </div>
          </div>
        </div>
        <div id="rv-content">
          ${title ? `<h1>${title}</h1>` : ""}
          ${byline ? `<p><em>${byline}</em></p>` : ""}
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

    // Apply saved prefs
    surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
    contentHost.style.setProperty("--rv-maxw", `${prefs.maxWidth}px`);

    // save status element
    tts.statusEl = container.querySelector("#rv-tts-status");
    setStatus("Ready");

    const outside = Array.from(document.body.children).filter(n => n !== container);
    outside.forEach(n => { try { n.setAttribute("inert", ""); } catch(_){} });

    document.documentElement.classList.add("rv-active");

    function cleanup() {
      stopPlayback();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("copy", onCopy, true);
      outside.forEach(n => { try { n.removeAttribute("inert"); } catch(_){} });
      document.documentElement.classList.remove("rv-active");
      container.remove();
    }

    function selectTarget() {
      const target = contentHost.querySelector("#rv-article-body") || contentHost;
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function onKey(e) {
      const accel = (e.metaKey || e.ctrlKey);
      if (accel && e.key.toLowerCase() === "a") { e.preventDefault(); selectTarget(); }
      if (e.key === "Escape") cleanup();
      if (e.altKey && (e.key === "+" || e.key === "=")) {
        prefs.fontSize = Math.min(32, prefs.fontSize + 1);
        surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
        savePrefs(prefs);
      }
      if (e.altKey && (e.key === "-" || e.key === "_")) {
        prefs.fontSize = Math.max(12, prefs.fontSize - 1);
        surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
        savePrefs(prefs);
      }
    }

    function onCopy(e) {
      const host = contentHost;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) return;
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
      prefs.fontSize = Math.min(32, prefs.fontSize + 1);
      surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
      savePrefs(prefs);
    });
    container.querySelector("#rv-font-dec").addEventListener("click", () => {
      prefs.fontSize = Math.max(12, prefs.fontSize - 1);
      surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
      savePrefs(prefs);
    });
    container.querySelector("#rv-width-widen").addEventListener("click", () => {
      prefs.maxWidth = Math.min(1400, prefs.maxWidth + 40);
      contentHost.style.setProperty("--rv-maxw", `${prefs.maxWidth}px`);
      savePrefs(prefs);
    });
    container.querySelector("#rv-width-narrow").addEventListener("click", () => {
      prefs.maxWidth = Math.max(520, prefs.maxWidth - 40);
      contentHost.style.setProperty("--rv-maxw", `${prefs.maxWidth}px`);
      savePrefs(prefs);
    });

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("copy", onCopy, true);
    document.documentElement.appendChild(container);
    surface.focus();

    // Setup TTS controls
    setupStaticTTSControls(container, contentHost);
  }

  // --------------------------
  // Main toggle function
  // --------------------------
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

    // Set icons
    setIcon("rv-close", "logout.png");
    setIcon("rv-font-inc", "text_increase.png");
    setIcon("rv-font-dec", "text_decrease.png");
    setIcon("rv-width-widen", "widen.png");
    setIcon("rv-width-narrow", "shrink.png");
    setIcon("rv-tts-play", "speak.png");
    setIcon("rv-tts-pause", "pause.png");
    setIcon("rv-tts-stop", "stop.png");
    setIcon("rv-tts-prev", "prev.png");
    setIcon("rv-tts-prevp", "pprev.png");
    setIcon("rv-tts-next", "next.png");
    setIcon("rv-tts-nextp", "nnext.png");
    addTTSHighlightStyle();
  }

  // --------------------------
  // TTS Controls
  // --------------------------
  let ttsUIState = { prepared: false, manifest: null, voice: "am_liam", speed: 1.0 };

  function setupStaticTTSControls(overlay, contentHost) {
    const voiceSel = overlay.querySelector("#rv-voice");
    const speedInp = overlay.querySelector("#rv-speed");
    const speedLabel = overlay.querySelector("#rv-speed-label");
    const btnPlay = overlay.querySelector("#rv-tts-play");
    const btnPause = overlay.querySelector("#rv-tts-pause");
    const btnStop = overlay.querySelector("#rv-tts-stop");
    const btnPrev = overlay.querySelector("#rv-tts-prev");
    const btnNext = overlay.querySelector("#rv-tts-next");
    const btnPrevP = overlay.querySelector("#rv-tts-prevp");
    const btnNextP = overlay.querySelector("#rv-tts-nextp");
    if (!voiceSel || !speedInp) return;
    voiceSel.innerHTML = "";
    TTS_VOICES.forEach(v => {
      const o = document.createElement("option"); o.value = v; o.textContent = v;
      voiceSel.appendChild(o);
    });
    voiceSel.value = ttsUIState.voice;
    speedInp.value = ttsUIState.speed;
    speedLabel.textContent = `${speedInp.value}x`;

    // State changes invalidate preparation
    voiceSel.onchange = () => { ttsUIState.voice = voiceSel.value; ttsUIState.prepared = false; };
    speedInp.oninput = () => {
      ttsUIState.speed = parseFloat(speedInp.value);
      speedLabel.textContent = `${speedInp.value}x`;
      ttsUIState.prepared = false;
    };

    // Segment sentences from article
    function segmentSentences(rootEl) {
      const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
      const BLOCKS = 'p, blockquote, li, h1, h2, h3, h4, h5, h6, div';
      const scope = rootEl.querySelector('#rv-article-body');
      if (!scope) return { texts: [], meta: [] };

      // Leaf blocks only (avoid parent+child duplication)
      const paras = Array.from(scope.querySelectorAll(
        `:is(${BLOCKS}):not(:has(${BLOCKS})):not(dialog *):not(header *):not(footer *):not(figure *)`
      ));

      const texts = [];
      const meta = [];

      for (const el of paras) {
        // 1) Build "plain" from actual text nodes so offsets match Range/TreeWalker
        const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let plain = "";
        let nodes = [];
        let pos = 0, n;

        while ((n = tw.nextNode())) {
          const val = (n.nodeValue || "").replace(/\r/g, ""); // normalize CR
          nodes.push({ node: n, start: pos, end: pos + val.length });
          plain += val;
          pos += val.length;
        }
        if (!plain) continue;

        // 2) Segment the "plain" string and compute trimmed offsets
        // Intl.Segmenter gives us d.index (start) and d.segment (text)
        for (const d of seg.segment(plain)) {
          const raw = d.segment;
          if (!raw) continue;
          const start0 = d.index;
          const end0 = start0 + raw.length;

          // trim leading/trailing whitespace within this sentence
          const lead = (/^\s*/.exec(raw)?.[0].length) ?? 0;
          const trail = (/\s*$/.exec(raw)?.[0].length) ?? 0;

          const start = start0 + lead;
          const end   = end0 - trail;
          if (end <= start) continue;

          const spoken = plain.slice(start, end).trim();
          if (!spoken) continue;

          texts.push(spoken);
          meta.push({ el, start, end });
        }
      }

      return { texts, meta };
    }
    // Prepare synthesis
    async function ensurePrepared() {
      if (ttsUIState.prepared && tts.segments?.length) return true;
      setStatus("Preparing speech...");

      const { texts, meta } = segmentSentences(contentHost);
      if (!texts.length) { setStatus("No text to speak"); return false; }

      tts.texts = texts;                  // keep using your existing property
      tts.meta = meta;                    // parallel metadata
      tts.segments = new Array(texts.length).fill(0);

      tts.manifestId = null;
      ttsUIState.manifest = null;
      ttsUIState.prepared = true;
      tts.index = 0;
      setStatus(`Ready (${tts.segments.length} segments)`);
      return true;
    }

    // Highlight current sentence
    function highlight(i) {
      const prev = document.querySelector(".rv-tts-active");
      if (prev) prev.classList.remove("rv-tts-active");

      const { sentences } = segmentSentences(contentHost);
      if (sentences[i]?.el) {
        sentences[i].el.classList.add("rv-tts-active");
        sentences[i].el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }

    function jumpAndPlayAt(idx) {
      if (idx < 0 || idx >= tts.segments.length) return;
      stopPlayback();
      tts.index = idx;
      highlightCurrent(idx);
      tts.playing = true;
      scheduleAt(idx);
    }

    // Button handlers
    btnPlay.onclick = async () => {
      if (tts.playing) return;
      const ok = await ensurePrepared();
      if (!ok) return;
      const startIndex = Math.max(0, tts.index);
      jumpAndPlayAt(startIndex);
    };

    btnPause.onclick = () => { stopPlayback("paused"); };
    btnStop.onclick = () => { stopPlayback(); };

    function paragraphStartIndexAt(idx) {
      if (!tts.meta?.length || idx < 0 || idx >= tts.meta.length) return -1;
      const el = tts.meta[idx].el;
      while (idx > 0 && tts.meta[idx - 1].el === el) idx--;
      return idx;
    }

    function paragraphEndIndexAt(idx) {
      if (!tts.meta?.length || idx < 0 || idx >= tts.meta.length) return -1;
      const el = tts.meta[idx].el;
      while (idx + 1 < tts.meta.length && tts.meta[idx + 1].el === el) idx++;
      return idx;
    }


    btnPrev.onclick = () => {
      const idx = Math.max(0, (tts.index > 0 ? tts.index : 0) - 1);
      jumpAndPlayAt(idx);
    };

    btnNext.onclick = () => {
      const idx = Math.min(tts.segments.length - 1, (tts.index >= 0 ? tts.index : -1) + 1);
      jumpAndPlayAt(idx);
    };

    btnPrevP.onclick = () => {
      if (!ttsUIState.prepared || !tts.meta?.length) return;
      // If index is unset, treat as 0
      let cur = Math.max(0, tts.index | 0);
      // move to start of current paragraph
      const curStart = paragraphStartIndexAt(cur);
      if (curStart <= 0) {
        // already at the first paragraph
        jumpAndPlayAt(0);
        return;
      }
      // previous paragraph = the run that ends at curStart - 1
      const prevEnd = curStart - 1;
      const prevStart = paragraphStartIndexAt(prevEnd);
      jumpAndPlayAt(prevStart);
    };

    btnNextP.onclick = () => {
      if (!ttsUIState.prepared || !tts.meta?.length) return;

      let cur = Math.max(0, tts.index | 0);
      // move to end of current paragraph
      const curEnd = paragraphEndIndexAt(cur);
      const nextStart = curEnd + 1;

      if (nextStart >= tts.meta.length) {
        // already at the last paragraph — stop at end
        jumpAndPlayAt(paragraphStartIndexAt(cur)); // or just do nothing
        return;
      }
      jumpAndPlayAt(nextStart);
    };

    // Click on paragraph to jump
    contentHost.addEventListener("click", (e) => {
      if (!ttsUIState.prepared || !tts.meta?.length) return;

      // Start from a visible block near the click
      const blocks = "p,li,blockquote,h1,h2,h3,h4,h5,h6,div";
      const base = e.target.closest(blocks);
      if (!base) return;

      // Snap to our LEAF block (same rule used in segmentSentences)
      const leafSel = `:is(${blocks}):not(:has(${blocks}))`;
      const leafEl = base.closest(leafSel);
      if (!leafEl) return;

      // Compute character offset within the leaf element
      const off = offsetInElementFromPoint(leafEl, e.clientX, e.clientY);
      if (off == null) return;

      // Find the sentence in this element that spans the offset
      let idx = -1;
      for (let i = 0; i < tts.meta.length; i++) {
        const m = tts.meta[i];
        if (m.el === leafEl && off >= m.start && off < m.end) {
          idx = i;
          break;
        }
      }
      // Fallback: first sentence in this element
      if (idx < 0) {
        idx = tts.meta.findIndex(m => m.el === leafEl);
      }
      jumpAndPlayAt(idx);
    }, true);
    // Listen for position updates from scheduler
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "tts.positionChanged") highlight(msg.payload.index);
    });
  }
})();