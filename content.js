// content.js
(function () {
  if (window.__readerViewInstalled) return;
  window.__readerViewInstalled = true;

  // --------------------------
  // Server definitions
  // --------------------------
  const Server = Object.freeze({
      MY_KOKORO: 1,
      VOX_ANE: 2,
      SUPERTONIC: 3
  });

  const SERVERS = new Map([
    [Server.MY_KOKORO, {name: 'Kokoro', active: false, voices: ["ax_liam", "af_heart"], speed: 1.0}],
    [Server.VOX_ANE, {name: 'Vox', active: true, voices: ["adam", "dorothy"], speed: 1.0}],
    [Server.SUPERTONIC, {name: 'SuperT', active: true, voices: ["F1", "M1"], speed: 1.2}]
  ]);

  // --------------------------
  // Storage helpers
  // --------------------------
  const STORAGE_KEY = "rv_prefs_v1";
  const defaults = { fontSize: 17, maxWidth: 860, server: Server.VOX_ANE, voice: {}, speeds: {}, ratings: {}, readingProgress: {}, autoScroll: true };
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
  // TTS Playback State
  // --------------------------
  const tts = {
    prepared: false,
    server: Server.VOX_ANE,
    voice: '',
    speed: 1.0,
    audioCtx: null,
    segments: [],
    texts: [],
    index: 0,
    playing: false,
    decoded: new Map(),
    inFlight: new Map(),
    currentSrc: null,
    playToken: 0,
    prefetchAhead: 4,    // # TTS segments to prefetch
    keepBehind: 3,
    statusEl: null,      // status label
    voiceEl: null,       // voice list control
    btnPlay: null,
    btnStop: null,
    btnNext: null,
    controls: null,      // button group not including Play
    scrl: null,          // auto scroll checkbox
    meta: [],            // [{el,start,end}] parallel to tts.texts[index]
    highlightSpan: null, // active <span> wrapper for current sentence
  };

  const LONG_PAGE_THRESHOLD = 150;  // Minimum segments to consider a page "long"
  const MAX_SAVED_PAGES = 50;       // Max number of saved reading positions
  const currentPageUrl = window.location.href.split(/[?#]/)[0]; // Use URL without query/hash
  const _lang = (document.documentElement.lang || 'en').substring(0, 2).toLowerCase();

  function sig(){ return `${tts.server}|${tts.voice}|${tts.speed}`; }
  function ttsKey(i){ return `${sig()}:${i}`; }
  function ensureCtx() {
    if (!tts.audioCtx || tts.audioCtx.state === "closed") {
      tts.audioCtx = new (AudioContext || webkitAudioContext)({ sampleRate: 44100 });
    }
    return tts.audioCtx;
  }

  // Show status message to user
  // set msg to '' or omit to show playing status
  function setStatus(msg = '') {
    if (msg==='') {
      msg = `${tts.playing ? 'Playing' : 'Ready'} ${tts.index + 1} / ${tts.segments.length}`;
    }
    tts.statusEl.textContent = msg;
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
  function decodeBuffer(i, arrayBuffer) {
    const k = ttsKey(i);
    if (tts.decoded.has(k)) return tts.decoded.get(k);
    const ctx = ensureCtx();
    const ab = ctx.decodeAudioData(arrayBuffer.slice(0));
    tts.decoded.set(k, ab);
    return ab;
  }

  // Ensure only one remote synthesis runs at a time across segments
  let synthChain = Promise.resolve();
  function withSynthLock(fn) {
    const next = synthChain.then(fn);
    // keep the chain alive even if a task throws
    synthChain = next.catch(() => {});
    return next;
  }
  // Fetch + decode a segment through background proxy
  async function fetchAndDecodeSegment(i, signature) {

    const k = ttsKey(i);

    // 1) Already decoded
    if (tts.decoded.has(k)) return tts.decoded.get(k);

    // 2) Already in flight for this index: reuse its Promise
    if (tts.inFlight.has(k)) return tts.inFlight.get(k);

    // 3) New synth task for this index
    const task = (async () => {
      try {
        // Only one synth at a time goes through this lock
        setStatus(`T→S ${i + 1} / ${tts.segments.length}`);
        const response = await withSynthLock(() =>
          chrome.runtime.sendMessage({
            type: "tts.synthesize",
            payload: {
              signature,
              out_of_order: i !== tts.index && !tts.decoded.has(ttsKey(tts.index)),
              fast: i === tts.index,
              text: tts.texts[i],
              lang: _lang,
              voice: tts.voice,
              speed: tts.speed,
              server: tts.server
            }
          })
        );

        if (!response?.ok) throw new Error(response?.error || "Synthesis failed");
        if (signature !== sig()) throw new Error('Stale signature');

        const buf = base64ToArrayBuffer(response.base64);
        const ab = decodeBuffer(i, buf);
        setStatus();
        return ab;
      } finally {
        tts.inFlight.delete(k);
      }
    })();

    tts.inFlight.set(k, task);
    return task;
  }

  // Main playback scheduler
  async function scheduleAt(index) {
    const token = ++tts.playToken;
    tts.index = index;
    const _sig = sig();

    highlightCurrent(index);
    try {
      // Fetch and Wait for this segment's audio
      const cur = await fetchAndDecodeSegment(index, _sig);
      // If something changed (voice/jump/stop) while we were waiting, bail
      if (!tts.playing || token != tts.playToken || _sig !== sig()) return;

      const ctx = ensureCtx();

      // Resume context if needed (user gesture requirement)
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const src = ctx.createBufferSource();
      tts.currentSrc = src;

      // Attach onended
      src.onended = () => {
        if (!tts.playing || token !== tts.playToken) return;
        tts.currentSrc = null;
        const next = tts.index + 1;
        if (next < tts.segments.length) {
          if (tts.server == Server.SUPERTONIC) {
            setTimeout(() => { scheduleAt(next); }, 500);
          } else {
            scheduleAt(next);
          }
        } else {
          stopPlayback();
          tts.index = 0;
          setStatus("Finished");
          chrome.runtime.sendMessage({ type: "tts.stateChanged", payload: "stopped" });
        }
      };

      // Start playback of this segment
      src.buffer = cur;
      src.connect(ctx.destination);
      tts.playing = true;
      src.start();
      setStatus();
      highlightReading();
      chrome.runtime.sendMessage({
        type: "tts.positionChanged",
        payload: { index }
      });

      // Prefetch without blocking the onended attachment/playback
      (async () => {
        const start = Math.max(0, tts.index + 1);
        const end = Math.min(tts.segments.length - 1, tts.index + tts.prefetchAhead);
        for (let i = start; i <= end; i++) {
          const k = ttsKey(i);
          if (!tts.decoded.has(k) && !tts.inFlight.has(k)) {
            try { await fetchAndDecodeSegment(i, _sig); } catch {}
          }
        }
        // Cleanup only far-behind buffers
        for (const k of Array.from(tts.decoded.keys())) {
          const idx = parseInt(k.split(":")[1], 10);
          if (Number.isFinite(idx) && idx < tts.index - tts.keepBehind) {
            tts.decoded.delete(k);
          }
        }
      })().catch(() => {});

    } catch (err) {
      setStatus();
      // advance only if index is current
      if (index == tts.index) tts.btnNext.click();
      else console.log("Playback error:", err);
    }
  }

  function stopPlayback() {
    try {
      if (tts.currentSrc) {
        tts.currentSrc.onended = null;
        tts.currentSrc.stop();
        tts.currentSrc.close();
      }
    } catch {}
    tts.currentSrc = null;
    tts.playing = false;
    tts.btnPlay.style.display = 'inherit';
    tts.controls.style.display = 'none';
    tts.inFlight.clear();
    // doesn't hurt to send cancel to server
    try { chrome.runtime.sendMessage({
      type: "tts.cancel",
      payload: { server: tts.server }
    }) } catch {}
    highlightReading();
    setStatus();
  }

  // Saves the current TTS reading progress (index) to storage.
  async function saveReadingProgress() {
    if (!tts.prepared || tts.segments.length < LONG_PAGE_THRESHOLD) {
      return;
    }

    // Fetch latest prefs from storage right now
    const prefs = await loadPrefs();

    if (!prefs.readingProgress) prefs.readingProgress = {};

    // Update only THIS page's entry
    prefs.readingProgress[currentPageUrl] = {
      index: tts.index,
      segments: tts.segments.length,
      timestamp: Date.now()
    };

    // Prune the oldest entries
    const urls = Object.keys(prefs.readingProgress);
    if (urls.length > MAX_SAVED_PAGES) {
      const sortedUrls = urls.sort((a, b) =>
        prefs.readingProgress[a].timestamp - prefs.readingProgress[b].timestamp
      );
      for (let i = 0; i < urls.length - MAX_SAVED_PAGES; i++) {
        delete prefs.readingProgress[sortedUrls[i]];
      }
    }

    // Save back to storage
    await savePrefs(prefs);
  }

  // --------------------------
  // Toggle hooks
  // --------------------------
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "toggleReader") toggle();
    });
  } catch {}

  function setIcon(btn_id, file) {
    const btn = document.getElementById(btn_id);
    const img = btn && btn.querySelector("img");
    if (img) img.src = chrome.runtime.getURL(`icons/${file}`);
  }

  function clearHighlight() {
    const target = tts.highlightSpan;
    if (!target) return;

    // Case 1: our normal wrapper span
    if (target.nodeType === Node.ELEMENT_NODE &&
        target.tagName === "SPAN" &&
        target.classList.contains("rv-tts-highlight") &&
        target.parentNode) {
      const parent = target.parentNode;
      while (target.firstChild) parent.insertBefore(target.firstChild, target);
      parent.removeChild(target);
    } else if (target.nodeType === Node.ELEMENT_NODE &&
               target.classList &&
               target.classList.contains("rv-tts-highlight")) {
      // Case 2: fallback where we just added a class to an existing element
      target.classList.remove("rv-tts-highlight");
      target.classList.remove("rv-tts-reading");
      target.classList.remove("rv-tts-inactive");
    }

    tts.highlightSpan = null;
  }

  function rangeFromOffsets(el, start, end) {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let cur = 0, startNode=null, startOff=0, endNode=null, endOff=0, n;
    while (n = tw.nextNode()) {
      if (n.parentElement?.closest('sup') || n.parentElement?.closest('label')) continue;
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
      // More robust than surroundContents: this splits nodes if needed
      const contents = r.extractContents();
      span.appendChild(contents);
      r.insertNode(span);
      tts.highlightSpan = span;
      if (!tts.playing) span.classList.add("rv-tts-inactive");
      if (tts.scrl.checked) span.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (e) {
      // Fallback: just highlight the whole paragraph/element
      m.el.classList.add("rv-tts-highlight");
      if (!tts.playing) span.classList.add("rv-tts-inactive");
      tts.highlightSpan = m.el;
      if (tts.scrl.checked) m.el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function highlightReading() {
    const target = tts.highlightSpan;
    if (!target) return;
    if (tts.playing) target.classList.add("rv-tts-reading");
    else {
      target.classList.remove("rv-tts-reading");
      target.classList.add("rv-tts-inactive");
    }
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
    while (n = tw.nextNode()) {
      if (n.parentElement?.closest('sup') || n.parentElement?.closest('label')) continue;
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
      <div id="rv-surface" role="dialog" aria-label="Reader View" tabindex="-1">
        <div id="rv-toolbar">
          <div id="rv-tts">
            <button class="rv-btn" id="rv-close" title="Exit"><img></button>
            <div id="rv-servers"></div>
            <select id="rv-voice" title="Voice"></select>
            <div id="rv-rating-control" class="rv-rating-control" title="Rate the selected voice (0-3 stars)"></div>
            <label class="rv-inline" title="Speed">
            <input id="rv-speed" type="range" min="0.7" max="1.5" step="0.05" value="1.0" />
            </label>
            <span id="rv-speed-label"></span>
            <button class="rv-btn" id="rv-tts-play" title="Speak"><img></button>
            <div id="rv-tts-controls" style="display:none">
            <button class="rv-btn" id="rv-tts-stop" title="Stop"><img></button>
            <button class="rv-btn" id="rv-tts-prevp" title="Previous paragraph"><img></button>
            <button class="rv-btn" id="rv-tts-prev" title="Previous sentence"><img></button>
            <button class="rv-btn" id="rv-tts-next" title="Next sentence"><img></button>
            <button class="rv-btn" id="rv-tts-nextp" title="Next paragraph"><img></button>
            </div>
            <span id="rv-tts-status"></span>
          </div>
          <div id="rv-format">
            <input id="rv-scrl" type="checkbox"/><label for="rv-scrl">AutoScroll </label>
            <button class="rv-btn" id="rv-font-inc" title="Increase font"><img></button>
            <button class="rv-btn" id="rv-font-dec" title="Decrease font"><img></button>
            <button class="rv-btn" id="rv-width-widen" title="Widen page"><img></button>
            <button class="rv-btn" id="rv-width-narrow" title="Narrow page"><img></button>
          </div>
        </div>
        <div id="rv-content">
          ${title ? `<h1>${title}</h1>` : ""}
          ${byline ? `<p><em>${byline}</em></p>` : ""}
          <div id="rv-article-body">${articleHTML}</div>
        </div>
      </div>
    `;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.id = "rv-style-link";
    link.href = chrome.runtime.getURL("overlay.css");
    document.head.appendChild(link);
    return container;
  }

  function attachOverlay(container, prefs) {
    document.getElementById("reader-view-overlay")?.remove();

    const surface = container.querySelector("#rv-surface");
    const contentHost = container.querySelector("#rv-content");

    // Apply saved prefs
    surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
    contentHost.style.setProperty("--rv-font-family", 'Verdana,Geneva,Helvetica,sans-serif');
    contentHost.style.setProperty("--rv-maxw", `${prefs.maxWidth}px`);
    if (prefs.server && SERVERS.has(prefs.server)) tts.server = prefs.server;

    // save status element
    tts.voiceEl = container.querySelector("#rv-voice");
    tts.statusEl = container.querySelector("#rv-tts-status");
    tts.btnPlay = container.querySelector("#rv-tts-play");
    tts.btnStop = container.querySelector("#rv-tts-stop");
    tts.btnNext = container.querySelector("#rv-tts-next");
    tts.controls = container.querySelector("#rv-tts-controls");
    tts.scrl = container.querySelector("#rv-scrl");
    setStatus();

    const outside = Array.from(document.body.children).filter(n => n !== container);
    outside.forEach(n => { try { n.setAttribute("inert", ""); } catch(_){} });

    document.documentElement.classList.add("rv-active");

    async function cleanup() {
      await saveReadingProgress(prefs);
      stopPlayback();
      document.removeEventListener("keyup", onKey, true);
      document.removeEventListener("copy", onCopy, true);
      outside.forEach(n => { try { n.removeAttribute("inert"); } catch(_){} });
      document.documentElement.classList.remove("rv-active");
      container.remove();
      if (!tts) return;
      if (tts.audioCtx) {
        try { tts.audioCtx.close(); } catch {}
      }
      tts.audioCtx = null;
      tts.prepared = false;
      tts.segments = [];
      tts.texts = [];
      tts.index = 0;
      tts.decoded.clear();
      tts.currentSrc = null;
      tts.meta = [];
      tts.highlightSpan = null;
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
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.keyCode == 32 && e.altKey || e.keyCode == 119 & !e.altKey) { // alt+space or f8
        e.preventDefault();
        if (tts.playing) tts.btnStop.click(); else tts.btnPlay.click();
      }
      if (!e.altKey) return;
      if (e.keyCode == 187) {
        e.preventDefault();
        prefs.fontSize = Math.min(32, prefs.fontSize + 1);
        surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
        savePrefs(prefs);
      } else if (e.keyCode == 189) {
        e.preventDefault();
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

    document.addEventListener("keyup", onKey, true);
    document.addEventListener("copy", onCopy, true);
    document.documentElement.appendChild(container);
    surface.focus();

    setupTTSControls(container, contentHost, prefs);
  }

  const BLOCKS = "p, div, blockquote, li, h1, h2, h3, h4, h5, h6, pre";

  // Pre-compile regexes and moves constants outside for performance
  const ABBREV = new Set([
    "Mr", "Mrs", "Ms", "Dr", "Prof", "Sr", "Jr", "St",
    "V", "v","Fig", "Rev", "Sen", "Capt", "Sgt", "Col", "Adm",
    "U.S", "U.K", "A.M", "P.M", "a.m", "p.m", "e.g", "i.e", "Vs", "vs", "cf",
    "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug",
    "Sep", "Sept", "Oct", "Nov", "Dec",
  ]);

  const RE_ABBREV_FALLBACK = /[^A-Z.]([A-Z]\.)+$/;
  const RE_ABBREV_MATCH = /[^A-Za-z.]([A-Za-z.]+)\.$/;
  const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "sentence" });

  // Helper: choose a split index (within str) for Vox long chunks.
  // Only split at ",", ";" or "--" near the middle. If nothing found, return -1.
  function chooseVoxSplitIndex(str) {
    const len = str.length;
    if (len < 2) return -1;

    const mid = Math.floor(len / 2);

    const isGoodPunctBoundary = (i) => {
      // we split "after" i - 1
      const prev = str[i - 1];
      const prev2 = str[i - 2];
      // split on , but not in number like 10,000
      if (prev === ',' && !/[0-9]/.test(str[i])) return true;
      if ([';', '—'].includes(prev)) return true;
      if (prev === '-' && prev2 === '-') return true; // "--"
      return false;
    };

    const maxOffset = Math.floor(len * 0.25); // search in middle 50 percent band

    for (let off = 0; off <= maxOffset; off++) {
      const left = mid - off;
      const right = mid + off;

      if (left > 1 && left < len && isGoodPunctBoundary(left)) {
        return left;
      }
      if (right > 1 && right < len && isGoodPunctBoundary(right)) {
        return right;
      }
    }

    // no suitable punctuation found
    return -1;
  }

  function segmentSentences(rootEl) {
    const isVox = tts.server == Server.VOX_ANE;
    const isSuper = tts.server == Server.SUPERTONIC;
    const MIN_CHARS = isVox ? 35 : (isSuper ? 100 : 150);
    const MAX_CHARS = isVox ? 200 : (isSuper ? 600 : 300);

    const scope = rootEl.querySelector('section[name="articleBody"]') || rootEl.querySelector('#rv-article-body');
    if (!scope) return { texts: [], meta: [] };

    const paras = scope.querySelectorAll(`:is(${BLOCKS}):not(:has(${BLOCKS})):not(header *):not(footer *):not(caption *):not([aria-hidden] *)`);
    const texts = [];
    const meta = [];

    // Helper to push result
    function emit(plain, el, s, e) {
      const spoken = plain.slice(s, e).trim();
      if (!spoken) return;

      if (MAX_CHARS && spoken.length > MAX_CHARS) {
        const rel = chooseVoxSplitIndex(spoken);
        if (rel > 0 && rel < spoken.length) {
          const splitAbs = s + rel;
          texts.push(spoken.slice(0, rel).trim());
          meta.push({ el, start: s, end: splitAbs });
          texts.push(spoken.slice(rel).trim());
          meta.push({ el, start: splitAbs, end: e });
          return;
        }
      }
      texts.push(spoken);
      meta.push({ el, start: s, end: e });
    }

    for (const el of paras) {
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let plain = "";
      while (n = tw.nextNode()) {
        if (n.parentElement?.closest('sup') || n.parentElement?.closest('label')) continue;
        plain += tw.currentNode.nodeValue;
      }
      if (!plain) continue;

      const segments = SEGMENTER.segment(plain);
      let groupStart = -1;
      let groupEnd = -1;
      let pendingText = "";

      for (const { index, segment } of segments) {
        if (groupStart === -1) groupStart = index;
        groupEnd = index + segment.length;
        pendingText += segment;

        // Determine if we should end the current group
        const trimmed = pendingText.trim();

        // Check abbreviation: Fast path for "Dr.", "Mr.", etc.
        let isAbbrev = false;
        if (trimmed.endsWith('.')) {
          if (RE_ABBREV_FALLBACK.test(trimmed)) isAbbrev = true;
          else {
            const m = trimmed.match(RE_ABBREV_MATCH);
            if (m && ABBREV.has(m[1])) isAbbrev = true;
          }
        }

        // Only emit if not an abbreviation AND we meet the length requirement
        if (!isAbbrev && trimmed.length >= MIN_CHARS) {
          emit(plain, el, groupStart, groupEnd);
          groupStart = -1;
          pendingText = "";
        }
      }

      // Emit any remaining text in the paragraph
      if (groupStart !== -1) {
        emit(plain, el, groupStart, groupEnd);
      }
    }

    return { texts, meta };
  }

  function refreshSegments(contentHostEl) {
    // Remember the current position to restore it after re-segmenting
    let savedEl = null;
    let savedOffset = 0;
    if (tts.prepared && tts.meta[tts.index]) {
      savedEl = tts.meta[tts.index].el;
      savedOffset = tts.meta[tts.index].start;
    }

    // Clear existing highlights before re-segmenting
    clearHighlight();

    // Perform segmentation with current server's MIN/MAX constraints
    const { texts, meta } = segmentSentences(contentHostEl);
    tts.texts = texts;
    tts.meta = meta;
    tts.segments = new Array(texts.length).fill(0);
    tts.prepared = true;

    // Try to restore the reading index
    if (savedEl) {
      const newIdx = tts.meta.findIndex(m => m.el === savedEl && m.start >= savedOffset);
      tts.index = newIdx !== -1 ? newIdx : 0;
    } else {
      tts.index = 0;
    }

    setTimeout(() => {
      highlightCurrent(tts.index);
      setStatus();
    }, 500);
  }

  // --------------------------
  // Main toggle function
  // --------------------------
  async function toggle() {
    const existing = document.getElementById("reader-view-overlay");
    if (existing) { existing.querySelector("#rv-close")?.click(); return; }
    if (!window.Readability) { console.error("Readability not found. Inject readability.js first."); return; }

    document.querySelectorAll(`script, noscript, dialog, modal, form, [class*="tags"], [class*="signup"], [class*="hidden"]`)
      .forEach(el => el.remove());
    if (window.location.href.includes('slate.com')) {
      document.querySelectorAll('p').forEach(p => {
        if (p.textContent.includes('Sign up for')) p.remove();
      })
    }

    const dom = new DOMParser().parseFromString(
      "<!doctype html>" + document.documentElement.outerHTML,
      "text/html"
    );
    const article = new window.Readability(dom).parse();
    if (!article || !article.content) { console.warn("Readability returned no content."); return; }

    container = buildOverlay(article.content, article.title, article.byline);

    const prefs = await loadPrefs();
    tts.server = prefs.server;
    attachOverlay(container, prefs);

    // --- Segmentation and Progress restoration logic ---
    const contentHostEl = container.querySelector("#rv-content");

    let progressRestored = false;
    const savedProgress = prefs.readingProgress[currentPageUrl];

    refreshSegments(contentHostEl);
    const currentSegmentCount = tts.segments.length;
    // Check if the saved progress is for a long page and the index is valid
    if (savedProgress?.segments >= LONG_PAGE_THRESHOLD && savedProgress.index > 0) {
      // Only restore if the total number of segments hasn't changed drastically (e.g., +/- 10%)
      if (Math.abs(savedProgress.segments - currentSegmentCount) < currentSegmentCount * 0.1) {
        // Restore the index (other tts properties are already set)
        tts.index = Math.min(savedProgress.index, currentSegmentCount - 1); // Clamp index
        // Jumps the view to the last read position
        setTimeout(() => {
          highlightCurrent(tts.index);
          setStatus();
        }, 500);
        progressRestored = true;
      } else {
        // If the article changed, remove the stale progress
        delete prefs.readingProgress[currentPageUrl];
        savePrefs(prefs);
      }
    }

    if (!progressRestored) {
        // If no progress restored, ensure index is 0 and set default status
        tts.index = 0;
        setStatus();
    }

    // Set icons
    setIcon("rv-close", "logout.png");
    setIcon("rv-font-inc", "text_increase.png");
    setIcon("rv-font-dec", "text_decrease.png");
    setIcon("rv-width-widen", "widen.png");
    setIcon("rv-width-narrow", "shrink.png");
    setIcon("rv-tts-play", "TTS.png");
    setIcon("rv-tts-stop", "stop.png");
    setIcon("rv-tts-prev", "prev.png");
    setIcon("rv-tts-prevp", "pprev.png");
    setIcon("rv-tts-next", "next.png");
    setIcon("rv-tts-nextp", "nnext.png");
  }

  function generateRatingControlHTML(rating) {
      let html = '';
      for (let i = 3; i >= 1; i--) {
          const starChar = '★';
          const isRated = (i <= rating) ? 'rated' : '';
          html += `<span class="rv-rating-star ${isRated}" data-rating-val="${i}">${starChar}</span>`;
      }
      return html;
  }

  // --------------------------
  // TTS Controls
  // --------------------------
  function setupTTSControls(overlay, contentHost, prefs) {
    const voiceEl = overlay.querySelector("#rv-voice");
    const speedInp = overlay.querySelector("#rv-speed");
    const speedLabel = overlay.querySelector("#rv-speed-label");
    const btnPlay = overlay.querySelector("#rv-tts-play");
    const btnStop = overlay.querySelector("#rv-tts-stop");
    const btnPrev = overlay.querySelector("#rv-tts-prev");
    const btnNext = overlay.querySelector("#rv-tts-next");
    const btnPrevP = overlay.querySelector("#rv-tts-prevp");
    const btnNextP = overlay.querySelector("#rv-tts-nextp");
    const ratingControl = overlay.querySelector("#rv-rating-control");
    const scrl = overlay.querySelector("#rv-scrl");

    if (!voiceEl || !speedInp || !ratingControl) return;

    speedInp.style.display = (tts.server == Server.VOX_ANE) ? 'none': 'inherit';
    speedLabel.style.display = (tts.server == Server.VOX_ANE) ? 'none': 'inherit';

    const serversDiv = overlay.querySelector('#rv-servers');
    for (const [id, server] of SERVERS.entries()) {
      if (!server.active) continue;
      const radioInput = document.createElement('input');
      radioInput.type = 'radio';
      radioInput.id = `server-${id}`;
      radioInput.name = 'tts_server';
      radioInput.value = id;
      radioInput.checked = id == tts.server;
      radioInput.className = 'rv-radio';

      const radioLabel = document.createElement('label');
      radioLabel.htmlFor = `server-${id}`;
      radioLabel.textContent = server.name;

      serversDiv.appendChild(radioInput);
      serversDiv.appendChild(radioLabel);

      radioInput.addEventListener('change', (event) => {
          if (event.target.checked) {
              const newServer = parseInt(event.target.value, 10);
              if (newServer == tts.server) return;
              invalidateAudio(false);
              tts.server = newServer;
              prefs.server = newServer;
              const contentHostEl = overlay.querySelector("#rv-content");
              refreshSegments(contentHostEl);
              speedInp.style.display = (tts.server == Server.VOX_ANE) ? 'none': 'inherit';
              speedLabel.style.display = (tts.server == Server.VOX_ANE) ? 'none': 'inherit';
              updateRatingDisplay();
              savePrefs(prefs);
              loadVoiceList();
          }
      });
    }

    async function loadVoiceList() {
      const serverVoiceRatings = prefs.ratings[tts.server] || {};
      let voices = [];
      try {
        const res = await chrome.runtime.sendMessage({
          type: "tts.listVoices",
          payload: { server: tts.server }
        });
        if (res?.ok) voices = res.voices;
        else console.log(res?.error || "voices fetch failed");
      } finally {
        // Use fallback if API failed or returned empty
        voices = voices.length ? voices : (SERVERS.get(tts.server).voices || []);

        // 1. Prepare for sorting
        let voiceData = voices.map(v => ({
            name: v,
            rating: serverVoiceRatings[v] || 0
        }));

        // 2. Sort by rating (descending). The highest rated voices appear first.
        // voiceData.sort((a, b) => b.rating - a.rating);

        // 3. Populate dropdown
        tts.voiceEl.innerHTML = "";
        for (const data of voiceData) {
          const opt = document.createElement("option");
          opt.value = data.name;
          const stars = '⭐'.repeat(Math.min(3, data.rating));
          opt.textContent = stars ? `${data.name}  ${stars}` : data.name;
          tts.voiceEl.appendChild(opt);
        }

        // 4. Set selected voice
        const preferred = prefs.voice[tts.server];
        tts.voiceEl.value = voices.includes(preferred) ? preferred : (voices[0] || "");
        tts.voice = tts.voiceEl.value;
        updateRatingDisplay();
        updateSpeedUI();
      }
    }

    loadVoiceList();

    function updateSpeedUI() {
        const serverDef = SERVERS.get(tts.server);
        const savedSpeed = prefs.speeds?.[tts.server]?.[tts.voice];
        const speedValue = savedSpeed ?? serverDef.speed ?? 1.0;

        tts.speed = speedValue;
        speedInp.value = speedValue;
        speedLabel.textContent = `${speedValue}x`;
    }

    scrl.checked = prefs.autoScroll;

    function getCurrentRating() {
        return prefs.ratings?.[tts.server]?.[tts.voice] || 0;
    }

    // Re-generate HTML to apply 'rated' class for persistence and correct character/color.
    function updateRatingDisplay() {
        const rating = getCurrentRating();
        ratingControl.innerHTML = generateRatingControlHTML(rating);
    }

    // Handle click to set rating
    ratingControl.addEventListener('click', (e) => {
        const target = e.target.closest('.rv-rating-star');
        if (!target) return;

        const currentRating = getCurrentRating();
        const clickedRating = parseInt(target.dataset.ratingVal, 10);
        let newRating = clickedRating;

        // If user clicks the currently set rating, unset it (set to 0)
        if (clickedRating === currentRating) {
            newRating = 0;
        }

        // --- Save the new rating ---
        // Ensure ratings structure exists
        if (!prefs.ratings) prefs.ratings = {};
        if (!prefs.ratings[tts.server]) prefs.ratings[tts.server] = {};

        if (newRating === 0) {
            delete prefs.ratings[tts.server][tts.voice];
        } else {
            prefs.ratings[tts.server][tts.voice] = newRating;
        }

        savePrefs(prefs).then(() => {
            // Update the interactive display and the dropdown list
            updateRatingDisplay();
            // Need to call loadVoiceList to update the dropdown text and sort
            loadVoiceList();
        });
    });

    voiceEl.addEventListener("change", () => {
      if (tts.voice !== voiceEl.value) {
        // const wasPlaying = tts.playing;
        tts.voice = voiceEl.value;
        prefs.voice[tts.server] = voiceEl.value;
        updateRatingDisplay();
        updateSpeedUI();
        savePrefs(prefs);
        invalidateAudio(false);
      }
    });

    speedInp.addEventListener("input", () => {
      const newSpeed = parseFloat(speedInp.value);
      if (tts.speed != newSpeed) {
        tts.speed = newSpeed;
        speedLabel.textContent = `${newSpeed}x`;

        if (!prefs.speeds) prefs.speeds = {};
        if (!prefs.speeds[tts.server]) prefs.speeds[tts.server] = {};
        prefs.speeds[tts.server][tts.voice] = newSpeed;

        savePrefs(prefs);
        invalidateAudio(false);
      }
    });

    scrl.addEventListener("change", () => {
      prefs.autoScroll = scrl.checked;
      savePrefs(prefs);
      highlightCurrent(tts.index);
      highlightReading();
    });

    function playAt(idx) {
      stopPlayback();
      if (idx < 0 || idx >= tts.segments.length) return;
      tts.index = idx;
      highlightCurrent(idx);
      tts.playing = true;
      tts.btnPlay.style.display = 'none';
      tts.controls.style.display = 'inherit';
      scheduleAt(idx);
    }

    function invalidateAudio(continuePlay) {
      const wasPlaying = tts.playing;
      stopPlayback();
      tts.decoded.clear();
      tts.playToken++;           // invalidate any pending onended
      if (wasPlaying && continuePlay) playAt(tts.index);
    }

    // Button handlers
    btnPlay.onclick = async () => {
      if (tts.playing) return;
      const startIndex = Math.max(0, tts.index);
      playAt(startIndex);
    };

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

    btnPrev.onclick = () => { playAt(tts.index - 1); };

    btnNext.onclick = () => { playAt(tts.index + 1); };

    btnPrevP.onclick = () => {
      if (!tts.prepared || !tts.meta?.length) return;
      // If index is unset, treat as 0
      let cur = Math.max(0, tts.index | 0);
      // move to start of current paragraph
      const curStart = paragraphStartIndexAt(cur);
      if (curStart <= 0) {
        // already at the first paragraph
        playAt(0);
        return;
      }
      // previous paragraph = the run that ends at curStart - 1
      const prevEnd = curStart - 1;
      const prevStart = paragraphStartIndexAt(prevEnd);
      playAt(prevStart);
    };

    btnNextP.onclick = () => {
      if (!tts.prepared || !tts.meta?.length) return;

      let cur = Math.max(0, tts.index | 0);
      // move to end of current paragraph
      const curEnd = paragraphEndIndexAt(cur);
      const nextStart = curEnd + 1;

      if (nextStart >= tts.meta.length) {
        // already at the last paragraph — stop at end
        playAt(paragraphStartIndexAt(cur)); // or just do nothing
        return;
      }
      playAt(nextStart);
    };

    function findIdxAtClick(e) {
      // Start from a visible block near the click
      const base = e.target.closest(BLOCKS);
      if (!base) return null;

      // Snap to our LEAF block (same rule used in segmentSentences)
      const leafSel = `:is(${BLOCKS}):not(:has(${BLOCKS}))`;
      const leafEl = base.closest(leafSel);
      if (!leafEl) return null;

      // Compute character offset within the leaf element
      const off = offsetInElementFromPoint(leafEl, e.clientX, e.clientY);
      if (off == null) return null;

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
      return idx;
    }

    // Double click on sentence to start playing there
    contentHost.addEventListener("dblclick", async (e) => {
      if (tts.playing) return; e.preventDefault();
      const idx = findIdxAtClick(e);
      if (idx !== null) playAt(idx);
    }, true);

    // Single click on sentence while playing to jump there
    contentHost.addEventListener("click", (e) => {
      if (!tts.playing) return; e.preventDefault();
      const idx = findIdxAtClick(e);
      if (idx !== null) playAt(idx);
    }, true);

  }
})();