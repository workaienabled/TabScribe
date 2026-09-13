/**
 * TabScribe side panel controller.
 *
 * The side panel is the right home for this: it survives tab switches, and it can
 * hold a live MediaStream, which a service worker cannot.
 *
 * Rendering is incremental, and that is load-bearing rather than an optimisation.
 * Recognition fires several events per second; rebuilding the transcript container on
 * each one destroys and recreates every DOM node, which silently drops whatever the
 * user had selected. So:
 *
 *   - each transcript segment owns one persistent DOM node, reused for its lifetime;
 *   - a node is touched only when its own text actually changed, which means
 *     finalised text is never mutated again;
 *   - any node the current selection intersects is left alone entirely until the
 *     selection clears, so the live interim line cannot yank text out from under a
 *     drag in progress.
 */
import { Transcriber, buildAudioGraph, formatClock } from './transcriber.js';
import * as prefs from './prefs.js';
import { MicTranscriber, mergeTranscripts, MIC_MESSAGES, stopStream } from './mic.js';

const el = {
  record: document.getElementById('recordBtn'),
  copy: document.getElementById('copyBtn'),
  download: document.getElementById('downloadBtn'),
  clearScreen: document.getElementById('clearScreenBtn'),
  hiddenNotice: document.getElementById('hiddenNotice'),
  hiddenCount: document.getElementById('hiddenCount'),
  showHidden: document.getElementById('showHiddenBtn'),
  micStatus: document.getElementById('micStatusBtn'),
  cloudWarning: document.getElementById('cloudWarning'),
  warnUnsaved: document.getElementById('warnUnsaved'),
  clear: document.getElementById('clearBtn'),
  undoBar: document.getElementById('undoBar'),
  undoClear: document.getElementById('undoClearBtn'),
  undoDismiss: document.getElementById('undoDismiss'),
  popout: document.getElementById('popoutBtn'),
  lang: document.getElementById('langSel'),
  localOnly: document.getElementById('localOnly'),
  timestamps: document.getElementById('tsToggle'),
  autoscroll: document.getElementById('autoscroll'),
  selectToCopy: document.getElementById('selectToCopy'),
  copyToast: document.getElementById('copyToast'),
  includeMic: document.getElementById('includeMic'),
  micHint: document.getElementById('micHint'),
  micGrant: document.getElementById('micGrantBtn'),
  prefsBtn: document.getElementById('prefsBtn'),
  theme: document.getElementById('themeSel'),
  fontSize: document.getElementById('fontSizeSel'),
  prefsPanel: document.getElementById('prefsPanel'),
  toast: document.getElementById('toast'),
  transcript: document.getElementById('transcript'),
  jumpLatest: document.getElementById('jumpLatestBtn'),
  empty: document.getElementById('emptyHint'),
  status: document.getElementById('status'),
  dot: document.getElementById('dot'),
  target: document.getElementById('target'),
  modelPanel: document.getElementById('modelPanel'),
  modelIcon: document.getElementById('modelIcon'),
  modelTitle: document.getElementById('modelTitle'),
  modelBody: document.getElementById('modelBody'),
  modelState: document.getElementById('modelState'),
  modelElapsed: document.getElementById('modelElapsed'),
  modelHint: document.getElementById('modelHint'),
  modelActions: document.getElementById('modelActions'),
  useCloud: document.getElementById('useCloudBtn'),
  retryModel: document.getElementById('retryModelBtn'),
};

// This same document serves both the side panel and the pop-out window; ?view=window
// marks the latter. Only one capture per tab is possible (verified: a second
// getMediaStreamId on an already-captured tab fails with "Cannot capture a tab with
// an active stream"), so popping out is a handoff rather than a second view.
const IS_WINDOW = new URLSearchParams(location.search).get('view') === 'window';
if (IS_WINDOW) {
  document.body.classList.add('view-window');
  document.title = 'TabScribe';

  // Remember how the user sized this window, so the next pop-out matches.
  // Debounced: a resize drag fires continuously, and each write would hit
  // storage and broadcast an onChanged to the other view.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Ignore a minimised or collapsed window; restoring those dimensions
      // later would open an unusable sliver.
      if (window.outerWidth < 200 || window.outerHeight < 200) return;
      prefs.set({ windowWidth: window.outerWidth, windowHeight: window.outerHeight });
    }, 600);
  });
}

let transcriber = null;
// Optional (on by default) and deliberately isolated: see mic.js. Constructed on
// the first Start that requests a stream, so the instance can own the in-flight
// request and release it if the user changes their mind.
let mic = null;
// Set when the microphone failed this session, so Start does not re-prompt on
// every press. Cleared when the user toggles the option or reloads the panel.
let micBlocked = false;
// Whether the microphone grant already exists for this extension's origin. The
// panel cannot create it — see mic-permission.html — so it only reads it.
let micGranted = false;
let graph = null;
let stream = null;
let targetTabId = null;
// Capture is armed as soon as the panel opens, not when Start is pressed.
//
// Two reasons, both measured:
//  - The activeTab grant that authorises tabCapture comes from the user's click on
//    the toolbar action. It does not survive slow work in between.
//  - chrome.tabCapture.getMediaStreamId() returns a short-lived, single-use id. On a
//    first run the on-device model download takes minutes, by which time a stream id
//    minted earlier has expired.
// Opening the stream immediately sidesteps both. Start/Stop then only control
// recognition, and the audio graph keeps the tab audible the whole time.
let armed = false;
// Set once this document has handed the tab over to the pop-out window. Recognition
// shutdown is asynchronous: stop() resolves before the recognizer's own 'end' event
// arrives, and that late event would otherwise overwrite the hand-off message with
// "Stopped." and re-enable controls this document no longer owns.
let handedOff = false;

async function armCapture() {
  if (armed) return { ok: true };
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STREAM_ID', tabId: targetTabId });
    if (!res?.ok) return res || { ok: false, error: 'no response from background' };

    targetTabId = res.tabId;
    targetTitle = res.title || `tab ${res.tabId}`;
    refreshRecordTitle();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: res.streamId,
        },
      },
    });

    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) {
      throw new Error('That tab is not producing audio.');
    }

    // Route through an AudioContext: restores tab playback (tabCapture mutes it)
    // and keeps frames flowing so the recognizer can flush trailing segments.
    graph = buildAudioGraph(stream, { monitor: true });

    tracks[0].addEventListener('ended', () => {
      armed = false;
      setStatus('Tab audio ended (tab closed, navigated, or stopped sharing).');
      if (transcriber?.running) stop();
    });

    armed = true;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function setStatus(text, isError = false) {
  // Once handed off, this document's story is fixed: it no longer owns the tab, and
  // late asynchronous events must not rewrite the message explaining that.
  if (handedOff && !isError) return;
  el.status.textContent = text || '';
  el.status.classList.toggle('error', !!isError);
}

function setState(state) {
  el.dot.dataset.state = state;
  // The dot rides in the control row now, and only appears when it says
  // something: an always-grey dot next to an idle Record button is noise.
  el.dot.hidden = (state === 'idle');
  updateModeSummary();
  refreshRecordTitle();
}

/**
 * Which tab is being captured, and in which mode.
 *
 * This used to be a title bar and a badge. With both gone, the information rides
 * on the Record control's tooltip — the one control that is always present and
 * always about the capture.
 */
let targetTitle = '';

