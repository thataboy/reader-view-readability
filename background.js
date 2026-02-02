
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

  // Wrap async logic so we can return true below
  (async () => {
    try {
      if (msg.type === "tts.listVoices") {
        const { server } = msg.payload;
        const list = await fetchVoices(server);
        sendResponse({ ok: true, voices: list });
        return;
      }

      if (msg.type === "tts.synthesize" {
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