
// ----- Reader View Injection (unchanged) -----
async function injectAndToggle(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
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

const OFFSCREEN_URL = "offscreen.html";
let offscreenCreating = null;

// streamId -> { tabId, sendResponse, responded, ended }
const streamPending = new Map();
// tabId -> Set(streamId)
const tabStreams = new Map();

async function ensureOffscreenDocument() {
  // If already exists, this resolves quickly
  try {
    // Chrome does not expose a direct "exists" check in stable across all versions.
    // The common approach is try create, catch "already exists" or track locally.
    if (offscreenCreating) return offscreenCreating;

    offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: "Stream TTS audio using WebAudio in an offscreen document."
    });

    await offscreenCreating;
  } catch (e) {
    // If it already exists, ignore
    // Some Chrome versions throw an error string that includes "Only a single offscreen document may be created."
    // We treat that as ok.
    const msg = String(e && (e.message || e));
    if (!msg.toLowerCase().includes("offscreen") && !msg.toLowerCase().includes("single")) {
      console.error("ensureOffscreenDocument failed:", e);
      throw e;
    }
  } finally {
    offscreenCreating = null;
  }
}

function makeStreamId(tabId, signature, token, index) {
  // Keep it deterministic and unique per request
  return `${tabId}>${signature}>${token}>${index}>${Math.random().toString(16).slice(2)}`;
}

function rememberStream(tabId, streamId, sendResponse) {
  streamPending.set(streamId, { tabId, sendResponse, responded: false, ended: false });
  if (!tabStreams.has(tabId)) tabStreams.set(tabId, new Set());
  tabStreams.get(tabId).add(streamId);
}

function respondStream(streamId, payload) {
  const rec = streamPending.get(streamId);
  if (!rec || rec.responded) return;
  rec.responded = true;
  try { rec.sendResponse(payload); } catch {}
}

function endStream(streamId) {
  const rec = streamPending.get(streamId);
  if (!rec) return;
  rec.ended = true;

  // If we never responded (e.g., ended happened before audio ready), respond with an error
  if (!rec.responded) {
    try { rec.sendResponse({ ok: false, error: "Stream ended before audio was ready" }); } catch {}
    rec.responded = true;
  }

  streamPending.delete(streamId);
  const set = tabStreams.get(rec.tabId);
  if (set) {
    set.delete(streamId);
    if (set.size === 0) tabStreams.delete(rec.tabId);
  }
}

function forwardToTab(tabId, msg) {
  try { chrome.tabs.sendMessage(tabId, msg); } catch {}
}

const Server = Object.freeze({
    MY_KOKORO: 1,
    VOX_ANE: 2,
    SUPERTONIC: 3,
    POCKET: 4,
    CANDLE: 5,
});

const SERVER_IP = navigator.userAgent.includes('Mac OS X') ? '127.0.0.1' : '192.168.1.11';

const SERVERS = new Map([
  [Server.MY_KOKORO, {port: 9090, min_len: 2}],
  [Server.VOX_ANE, {port: 9000, sanitizer: sanitizeVox, min_len: 5}],
  [Server.SUPERTONIC, {port: 8001, sanitizer: sanitizeSupertonic, min_len: 5}],
  [Server.POCKET, {port: 9800, sanitizer: sanitizePocket, min_len: 2}],
  [Server.CANDLE, {
    port: 9900, sanitizer: sanitizePocket, min_len: 2, extra_params: {'model': 'pocket-tts'},
  }],
]);

async function fetchVoices(server) {
  const r = await fetch(`http://${SERVER_IP}:${SERVERS.get(server).port}/voices`);
  if (!r.ok) throw new Error(`/voices failed: ${r.status} ${r.statusText}`);
  const j = await r.json();
  return j.voices;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // The btoa() function creates a Base64-encoded ASCII string
  return btoa(binary);
}