function refreshRecordTitle() {
  const recording = el.record.getAttribute('aria-pressed') === 'true';
  const what = targetTitle ? ` “${targetTitle}”` : ' this tab';
  el.record.title = recording
    ? `Stop transcribing${what}`
    : `Start transcribing${what}`;
}

function updateModeSummary() {
  const active = !!transcriber?.running;
  const local = active ? transcriber.options.processLocally : el.localOnly.checked;
  const lang = active ? transcriber.options.lang : el.lang.value;
  // Cloud recognition uploads audio. The badge that said so lived in the removed
  // title bar, so it becomes its own line rather than disappearing with it.
  el.cloudWarning.hidden = local;
  el.cloudWarning.textContent = active
    ? `Cloud recognition (${langName(lang)}): this tab's audio is sent to Google.`
    : `Cloud recognition (${langName(lang)}): audio will be sent to Google from the next recording.`;
}

/* ---------------------------------------------------------------- selection */

/** The live selection, but only if it actually lies inside the transcript. */
function transcriptSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const anchor = range.commonAncestorContainer;
  if (!el.transcript.contains(anchor) && anchor !== el.transcript) return null;
  return sel;
}

function selectionIntersects(sel, node) {
  for (let i = 0; i < sel.rangeCount; i += 1) {
    try {
      if (sel.getRangeAt(i).intersectsNode(node)) return true;
    } catch (e) { /* detached node */ }
  }
  return false;
}

/* ---------------------------------------------------------------- rendering */

// segment key -> { row, ts, textNode, text, isFinal, showTs }
const nodes = new Map();
let lastStore = null;
let heldUpdates = false;
let following = true;

function nearLatest() {
  return el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 48;
}

function refreshJumpButton() {
  el.jumpLatest.hidden = !lastStore || lastStore.isEmpty() || nearLatest();
}

el.transcript.addEventListener('scroll', () => {
  following = nearLatest();
  refreshJumpButton();
}, { passive: true });
el.jumpLatest.addEventListener('click', () => {
  // An explicit jump may release a selection; incoming text never does.
  if (transcriptSelection()) window.getSelection().removeAllRanges();
  following = true;
  el.transcript.scrollTop = el.transcript.scrollHeight;
  refreshJumpButton();
  el.transcript.focus({preventScroll: true});
});

function makeRow(key) {
  const row = document.createElement('div');
  row.className = 'seg';
  row.dataset.key = key;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.hidden = true;

  const txt = document.createElement('span');
  txt.className = 'txt';
  const textNode = document.createTextNode('');
  txt.appendChild(textNode);

  row.append(ts, txt);
  el.transcript.appendChild(row);
  return { row, ts, txt, textNode, text: null, isFinal: null, showTs: null };
}

function applyRow(entry, seg, showTs) {
  // Mutate the existing text node in place rather than reassigning textContent,
  // which would replace the node and invalidate any range anchored in it.
  const text = seg.text.trim();
  if (entry.textNode.data !== text) entry.textNode.data = text;
  entry.row.classList.toggle('interim', !seg.isFinal);

  if (showTs) {
    const stamp = `[${formatClock(seg.startedAt)}]`;
    if (entry.ts.textContent !== stamp) entry.ts.textContent = stamp;
    entry.ts.hidden = false;
  } else {
    entry.ts.hidden = true;
  }

  entry.text = seg.text;
  entry.isFinal = seg.isFinal;
  entry.showTs = showTs;
}

/* ------------------------------------------------------- screen vs. store */

/**
 * Segment keys hidden from the VIEW only.
 *
 * The gear's Delete removes text from the store, so it leaves the download too.
 * This is the other thing people want: clear the screen to stop scrolling
 * through an hour of meeting, while the file you download at the end still has
 * all of it. The store is never touched here — only what render() draws.
 */
let screenHidden = new Set();

function hiddenNoticeRefresh(store) {
  const hiding = screenHidden.size > 0;
  el.hiddenNotice.hidden = !hiding;
  if (!hiding || !store) return;
  const words = store.liveSegments()
    .filter((s) => screenHidden.has(s.key))
    .reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  el.hiddenCount.textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
}

function clearScreen() {
  if (!lastStore) return;
  for (const seg of lastStore.liveSegments()) screenHidden.add(seg.key);
  // Drop the rows outright: keeping them hidden would leave them selectable and
  // copyable, which is not what "cleared" means.
  for (const [key, entry] of nodes) {
    if (screenHidden.has(key)) { entry.row.remove(); nodes.delete(key); }
  }
  render(lastStore);
  confirmAction('Screen cleared', 'Screen cleared. The text is still in the download.');
}

function showHidden() {
  screenHidden = new Set();
  if (lastStore) render(lastStore);
}

/* ------------------------------------------------------------ unsaved work */

/**
 * Whether the transcript holds anything that has not been downloaded.
 *
 * Compared against the exact text last written to disk rather than a dirty flag:
 * a flag would go stale after Undo, after a hand-off, or after the microphone
 * merged extra text in, and would then either nag about nothing or stay silent
 * over a lost meeting.
 */
let savedText = '';

function hasUnsavedTranscript() {
  if (!lastStore || lastStore.isEmpty()) return false;
  return transcriptForSaving() !== savedText;
}

function refreshUnsavedUi() {
  // The footer marker is gone; the unsaved state is carried by the Download
  // control itself, which is where the user would act on it.
  const unsaved = hasUnsavedTranscript();
  el.download.classList.toggle('unsaved', unsaved);
  el.download.setAttribute('aria-label',
    unsaved ? 'Download transcript (not saved yet)' : 'Download transcript');
}

/* ------------------------------------------------------------- persistence */

/**
 * Keep the transcript across a panel close.
 *
 * A Chrome side panel is not a tab: closing it, or closing the browser, destroys
 * the document WITHOUT running the beforeunload prompt. Measured against real
 * use — the warning fires in the pop-out window and never in the panel. A
 * warning that only works in one of two modes is not a safety net, so the text
 * is persisted continuously instead and restored on the next open. Losing the
 * meeting stops depending on a dialog Chrome may never show.
 *
 * chrome.storage.session is the right store: it survives the panel closing and
 * reopening, and is discarded when the browser exits, so a transcript is never
 * written to disk behind the user's back.
 */
const AUTOSAVE_KEY = 'liveTranscript';
let autosaveTimer = null;

function scheduleAutosave() {
  if (autosaveTimer) return;
  // Coalesced: recognition updates several times a second and every write would
  // otherwise hit storage.
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    try {
      if (!transcriber || transcriber.store.isEmpty()) {
        await chrome.storage.session.remove(AUTOSAVE_KEY);
        return;
      }
      await chrome.storage.session.set({
        [AUTOSAVE_KEY]: {
          snapshot: transcriber.store.serialize(),
          savedText,
          micText: mic?.hasText() ? mic.store.serialize() : null,
          at: Date.now(),
        },
      });
    } catch (e) {
      // Persistence is a safety net, never the thing that breaks a meeting.
      console.warn('TabScribe autosave failed:', e);
    }
  }, 1200);
}

/** Restore a transcript left behind by a previous panel document. */
async function restoreAutosave() {
  try {
    const stored = await chrome.storage.session.get(AUTOSAVE_KEY);
    const saved = stored[AUTOSAVE_KEY];
    if (!saved?.snapshot?.segments?.length) return false;
    ensureTranscriber();
    transcriber.store.restore(saved.snapshot);
    if (typeof saved.savedText === 'string') savedText = saved.savedText;
    if (saved.micText?.segments?.length) {
      if (!mic) mic = new MicTranscriber({ onStateChange: onMicState });
      mic.store.restore(saved.micText);
    }
    render(transcriber.store);
    return true;
  } catch (e) {
    console.warn('TabScribe could not restore the previous transcript:', e);
    return false;
  }
}

