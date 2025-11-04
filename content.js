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
          color: inherit;
          background: transparent;
          cursor: pointer;

          /* critical anti-stretch guards */
          width: auto !important;
          min-width: 0 !important;
          max-width: none !important;
          flex: 0 0 auto !important;
          box-sizing: border-box;
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
        <button class="rv-btn" id="rv-close">Close</button>
        <span class="rv-group">
          <button class="rv-btn" id="rv-font-inc">A+</button>
          <button class="rv-btn" id="rv-font-dec">a−</button>
          <button class="rv-btn" id="rv-width-narrow">⇥⇤</button>
          <button class="rv-btn" id="rv-width-widen">⇤⇥</button>
        </span>
        <div class="rv-spacer"></div>
          <label style="opacity:.8;">Reader View</label>
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
  }
})();