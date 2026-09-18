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

function validated(patch) {
  const accepted = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return accepted;
  for (const key of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && validChoice(key, patch[key])) {
      accepted[key] = patch[key];
    }
  }
  return accepted;
}

let cache = { ...DEFAULTS };
let loaded = false;
let writeQueue = Promise.resolve();
const errorObservers = new Set();
const errors = { load: null, save: null };

/** Observe persistence failures and recovery. Returns an unsubscribe function. */
export function onError(callback) {
  errorObservers.add(callback);
  return () => errorObservers.delete(callback);
}

function reportError(operation, error) {
  if (error === null && errors[operation] === null) return;
  errors[operation] = error;
  for (const callback of errorObservers) {
    try {
      // Reporting must never turn a recoverable storage failure into a failed
      // preference operation, even when a view uses an async observer.
      Promise.resolve(callback({ operation, error })).catch(() => {});
    } catch (e) { /* one broken observer must not block the others */ }
  }
}

/** Read stored preferences. Unknown keys are ignored; missing keys fall back. */
export async function load() {
  try {
    const got = await chrome.storage.local.get(KEY);
    cache = { ...DEFAULTS, ...validated(got?.[KEY]) };
    reportError('load', null);
  } catch (e) {
    // A failed read is not a pristine installation: a saved microphone opt-out
    // may exist. Keep capture off until the user explicitly chooses otherwise.
    cache = { ...DEFAULTS, includeMic: false };
    reportError('load', String(e?.message ?? e));
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
  // The panel writes its whole control set on any change, so the keys that
  // differ from what the controls were showing (the cache) are the change;
  // the rest is an echo. Normally that distinction is moot. After a failed
  // load it matters: the echoed part is the safety fallback (includeMic:false),
  // not a choice the user made, and persisting it would overwrite their real
  // saved value for good. So retry the read first, and let the stored values
  // win for every key this write does not explicitly change.
  const changes = Object.fromEntries(
    Object.entries(validated(patch)).filter(([key, value]) => value !== cache[key]));
  let base = cache;
  if (errors.load !== null) {
    try {
      const got = await chrome.storage.local.get(KEY);
      base = { ...DEFAULTS, ...validated(got?.[KEY]) };
      cache = { ...base, ...changes };
      // Observers re-apply the recovered values to their controls.
      reportError('load', null);
    } catch (e) {
      base = cache; // still unreadable: the explicit change is all we know
    }
  }
  cache = { ...base, ...changes };
  const values = { ...cache };
  // Each request keeps its own snapshot and waits for the preceding write.
  // Otherwise a slow earlier write can overwrite a newer choice on completion.
  writeQueue = writeQueue.then(async () => {
    try {
      await chrome.storage.local.set({ [KEY]: values });
      reportError('save', null);
    } catch (e) {
      // Keep the in-memory choice and leave the queue usable for a later retry.
      reportError('save', String(e?.message ?? e));
    }
  });
  await writeQueue;
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