function render(store) {
  lastStore = store;
  // Hidden keys are filtered here, and only here: the store still holds them, so
  // Copy, Download, and the word count are unaffected by clearing the screen.
  const all = store.liveSegments();
  const segs = screenHidden.size ? all.filter((s) => !screenHidden.has(s.key)) : all;

  el.empty.style.display = all.length === 0 ? '' : 'none';
  el.copy.disabled = el.download.disabled = el.clear.disabled = store.isEmpty();
  el.clearScreen.disabled = segs.length === 0;
  hiddenNoticeRefresh(store);
  refreshUnsavedUi();
  scheduleAutosave();

  const showTs = el.timestamps.checked;
  const sel = transcriptSelection();
  let deferred = 0;

  for (const seg of segs) {
    let entry = nodes.get(seg.key);
    if (!entry) {
      // A brand-new row is appended after everything else, which cannot disturb a
      // selection that already exists above it.
      entry = makeRow(seg.key);
      nodes.set(seg.key, entry);
    } else if (entry.text === seg.text && entry.isFinal === seg.isFinal && entry.showTs === showTs) {
      continue; // nothing changed: do not touch the DOM at all
    }

    if (sel && selectionIntersects(sel, entry.row)) {
      deferred += 1; // held until the selection clears
      continue;
    }
    applyRow(entry, seg, showTs);
  }

  heldUpdates = deferred > 0;
  el.transcript.classList.toggle('holding', !!sel);

  // Autoscrolling while the user is dragging moves the text under the cursor.
  if (el.autoscroll.checked && following && !sel) {
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }
  refreshJumpButton();
}

function refreshSelectionUi() {
  const sel = transcriptSelection();
  const selecting = !!sel;
  el.copy.setAttribute('aria-label', selecting ? 'Copy selected passage' : 'Copy transcript');
  el.copy.title = selecting
    ? 'Copy the passage you selected'
    : 'Copy the whole transcript, or only the passage you select';
  el.transcript.classList.toggle('holding', selecting);

  // Selection gone: apply whatever was held back while it existed.
  if (!selecting && heldUpdates && lastStore) render(lastStore);
}

document.addEventListener('selectionchange', refreshSelectionUi);

/* ------------------------------------------------------------- select to copy */

// Copy when the selection SETTLES, not on every selectionchange: that event
// fires continuously while a drag is in progress, so copying from it would put
// dozens of partial fragments on the clipboard and leave whichever one happened
// to fire last. mouseup / keyup mark the end of a selection gesture.
//
// lastAutoCopied suppresses re-copying the same text when a later event reports
// an unchanged selection (clicking inside an existing selection, a focus change,
// a keyup after the gesture has already been handled).
let lastAutoCopied = '';
let toastTimer = null;
let toastHideTimer = null;

/**
 * Brief, quiet confirmation. Replaced a full-pane flash, which was distracting
 * because auto-copy fires on every selection while reading.
 *
 * `hidden` is toggled around the opacity transition so the element is genuinely
 * out of the accessibility tree between toasts rather than merely transparent.
 */
function showToast(message = 'Copied') {
  if (!el.copyToast.checked) return false;
  if (toastTimer) clearTimeout(toastTimer);
  if (toastHideTimer) clearTimeout(toastHideTimer);

  el.toast.textContent = message;
  el.toast.hidden = false;
  // Force a reflow so the transition runs when re-showing an already-shown toast.
  void el.toast.offsetWidth;
  el.toast.classList.add('show');

  toastTimer = setTimeout(() => {
    el.toast.classList.remove('show');
    toastHideTimer = setTimeout(() => { el.toast.hidden = true; }, 160);
  }, 900);
  return true;
}

/**
 * Confirm an action the user explicitly asked for.
 *
 * The toast is the quiet path and it is optional, so it cannot be the only
 * acknowledgement: with "Copy toast" off, pressing Copy or Download otherwise
 * produced no feedback at all and looked broken. Auto-copy stays silent when the
 * toast is off — it fires on every selection, and narrating it is the noise the
 * toggle exists to remove.
 *
 * The toast keeps its short fixed wording; the longer sentence is only for the
 * status line, which has room for it.
 */
function confirmAction(toastText, statusText) {
  if (!showToast(toastText)) setStatus(statusText);
}

async function autoCopySelection() {
  if (!el.selectToCopy.checked) return;

  const sel = transcriptSelection();
  const text = sel ? sel.toString().trim() : '';
  if (!text) {
    lastAutoCopied = '';
    return;
  }
  if (text === lastAutoCopied) return;

  const ok = await writeClipboard(text);
  if (!ok) {
    // Do not claim success. The manual Copy button remains available.
    setStatus('Auto-copy failed — press Ctrl+C to copy the selection.', true);
    return;
  }
  lastAutoCopied = text;
  showToast('Copied');
}

// Pointer and keyboard selection both end with an "up" event. Listening on the
// document (not the transcript) catches a drag that ends outside the pane.
document.addEventListener('mouseup', () => { setTimeout(autoCopySelection, 0); });
document.addEventListener('keyup', (e) => {
  // Only selection-extending keys; ignore ordinary typing in the language select.
  if (e.shiftKey || e.key === 'Shift' || (e.ctrlKey && e.key.toLowerCase() === 'a')) {
    setTimeout(autoCopySelection, 0);
  }
});
// Double/triple click selects a word or line without an intervening drag.
document.addEventListener('dblclick', () => { setTimeout(autoCopySelection, 0); });

/* --------------------------------------------------- model download notice */

// Chrome's install() reports NO download progress: verified on Chrome 151 that the
// Prompt-API style `monitor` callback is never invoked, no `downloadprogress` events
// fire, and the promise carries no progress affordances. Sampling the model on disk
// during a real download showed it arriving in two jumps (0 → 121 MB → 323 MB), so
// even a byte-based estimate would misrepresent it. The notice therefore shows the
// real state Chrome does report plus elapsed time, with an indeterminate bar — and
// says plainly that no percentage is available.
const MODEL_LANG_NAMES = {
  'en-US': 'English (US)', 'en-GB': 'English (UK)', 'es-ES': 'Spanish',
  'fr-FR': 'French', 'de-DE': 'German', 'it-IT': 'Italian',
  'pt-BR': 'Portuguese', 'ja-JP': 'Japanese', 'hi-IN': 'Hindi',
};
let modelTimer = null;
let modelStartedAt = 0;

function langName(code) {
  return MODEL_LANG_NAMES[code] || code;
}

function showModelPanel({ title, body, state, phase, hint = true, actions = true }) {
  el.modelPanel.hidden = false;
  el.modelPanel.classList.remove('failed', 'idle');
  if (phase) el.modelPanel.classList.add(phase);
  if (title !== undefined) el.modelTitle.textContent = title;
  if (body !== undefined) el.modelBody.innerHTML = body;
  if (state !== undefined) el.modelState.textContent = state;
  el.modelHint.hidden = !hint;
  el.modelActions.hidden = !actions;
}

function hideModelPanel() {
  el.modelPanel.hidden = true;
  stopModelTimer();
}