function generateSilenceWav() {
  const sampleRate = 44100;
  const duration = 0.1;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteLength = sampleRate * duration * numChannels * (bitsPerSample / 8);

  const buffer = new ArrayBuffer(44 + byteLength);
  const view = new DataView(buffer);

  // RIFF identifier 'RIFF'
  view.setUint32(0, 0x52494646, false);
  // file length
  view.setUint32(4, 36 + byteLength, true);
  // RIFF type 'WAVE'
  view.setUint32(8, 0x57415645, false);
  // format chunk identifier 'fmt '
  view.setUint32(12, 0x666d7420, false);
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (raw)
  view.setUint16(20, 1, true);
  // channel count
  view.setUint16(22, numChannels, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sample rate * block align)
  view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
  // block align (channel count * bytes per sample)
  view.setUint16(32, numChannels * (bitsPerSample / 8), true);
  // bits per sample
  view.setUint16(34, bitsPerSample, true);
  // data chunk identifier 'data'
  view.setUint32(36, 0x64617461, false);
  // data chunk length
  view.setUint32(40, byteLength, true);
  return buffer;
}

// fix a bunch of weird quirks with VoxCPM
function sanitizeVox(text) {
  // Vox freaks out if text is all caps
  if (/^[^a-z]*[A-Z][^a-z]*$/.test(text)) text = text.toLowerCase();
  return text
    .replace(/[()[\]|~`/…]/g, ' ')
    // .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[“”"]/g, ' ')
    .replace(/\!{2,}/g, '!')
    // .replace(/[‘’]/g, "'")
    .replace(/(\.|\*|\-){3,}/g, ' ')
    // .replace(/-(?![a-zA-Z])|(?<![a-zA-Z])-/g, ' ')
    // .replace(/[—:;]/g, ', ')
    // .replace(/[^\n\x20-\x7E]/g, ' ').replace(/ +/g, ' ').trim();
    .replace(/([,.])\s*[.,]/g, '$1 ')
    .replace(/^[,.]\s*/, '')
    .replace(/(\s*(\.))+$/, '$1')
    .replace(/\s+([,.])/g, '$1')
    // .replace(/(["”’'])\s*\.?\s*$/, '')
    // .replace(/\s+([”’])/g, '$1')
    // .replace(/([‘“])\s+/g, '$1')
    // .replace(/(\s*[,!:;]\s*)+$/, '')
    // .replace(/^(\s*[,!:;]\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Initialized once in the outer scope
const ABBREVIATION_MAP = {
  "Mr.": "Mister",
  "Mrs.": "Misses",
  "Ms.": "Miss",
  "Dr.": "Doctor",
  "V.": "versus",
  "v.": "versus",
  "A.I.": "eigh eye",
  "AI": "eigh eye",
  "MacOS": "mac oh ess",
  "lbs.": "pounds",
  "lbs": "pounds",
  "Prof.": "Professor",
  "Bros.": "Brothers",
  "Sr.": "Senior",
  "Jr.": "Junior",
  "Det.": "Detective",
  "Capt.": "Captain",
  "Maj.": "Major",
  "Gen.": "General",
  "Col.": "Colonel",
  "Lt.": "Lieutenant",
  "Fig.": "Figure",
  "St.": "Saint"
};

// Escape dots and join keys into a single regex pattern
const ABBR_REGEX = new RegExp(
  '(?<=\\s|^)(' +
  Object.keys(ABBREVIATION_MAP)
    .map(k => k.replace('.', '\\.'))
    .join('|')
  + ')(?=\\s|$|\\b)',
  'g'
);

function expandAbbreviations(text) {
  if (!text) return text;
  return text.replace(ABBR_REGEX, (matched) => ABBREVIATION_MAP[matched]);
}

/**
 * Normalizes a string by converting special characters/accents
 * to their closest ASCII equivalents.
 */
const manualMap = {
  'ø': 'o', 'Ø': 'O',
  'æ': 'ae', 'Æ': 'AE',
  'œ': 'oe', 'Œ': 'OE',
  'ß': 'ss', 'ł': 'l', 'Ł': 'L'
};

function sanitizeSupertonic(str) {
  return str
    .replace(/[><()\[\]^]/g, ' ')
    // remove emojis
    // .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    // normalize special chars
    .replace(/[øØæÆœŒßłŁ]/g, match => manualMap[match])
    // Use NFD normalization to decompose accents (e.g., 'é' -> 'e' + '´')
    // .normalize("NFD")
    // Use Regex to remove the "Combining Diacritical Marks" (the accents)
    // .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function sanitizePocket(text) {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[[\]]/g, "")
    .replace(/(\d)\.(\d)/g, '$1 point $2')
    .replace(/([a-z]{2,3})\.([a-z]{2,3}\d)/g, '$1 dot $2')
    // remove extraneous punctuation after . ? !
    .replace(/([\.\?!])[^\s\p{L}\p{N}]+/gu, '$1 ')
    .replace(/\$\s?([\d,]+(?:\.\d{2})?)/g, '$1 dollars')
    // drop . from middle initial
    .replace(/\s([A-Z])\.\s/g, ' $1 ')
    // replace V.I.P. with VIP
    .replace(/([A-Z]\.){3,}/g, (match) => {  return match.replace(/\./g, ""); } )
    .trim()
    ;
}

function sanitizeAll(text) {
  if (!text) return '';
  return text
    // Remove URLs (TTS engines usually mangle these)
    .replace(/(https?:\/\/[^\s]+)/g, '')

    // Whitelist: Keep letters (\p{L}), numbers (\p{N}),
    // basic punctuation (\p{P}), and spaces (\s).
    // This automatically strips emojis, arrows, and symbols.
    .replace(/[^\p{L}\p{N}\p{P}\p{S}\s]/gu, '')

    // !!! and ???
    .replace(/([!?.])\1+/g, '$1')

    .replace(/\s+/g, ' ')
    .trim();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: "Invalid message" });
    return; // no async work to keep alive
  }

 if (msg.type === "offscreen.tts.streamPlaying") {
    const { streamId, index, signature, token } = msg.payload || {};
    const rec = streamPending.get(streamId);
    if (rec) {
      forwardToTab(rec.tabId, {
        type: "tts.streamPlaying",
        payload: { index, signature, token }
      });
    }
    return;
  }

  if (msg.type === "offscreen.tts.streamEnded") {

    const { streamId, index, signature, token } = msg.payload || {};
    const rec = streamPending.get(streamId);
    if (rec) {
      forwardToTab(rec.tabId, {
        type: "tts.streamEnded",
        payload: { index, signature, token }
      });
    }
    endStream(streamId);
    return;
  }

  if (msg.type === "offscreen.tts.streamAudioReady") {
    // Offscreen finished downloading full WAV and is returning it for caching.
    const { streamId, base64 } = msg.payload || {};
    respondStream(streamId,
      base64 ? { ok: true, base64 }: { ok: false, error: "Missing audio payload" }
    );
    return;
  }

  if (msg.type === "offscreen.tts.streamError") {
    const { streamId, error } = msg.payload || {};
    respondStream(streamId, { ok: false, error: error || "Stream failed" });
    endStream(streamId);
    return;
  }

  if (msg.type === "offscreen.tts.streamCancelled") {
    const { streamId } = msg.payload || {};
    respondStream(streamId, { ok:false, error:"Cancelled" });
    endStream(streamId);
    return;
  }

  if (msg.type === "tts.stream") {
    (async () => {
      const tabId = sender?.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: "No sender tab for stream request" });
        return;
      }

      const p = msg.payload || {};
      const { signature, token, index, text, lang, voice, speed, server } = p;

      try {
        await ensureOffscreenDocument();

        const serverCfg = SERVERS.get(server);
        if (!serverCfg) throw new Error("Unknown server");

        const streamId = makeStreamId(tabId, signature, token, index);
        rememberStream(tabId, streamId, sendResponse);

        // Forward to offscreen for actual streaming playback + download
        await chrome.runtime.sendMessage({
          type: "offscreen.tts.stream",
          payload: {
            streamId,
            endpoint: `http://${SERVER_IP}:${serverCfg.port}/stream`,
            // payload is unchanged, same as synth route
            body: {
              input: text,
              voice,
              speed,
              lang,
              ...(serverCfg.extra_params || {})
            },
            signature,
            token,
            index
          }
        });

        // Do not sendResponse here.
        // We return true below and respond later when offscreen delivers full WAV.

      } catch (e) {
        console.error("tts.stream error:", e);
        sendResponse({ ok: false, error: String(e && (e.message || e)) });
      }
    })();

    return true; // keep sendResponse alive
  }

  if (msg.type === "tts.streamCancel") {
    const senderTabId = sender?.tab?.id;
    const { signature, token, index } = msg.payload || {};

    if (!senderTabId) {
      sendResponse?.({ ok: false, error: "No sender tab" });
      return;
    }

    const streamSet = tabStreams.get(senderTabId);
    if (!streamSet || streamSet.size === 0) {
      sendResponse?.({ ok: true }); // nothing to cancel
      return;
    }

    for (const streamId of Array.from(streamSet)) {
      const rec = streamPending.get(streamId);
      if (!rec) continue;

      // streamId format: tabId|signature|token|index|...
      // we only need to match what caller gave us
      const parts = streamId.split(">");
      const sidTab   = parts[0];
      const sidSig   = parts[1];
      const sidToken = parts[2];
      const sidIndex = parts[3];

      const matches =
        String(sidTab) === String(senderTabId) &&
        (signature == null || String(signature) === String(sidSig)) &&
        (token == null || String(token) === String(sidToken)) &&
        (index == null || String(index) === String(sidIndex));

      if (!matches) continue;

      // 1) Tell offscreen to stop audio immediately
      try {
        chrome.runtime.sendMessage({
          type: "offscreen.tts.cancel",
          payload: { streamId }
        });
      } catch {}

      // 2) Resolve any awaiting tts.stream() promise
      respondStream(streamId, {
        ok: false,
        error: "Cancelled"
      });

      // 3) Final cleanup (routing + bookkeeping)
      endStream(streamId);
    }

    sendResponse?.({ ok: true });
    return;
  }

  // Wrap async logic so we can return true below
  (async () => {
    try {
      if (msg.type === "tts.listVoices") {
        const { server } = msg.payload;
        const list = await fetchVoices(server);
        sendResponse({ ok: true, voices: list });
        return;
      }

      if (msg.type === "tts.synthesize") {
        const { signature, out_of_order, text, lang, voice, speed, server } = msg.payload || {};
        if (signature !== `${server}|${voice}|${speed}`) {
          sendResponse({ error: `mismatched ${signature}`});
          return
        }
        if (out_of_order) {
          sendResponse({ error: 'out_of_order'});
          return
        }

        const serv = SERVERS.get(server);
        let input = sanitizeAll(text);
        if (serv.sanitizer) input = serv.sanitizer(input);
        if (!input || input.length < serv.min_len) {
          const buf = generateSilenceWav();
          const b64 = arrayBufferToBase64(buf);
          sendResponse({ ok: true, base64: b64 });
          return
        }
        input = expandAbbreviations(input);

        const body = {...{input, voice, lang, speed,}, ...(serv.extra_params??{})};

        const r = await fetch(`http://${SERVER_IP}:${serv.port}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!r.ok) {
          sendResponse({ error: `/synthesize failed: ${r.status} ${r.statusText}` });
          return;
        }
        const buf = await r.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        sendResponse({ ok: true, base64: b64 });
        return;
      }

      if (msg.type === "tts.cancel") {
        const { server } = msg.payload;
        fetch(`http://${SERVER_IP}:${SERVERS.get(server).port}/v1/audio/speech/cancel`,
          { method: "POST" }
        ).catch(() => {});
        sendResponse({ ok: true });
        return;
      }

      // No-op controls
      if (["tts.play", "tts.pause", "tts.stop", "tts.jumpTo"].includes(msg.type)) {
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (err) {
      sendResponse({ error: String(err?.message || err) });
    }
  })();

  // IMPORTANT: keep the service worker alive for the async work above
  return true;
});