/**
 * Persisted user preferences.
 *
 * Stored in chrome.storage.local rather than .sync: these are per-machine
 * ergonomics (which language this box transcribes, how big the window is on this
 * screen), and .sync would drag one machine's window size onto another.
 *
 * Two rules the UI depends on:
 *
 *  - load() MUST be awaited before the first render. Applying preferences after
 *    the UI has initialised makes controls visibly flip, and worse, the model
 *    check and capture arming would run against default values rather than the
 *    user's.
 *  - Changes are broadcast via chrome.storage.onChanged, so the side panel and
 *    the popped-out window stay in agreement instead of overwriting each other.
 */

const KEY = 'prefs';

// The languages the UI actually offers. A stored value outside this set makes
// recognition report a false capability error, so it is rejected on load.
export const LANGS = ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'it-IT',
                      'pt-BR', 'ja-JP', 'hi-IN'];

export const DEFAULTS = {
  lang: 'en-US',
  localOnly: true,
  timestamps: false,
  autoscroll: true,
  // Selecting text copies it immediately. On by default: the user asked for it,
  // and the selection-preserving renderer makes it safe.
  selectToCopy: true,
  // Brief "Copied" toast on auto-copy. Separate from selectToCopy so the copying
  // can stay on while the confirmation is silenced.
  copyToast: true,
  // Chrome's own close warning when the transcript has not been downloaded.
  warnUnsaved: true,
  // Whether the preferences group is expanded. Remembered so the panel opens the
  // way it was left rather than snapping shut every time.
  prefsOpen: false,
  theme: 'system',
  fontSize: 13,
  // Transcribe the microphone into the SAVED file only. On by default: a meeting
  // transcript missing the user's own half is the surprising outcome. Chrome
  // still asks for microphone access on first use, and every failure path leaves
  // the meeting transcript untouched.
  includeMic: true,
  windowWidth: 460,
  windowHeight: 780,
};

function validChoice(key, value) {
  if (key === 'theme') return ['system', 'light', 'dark'].includes(value);
  if (key === 'fontSize') return [13, 15, 17].includes(value);
  if (key === 'lang') return LANGS.includes(value);
  // Dimensions come back from storage that another version of this extension
  // may have written. A NaN, a negative, or a value larger than any real screen
  // would open an unusable window, so clamp the accepted range here rather than
  // at each of the several call sites that read them.
  if (key === 'windowWidth' || key === 'windowHeight') {
    return Number.isFinite(value) && value >= 200 && value <= 10000;
  }
  return typeof value === typeof DEFAULTS[key];
}

let cache = { ...DEFAULTS };
let loaded = false;

/** Read stored preferences. Unknown keys are ignored; missing keys fall back. */
export async function load() {
  try {
    const got = await chrome.storage.local.get(KEY);
    const stored = got?.[KEY] || {};
    const merged = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (stored[k] !== undefined && validChoice(k, stored[k])) {
        merged[k] = stored[k];
      }
    }
    cache = merged;
  } catch (e) {
    cache = { ...DEFAULTS };
  }
  loaded = true;
  return cache;
}

/** Current values. Returns defaults if called before load() resolves. */
export function get() {
  return { ...cache };
}

export function isLoaded() {
  return loaded;
}

/** Merge and persist. Returns the new full set. */
export async function set(patch) {
  cache = { ...cache, ...patch };
  try {
    await chrome.storage.local.set({ [KEY]: cache });
  } catch (e) { /* storage full or unavailable; keep the in-memory value */ }
  return { ...cache };
}

/**
 * Observe changes made by another view (side panel vs pop-out window).
 * The callback receives only the keys that actually changed.
 */
export function onChange(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    const next = changes[KEY].newValue || {};
    const diff = {};
    for (const k of Object.keys(DEFAULTS)) {
      // Validate here too: load() filters, but without this an invalid value
      // written by another view enters the cache and is persisted back.
      if (next[k] !== undefined && next[k] !== cache[k] && validChoice(k, next[k])) {
        diff[k] = next[k];
      }
    }
    if (!Object.keys(diff).length) return;
    cache = { ...cache, ...diff };
    callback(diff, { ...cache });
  });
}
