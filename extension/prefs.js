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
  // Whether the preferences group is expanded. Remembered so the panel opens the
  // way it was left rather than snapping shut every time.
  prefsOpen: false,
  windowWidth: 460,
  windowHeight: 780,
};

let cache = { ...DEFAULTS };
let loaded = false;

/** Read stored preferences. Unknown keys are ignored; missing keys fall back. */
export async function load() {
  try {
    const got = await chrome.storage.local.get(KEY);
    const stored = got?.[KEY] || {};
    const merged = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (stored[k] !== undefined && typeof stored[k] === typeof DEFAULTS[k]) {
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
      if (next[k] !== undefined && next[k] !== cache[k]) diff[k] = next[k];
    }
    if (!Object.keys(diff).length) return;
    cache = { ...cache, ...diff };
    callback(diff, { ...cache });
  });
}