function startModelTimer() {
  stopModelTimer();
  modelStartedAt = Date.now();
  const tick = () => {
    const secs = Math.floor((Date.now() - modelStartedAt) / 1000);
    const mins = Math.floor(secs / 60);
    el.modelElapsed.textContent = mins > 0
      ? `${mins}m ${String(secs % 60).padStart(2, '0')}s elapsed`
      : `${secs}s elapsed`;
  };
  tick();
  modelTimer = setInterval(tick, 1000);
}

function stopModelTimer() {
  if (modelTimer) clearInterval(modelTimer);
  modelTimer = null;
}

function onModelProgress(info) {
  const lang = langName(el.lang.value);
  switch (info.phase) {
    case 'checking':
      showModelPanel({
        title: 'Checking for the speech model…',
        body: `Looking for the on-device ${lang} model.`,
        state: 'Checking',
        hint: false,
        actions: false,
      });
      break;

    case 'downloading':
      if (!modelTimer) startModelTimer();
      showModelPanel({
        title: 'First run: one-time model download',
        body: `TabScribe transcribes on your own machine using Chrome's ${lang} speech ` +
              'model — roughly 300&nbsp;MB. It downloads once, then works instantly and ' +
              'offline. You can leave this open and keep using the tab.',
        state: 'Downloading…',
      });
      break;

    case 'ready':
      // Nothing to say once the model is present. A "Model ready" panel is
      // noise: it appears only to disappear, and on the common path (model
      // already installed) the user never needed to know a model existed.
      stopModelTimer();
      hideModelPanel();
      break;

    case 'failed':
      stopModelTimer();
      showModelPanel({
        title: 'Model download failed',
        body: info.error
          ? `Chrome reported: ${info.error}`
          : 'Chrome could not finish downloading the model. This is usually a network ' +
            'problem — the download resumes from scratch, so a stable connection helps.',
        state: 'Failed',
        phase: 'failed',
        hint: false,
      });
      el.retryModel.hidden = false;
      break;

    case 'unavailable':
    case 'unsupported':
      stopModelTimer();
      showModelPanel({
        title: 'On-device model not available',
        body: info.phase === 'unsupported'
          ? 'This Chrome build does not offer on-device speech recognition. Chrome 150+ ' +
            'is required.'
          : `Chrome has no on-device model for ${lang} on this device.`,
        state: 'Unavailable',
        phase: 'failed',
        hint: false,
      });
      el.retryModel.hidden = true;
      // The remedies (pick another language, untick "On-device only") live in the
      // preferences group, so open it rather than describing controls the user
      // cannot see.
      if (el.prefsPanel.hidden) setPrefsOpen(true);
      break;

    default:
      break;
  }
}

async function useCloudInstead() {
  el.localOnly.checked = false;
  savePrefsFromUi();
  hideModelPanel();
  setStatus('Switched to Chrome\'s cloud recognition. Audio is sent to Google.');
  // Reached from the notice's own button, so the activation is still live.
  if (!el.record.disabled) await start({ gesture: true });
}

async function retryModel() {
  el.retryModel.hidden = true;
  if (!el.record.disabled) await start({ gesture: true });
}

/* ---------------------------------------------------------------- preferences */

function applyReadingPrefs(p) {
  el.theme.value = ['system', 'light', 'dark'].includes(p.theme) ? p.theme : 'system';
  el.fontSize.value = String([13, 15, 17].includes(p.fontSize) ? p.fontSize : 13);
  document.documentElement.dataset.theme = el.theme.value;
  document.documentElement.style.setProperty('--reading-size', `${el.fontSize.value}px`);
}

/** Push stored values onto the controls. Call BEFORE anything reads them. */
function applyPrefs(p) {
  applyReadingPrefs(p);
  el.lang.value = p.lang;
  el.localOnly.checked = p.localOnly;
  el.timestamps.checked = p.timestamps;
  el.autoscroll.checked = p.autoscroll;
  el.selectToCopy.checked = p.selectToCopy;
  el.copyToast.checked = p.copyToast;
  el.warnUnsaved.checked = p.warnUnsaved;
  el.includeMic.checked = p.includeMic;
  setPrefsOpen(p.prefsOpen, { save: false });
  updateModeSummary();
}

/** Show or hide the preferences group. */
function setPrefsOpen(open, { save = true } = {}) {
  el.prefsPanel.hidden = !open;
  el.prefsBtn.setAttribute('aria-expanded', String(!!open));
  if (save) prefs.set({ prefsOpen: !!open });
}

/** Persist whatever the controls currently say. */
function savePrefsFromUi() {
  updateModeSummary();
  return prefs.set({
    lang: el.lang.value,
    localOnly: el.localOnly.checked,
    timestamps: el.timestamps.checked,
    autoscroll: el.autoscroll.checked,
    selectToCopy: el.selectToCopy.checked,
    copyToast: el.copyToast.checked,
    warnUnsaved: el.warnUnsaved.checked,
    includeMic: el.includeMic.checked,
  });
}

// The side panel and the pop-out window are separate documents sharing one
// store. Without this, changing a toggle in one and then in the other would
// clobber the first change.
prefs.onChange((diff) => {
  if (diff.theme !== undefined || diff.fontSize !== undefined) applyReadingPrefs(prefs.get());
  if (diff.lang !== undefined) el.lang.value = diff.lang;
  if (diff.localOnly !== undefined) el.localOnly.checked = diff.localOnly;
  if (diff.timestamps !== undefined) {
    el.timestamps.checked = diff.timestamps;
    if (lastStore) render(lastStore);
  }
  if (diff.autoscroll !== undefined) el.autoscroll.checked = diff.autoscroll;
  if (diff.selectToCopy !== undefined) el.selectToCopy.checked = diff.selectToCopy;
  if (diff.copyToast !== undefined) el.copyToast.checked = diff.copyToast;
  if (diff.warnUnsaved !== undefined) el.warnUnsaved.checked = diff.warnUnsaved;
  if (diff.includeMic !== undefined) {
    el.includeMic.checked = diff.includeMic;
    // Both documents can be alive at once (sidePanel.close() is allowed to
    // fail), so turning the microphone off in one view must release it here too
    // rather than leaving the other document quietly recording.
    if (!diff.includeMic && mic) {
      mic.stop({ flushMs: 0 });
      setMicHint('Microphone off. Your own speech will not be added to the saved file.', false);
    }
  }
  if (diff.prefsOpen !== undefined) setPrefsOpen(diff.prefsOpen, { save: false });
  updateModeSummary();
});

/* ------------------------------------------------------------------ pop-out */

/** A Transcriber that holds text without a recognition session running. */
function ensureTranscriber() {
  if (transcriber) return transcriber;
  transcriber = new Transcriber({
    onUpdate: render,
    onStatus: (s) => {
      setState(s === 'listening' ? 'listening' : s);
      if (s === 'listening') setStatus('Listening. Select any text to copy part of it.');
      else if (s === 'restarting') setStatus('Reconnecting recognizer…');
      else if (s === 'stopped') setStatus('Stopped.');
    },
    onError: (code, message) => {
      setState('error');
      setStatus(`Recognition error: ${code}${message ? ` — ${message}` : ''}`, true);
    },
  });
  return transcriber;
}

/**
 * The single Record control's state.
 *
 * Start and Stop used to be two buttons that were never both usable. One toggle
 * is smaller and removes the "which one is live?" question, but it only works if
 * the control renames itself: a toggle that looks identical in both states is a
 * button people press twice. aria-pressed carries the state for screen readers,
 * the icon carries it visually, and the accessible name says what the NEXT press
 * will do.
 */
