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
    SUPERTONIC: 3,
    POCKET: 4,
    CANDLE: 5,
    MLX: 6,
  });

  const SERVERS = new Map([
    [
      Server.MY_KOKORO,
      { name: "Kokoro", active: true, speed: 1.0, chunk_size: [35, 200] },
    ],
    [Server.VOX_ANE, { name: "Vox", active: false, chunk_size: [35, 80] }],
    [
      Server.SUPERTONIC,
      {
        name: "SuperT",
        active: true,
        speed: 1.2,
        chunk_size: [80, 350],
        pause: 150,
      },
    ],
    [
      Server.POCKET,
      { name: "Pocket", active: true, chunk_size: [80, 350], pause: 0 },
    ],
    [
      Server.CANDLE,
      { name: "Candle", active: true, chunk_size: [80, 350], pause: 0 },
    ],
    [
      Server.MLX,
      { name: "P-mlx", active: false, chunk_size: [80, 350], pause: 0 },
    ],
  ]);

  const isSmallScrn = window.matchMedia('(max-width: 720px)').matches;
  const isAndroid = navigator.userAgent.includes("ndroid");

  let prefs = null; // saved preferences
  let overlay = null; // reader view overlay
  let surface = null; // inner focusable div of overrlay
  let contentHost = null; // div where main content resides

  // --------------------------
  // Storage helpers
  // --------------------------
  const STORAGE_KEY = "rv_prefs_v1";
  const defaults = {
    fontSize: 17,
    maxWidth: 860,
    server: Server.POCKET,
    voice: {},
    speeds: {},
    ratings: {},
    readingProgress: {},
    autoScroll: true,
  };
  async function loadPrefs() {
    try {
      const out = await chrome.storage.local.get(STORAGE_KEY);
      return { ...defaults, ...(out[STORAGE_KEY] || {}) };
    } catch {
      try {
        return {
          ...defaults,
          ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"),
        };
      } catch {
        return { ...defaults };
      }
    }
  }
  async function savePrefs() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: prefs });
    } catch {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      } catch {}
    }
  }

  // --------------------------
  // TTS Playback State
  // --------------------------
  const tts = {
    prepared: false,
    server: null,
    voice: "",
    speed: 1.0,
    texts: [],
    index: 0,
    playing: false,
    prefetchAhead: 3, // # TTS segments to prefetch
    statusEl: null, // status label
    voiceEl: null, // voice list control
    btnPlay: null,
    btnStop: null,
    btnNext: null,
    rating: null, // star rating control
    controls: null, // button group not including Play
    scrl: null, // auto scroll checkbox
    meta: [], // [{el,start,end}] parallel to tts.texts[index]
    highlightSpan: null, // active <span> wrapper for current sentence
  };

  const LONG_PAGE_THRESHOLD = 100; // Minimum segments to consider a page "long"
  const MAX_SAVED_PAGES = 100; // Max number of saved reading positions
  const currentPageUrl = window.location.href.split(/[?#]/)[0]; // Use URL without query/hash
  const _lang = (document.documentElement.lang || "en")
    .substring(0, 2)
    .toLowerCase();

  // Show status message to user
  // set msg to '' or omit to show playing status
  function setStatus(msg = "") {
    if (msg === "") {
      msg = `${tts.playing ? "▶️" : "Ready"} ${tts.index + 1} / ${tts.texts.length}`;
    }
    tts.statusEl.textContent = msg;
  }

  function playAt(idx, moveOnly = false) {
    if (idx < 0 || idx >= tts.texts.length) return;
    tts.index = idx;
    if (moveOnly || !tts.server) {
      saveReadingProgress();
      highlightCurrent();
      return;
    }
    stopPlayback();
    highlightCurrent();
    scheduleAt(idx);
  }

  // Main playback scheduler
  async function scheduleAt(index) {
    tts.index = index;
    saveReadingProgress();

    highlightCurrent();

    try {
      // Content is intentionally dumb:
      // it sends the desired window [index..index+prefetchAhead] and offscreen decides
      // what to stream/play/prefetch and how to serialize requests.
      tts.playing = true;
      tts.btnPlay.style.display = "none";
      tts.controls.style.display = "inherit";
      setStatus();

      const endIndex = Math.min(
        tts.texts.length - 1,
        index + tts.prefetchAhead,
      );
      const segments = [];
      for (let i = index; i <= endIndex; i++) {
        segments.push({ index: i, text: tts.texts[i] });
      }

      await chrome.runtime.sendMessage({
        type: "tts.fetchWindow",
        payload: {
          server: tts.server,
          voice: tts.voice,
          speed: tts.speed,
          lang: _lang,
          startIndex: index,
          endIndex,
          segments,
        },
      });

      return;
    } catch (err) {
      setStatus();
      console.log("Playback error:", err);
      if (index === tts.index) tts.btnNext.click();
    }
  }

  function stopPlayback(notifyBackground=true) {
    if (notifyBackground)
      chrome.runtime.sendMessage({ type: "tts.stop", payload: {} }).catch();

    tts.playing = false;
    tts.btnPlay.style.display = "inherit";
    tts.controls.style.display = "none";

    highlightReading();
    setStatus();
  }

  function restartAudio(continuePlay = true) {
    const wasPlaying = tts.playing;

    stopPlayback();

    if (wasPlaying && continuePlay)
      setTimeout(() => {
        playAt(tts.index);
      }, 500);
  }

  // Saves the current TTS reading progress (index) to storage.
  async function saveReadingProgress() {
    if (!tts.prepared || tts.texts.length < LONG_PAGE_THRESHOLD) {
      return;
    }

    // Fetch latest prefs from storage right now
    prefs = await loadPrefs();

    if (!prefs.readingProgress) prefs.readingProgress = {};

    if (tts.index == 0 || tts.index + 1 >= tts.texts.length)
      delete prefs.readingProgress[currentPageUrl];
    else
      prefs.readingProgress[currentPageUrl] = {
        index: tts.index,
        segments: tts.texts.length,
        timestamp: Date.now(),
      };

    // Prune the oldest entries
    const urls = Object.keys(prefs.readingProgress);
    const n = urls.length - MAX_SAVED_PAGES;
    if (n > 0) {
      urls.sort(
        (a, b) =>
          prefs.readingProgress[a].timestamp -
          prefs.readingProgress[b].timestamp,
      );
      for (let i = 0; i < n; i++) delete prefs.readingProgress[urls[i]];
    }

    await savePrefs();
  }

  // --------------------------
  // Toggle hooks
  // --------------------------
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;

      if (msg.type === "toggleReader") {
        toggle();
        return;
      }

      if (!tts.playing) return;
      const p = msg.payload || {};
      if (
        p.index !== tts.index
      )
        return;

      if (msg.type === "tts.playing") {
        setStatus(); // show Playing x/y
        highlightReading();
        return;
      }

      if (msg.type === "tts.ended") {
        if (!tts.playing) return;
        if (p.reason && p.reason !== "natural") {
          stopPlayback((notifyBackground=false));
          return;
        }
        const next = tts.index + 1;
        if (next < tts.texts.length) {
          let pause = SERVERS.get(tts.server).pause || 0;
          if (pause > 0) {
            pause += Math.random() * pause * 0.2;
            setTimeout(() => {
              scheduleAt(next);
            }, Math.ceil(pause));
          } else {
            scheduleAt(next);
          }
        } else {
          stopPlayback();
          tts.index = 0;
          setStatus("Finished");
        }
        return;
      }
      if (msg.type === "tts.error") {
        setStatus("TTS error:", p.error);
        stopPlayback();
        return;
      }
    });
  } catch {}

  function clearHighlight() {
    const target = tts.highlightSpan;
    if (!target) return;

    // Case 1: our normal wrapper span
    if (
      target.nodeType === Node.ELEMENT_NODE &&
      target.tagName === "SPAN" &&
      target.classList.contains("rv-tts-highlight") &&
      target.parentNode
    ) {
      const parent = target.parentNode;
      while (target.firstChild) parent.insertBefore(target.firstChild, target);
      parent.removeChild(target);
    } else if (
      target.nodeType === Node.ELEMENT_NODE &&
      target.classList &&
      target.classList.contains("rv-tts-highlight")
    ) {
      // Case 2: fallback where we just added a class to an existing element
      target.classList.remove("rv-tts-highlight");
      target.classList.remove("rv-tts-reading");
      target.classList.remove("rv-tts-inactive");
    }

    tts.highlightSpan = null;
  }

  function rangeFromOffsets(el, start, end) {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let cur = 0,
      startNode = null,
      startOff = 0,
      endNode = null,
      endOff = 0,
      n;
    while ((n = tw.nextNode())) {
      if (n.parentElement?.closest("sup") || n.parentElement?.closest("label"))
        continue;
      const len = n.nodeValue.length,
        next = cur + len;
      if (startNode == null && start >= cur && start <= next) {
        startNode = n;
        startOff = start - cur;
      }
      if (endNode == null && end >= cur && end <= next) {
        endNode = n;
        endOff = end - cur;
      }
      cur = next;
      if (startNode && endNode) break;
    }
    const r = document.createRange();
    if (!startNode || !endNode) {
      r.selectNodeContents(el);
      return r;
    }
    r.setStart(
      startNode,
      Math.max(0, Math.min(startOff, startNode.nodeValue.length)),
    );
    r.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.nodeValue.length)));
    return r;
  }

  function highlightCurrent(index = tts.index) {
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
      if (tts.scrl.checked)
        span.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (e) {
      // Fallback: just highlight the whole paragraph/element
      m.el.classList.add("rv-tts-highlight");
      if (!tts.playing) span.classList.add("rv-tts-inactive");
      tts.highlightSpan = m.el;
      if (tts.scrl.checked)
        m.el.scrollIntoView({ block: "center", behavior: "smooth" });
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
    let cur = 0,
      n;
    while ((n = tw.nextNode())) {
      if (n.parentElement?.closest("sup") || n.parentElement?.closest("label"))
        continue;
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
  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.id = "reader-view-overlay";
    const hideSmall = isSmallScrn ? 'style="display:none" ' : '';
    overlay.innerHTML = `
      <div id="rv-surface" role="dialog" aria-label="Reader View" tabindex="-1">
        <div id="rv-toolbar">
          <button class="rv-btn" id="rv-close" title="Exit">
          <svg viewBox="0 0 24 24" width="24" height="24"
            fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
            <path d="M14 4h6v16h-6"/>
            <path d="M12 12H6"/>
            <path d="m6 12 3-3"/>
            <path d="m6 12 3 3"/>
            <path d="M14 12h-1"/>
          </svg>
          </button>
          <div id="rv-tts" style="display:none">
            <div id="rv-servers-div">
              <select id="rv-servers-sel" style="display:none"></select>
            </div>
            <select id="rv-voice" title="Voice"></select>
            <button class="rv-btn" id="rv-voices-refresh" title="Refresh voices">
            <svg viewBox="0 0 24 24" width="16" height="16"
              fill="none" stroke="white" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
              <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-8.2-5.2"/>
              <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 8.2 5.2"/>
              <path d="M21 3v6h-6"/>
              <path d="M3 21v-6h6"/>
            </svg>
            </button>
            <div id="rv-rating-control" class="rv-rating-control" title="Rate the selected voice (0-3 stars)"></div>
            <div id="rv-speed-div" style="display:none">
            <label class="rv-inline" title="Speed">
            <input id="rv-speed" type="range" min="0.7" max="1.5" step="0.05" value="1.0" />
            </label>
            <span id="rv-speed-label"></span>
            </div>
            <div id="rv-speak-div">
            <button class="rv-btn" id="rv-tts-play" title="Speak">
            <svg viewBox="0 0 24 24" width="24" height="24"
              fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
              <path d="M11 5 6 9H3v6h3l5 4V5z"/>
              <path d="M15.5 8.5a4.5 4.5 0 0 1 0 7"/>
              <path d="M18 6a8 8 0 0 1 0 12"/>
            </svg><label for="rv-tts-play">Speak</label>
            </button>
            </div>
            <div id="rv-tts-controls" style="display:none">
            <button class="rv-btn" id="rv-tts-stop" title="Stop">
            <svg viewBox="0 0 24 24" width="24" height="24"
              fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
              <rect x="5" y="5" width="14" height="14" rx="2"/>
            </svg><label for="rv-tts-stop">stop</label>
            </button>
            <button class="rv-btn" id="rv-tts-prevp" title="Previous paragraph">
            <svg viewBox="0 0 24 24" width="24" height="24"
              fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
              <path d="M19 12H9"/>
              <path d="m11 7-5 5 5 5"/>
              <path d="m15 7-5 5 5 5"/>
            </svg>
            </button>
            <button class="rv-btn" id="rv-tts-prev" title="Previous sentence">
            <svg viewBox="0 0 24 24" width="24" height="24"
              fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
              <path d="M19 12H7"/>
              <path d="m11 6-6 6 6 6"/>
            </svg>
            </button>
            <button class="rv-btn" id="rv-tts-next" title="Next sentence">
            <svg viewBox="0 0 24 24" width="24" height="24"
              fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
              <path d="M5 12h12"/>
              <path d="m13 6 6 6-6 6"/>
            </svg>
            </button>
            <button class="rv-btn" id="rv-tts-nextp" title="Next paragraph">
            <svg viewBox="0 0 24 24" width="24" height="24"
              fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
              <path d="M5 12h10"/>
              <path d="m13 7 5 5-5 5"/>
              <path d="m9 7 5 5-5 5"/>
            </svg>
            </button>
            </div>
            <span id="rv-tts-status"></span>
            <div id="rv-jump-div" style="display:none">
              <input id="rv-jump-input" type="number" inputmode="numeric" step="1"
                  style="width:${isSmallScrn ? '30px' : '50px'};"/>
            </div>
          </div>
          <div id="rv-toolbar-rhs">
            <button class="rv-btn" id="rv-find-btn">
            <svg viewBox="0 0 24 24" width="20" height="20"
              fill="none" stroke="white" stroke-width="1.7"
              stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            </button>
            <div id="rv-find-panel" style="display:none; align-items:center; gap:1px;">
              <input id="rv-find-input" type="search" placeholder="Find" autocomplete="off" spellcheck="false"
                style="width:${isSmallScrn ? '80px' : '120px'};"/>
              <label for="rv-find-input" id="rv-find-count"></label>
              <button class="rv-btn rv-compact" id="rv-find-prev" title="Previous match">
                <svg viewBox="0 0 24 24" width="20" height="20"
                  fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
                  <path d="M15 18l-6-6 6-6"/>
                </svg>
              </button>
              <button class="rv-btn rv-compact" id="rv-find-next" title="Next match">
                <svg viewBox="0 0 24 24" width="20" height="20"
                  fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 6l6 6-6 6"/>
                </svg>
              </button>
            </div>
            <input id="rv-scrl" type="checkbox"/><label for="rv-scrl">${isSmallScrn ? 'scrl':'AutoScroll'}</label>
            <button class="rv-btn" id="rv-font-inc" title="Increase font">
            <svg viewBox="0 0 24 24" width="20" height="20"
              fill="none" stroke="white" stroke-width="1.7"
              stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
              <path d="M4.5 18.5 9.5 5.5 14.5 18.5"/>
              <path d="M6.7 14h5.6"/>
              <path d="M19 9v6"/>
              <path d="M16 12h6"/>
            </svg>
            </button>
            <button class="rv-btn" id="rv-font-dec" title="Decrease font">
            <svg viewBox="0 0 24 24" width="20" height="20"
              fill="none" stroke="white" stroke-width="1.6"
              stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
              <path d="M4.5 18.5 9.5 5.5 14.5 18.5"/>
              <path d="M6.7 14h5.6"/>
              <path d="M16 12h6"/>
            </svg>
            </button>
            <button class="rv-btn" id="rv-width-widen" ${hideSmall}title="Widen page">
            <svg width="20" height="20" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
              <g>
                <g>
                  <rect width="48" height="48" fill="none"/>
                </g>
                <g>
                  <g>
                    <path d="M30.6,28.6a1.9,1.9,0,0,0,.2,3,2.1,2.1,0,0,0,2.7-.2l5.9-6a1.9,1.9,0,0,0,0-2.8l-5.9-6a2.1,2.1,0,0,0-2.7-.2,1.9,1.9,0,0,0-.2,3L33.2,22H14.8l2.6-2.6a1.9,1.9,0,0,0-.2-3,2.1,2.1,0,0,0-2.7.2l-5.9,6a1.9,1.9,0,0,0,0,2.8l5.9,6a2.1,2.1,0,0,0,2.7.2,1.9,1.9,0,0,0,.2-3L14.8,26H33.2Z"/>
                    <path d="M42,10V38a2,2,0,0,0,4,0V10a2,2,0,0,0-4,0Z"/>
                    <path d="M6,38V10A2,2,0,0,0,2,10V38a2,2,0,0,0,4,0Z"/>
                  </g>
                </g>
              </g>
            </svg>
            </button>
            <button class="rv-btn" id="rv-width-narrow" ${hideSmall}title="Narrow page">
            <svg width="20" height="20" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
              <g>
                <g>
                  <rect width="48" height="48" fill="none"/>
                </g>
                <g>
                  <g>
                    <path d="M32.6,22.6a1.9,1.9,0,0,0,0,2.8l5.9,6a2.1,2.1,0,0,0,2.7.2,1.9,1.9,0,0,0,.2-3L38.8,26H44a2,2,0,0,0,0-4H38.8l2.6-2.6a1.9,1.9,0,0,0-.2-3,2.1,2.1,0,0,0-2.7.2Z"/>
                    <path d="M15.4,25.4a1.9,1.9,0,0,0,0-2.8l-5.9-6a2.1,2.1,0,0,0-2.7-.2,1.9,1.9,0,0,0-.2,3L9.2,22H4a2,2,0,0,0,0,4H9.2L6.6,28.6a1.9,1.9,0,0,0,.2,3,2.1,2.1,0,0,0,2.7-.2Z"/>
                    <path d="M26,10V38a2,2,0,0,0,4,0V10a2,2,0,0,0-4,0Z"/>
                    <path d="M22,38V10a2,2,0,0,0-4,0V38a2,2,0,0,0,4,0Z"/>
                  </g>
                </g>
              </g>
            </svg>
            </button>
          </div>
        </div>
        <div id="rv-content">
          <h1 id="rv-article-title"></h1>
          <p><em><span id="rv-article-byline">Loading...</span></em><p>
          <div id="rv-article-body"></div>
          <br/><br/>
        </div>
      </div>
    `;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.id = "rv-style-link";
    link.href = chrome.runtime.getURL("overlay.css");
    document.head.appendChild(link);
  }

  /* =========================
     Reader View Overlay Search
     ========================= */

  // state
  const rvFind = {
    matches: [],
    index: -1,
    overlaySpans: [], // store created highlights
  };

  // clear previous highlights
  function clearFind() {
    rvFind.overlaySpans.forEach(span => {
      if (span.parentNode) {
        const parent = span.parentNode;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        span.remove();
      }
    });
    // This merges the split text nodes back into one, fixing index drift
    contentHost.normalize();

    rvFind.overlaySpans = [];
    rvFind.matches = [];
    rvFind.index = -1;
  }

  // search texts
  function doFind(query) {
    clearFind();

    if (!query) {
      updateFindCounter();
      return;
    }

    // const safe = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(query, "gi");

    for (let i = 0; i < tts.texts.length; i++) {
      const text = tts.texts[i];
      let match;
      while ((match = regex.exec(text))) {
        rvFind.matches.push({
          segIndex: i,
          start: match.index,
          length: match[0].length,
        });
      }
    }

    applyFindHighlights();
    updateFindCounter();
    if (rvFind.matches.length) rvJumpTo(0);
  }

  // apply highlights via separate span, never touch original text nodes
  function applyFindHighlights() {
    rvFind.matches.forEach(m => {
      const meta = tts.meta[m.segIndex];
      if (!meta?.el) return;

      try {
        // CORRECT CALCULATION:
        // m.start is the position of the word WITHIN the segment.
        // meta.start is the position of the segment WITHIN the element.
        const matchStart = meta.start + m.start;
        const matchEnd = matchStart + m.length;

        // Use your existing range helper to find the specific text nodes
        const r = rangeFromOffsets(meta.el, matchStart, matchEnd);

        const span = document.createElement("span");
        span.className = "rv-find-mark";

        // Use document fragment extraction to safely wrap across nested tags
        const contents = r.extractContents();
        span.appendChild(contents);
        r.insertNode(span);

        rvFind.overlaySpans.push(span);
      } catch (e) {
        console.error("Highlighting failed:", e);
      }
    });
  }

  // jump to next/prev
  function rvJumpTo(i) {
    if (!rvFind.matches.length) return;
    rvFind.index = (i + rvFind.matches.length) % rvFind.matches.length;

    rvFind.overlaySpans.forEach(s => s.classList.remove("active"));

    const span = rvFind.overlaySpans[rvFind.index];
    if (!span) return;

    span.classList.add("active");
    span.scrollIntoView({ behavior: "smooth", block: "center" });

    updateFindCounter();
  }

  function rvNext() {
    rvJumpTo(rvFind.index + 1);
  }

  function rvPrev() {
    rvJumpTo(rvFind.index - 1);
  }

  function updateFindCounter() {
    const el = overlay.querySelector("#rv-find-count");
    if (!el) return;
    el.textContent = rvFind.matches.length
       ? `${rvFind.index + 1}/${rvFind.matches.length}`
       : "0";
  }

  function initFindUI() {
    let timer;

    const input = overlay.querySelector("#rv-find-input");
    const panel = overlay.querySelector("#rv-find-panel");

    overlay.querySelector("#rv-find-btn").onclick = () => {
      const visible = panel.style.display === "flex";
      panel.style.display = visible ? "none" : "flex";
      if (isSmallScrn) {
        overlay.querySelector("#rv-tts").style.display = visible ? "flex" : "none";
      }
      if (visible) {
        clearFind();
      } else {
        input.focus();
        input.select();
        doFind(input.value);
      }
    };

    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => doFind(input.value),
        isAndroid || tts.texts.length > 1000
        ? 1000
        : 300);
    });

    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.shiftKey ? rvPrev() : rvNext();
        e.preventDefault();
      }
    });

    overlay.querySelector("#rv-find-next").onclick = rvNext;
    overlay.querySelector("#rv-find-prev").onclick = rvPrev;
  }

  function attachOverlay() {
    document.getElementById("reader-view-overlay")?.remove();

    contentHost = overlay.querySelector("#rv-content");
    surface = overlay.querySelector("#rv-surface");

    // Apply saved prefs
    surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
    contentHost.style.setProperty(
      "--rv-font-family",
      "Verdana,Geneva,Helvetica,sans-serif",
    );
    contentHost.style.setProperty("--rv-maxw", `${prefs.maxWidth}px`);
    if (prefs.server && SERVERS.has(prefs.server)) tts.server = prefs.server;

    // save UI elements
    tts.voiceEl = overlay.querySelector("#rv-voice");
    tts.statusEl = overlay.querySelector("#rv-tts-status");
    tts.btnPlay = overlay.querySelector("#rv-tts-play");
    tts.btnStop = overlay.querySelector("#rv-tts-stop");
    tts.btnNext = overlay.querySelector("#rv-tts-next");
    tts.controls = overlay.querySelector("#rv-tts-controls");
    tts.rating = overlay.querySelector("#rv-rating-control");
    tts.scrl = overlay.querySelector("#rv-scrl");

    document.documentElement.appendChild(overlay);
    surface.focus();
  }

  const BLOCKS = "p, div, blockquote, li, dt, dd, h1, h2, h3, h4, h5, h6, pre";

  // Pre-compile regexes and moves constants outside for performance
  const ABBREV = new Set([
    "Mr",
    "Mrs",
    "Ms",
    "Dr",
    "Prof",
    "Sr",
    "Jr",
    "St",
    "Bros",
    "V",
    "v",
    "Fig",
    "Det",
    "Rev",
    "Sen",
    "Capt",
    "Sgt",
    "Col",
    "Adm",
    "etc",
    "U.S",
    "U.K",
    "A.I",
    "A.M",
    "P.M",
    "a.m",
    "p.m",
    "e.g",
    "i.e",
    "a.k.a",
    "Vs",
    "vs",
    "cf",
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Sept",
    "Oct",
    "Nov",
    "Dec",
  ]);

  const RE_ABBREV_FALLBACK = /[^A-Z.]([A-Z]\.)+$/;
  const RE_ABBREV_MATCH = /[^A-Za-z.]([A-Za-z.]+)\.$/;
  const SEGMENTER = new Intl.Segmenter(_lang, { granularity: "sentence" });

  // Helper: choose a split index (within str) for long chunks.
  // Only split at ",", ";" or "--" near the middle. If nothing found, return -1.
  function chooseSplitIndex(str) {
    const len = str.length;
    if (len < 2) return -1;

    const mid = Math.floor(len / 2);

    const isGoodPunctBoundary = (i) => {
      // we split "after" i - 1
      const prev = str[i - 1];
      const prev2 = str[i - 2];
      // split on , but not in number like 10,000
      if (prev === "," && !/[0-9]/.test(str[i])) return true;
      if ([";", "–", "—", ")", "]"].includes(prev)) return true;
      if (prev === "-" && prev2 === "-") return true; // "--"
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

  const TTS_SKIP_BLOCKS = [
    "header",
    "footer",
    "caption",
    "figcaption",
    '[attr*="caption"]',
    '[attr*="header"]',
    '[attr*="author"]',
    "[aria-hidden]",
    "header *",
    "footer *",
    "caption *",
    "figcaption *",
    '[attr*="caption"] *',
    '[attr*="header"] *',
    '[attr*="author"] *',
    "[aria-hidden] *",
  ].join(", ");

  function segmentSentences() {
    const [MIN_CHARS, MAX_CHARS] = SERVERS.get(tts.server)?.chunk_size || [
      35, 150,
    ];

    const scope = contentHost.querySelector("#rv-article-body");
    if (!scope) return { texts: [], meta: [] };

    const allBlocks = Array.from(
      scope.querySelectorAll(`:is(${BLOCKS}):not(${TTS_SKIP_BLOCKS})`),
    );

    // Filter for containers that have direct text or are leaf nodes
    const validContainers = allBlocks.filter((el) => {
      const hasDirectText = Array.from(el.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim().length > 5,
      );
      return hasDirectText || !el.querySelector(BLOCKS);
    });

    const texts = [];
    const meta = [];

    // Helper to push result
    function emit(plain, el, s, e) {
      const spoken = plain.slice(s, e).trim();
      if (!spoken) return;

      if (MAX_CHARS && spoken.length > MAX_CHARS) {
        const rel = chooseSplitIndex(spoken);
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

    // Use a Set for O(1) lookups inside the TreeWalker
    const containerSet = new Set(validContainers);
    const SKIP_TEXTS = ["Reading time", "Temps de lecture"];

    for (const el of validContainers) {
      // Use matches() to skip sup/label and check containerSet to prevent double-reading nested blocks
      let inBlockQuote = false;
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const p = n.parentElement;
          if (p.matches("sup, sup *, label, label *"))
            return NodeFilter.FILTER_REJECT;
          if (SKIP_TEXTS.some((txt) => n.textContent.includes(txt)))
            return NodeFilter.FILTER_REJECT;
          if (p.matches("blockquote, blockquote *")) inBlockQuote = true;

          let walk = p;

          while (walk && walk !== el) {
            if (containerSet.has(walk)) return NodeFilter.FILTER_REJECT;
            walk = walk.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      let plain = "";
      let n;
      while ((n = tw.nextNode())) {
        plain += n.nodeValue;
      }
      if (!plain) continue;

      // fix for <blockquote> text somehow getting turned into
      // " ...... "
      // " ...... "
      // which screws up our segmenting
      if (inBlockQuote)
        plain = plain.replace(/["\r\n]/g, " ").replace(/\s{2,}/g, " ");

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

        // Check abbreviation
        let isAbbrev = false;
        if (trimmed.endsWith(".")) {
          if (RE_ABBREV_FALLBACK.test(trimmed)) isAbbrev = true;
          else {
            const m = trimmed.match(RE_ABBREV_MATCH);
            if (m && ABBREV.has(m[1])) isAbbrev = true;
          }
        }

        if (!isAbbrev && trimmed.length >= MIN_CHARS) {
          emit(plain, el, groupStart, groupEnd);
          groupStart = -1;
          pendingText = "";
        }
      }

      // Emit remaining text
      if (groupStart !== -1) {
        emit(plain, el, groupStart, groupEnd);
      }
    }

    return { texts, meta };
  }

  // segment page into sentence chunks for TTS
  function buildSegments() {
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
    const { texts, meta } = segmentSentences();
    tts.texts = texts;
    tts.meta = meta;
    tts.segments = new Array(texts.length).fill(0);
    tts.prepared = true;

    // Try to restore the reading index
    if (savedEl) {
      const newIdx = tts.meta.findIndex(
        (m) => m.el === savedEl && m.start >= savedOffset,
      );
      tts.index = newIdx !== -1 ? newIdx : 0;
    } else {
      // clamp tts.index
      if (tts.index + 1 >= tts.texts.length) tts.index = 0;
    }

    setTimeout(() => {
      highlightCurrent();
      setStatus();
    }, Math.floor(tts.texts.length / 5));
  }

  // --------------------------
  // Main toggle function
  // --------------------------
  async function toggle() {
    const existing = document.getElementById("reader-view-overlay");
    if (existing) {
      existing.querySelector("#rv-close")?.click();
      return;
    }
    if (!window.Readability) {
      console.error("Readability not found. Inject readability.js first.");
      return;
    }

    const cloned = document.cloneNode(true);

    buildOverlay();

    prefs = await loadPrefs();
    tts.server = prefs.server;

    attachOverlay();
    setupMiscControls();
    await setupTTSControls();

    const REMOVE_SELECTORS = [
      "style",
      "script",
      "noscript",
      "dialog",
      "modal",
      "form",
      "header",
      "footer",
      "aside",
      "nav",
      "time",
      "date",
      '[rel*="category"]',
      '[class*="footer"]',
      '[class*="tags"]',
      '[class*="signup"]',
      '[class*="social"]',
      '[class*="subscribe"]',
      '[class*="subscription"]',
      '[class*="hidden"]',
      '[class*="restricted"]',
      '[class*="author-box"]',
      '[class*="share"]',
    ];
    PER_SITE_REMOVE = [
      ["lesswrong.com", '[class*="FixedPositionToC"]'],
      ["slate.fr", '[class*="to-read"]'],
      ["stratechery.com", "sup, sup *"],
      ["poets.org", '[class*="field_credit"]'],
      ["/books/", '[type="pagebreak"]'],
    ];
    for (const [url, elem] of PER_SITE_REMOVE) {
      if (currentPageUrl.includes(url)) {
        REMOVE_SELECTORS.push(elem);
        break;
      }
    }
    cloned
      .querySelectorAll(REMOVE_SELECTORS.join(","))
      .forEach((el) => el.remove());

    const junkPhrases = [
      "Skip to main content",
      "Sign up for",
      "Subscribe to",
      "Continue reading",
      "Most Popular",
      "Follow us on",
      "Abonnez-vous gratuitement",
    ];
    cloned
      .querySelectorAll(`:is(${BLOCKS},a):not(:has(${BLOCKS}))`)
      .forEach((el) => {
        if (junkPhrases.some((phrase) => el.textContent.includes(phrase)))
          el.remove();
      });

    // if there is <article> remove all blocks not a descendant or ancestor of <article>
    if (cloned.querySelector("article")) {
      cloned
        .querySelectorAll(`:is(${BLOCKS}):not(article *):not(:has(article))`)
        .forEach((el) => el.remove());
    }

    document.documentElement.classList.add("rv-active");

    const options = {
      classesToPreserve: [/header|caption|author/],
    };
    const article = new window.Readability(cloned, options).parse();

    overlay.querySelector("#rv-article-byline").textContent = article?.byline || "";
    const titleEl = overlay.querySelector("#rv-article-title");
    if (!article?.content) {
      titleEl.textContent = "Readability returned no content.";
      return;
    }
    titleEl.textContent = article.title;

    const savedProgress = prefs.readingProgress[currentPageUrl];
    tts.index = savedProgress?.index || 0;

    // when navigating away, the overlay is not destroyed,
    // but it is now disconnected from background.js.
    // So on pageshow, we need to remove the zombie overlay
    window.addEventListener('pageshow', (event) => {
      // event.persisted is true if the page was restored from BFCache
      if (event.persisted) {
        cleanup(notifyBackground=false);  // remove orphaned overlay
      }
    });

    // don't attach article content until we finish building UI
    // otherwise adding UI elements causes DOM restructuring
    // which is slow on very large pages
    overlay.querySelector("#rv-article-body").innerHTML = article.content;

    buildSegments();
  }

  function generateRatingControlHTML(rating) {
    let html = "";
    for (let i = 3; i >= 1; i--) {
      const starChar = "★";
      const isRated = i <= rating ? "rated" : "";
      html += `<span class="rv-rating-star ${isRated}" data-rating-val="${i}">${starChar}</span>`;
    }
    return html;
  }

  function getCurrentRating() {
    return prefs.ratings?.[tts.server]?.[tts.voice] || 0;
  }

  // Re-generate HTML to apply 'rated' class for persistence and correct character/color.
  function updateRatingDisplay() {
    const rating = getCurrentRating();
    tts.rating.innerHTML = generateRatingControlHTML(rating);
  }

  function switchServer(val) {
    const newServer = parseInt(val, 10);
    if (newServer == tts.server) return;
    restartAudio();
    tts.server = newServer;
    prefs.server = newServer;
    buildSegments();
    const speedDiv = overlay.querySelector("#rv-speed-div");
    speedDiv.style.display = SERVERS.get(tts.server)?.speed
      ? "inherit"
      : "none";
    updateRatingDisplay();
    savePrefs();
    updateVoiceUI();
  }

  async function loadServerUI() {
    const actives = new Map();
    let liveServer = null;

    // collect active servers
    for (const [id, server] of SERVERS.entries()) {
      server.voices = [];
      if (!server.active) continue;
      // load voices from server, thereby checking if server is alive
      try {
        const res = await chrome.runtime.sendMessage({
          type: "tts.listVoices",
          payload: { server: id },
        });
        if (res?.ok) {
          server.voices = res.voices;
          liveServer ||= id;
        }
      } catch {}
      if (server.voices.length > 0) actives.set(id, server);
    }

    // fallback to first live server if current server is not responding
    if (!SERVERS.get(tts.server)?.voices?.length) tts.server = liveServer;

    if (actives.size === 0) return;

    const fragment = document.createDocumentFragment();

    if (actives.size <= (isSmallScrn ? 2 : 4)) {
      for (const [id, server] of actives.entries()) {
        const radioInput = document.createElement("input");
        radioInput.type = "radio";
        radioInput.id = `server-${id}`;
        radioInput.name = "tts_server";
        radioInput.value = id;
        radioInput.checked = id == tts.server || id == liveServer;
        const radioLabel = document.createElement("label");
        radioLabel.htmlFor = `server-${id}`;
        radioLabel.textContent = server.name;
        fragment.appendChild(radioInput);
        fragment.appendChild(radioLabel);

        radioInput.addEventListener("change", (event) => {
          if (event.target.checked) switchServer(event.target.value);
        });
      }
      const serversDiv = overlay.querySelector("#rv-servers-div");
      serversDiv.replaceChildren(fragment);
    } else {
      for (const [id, server] of actives.entries()) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = server.name;
        opt.selected = id == tts.server || id == liveServer;
        fragment.appendChild(opt);
      }
      const serversSel = overlay.querySelector("#rv-servers-sel");
      serversSel.replaceChildren(fragment);
      serversSel.style.display = "inline";
      serversSel.addEventListener("change", (event) => {
        switchServer(event.target.value);
      });
    }
  }

  function updateVoiceUI() {
    const serverVoiceRatings = prefs.ratings[tts.server] || {};
    const voices = SERVERS.get(tts.server).voices;
    if (voices.length) {
      // 1. Prepare for sorting
      let voiceData = voices.map((v) => ({
        name: v,
        rating: serverVoiceRatings[v] || 0,
      }));

      // 2. Sort by rating (descending). The highest rated voices appear first.
      // voiceData.sort((a, b) => b.rating - a.rating);

      // 3. Populate dropdown
      const fragment = document.createDocumentFragment();
      for (const data of voiceData) {
        const opt = document.createElement("option");
        opt.value = data.name;
        const stars = "⭐".repeat(Math.min(3, data.rating));
        opt.textContent = stars ? `${data.name}  ${stars}` : data.name;
        fragment.appendChild(opt);
      }
      tts.voiceEl.replaceChildren(fragment);

      // 4. Set selected voice
      const preferred = prefs.voice[tts.server];
      tts.voiceEl.value = voices.includes(preferred)
        ? preferred
        : voices[0] || "";
      tts.voice = tts.voiceEl.value;
      updateRatingDisplay();
      updateSpeedUI();
    }
  }

  function updateSpeedUI() {
    const serverDefault = SERVERS.get(tts.server)?.speed || 1.0;
    const savedSpeed = prefs.speeds?.[tts.server]?.[tts.voice];
    const speedValue = savedSpeed ?? serverDefault;
    const speedInp = overlay.querySelector("#rv-speed");
    const speedLabel = overlay.querySelector("#rv-speed-label");
    tts.speed = speedValue;
    speedInp.value = speedValue;
    speedLabel.textContent = `${speedValue}x`;
  }

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

  function findIdxAtClick(e) {
    const scope = contentHost.querySelector("#rv-article-body");
    if (!scope) return null;

    // Start from the block element that was actually clicked
    let el = e.target.closest(BLOCKS);
    if (!el) return null;

    // Walk up until we find the element we actually registered in tts.meta.
    // We stop at scope to stay within the article bounds.
    while (el && scope.contains(el)) {
      if (tts.meta.some((m) => m.el === el)) break;
      const parent = el.parentElement?.closest(BLOCKS);
      if (!parent) break;
      el = parent;
    }

    if (!el) return null;

    // Compute character offset within the identified overlay
    const off = offsetInElementFromPoint(el, e.clientX, e.clientY);
    if (off == null) return null;

    // Find the sentence in this element that spans the offset
    let idx = -1;
    for (let i = 0; i < tts.meta.length; i++) {
      const m = tts.meta[i];
      if (m.el === el && off >= m.start && off < m.end) {
        idx = i;
        break;
      }
    }

    // Fallback: first sentence in this element
    if (idx < 0) {
      idx = tts.meta.findIndex((m) => m.el === el);
    }
    return idx;
  }

  function playAtClick(e, moveOnly = false) {
    if (!moveOnly) e.preventDefault(); // allow clicking on links
    const idx = findIdxAtClick(e);
    if (idx !== null) playAt(idx, moveOnly);
  }

  async function cleanup(notifyBackground=true) {
    stopPlayback(notifyBackground);
    if (notifyBackground) {
      chrome.runtime.sendMessage({ type: "tts.cleanup", payload: {} }).catch();
    }
    overlay?.remove();
    document.removeEventListener("keyup", onKey, true);
    document.removeEventListener("copy", onCopy, true);
    // outside.forEach(n => { try { n.removeAttribute("inert"); } catch(_){} });
    document.documentElement.classList.remove("rv-active");
    tts.prepared = false;
    tts.texts = [];
    tts.index = 0;
    tts.meta = [];
    tts.server = null;
    tts.highlightSpan = null;
    clearFind();
  }

  function onKey(e) {
    const accel = e.metaKey || e.ctrlKey;
    if (accel && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectTarget();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (tts.statusEl?.style.display === "none") {
        tts.statusEl.click();
      } else if (overlay?.querySelector("#rv-find-panel")?.style.display === "flex")
        overlay.querySelector("#rv-find-btn").click();
      else
        cleanup();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!e.altKey && e.key === "F2") {
      e.preventDefault();
      overlay.querySelector("#rv-find-btn").click();
      return;
    }
    if ((e.keyCode == 32 && e.altKey) || (e.key == "F8" && !e.altKey)) {
      e.preventDefault();
      if (tts.playing) tts.btnStop.click();
      else tts.btnPlay.click();
      return;
    }
    if (!e.altKey) return;
    if (e.key == "F9") {
      e.preventDefault();
      prefs.fontSize = Math.min(32, prefs.fontSize + 1);
      surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
      savePrefs();
      return;
    } else if (e.keyCode == 189) {
      e.preventDefault();
      prefs.fontSize = Math.max(12, prefs.fontSize - 1);
      surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
      savePrefs();
      return;
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

  function selectTarget() {
    const target = contentHost.querySelector("#rv-article-body");
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function setupMiscControls() {
    tts.scrl.checked = prefs.autoScroll;
    tts.scrl.addEventListener("change", () => {
      prefs.autoScroll = tts.scrl.checked;
      savePrefs();
      highlightCurrent();
      highlightReading();
    });

    // dbl click, middle click, or meta + click on sentence while not playing to start playing there
    contentHost.addEventListener(
      "dblclick",
      (e) => {
        if (!tts.playing) playAtClick(e);
      },
      true,
    );

    contentHost.addEventListener(
      "mouseup",
      (e) => {
        if (e.button === 1) playAtClick(e);
      },
      true,
    );

    contentHost.addEventListener(
      "click",
      (e) => {
        if (e.metaKey) {
          playAtClick(e);
          return;
        }
        // Single click: if playing, then start playing there, else just move index
        playAtClick(e, (moveOnly = !tts.playing));
      },
      true,
    );

    // Toolbar handlers
    overlay.querySelector("#rv-close").addEventListener("click", cleanup);

    const jumpDiv = overlay.querySelector("#rv-jump-div");
    const jumpInp = overlay.querySelector("#rv-jump-input");
    tts.statusEl.addEventListener("click", () => {
      if (tts.statusEl.style.display === "none") {
        jumpDiv.style.display = "none";
        tts.statusEl.style.display = "inherit";
      } else {
        jumpDiv.style.display = "inline";
        tts.statusEl.style.display = "none";
        if (!jumpInp.value) jumpInp.value = tts.index;
        jumpInp.focus();
        jumpInp.select();
        jumpInp.placeholder = `${tts.index} / ${tts.texts.length}`;
      }
    });
    jumpInp.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        let idx = jumpInp.value.trim();
        if (idx === "") return;
        idx = Number(idx);
        if (!isFinite(idx) || idx < 0 || idx >= tts.texts.length) return;
        idx = Math.floor(idx);
        jumpInp.value = idx;
        tts.index = idx;
        if (tts.playing) restartAudio();
        else {
          highlightCurrent();
          setStatus();
        }
      }
    });
    jumpInp.addEventListener("blur", () => {
      if (jumpDiv.style.display !== "none") tts.statusEl.click();
    });

    initFindUI();

    overlay.querySelector("#rv-font-inc").addEventListener("click", () => {
      prefs.fontSize = Math.min(32, prefs.fontSize + 1);
      surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
      savePrefs();
    });
    overlay.querySelector("#rv-font-dec").addEventListener("click", () => {
      prefs.fontSize = Math.max(12, prefs.fontSize - 1);
      surface.style.setProperty("--rv-font-size", `${prefs.fontSize}px`);
      savePrefs();
    });
    overlay.querySelector("#rv-width-widen").addEventListener("click", () => {
      prefs.maxWidth = Math.min(1400, prefs.maxWidth + 40);
      contentHost.style.setProperty("--rv-maxw", `${prefs.maxWidth}px`);
      savePrefs();
    });
    overlay.querySelector("#rv-width-narrow").addEventListener("click", () => {
      prefs.maxWidth = Math.max(520, prefs.maxWidth - 40);
      contentHost.style.setProperty("--rv-maxw", `${prefs.maxWidth}px`);
      savePrefs();
    });
    document.addEventListener("keyup", onKey, true);
    document.addEventListener("copy", onCopy, true);
  }

  // --------------------------
  // TTS Controls
  // --------------------------
  async function setupTTSControls() {
    await loadServerUI();
    if (!tts.server) return;

    const speedInp = overlay.querySelector("#rv-speed");
    const speedLabel = overlay.querySelector("#rv-speed-label");
    const btnPrev = overlay.querySelector("#rv-tts-prev");
    const btnNextP = overlay.querySelector("#rv-tts-nextp");
    const btnPrevP = overlay.querySelector("#rv-tts-prevp");

    updateVoiceUI();

    if (SERVERS.get(tts.server)?.speed)
      overlay.querySelector("#rv-speed-div").style.display = "inherit";

    overlay.querySelector("#rv-tts").style.display = "inherit";

    // Handle click to set rating
    tts.rating.addEventListener("click", (e) => {
      const target = e.target.closest(".rv-rating-star");
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

      savePrefs().then(() => {
        // Update the interactive display and the dropdown list
        updateRatingDisplay();
        // Need to call updateVoiceUI to update the dropdown text and sort
        updateVoiceUI();
      });
    });

    tts.voiceEl.addEventListener("change", () => {
      if (tts.voice !== tts.voiceEl.value) {
        // const wasPlaying = tts.playing;
        tts.voice = tts.voiceEl.value;
        prefs.voice[tts.server] = tts.voiceEl.value;
        updateRatingDisplay();
        updateSpeedUI();
        savePrefs();
        restartAudio();
      }
    });

    overlay
      .querySelector("#rv-voices-refresh")
      .addEventListener("click", async (e) => {
        if (!tts.server) return;
        const btn = e.target;
        try {
          setStatus("Refreshing voices...");
          btn.disabled = true;
          const r = await chrome.runtime.sendMessage({
            type: "tts.refreshVoices",
            payload: { server: tts.server },
          });
          if (!r || !r.ok) throw new Error(r?.error || "Refresh failed");

          const cfg = SERVERS.get(tts.server);
          cfg.voices = r.voices;

          // Re-render dropdown and keep current selection if possible
          const keep = tts.voice;
          updateVoiceUI();
          if (keep && cfg.voices.includes(keep)) {
            tts.voiceEl.value = keep;
            tts.voice = keep;
          }
          setStatus("Voices refreshed");
        } catch {
          setStatus("Refresh failed");
        } finally {
          btn.disabled = false;
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

        savePrefs();
        restartAudio(continuePlay=false);
      }
    });

    // Button handlers
    tts.btnPlay.onclick = async () => {
      const startIndex = Math.max(0, tts.index);
      playAt(startIndex);
    };

    tts.btnStop.onclick = () => {
      stopPlayback();
      // saveReadingProgress();
    };

    btnPrev.onclick = () => {
      playAt(tts.index - 1);
    };

    tts.btnNext.onclick = () => {
      playAt(tts.index + 1);
    };

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
  }
})();
