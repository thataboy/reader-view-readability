// content.js
(function () {
  if (window.__readerViewInstalled) return;
  window.__readerViewInstalled = true;

  // --------------------------
  // Server definitionss
  // --------------------------
  const Server = Object.freeze({
      MY_KOKORO: 1,
      VOX_ANE: 2
  });

  const SERVER_NAME = new Map([
    [Server.MY_KOKORO, 'Kokoro'],
    [Server.VOX_ANE, 'Vox']
  ]);

  // --------------------------
  // Storage helpers
  // --------------------------
  const STORAGE_KEY = "rv_prefs_v1";
  const defaults = { fontSize: 17, maxWidth: 860, voice: {}, speed: 1.0, server: Server.MY_KOKORO };
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
    server: Server.MY_KOKORO,
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
    prefetchAhead: 3,    // # TTS segments to prefetch
    keepBehind: 1,
    statusEl: null,      // status label
    voiceEl: null,       // voice list control
    btnPlay: null,
    btnStop: null,
    btnNext: null,
    controls: null,      // button group not including Play
    meta: [],            // [{el,start,end}] parallel to tts.texts[index]
    highlightSpan: null, // active <span> wrapper for current sentence
  };

  function ttsKey(i){ return `seg:${i}`; }
  function ensureCtx() {
    if (!tts.audioCtx || tts.audioCtx.state === "closed") {
      tts.audioCtx = new (AudioContext || webkitAudioContext)({ sampleRate: 24000 });
    }
    return tts.audioCtx;
  }

  // Show status message to user
  // set msg to '' or omit to show playing status
  function setStatus(msg = '') {
    if (msg==='' && tts.playing) {
      msg = `Playing ${tts.index + 1} / ${tts.segments.length}`;
    }
    tts.statusEl.textContent = msg;
    // console.log(msg);
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

  // Ensure only one remote synthesis runs at a time across segments
  let synthChain = Promise.resolve();
  function withSynthLock(fn) {
    const next = synthChain.then(fn);
    // keep the chain alive even if a task throws
    synthChain = next.catch(() => {});
    return next;
  }
  // Fetch + decode a segment through background proxy
  async function fetchAndDecodeSegment(i) {
    const k = ttsKey(i);

    const text = tts.texts[i];

    // 1) Already decoded
    if (tts.decoded.has(k)) return tts.decoded.get(k);

    // 2) Already in flight for this index: reuse its Promise
    if (tts.inFlight.has(i)) {
      return tts.inFlight.get(i);
    }

    // 3) New synth task for this index
    const task = (async () => {
      try {
        setStatus(`Text→Speech ${i + 1} / ${tts.segments.length} ...`);

        // Only one synth at a time goes through this lock
        const response = await withSynthLock(() =>
          chrome.runtime.sendMessage({
            type: "tts.synthesize",
            payload: {
              text: tts.texts[i],
              voice: tts.voice,
              speed: tts.speed,
              server: tts.server
            }
          })
        );

        if (!response?.ok) throw new Error(response?.error || "Synthesis failed");

        const buf = base64ToArrayBuffer(response.base64);
        const ab = await decodeBuffer(i, buf);
        setStatus();
        return ab;
      } catch (err) {
        setStatus(`Error: ${err.message}`);
        throw err;
      } finally {
        tts.inFlight.delete(i);
      }
    })();

    tts.inFlight.set(i, task);
    return task;
  }

  function expectedDurationFromText(text) {
    // const charsPerSecond = (tts.voice == '_helen') ? 12.5 :
    //   (tts.voice == '_jameson') ? 10.5 :
    //   (tts.voice == '_denise') ? 13.0 :
    //   (tts.voice == '_caroline') ? 13.0 :
    //   (tts.voice == '_david') ? 10.0 :
    //   (tts.voice == '_emily-11') ? 10.0 :
    //   (tts.voice == '_emilyB-11') ? 10.0 :
    //   (tts.voice == '_dorothy-11') ? 8.0 :
    //   (tts.voice == '_scholar') ? 11.0 :
    //   (tts.voice == '_thomas-11') ? 10.0 :
    //   9.0;
    return Math.max(2.0, text.length / 9.0);//charsPerSecond);
  }

  // Main playback scheduler
  async function scheduleAt(index) {
    const token = ++tts.playToken;

    highlightCurrent(index);
    try {
      // Fetch and Wait for this segment's audio
      const cur = await fetchAndDecodeSegment(index);
      // If something changed (voice/jump/stop) while we were waiting, bail
      if (!tts.playing || !tts.segments.length) return;

      tts.index = index;
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
        const next = index + 1;
        if (next < tts.segments.length) {
          scheduleAt(next);
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
      // const t0 = ctx.currentTime; + 0.12;
      tts.playing = true;
      if (tts.server == Server.VOX_ANE) {
        const maxDuration = expectedDurationFromText(tts.texts[index]);
        if (maxDuration < src.buffer.duration) {
          console.log(`${maxDuration.toFixed(2)} < ${src.buffer.duration}`);
        }
        src.start(0, 0, maxDuration);
      } else {
        src.start(0, 0);
      }
      setStatus(`Playing ${index + 1} / ${tts.segments.length}`);
      highlightReading();
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
      console.log("Playback error:", err);
      setStatus(`Playback failed: ${err.message}`);
      tts.btnNext.click();
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
    setStatus("Ready");
  }

  // --------------------------
  // Toggle hooks
  // --------------------------
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "toggleReader") toggle();
    });
  } catch {}

  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "r") { e.preventDefault(); toggle(); }
    if (e.altKey && e.keyCode === 32 && tts?.btnPlay) {
      if (tts.playing) tts.btnStop.click(); else tts.btnPlay.click();
    }
  }, true);

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
      // More robust than surroundContents: this splits nodes if needed
      const contents = r.extractContents();
      span.appendChild(contents);
      r.insertNode(span);
      tts.highlightSpan = span;
      span.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (e) {
      // Fallback: just highlight the whole paragraph/element
      m.el.classList.add("rv-tts-highlight");
      tts.highlightSpan = m.el;
      m.el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function highlightReading() {
    const target = tts.highlightSpan;
    if (!target) return;
    target.classList.add("rv-tts-reading");
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
      <div id="rv-surface" role="dialog" aria-label="Reader View" tabindex="-1">
        <div id="rv-toolbar">
          <button class="rv-btn" id="rv-close" title="Close"><img></button>
          <div class="rv-group">
            <button class="rv-btn" id="rv-font-inc" title="Increase font"><img></button>
            <button class="rv-btn" id="rv-font-dec" title="Decrease font"><img></button>
            <button class="rv-btn" id="rv-width-widen" title="Widen page"><img></button>
            <button class="rv-btn" id="rv-width-narrow" title="Narrow page"><img></button>
          </div>
          <div class="rv-spacer">
            <div id="rv-tts" style="margin-left:5px;display:flex;gap:4px;align-items:center">
              <div id="rv-servers"></div>
              <select id="rv-voice" title="Voice"></select>
              <label class="rv-inline" title="Speed">
              <input id="rv-speed" type="range" min="0.7" max="1.5" step="0.05" value="1.0" />
              </label>
              <span id="rv-speed-label"></span>
              <button class="rv-btn" id="rv-tts-play" title="Play"><img></button>
              <div id="rv-tts-controls" style="display:none">
              <button class="rv-btn" id="rv-tts-stop" title="Stop"><img></button>
              <button class="rv-btn" id="rv-tts-prevp" title="Previous paragraph"><img></button>
              <button class="rv-btn" id="rv-tts-prev" title="Previous sentence"><img></button>
              <button class="rv-btn" id="rv-tts-next" title="Next sentence"><img></button>
              <button class="rv-btn" id="rv-tts-nextp" title="Next paragraph"><img></button>
              </div>
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
    if (prefs.server && SERVER_NAME.get(prefs.server)) tts.server = prefs.server;

    // save status element
    tts.voiceEl = container.querySelector("#rv-voice");
    tts.statusEl = container.querySelector("#rv-tts-status");
    tts.btnPlay = container.querySelector("#rv-tts-play");
    tts.btnStop = container.querySelector("#rv-tts-stop");
    tts.btnNext = container.querySelector("#rv-tts-next");
    tts.controls = container.querySelector("#rv-tts-controls");
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
    setupStaticTTSControls(container, contentHost, prefs);
  }

  // --------------------------
  // Main toggle function
  // --------------------------
  async function toggle() {
    const existing = document.getElementById("reader-view-overlay");
    if (existing) { existing.querySelector("#rv-close")?.click(); return; }
    if (!window.Readability) { console.error("Readability not found. Inject readability.js first."); return; }

    document.querySelectorAll(`script, modal, form, [class*="hidden"]`).forEach(el => el.remove());

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

  // --------------------------
  // TTS Controls
  // --------------------------
  function setupStaticTTSControls(overlay, contentHost, prefs) {
    const voiceEl = overlay.querySelector("#rv-voice");
    const speedInp = overlay.querySelector("#rv-speed");
    const speedLabel = overlay.querySelector("#rv-speed-label");
    const btnPlay = overlay.querySelector("#rv-tts-play");
    const btnStop = overlay.querySelector("#rv-tts-stop");
    const btnPrev = overlay.querySelector("#rv-tts-prev");
    const btnNext = overlay.querySelector("#rv-tts-next");
    const btnPrevP = overlay.querySelector("#rv-tts-prevp");
    const btnNextP = overlay.querySelector("#rv-tts-nextp");
    if (!voiceEl || !speedInp) return;

    const serversDiv = overlay.querySelector('#rv-servers');
    for (const [serverValue, serverName] of SERVER_NAME.entries()) {
      const radioInput = document.createElement('input');
      radioInput.type = 'radio';
      radioInput.id = `server-${serverValue}`;
      radioInput.name = 'tts_server';
      radioInput.value = serverValue;
      radioInput.checked = serverValue == tts.server;
      radioInput.className = 'rv-radio';

      const radioLabel = document.createElement('label');
      radioLabel.htmlFor = `server-${serverValue}`;
      radioLabel.textContent = serverName;

      serversDiv.appendChild(radioInput);
      serversDiv.appendChild(radioLabel);

      radioInput.addEventListener('change', (event) => {
          if (event.target.checked) {
              const newServer = parseInt(event.target.value, 10);
              if (newServer == tts.server) return;
              invalidateAudio(false);
              tts.server = newServer;
              prefs.server = newServer;
              savePrefs(prefs);
              loadVoiceList();
          }
      });
    }

    async function loadVoiceList() {
      // Fallback set if server fails (only used if fetch errors)
      const fallback = new Map([
        [Server.MY_KOKORO, ["ax_liam", "af_heart", "af_kore"]],
        [Server.VOX_ANE, ["_dorothy-11", "_mark"]]
      ]);
      let voices = [];
      try {
        const res = await chrome.runtime.sendMessage({
          type: "tts.listVoices",
          payload: { server: tts.server }
        });
        if (res?.ok) voices = res.voices;
        else console.log(res?.error || "voices fetch failed");
      } finally {
        tts.voiceEl.innerHTML = "";
        voices ||= fallback;
        for (const v of voices) {
          const opt = document.createElement("option");
          opt.value = v;
          opt.textContent = v;
          tts.voiceEl.appendChild(opt);
        }
        const preferred = prefs.voice[tts.server];
        tts.voiceEl.value = voices.includes(preferred) ? preferred : (voices[0] || "");
        tts.voice = tts.voiceEl.value;
        if (tts.server == Server.VOX_ANE && tts.voice) {
          try { chrome.runtime.sendMessage({
            type: "tts.warmup",
            payload: { voice: tts.voice }
          }) } catch {}
        }
      }
    }

    loadVoiceList();

    speedInp.value = prefs.speed;
    tts.speed = prefs.speed;
    speedLabel.textContent = `${speedInp.value}x`;

    voiceEl.addEventListener("change", () => {
      if (tts.voice !== voiceEl.value) {
        const wasPlaying = tts.playing;
        tts.voice = voiceEl.value;
        prefs.voice[tts.server] = voiceEl.value;
        savePrefs(prefs);
        invalidateAudio();
        if (!wasPlaying && tts.server == Server.VOX_ANE && tts.voice) {
          try { chrome.runtime.sendMessage({
            type: "tts.warmup",
            payload: { voice: tts.voice }
          }) } catch {}
        }
      }
    });

    speedInp.addEventListener("input", () => {
      const newSpeed = parseFloat(speedInp.value);
      if (tts.speed != newSpeed) {
        tts.speed = newSpeed;
        speedLabel.textContent = `${newSpeed}x`;
        prefs.speed = newSpeed;
        savePrefs(prefs);
        invalidateAudio();
      }
    });

    // Segment sentences from article
    function segmentSentences(rootEl) {
      const MIN_CHARS = (tts.server == Server.MY_KOKORO) ? 100 : 30;
      const MAX_CHARS = (tts.server == Server.VOX_ANE) ? 250 : 500;

      // Known abbreviations that should NOT end a sentence
      const ABBREV = new Set([
        "Mr", "Mrs", "Ms", "Dr", "Prof", "Sr", "Jr", "St",
        "No", "Fig", "Rev", "Capt", "Sgt", "Col", "Adm",
        "U.S", "U.K", "A.M", "P.M", "a.m", "p.m", "e.g", "i.e", "etc", "Vs", "vs", "cf",
        "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug",
        "Sep", "Sept", "Oct", "Nov", "Dec",
      ]);

      // Helper: does segment end with an abbreviation?
      function endsWithAbbreviation(str) {
        // Strip trailing quotes/paren
        const cleaned = str.trim(); //.replace(/['"”’)\]]+$/, "");
        if (cleaned.match(/[^A-Z.]([A-Z]\.)+$/)) return true;
        const m = cleaned.match(/[^A-Za-z.]([A-Za-z.]+)\.$/);
        if (!m) return false;
        return ABBREV.has(m[1]);
      }

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
          if ([',', ';', ')', '—'].includes(prev)) return true;
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

      const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
      const BLOCKS = "p, blockquote, li, h1, h2, h3, h4, h5, h6, div";
      const bodySelectors = [
        'section[name="articleBody"]', // NY Times
        '#rv-article-body'             // ours
      ];
      let scope = null;
      for (const selector of bodySelectors) {
        const element = rootEl.querySelector(selector);
        if (element) {
          scope = element;
          break;
        }
      }
      if (!scope) return { texts: [], meta: [] };

      // Leaf blocks only (avoid parent+child duplication)
      const paras = Array.from(
        scope.querySelectorAll(
          `:is(${BLOCKS}):not(:has(${BLOCKS})):not(header *):not(footer *):not(caption *):not(figure *):not([aria-hidden] *)`
        )
      );
      const texts = [];
      const meta = [];

      function emitChunk(plain, el, start, end) {
        const raw = plain.slice(start, end);
        const leadMatch = raw.match(/^\s*/);
        const trailMatch = raw.match(/\s*$/);
        const lead = leadMatch ? leadMatch[0].length : 0;
        const trail = trailMatch ? trailMatch[0].length : 0;

        const s = start + lead;
        const e = end - trail;
        if (e <= s) return;

        const spoken = plain.slice(s, e).trim();
        if (!spoken) return;

        texts.push(spoken);
        meta.push({ el, start: s, end: e });
      }

      for (const el of paras) {
        // 1) Build "plain" from actual text nodes so offsets match Range/TreeWalker
        const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let plain = "";
        let nodes = [];
        let pos = 0;
        let n;

        while ((n = tw.nextNode())) {
          const val = (n.nodeValue || "").replace(/\r/g, ""); // normalize CR
          nodes.push({ node: n, start: pos, end: pos + val.length });
          plain += val;
          pos += val.length;
        }
        if (!plain) continue;

        // --- 2) Segment the "plain" string but MERGE bad splits (e.g., "Dr.", "No.", etc.) ---

        // 1st pass: collect raw segments with offsets
        let rawSegs = [];
        for (const d of seg.segment(plain)) {
          rawSegs.push({
            start: d.index,
            end: d.index + d.segment.length,
            raw: d.segment,
          });
        }

        // 2nd pass: merge when segment ends with known abbreviation
        let merged = [];
        for (let i = 0; i < rawSegs.length; i++) {
          let cur = rawSegs[i];

          while (
            endsWithAbbreviation(plain.slice(cur.start, cur.end)) &&
            i + 1 < rawSegs.length
          ) {
            // merge with next segment
            const nxt = rawSegs[i + 1];
            cur = {
              start: cur.start,
              end: nxt.end,
              raw: plain.slice(cur.start, nxt.end),
            };
            i++; // skip the next one
          }
          merged.push(cur);
        }

        // 3rd pass: trim whitespace on each merged sentence, but DO NOT push yet
        const cleanedSegs = [];
        for (const segm of merged) {
          const raw = plain.slice(segm.start, segm.end);

          const leadMatch = raw.match(/^\s*/);
          const trailMatch = raw.match(/\s*$/);
          const lead = leadMatch ? leadMatch[0].length : 0;
          const trail = trailMatch ? trailMatch[0].length : 0;

          const start = segm.start + lead;
          const end = segm.end - trail;
          if (end <= start) continue;

          const spoken = plain.slice(start, end).trim();
          if (!spoken) continue;

          cleanedSegs.push({ start, end });
        }

        // 4th pass: coalesce adjacent segments to reach MIN_CHARS where possible
        let i = 0;
        while (i < cleanedSegs.length) {
          let groupStart = cleanedSegs[i].start;
          let groupEnd = cleanedSegs[i].end;
          let j = i + 1;

          // If this element is short overall, do not bother merging
          const elementTextLen = plain.trim().length;

          if (elementTextLen >= MIN_CHARS) {
            // Grow the group until we reach MIN_CHARS or run out of segments
            while (
              plain.slice(groupStart, groupEnd).trim().length < MIN_CHARS &&
              j < cleanedSegs.length
            ) {
              groupEnd = cleanedSegs[j].end;
              j++;
            }
          }

          const chunkStr = plain.slice(groupStart, groupEnd).trim();

          if (MAX_CHARS && chunkStr.length > MAX_CHARS) {
            const rel = chooseVoxSplitIndex(chunkStr);
            if (rel > 0 && rel < chunkStr.length) {
              const splitAbs = groupStart + rel;
              // first half
              emitChunk(plain, el, groupStart, splitAbs);
              // second half
              emitChunk(plain, el, splitAbs, groupEnd);
            } else {
              // no good punctuation to split on; keep as one
              emitChunk(plain, el, groupStart, groupEnd);
            }
          } else {
            // non Vox or short enough
            emitChunk(plain, el, groupStart, groupEnd);
          }

          i = j;
        }
      }

      return { texts, meta };
    }

    // Prepare synthesis
    async function ensurePrepared() {
      if (tts.prepared && tts.segments?.length) return true;
      setStatus("Preparing speech...");

      const { texts, meta } = segmentSentences(contentHost);
      if (!texts.length) { setStatus("No text to speak"); return false; }

      tts.texts = texts;                  // keep using your existing property
      tts.meta = meta;                    // parallel metadata
      tts.segments = new Array(texts.length).fill(0);

      tts.prepared = true;
      tts.index = 0;
      setStatus(`Ready (${tts.segments.length} segments)`);
      return true;
    }

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

    function invalidateAudio(continuePlay = true) {
      const wasPlaying = tts.playing;
      stopPlayback();
      tts.decoded.clear();
      tts.playToken++;           // invalidate any pending onended
      if (wasPlaying && continuePlay) playAt(tts.index);
    }

    // Button handlers
    btnPlay.onclick = async () => {
      if (tts.playing) return;
      const ok = await ensurePrepared();
      if (!ok) return;
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


    btnPrev.onclick = () => {
      const idx = Math.max(0, (tts.index > 0 ? tts.index : 0) - 1);
      playAt(idx);
    };

    btnNext.onclick = () => {
      const idx = Math.min(tts.segments.length - 1, (tts.index >= 0 ? tts.index : -1) + 1);
      playAt(idx);
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

    function findIdxAtClick(e) {
      // Start from a visible block near the click
      const blocks = "p,li,blockquote,h1,h2,h3,h4,h5,h6,div";
      const base = e.target.closest(blocks);
      if (!base) return null;

      // Snap to our LEAF block (same rule used in segmentSentences)
      const leafSel = `:is(${blocks}):not(:has(${blocks}))`;
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
      if (tts.playing) return;
      const ok = await ensurePrepared();
      if (!ok) return;
      const idx = findIdxAtClick(e);
      if (idx !== null) playAt(idx);
    }, true);

    // Single click on sentence while playing to jump there
    contentHost.addEventListener("click", (e) => {
      if (!tts.playing) return;
      const idx = findIdxAtClick(e);
      if (idx !== null) playAt(idx);
    }, true);

  }
})();