function setRecording(on) {
  el.record.setAttribute('aria-pressed', on ? 'true' : 'false');
  el.record.setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
  el.record.title = on
    ? 'Stop recognition and keep the transcript'
    : 'Start transcribing this tab';
}

/**
 * Keep the pop-out control's visible label and accessible name in agreement.
 * They diverged after a hand-off: the button read "Focus window" while screen
 * readers still announced "Open in window".
 */
function setPopoutLabel(text) {
  const label = el.popout.querySelector('.popout-label');
  if (label) label.textContent = text;
  el.popout.setAttribute('aria-label', text);
  el.popout.title = text === 'Focus window'
    ? 'Bring the TabScribe window to the front'
    : 'Move TabScribe into its own window';
}

async function popOut() {
  el.popout.disabled = true;
  const wasRunning = !!transcriber?.running;
  try {
    setStatus('Opening window…');

    // sidePanel.close() needs the id of the browser window hosting this panel, and
    // the panel document cannot determine that itself. Ask before releasing the tab,
    // so a failure here costs nothing.
    let sourceWindowId;
    try {
      const host = await chrome.runtime.sendMessage({ type: 'GET_HOST_WINDOW' });
      if (host?.ok) sourceWindowId = host.windowId;
    } catch (e) { /* close is best-effort */ }

    // Stop recognition and release the capture BEFORE the window opens: the tab can
    // only be captured once, so the window cannot arm until this document lets go.
    if (transcriber?.running) {
      await transcriber.stop({ flushMs: 400 });
    }
    const snapshot = transcriber ? transcriber.store.serialize() : null;
    await teardown();

    const res = await chrome.runtime.sendMessage({
      type: 'OPEN_WINDOW',
      snapshot,
      resume: wasRunning,
      sourceWindowId,
      width: prefs.get().windowWidth,
      height: prefs.get().windowHeight,
    });

    if (!res?.ok) {
      // Re-arm here so a failed pop-out does not leave the user with nothing.
      handedOff = false;
      const cap = await armCapture();
      setStatus(res?.error || 'Could not open the window.', true);
      if (cap.ok && wasRunning) await start();
      el.popout.disabled = false;
      return;
    }

    if (res.reused) {
      // The window already holds this tab's capture, so re-arming here is
      // guaranteed to fail with "Cannot capture a tab with an active stream".
      // Focusing it is the whole action; leave the hand-off state alone.
      if (handedOff) {
        el.status.textContent = 'TabScribe is already open in a window.';
        el.status.classList.remove('error');
        el.popout.disabled = false;
        return;
      }
      setStatus('TabScribe is already open in a window.');
      const cap = await armCapture();
      if (cap.ok && wasRunning) await start();
      el.popout.disabled = false;
      return;
    }

    // The window now owns the capture. Leave this document inert rather than
    // fighting it for the tab. handedOff is set BEFORE the message so a late 'end'
    // event from the recognizer cannot overwrite it.
    //
    // Normally this panel is already closing (the background closed it via
    // sidePanel.close), so this state is only ever seen when that failed — the
    // message is written for that case.
    handedOff = true;
    setState('idle');
    // The window owns the transcript now. A recovery copy left behind here would
    // let this dead panel restore and export text the live view no longer has.
    clearedSnapshot = null;
    el.undoBar.hidden = true;
    el.status.textContent = res.panelClosed
      ? 'Moved to its own window.'
      : 'Moved to its own window. You can close this panel.';
    el.status.classList.remove('error');
    el.record.disabled = true;
    setRecording(false);
    el.popout.disabled = false;
    setPopoutLabel('Focus window');
  } catch (e) {
    handedOff = false;
    setStatus(String(e && e.message ? e.message : e), true);
    el.popout.disabled = false;
  }
}

/** In window mode, adopt the transcript the side panel handed over. */
async function claimHandoff() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CLAIM_HANDOFF' });
    if (res?.ok && res.snapshot) {
      ensureTranscriber().store.restore(res.snapshot);
      render(transcriber.store);
      return { received: true, resume: !!res.resume };
    }
  } catch (e) { /* no handoff waiting */ }
  return { received: false, resume: false };
}

async function refreshTarget() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_TARGET' });
  if (res?.ok) {
    targetTabId = res.tabId;
    targetTitle = res.title || `tab ${res.tabId}`;
    refreshRecordTitle();
  }
}

/**
 * Begin transcribing.
 *
 * `gesture` says whether a live user activation is available. It is TRUE only
 * for the Start button's own click handler. Every programmatic caller — the
 * pop-out resume, the re-arm after a hand-off — passes false, because a
 * microphone request without a gesture is auto-denied with no prompt shown, and
 * reporting that as a refusal is the bug this whole path exists to avoid.
 */
async function start({ gesture = false } = {}) {
  el.record.disabled = true;
  // FIRST, synchronously: the user's click is a live gesture right now, and
  // everything below this line awaits, which would destroy it.
  //
  // micGranted is the load-bearing term. A side panel CANNOT show the microphone
  // prompt: without a stored grant, getUserMedia here is auto-rejected as
  // "Permission dismissed" and the panel would report a refusal the user was
  // never asked for. So it only opens the microphone once the grant already
  // exists; obtaining it is mic-permission.html's job, in a tab.
  // `armed` keeps the microphone from ever queueing ahead of tab capture.
  const pendingMic = (gesture && armed && micGranted && !micBlocked)
    ? requestMicStream() : null;
  setState('starting');
  setStatus('Preparing…');
  // The toggle reads as recording from the moment the user presses it, and stays
  // usable throughout. A first-run model download takes minutes, and a control
  // that is disabled and still labelled "Start" for that whole time gives the
  // user no way to change their mind and no idea what state they are in.
  setRecording(true);
  el.record.disabled = false;

  try {
    const lang = el.lang.value;
    const localOnly = el.localOnly.checked;

    // 1. Make sure the tab audio is captured. Normally armCapture() already ran when
    //    the panel opened; this covers a re-arm after the track ended.
    const cap = await armCapture();
    if (!cap.ok) {
      if (cap.needsInvocation) {
        throw new Error(
          'Click the TabScribe toolbar icon on the tab you want to transcribe, ' +
          'then press Start.'
        );
      }
      throw new Error(cap.error || 'Could not capture this tab\'s audio.');
    }

    // 2. Confirm the recognition model. Capture is already open, so a first-run
    //    model download cannot cost us the activeTab grant or expire a stream id.
    if (localOnly) {
      setStatus('Checking on-device model…');
      const model = await Transcriber.ensureModel(lang, {
        allowCloudFallback: false,
        onStatus: setStatus,
        onProgress: onModelProgress,
      });
      if (!model.ok) {
        if (model.availability === 'unsupported') {
          throw new Error(
            'This Chrome build does not expose on-device speech recognition. ' +
            'Chrome 150+ is required, or uncheck "On-device only".'
          );
        }
        throw new Error(
          `On-device model for ${lang} is "${model.availability}". ` +
          'Try another language, or uncheck "On-device only" to use the cloud service.'
        );
      }
    } else {
      hideModelPanel();
    }

    // 3. Recognize from the graph's output track. ensureTranscriber() reuses an
    //    existing instance so a transcript restored from a pop-out handoff, or kept
    //    from a previous Start/Stop cycle, is appended to rather than discarded.
    ensureTranscriber();

    transcriber.start(graph.track, { lang, processLocally: localOnly });

    setRecording(true);
    el.record.disabled = false;
    setStatus('Listening. Select any text to copy part of it.');

    // Strictly after the meeting transcription is live, and never awaited into
    // its failure path: the microphone is a bonus for the saved file and must
    // not be able to break, delay, or fail the thing the user actually asked for.
    attachMic(pendingMic, lang, localOnly);
  } catch (e) {
    setState('error');
    setStatus(String(e && e.message ? e.message : e), true);
    // The meeting failed to start, so release a microphone opened for it.
    if (pendingMic) {
      pendingMic.then((r) => stopStream(r && r.stream)).catch(() => {});
    }
    // The recognizer may already be running against the graph teardown is about
    // to destroy (transcriber.start() succeeded, then something after it threw).
    // Leaving it attached to a dead track produces an endless restart loop that
    // no longer has any audio to hear.
    if (transcriber?.running) {
      try { await transcriber.stop({ flushMs: 0 }); } catch (e2) { /* best effort */ }
    }
    await teardown();
    el.record.disabled = false;
    setRecording(false);
  }
}

