# Reader View (Readability-first) — v1.1.0

This build prefers **Mozilla Readability** for extraction, then falls back to a lightweight heuristic.
To get the best results (proper paragraphs, titles, bylines), add `readability.js` to the extension folder.

## Add Mozilla Readability
1. Download `readability.js` from the official repo (mozilla/readability) or npm build artifact.

   - File you want is the UMD/browser build typically named `Readability.js` or `readability.js`.

2. Save it into this extension folder as **readability.js** (exact name).

3. In chrome://extensions, click **Reload** on this extension.

4. Toggle Reader (toolbar button or Alt+R).

If the file is not present, the extension quietly uses the heuristic extractor.

## Install (Developer Mode)
1. Extract the ZIP.

2. Go to `chrome://extensions` → **Developer mode** on.

3. **Load unpacked** → select the folder.

## Shortcuts
- **Alt+R** toggle, **Esc** to close, **A−/A+** to change font.