async function teardown() {
  armed = false;
  // The microphone indicator must not stay lit after the panel lets the tab go.
  if (mic) {
    try { await mic.stop({ flushMs: 0 }); } catch (e) { /* best effort */ }
  }
  try { await graph?.cleanup(); } catch (e) { /* best effort */ }
  graph = null;
  if (stream) {
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch (e) { /* best effort */ }
    }
  }
  stream = null;
}

async function stop() {
  setRecording(false);
  setStatus('Finishing…');
  // Stop the microphone first and independently; its text is already banked in
  // its own store, and a failure here must not delay finishing the meeting.
  if (mic) {
    try { await mic.stop({ flushMs: 600 }); } catch (e) { /* best effort */ }
  }
  if (transcriber) {
    // Give the recognizer a moment to finalize the sentence in flight.
    await transcriber.stop({ flushMs: 1500 });
    render(transcriber.store);
  }
  // The capture stays armed so Start works again without another toolbar click.
  setState('idle');
  setStatus('Stopped. Transcript kept — use Copy or Download.');
  el.record.disabled = false;
}

// Release the capture when the panel goes away, so the tab is not held open.
window.addEventListener('pagehide', () => { teardown(); });

// After popping out, this document deliberately holds no capture. When the user
// comes back to it (typically because they closed the window), take the tab back
// rather than sitting there inert.
if (!IS_WINDOW) {
  window.addEventListener('focus', async () => {
    if (armed || !handedOff) return;
    const cap = await armCapture();
    if (cap.ok) {
      handedOff = false; // this document owns the tab again
      el.record.disabled = false;
      el.popout.disabled = false;
      setPopoutLabel('Open in window');
      setStatus('Back in the side panel. Press Record to transcribe this tab.');
    }
  });
}

/* ------------------------------------------------------------------- output */

/* ------------------------------------------------------------- microphone */

/**
 * Open the microphone, synchronously, while the Start click's gesture is live.
 *
 * This MUST NOT be awaited before it is called. Measured on Chrome 151: a side
 * panel calling getUserMedia without a live user gesture is rejected with
 * NotAllowedError and no prompt is ever shown — which is why the panel used to
 * announce a refusal the user was never given the chance to make.
 *
 * Returns a promise for the stream request, or null when the option is off.
 * Never throws, so it cannot interfere with arming tab capture.
 */
function requestMicStream() {
  if (!el.includeMic.checked) return null;
  try {
    // Ownership matters: the instance tracks the in-flight request so turning
    // the option off while the prompt is open releases whatever arrives later.
    if (!mic) mic = new MicTranscriber({ onStateChange: onMicState });
    return mic.open();
  } catch (e) {
    return Promise.resolve({ ok: false, reason: 'failed',
                             error: String(e && e.message ? e.message : e) });
  }
}

/**
 * Attach an already-open microphone stream to its own recognizer.
 *
 * Called after the meeting transcription is already live, so any failure here
 * is reported where the control lives and changes nothing else.
 */
async function attachMic(pending, lang, processLocally) {
  if (!pending) return;
  let res;
  try {
    res = await pending;
  } catch (e) {
    disableMic('failed', String(e && e.message ? e.message : e));
    return;
  }
  // 'cancelled' is the user's own doing, not a failure to report.
  if (!res.ok) {
    if (res.reason !== 'cancelled') disableMic(res.reason, res.error);
    return;
  }
  if (!el.includeMic.checked) { stopStream(res.stream); return; }

  try {
    if (!mic) mic = new MicTranscriber({ onStateChange: onMicState });
    if (mic.running) { stopStream(res.stream); return; }
    const started = await mic.start(res.stream, {
      lang,
      processLocally,
      // The meeting's clock, so merged turns land where they were spoken.
      t0: transcriber?.t0 || 0,
    });
    if (!started.ok) { disableMic(started.reason, started.error); return; }
    setMicHint('Your microphone is being transcribed into the saved file only.', false);
  } catch (e) {
    stopStream(res.stream);
    disableMic('failed', String(e && e.message ? e.message : e));
  }
}

function setMicHint(text, denied) {
  el.micHint.textContent = text;
  el.micHint.classList.toggle('denied', !!denied);
}

/**
 * The microphone indicator in the toolbar.
 *
 * One glance should answer "is my voice being saved?". The states are distinct
 * because the remedies are distinct, and each carries its meaning in the
 * accessible name and tooltip rather than in colour alone:
 *
 *   off              the option is unticked — nothing to fix
 *   needs-permission no grant yet; pressing it opens the page that can ask
 *   recording        actually transcribing into the saved file
 *   blocked          Chrome is refusing; only Chrome's own UI can undo that
 *   error            it failed for some other reason, named in the hint
 */
function setMicIndicator(permissionState) {
  let state = 'off';
  let label = 'Microphone off. Your own speech is not saved.';

  if (el.includeMic.checked) {
    if (mic?.running) {
      state = 'recording';
      label = 'Microphone on. Your speech is being added to the saved transcript.';
    } else if (permissionState === 'denied') {
      state = 'blocked';
      label = 'Microphone blocked by Chrome. Allow it from the address-bar icon.';
    } else if (micBlocked) {
      state = 'error';
      label = 'Microphone unavailable this session. The meeting transcript is unaffected.';
    } else if (permissionState !== 'granted') {
      state = 'needs-permission';
      label = 'Allow microphone so your own speech is saved';
    } else {
      state = 'off';
      label = 'Microphone ready. It starts with the next recording.';
    }
  }

  el.micStatus.dataset.state = state;
  el.micStatus.setAttribute('aria-label', label);
  el.micStatus.title = label;
  // Only one state has an action behind it; the others are status, not buttons.
  el.micStatus.disabled = state !== 'needs-permission';
}

/**
 * Reflect the real permission state in the preferences row.
 *
 * Called on load and whenever the option is ticked, so the panel never implies
 * the microphone is working when the grant does not exist.
 */
async function refreshMicPermission() {
  const state = await MicTranscriber.permissionState();
  micGranted = state === 'granted';
  el.micGrant.hidden = !el.includeMic.checked || micGranted;
  setMicIndicator(state);
  if (!el.includeMic.checked) return state;
  if (micGranted) {
    setMicHint('Your own speech is added to the downloaded transcript only — '
      + 'never shown live.', false);
  } else if (state === 'denied') {
    setMicHint('Chrome is blocking the microphone for TabScribe. Allow it from the '
      + 'address-bar icon, then press Start again.', true);
  } else {
    setMicHint('Your own speech is added to the downloaded transcript only — never '
      + 'shown live. Chrome needs to ask for the microphone once.', false);
  }
  return state;
}

/**
 * Open the page that can actually ask. A side panel cannot show the prompt, so
 * this is the only way to obtain the grant (measured — see mic-permission.js).
 */
async function openMicPermissionPage() {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
  } catch (e) {
    setMicHint(`Could not open the microphone page: ${e && e.message ? e.message : e}`, true);
  }
}

/**
 * The microphone died on its own — permission revoked mid-session, device
 * unplugged, recognizer gave up. Without this the panel keeps claiming the
 * microphone is being transcribed when it no longer is.
 */
function onMicState(state) {
  // Whatever happened, the toolbar indicator must stop claiming the old state.
  refreshMicPermission();
  if (state.running) return;
  if (state.error) { disableMic('failed', state.error); return; }
  // A clean stop while the option is still on: do not leave the success wording
  // standing, since nothing is being captured any more.
  if (el.includeMic.checked && !el.micHint.classList.contains('denied')
      && /being transcribed/.test(el.micHint.textContent)) {
    setMicHint('The microphone stopped. Your own speech is no longer being added.', false);
  }
}

/**
 * Report a microphone failure where the control lives, and stop retrying it.
 *
 * The status line is reserved for the meeting transcription; a microphone
 * problem must never read like a recognition failure. The checkbox is left ON:
 * the user asked for this, and a transient problem (device busy, prompt
 * dismissed) should not silently revoke the setting for every future meeting.
 * Only this session stops trying, via micBlocked.
 */
function disableMic(reason, detail) {
  micBlocked = true;
  const message = MIC_MESSAGES[reason] || MIC_MESSAGES.failed;
  setMicHint(`${message} The meeting transcript is unaffected.`, true);
  if (detail) console.warn('TabScribe microphone:', reason, detail);
}

/** The saved text: meeting only, or meeting merged with the user's own speech. */
function transcriptForSaving() {
  const timestamps = el.timestamps.checked;
  if (!transcriber) return '';
  if (!el.includeMic.checked || !mic || !mic.hasText()) {
    return transcriber.getText({ timestamps });
  }
  try {
    return mergeTranscripts(transcriber.store, mic.store, { timestamps });
  } catch (e) {
    // Never lose the meeting transcript to a merge bug.
    return transcriber.getText({ timestamps });
  }
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // The Clipboard API refuses to write from an unfocused document; fall back to
    // a scratch textarea, which does not disturb the transcript selection because
    // the previous selection is restored afterwards.
    const sel = window.getSelection();
    const saved = [];
    for (let i = 0; i < sel.rangeCount; i += 1) saved.push(sel.getRangeAt(i).cloneRange());

    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();

    sel.removeAllRanges();
    for (const range of saved) sel.addRange(range);
    return ok;
  }
}

async function copy() {
  // A selection means "copy this part" — that is the whole point of being able to
  // select. With nothing selected, fall back to the entire transcript.
  const sel = transcriptSelection();
  const selected = sel ? sel.toString().trim() : '';
  const whole = transcriber ? transcriber.getText({ timestamps: el.timestamps.checked }) : '';
  const text = selected || whole;

  if (!text) { setStatus('Nothing to copy yet.'); return; }

  const ok = await writeClipboard(text);
  if (!ok) {
    setStatus('Copy failed — press Ctrl+C with the text selected.', true);
    return;
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  confirmAction('Copied', selected
    ? `Copied the selected passage (${words} words).`
    : `Copied the whole transcript (${words} words).`);
}



/**
 * Chrome's own "You have unsaved progress" dialog.
 *
 * Measured on Chrome 151 (probe/spike_unload.py, probe/spike_panel_unload.py):
 * beforeunload produces a real blocking dialog in the side panel, in the pop-out
 * window, and in an extension page in a tab. It needs a prior user interaction,
 * which any session that produced a transcript necessarily has.
 *
 * Chrome ignores the returned string and shows its own wording, so there is no
 * custom message to write here.
 */
window.addEventListener('beforeunload', (event) => {
  if (!el.warnUnsaved.checked) return undefined;
  if (!hasUnsavedTranscript()) return undefined;
  event.preventDefault();
  event.returnValue = '';
  return '';
});

function download() {
  // Download is the one place the microphone appears: the live view and Copy
  // stay exactly as they were.
  const text = transcriptForSaving();
  if (!text) { setStatus('Nothing to download yet.'); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `transcript-${stamp}.txt`;
  let url = null;
  try {
    // Losing the whole meeting to a silent failure is the worst outcome this UI
    // has, so the one unavoidable output path reports when it did not work.
    url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  } catch (e) {
    if (url) { try { URL.revokeObjectURL(url); } catch (e2) { /* nothing to revoke */ } }
    setStatus(`Could not save the transcript: ${e && e.message ? e.message : e}. `
      + 'Use Copy and paste it somewhere safe.', true);
    return;
  }
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  // Remember exactly what reached the disk, so the close warning can tell the
  // difference between "saved" and "saved, then the meeting continued".
  savedText = text;
  refreshUnsavedUi();
  const withMic = el.includeMic.checked && mic?.hasText();
  confirmAction('Downloaded', withMic
    ? `Downloaded ${name}, including your microphone.`
    : `Downloaded ${name}`);
}

// Only the most recent Clear is recoverable, in this view's memory. It is never
// persisted to disk, and remains available until used, dismissed, or replaced.
let clearedSnapshot = null;

function undoClear() {
  if (!clearedSnapshot || !transcriber) return;
  transcriber.store.prepend(clearedSnapshot);
  clearedSnapshot = null;
  el.undoBar.hidden = true;
  // Rebuild only for the explicit recovery action, never for live updates.
  nodes.clear();
  el.transcript.replaceChildren(el.empty);
  following = false;
  render(transcriber.store);
  el.transcript.scrollTop = 0;
  el.transcript.focus({preventScroll: true});
}

function clear() {
  // The occasional action lives in Preferences; reveal its result and Undo.
  // save:false — collapsing is a consequence of Clear, not a preference the user
  // expressed, and persisting it would also reach into the other open view.
  setPrefsOpen(false, { save: false });
  el.transcript.focus({preventScroll: true});
  if (transcriber && !transcriber.store.isEmpty()) {
    clearedSnapshot = transcriber.store.serialize();
    el.undoBar.hidden = false;
  }
  // Drop the DOM rows and their cached identities first, so nothing from the old
  // transcript can be reused when rendering resumes.
  nodes.clear();
  heldUpdates = false;
  el.transcript.replaceChildren(el.empty);
  following = true;
  el.jumpLatest.hidden = true;
  el.empty.style.display = '';
  el.copy.disabled = el.download.disabled = el.clear.disabled = true;

  // Clearing the store alone would leave the in-flight utterance alive inside the
  // recognition session, and it would reappear on the next event. reset() abandons
  // that session and starts a fresh one when recognition is running.
  if (transcriber) {
    transcriber.reset();
  }
  // Clear means clear: microphone text is part of what a later Download would
  // write, so leaving it behind would resurrect speech the user just discarded.
  // Undo intentionally does not restore it — recovering hidden text into a file
  // the user cannot see on screen would be worse than losing it.
  mic?.clear();

  // A pending selection inside the removed text is meaningless now.
  const sel = window.getSelection();
  if (sel && el.transcript.contains(sel.anchorNode)) sel.removeAllRanges();
  el.transcript.classList.remove('holding');
  refreshSelectionUi();

  setStatus(transcriber?.running
    ? 'Cleared. Still listening.'
    : 'Cleared.');
}

// The ONLY caller with a live user activation, and so the only one that may ask
// for the microphone. Wrapped rather than passed directly: the click event
// object would otherwise arrive as the options argument.
// One control: press to start, press again to stop. gesture:true only here,
// because this is the sole caller with a live user activation.
el.record.addEventListener('click', () => {
  if (el.record.getAttribute('aria-pressed') === 'true') return stop();
  return start({ gesture: true });
});
el.copy.addEventListener('click', copy);
el.download.addEventListener('click', download);
el.clear.addEventListener('click', clear);
el.undoClear.addEventListener('click', undoClear);
el.undoDismiss.addEventListener('click', () => {
  clearedSnapshot = null;
  el.undoBar.hidden = true;
  el.transcript.focus({preventScroll: true});
});
el.popout.addEventListener('click', popOut);
el.useCloud.addEventListener('click', useCloudInstead);
el.retryModel.addEventListener('click', retryModel);
el.prefsBtn.addEventListener('click', () => {
  setPrefsOpen(el.prefsPanel.hidden);
});
for (const control of [el.theme, el.fontSize]) {
  control.addEventListener('change', () => {
    const values = {theme: el.theme.value, fontSize: Number(el.fontSize.value)};
    applyReadingPrefs(values);
    prefs.set(values);
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.prefsPanel.hidden) {
    setPrefsOpen(false);
    el.prefsBtn.focus();
    event.preventDefault();
  }
});
el.copyToast.addEventListener('change', savePrefsFromUi);
el.timestamps.addEventListener('change', () => {
  savePrefsFromUi();
  if (lastStore) render(lastStore);
});
el.autoscroll.addEventListener('change', savePrefsFromUi);
el.includeMic.addEventListener('change', () => {
  savePrefsFromUi();
  if (el.includeMic.checked) {
    // A deliberate re-tick is the user asking to try again.
    micBlocked = false;
    // Ticking is a gesture, but a gesture is not enough in a side panel: without
    // a stored grant the request is auto-rejected with no prompt. Ask for the
    // stream only when the grant already exists; otherwise show the button that
    // opens the page which CAN prompt.
    if (micGranted && transcriber?.running && !mic?.running) {
      attachMic(requestMicStream(), el.lang.value, el.localOnly.checked);
    }
    refreshMicPermission();
  } else if (mic) {
    // Turning it off releases the microphone immediately. Text already captured
    // is kept: the user may re-enable before saving, and silently discarding it
    // on a stray click would be the destructive choice.
    mic.stop({ flushMs: 0 });
    setMicHint('Microphone off. Your own speech will not be added to the saved file.', false);
    el.micGrant.hidden = true;
  } else {
    setMicHint('Microphone off. Your own speech will not be added to the saved file.', false);
    el.micGrant.hidden = true;
  }
});
el.micGrant.addEventListener('click', openMicPermissionPage);
el.clearScreen.addEventListener('click', clearScreen);
el.showHidden.addEventListener('click', showHidden);
el.warnUnsaved.addEventListener('change', savePrefsFromUi);
// The indicator is only actionable in the state that has an action: no grant yet.
el.micStatus.addEventListener('click', () => {
  if (el.micStatus.dataset.state === 'needs-permission') openMicPermissionPage();
});
el.selectToCopy.addEventListener('change', () => {
  savePrefsFromUi();
  // Turning it on mid-selection should not retroactively copy what is already
  // highlighted — the user did not make that selection under this setting.
  lastAutoCopied = el.selectToCopy.checked
    ? (transcriptSelection()?.toString().trim() || '')
    : '';
});
el.lang.addEventListener('change', () => {
  savePrefsFromUi();
  if (el.localOnly.checked) previewModelState();
});
el.localOnly.addEventListener('change', () => {
  savePrefsFromUi();
  if (el.localOnly.checked) previewModelState();
  else hideModelPanel();
});

/**
 * Warn about the one-time download BEFORE the user presses Start, so a slow
 * connection is not a surprise mid-session. This only reads state; it never starts
 * a download on its own.
 */
async function previewModelState() {
  if (!el.localOnly.checked) { hideModelPanel(); return; }
  const lang = el.lang.value;
  const availability = await Transcriber.availability(lang, true);
  if (availability === 'available') { hideModelPanel(); return; }

  if (availability === 'downloading') {
    onModelProgress({ phase: 'downloading', availability });
    return;
  }
  if (availability === 'downloadable') {
    showModelPanel({
      title: 'First run needs a one-time download',
      body: `Transcribing ${langName(lang)} on-device needs Chrome's speech model — ` +
            'roughly 300&nbsp;MB, downloaded once. Press <strong>Start</strong> and it ' +
            'will download automatically; on a slow connection expect several minutes.',
      state: 'Not downloaded yet',
      phase: 'idle',
      hint: false,
    });
    el.retryModel.hidden = true;
    return;
  }
  onModelProgress({ phase: availability === 'unsupported' ? 'unsupported' : 'unavailable',
                    availability });
}

// Arm capture immediately: the panel opened because the user just clicked the
// toolbar action, and that invocation is what authorises tabCapture. Waiting until
// Start risks losing the grant, and a stream id minted now would expire during a
// first-run model download.
//
// In window mode the transcript handed over by the side panel is restored first, so
// the text is on screen even if arming turns out to be slow.
(async () => {
  // Preferences first, before anything reads a control. Applying them later
  // makes the UI visibly flip, and worse, the model check and capture arming
  // below would run against defaults rather than the user's chosen values.
  applyPrefs(await prefs.load());
  // Read the real grant state before anything reports on the microphone. This
  // never prompts; it only decides whether Start may open the microphone and
  // whether the "Allow microphone…" button is offered.
  await refreshMicPermission();

  let handoff = { received: false, resume: false };
  if (IS_WINDOW) {
    handoff = await claimHandoff();
  }

  // A pop-out hand-off carries its own text; otherwise pick up whatever the last
  // panel document left behind. Closing the side panel destroys it without any
  // warning from Chrome, so this is what keeps a meeting from disappearing.
  let restored = false;
  if (!handoff.received) {
    restored = await restoreAutosave();
  }

  await refreshTarget();
  const cap = await armCapture();

  if (!cap.ok) {
    if (cap.needsInvocation) {
      setStatus('Click the TabScribe toolbar icon on the tab you want to transcribe.');
    } else {
      setStatus(cap.error || 'Could not capture this tab\'s audio.', true);
    }
    return;
  }

  if (handoff.resume) {
    // The side panel was transcribing when the user popped out; pick up where it
    // left off rather than making them press Start again.
    //
    // No gesture here, so the microphone is not opened on this path even when
    // granted; the meeting transcript is what must resume. The user's next Start
    // in this window picks the microphone up.
    await start();
    if (el.includeMic.checked && micGranted && !mic?.running) {
      setMicHint('Press Stop and Start in this window to include your microphone.', false);
    }
    return;
  }
  if (restored) {
    setStatus('Earlier transcript restored. Press Record to continue, '
      + 'or Download to save it.');
    return;
  }
  setStatus(handoff.received
    ? 'Moved to this window. Press Record to continue transcribing.'
    : 'Ready. Press Record to transcribe this tab.');

  // Surface the one-time download requirement up front rather than at Start.
  previewModelState();
})();
