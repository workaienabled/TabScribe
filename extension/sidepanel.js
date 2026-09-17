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
import { Transcriber, TranscriptStore, buildAudioGraph, formatClock } from './transcriber.js';
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
  clear: document.getElementById('clearBtn'),
  undoBar: document.getElementById('undoBar'),
  confirmBar: document.getElementById('confirmBar'),
  confirmSave: document.getElementById('confirmSaveBtn'),
  confirmDelete: document.getElementById('confirmDeleteBtn'),
  confirmCancel: document.getElementById('confirmCancelBtn'),
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
  actionLog: document.getElementById('actionLog'),
  transcript: document.getElementById('transcript'),
  jumpLatest: document.getElementById('jumpLatestBtn'),
  empty: document.getElementById('emptyHint'),
  status: document.getElementById('status'),
  issues: document.getElementById('issues'),
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

/**
 * The message protocol this document was built against. Must match the
 * worker's PROTOCOL_VERSION in background.js; bump both together.
 *
 * Chrome can keep an old service worker alive across an unpacked reload, so a
 * panel from the new files may be talking to a worker from the old ones. That
 * worker answers the messages it knows and returns undefined for the rest, and
 * nothing errors: the failure shows up later, somewhere else, looking like a
 * different bug. A stale worker stopped a live meeting mid-switch this way,
 * through four fixes to the switch itself. So the mismatch is detected once,
 * at startup, and said out loud.
 */
const PROTOCOL_VERSION = 4;
const receiverId = crypto.randomUUID();
window.PROTOCOL_VERSION = PROTOCOL_VERSION;
let workerStale = false;

/** True when a reply came from a worker that predates this document. */
function replyIsStale(reply) {
  return !reply || typeof reply !== 'object' || reply.workerVersion !== PROTOCOL_VERSION;
}

/** A dead message channel must not leave a control disabled forever. */
async function workerRequest(message) {
  let timer;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TabScribe's background service did not answer ${message.type}. Keep this view open and retry.`)), 25000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

const STALE_WORKER_MESSAGE =
  'TabScribe was updated but Chrome is still running the old version. '
  + 'Reload the extension at chrome://extensions, or restart Chrome.';

function noteStaleWorker(where, reply) {
  workerStale = true;
  switchLog('STALE WORKER detected', {
    at: where,
    expected: PROTOCOL_VERSION,
    got: reply && typeof reply === 'object' ? (reply.workerVersion ?? 'unversioned') : String(reply),
  });
}

// How long the side panel will wait for a hand-off the window has ANNOUNCED.
// This is a ceiling on a wait that normally ends the moment the snapshot lands,
// not a guess at how long a teardown takes — it only has to outlast the slowest
// plausible recognizer flush.
const SWITCH_HANDOFF_WAIT_MS = 20000;

/**
 * A step-by-step record of the last view switch, kept in session storage so it
 * survives the document swap the switch itself causes. Four attempts at fixing
 * "recording stops when I switch back" each fixed a cause the harness could
 * reproduce and missed the one the user hit; this exists so the next report can
 * carry facts. Read from the gear panel, under "Last view switch".
 */
const SWITCH_LOG_KEY = 'switchLog';
const SWITCH_LOG_MAX = 40;
const docTag = IS_WINDOW ? 'window' : `panel:${Math.random().toString(36).slice(2, 6)}`;

async function switchLog(step, detail) {
  const line = `${new Date().toISOString().slice(11, 23)} ${docTag} ${step}`
    + (detail ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '');
  try {
    const stored = await chrome.storage.session.get(SWITCH_LOG_KEY);
    const lines = Array.isArray(stored[SWITCH_LOG_KEY]) ? stored[SWITCH_LOG_KEY] : [];
    lines.push(line);
    await chrome.storage.session.set({ [SWITCH_LOG_KEY]: lines.slice(-SWITCH_LOG_MAX) });
  } catch (e) { /* logging must never break the thing it logs */ }
}

async function switchLogReset(step) {
  try { await chrome.storage.session.set({ [SWITCH_LOG_KEY]: [] }); } catch (e) { /* ignore */ }
  await switchLog(step);
}

// Deliberately no on-screen renderer. The record below is kept — it costs one
// session-storage write per step and is what the regression suites read — but
// it is developer output, and this panel is meant to be minimal. Read it with:
//   chrome.storage.session.get('switchLog')
// from the panel's devtools console.

let armingPromise = null;
function armCapture(options = {}) {
  if (!armingPromise) armingPromise = armCaptureAttempt(options).finally(() => { armingPromise = null; });
  return armingPromise;
}

async function armCaptureAttempt({ retries = 0 } = {}) {
  if (armed && stream?.getAudioTracks().some(t => t.readyState === 'live') && graph?.track.readyState === 'live') return { ok: true };
  await teardown();
  try {
    const res = await workerRequest({ type: 'GET_STREAM_ID', tabId: targetTabId });
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

    const capturedStream = stream;
    tracks[0].addEventListener('ended', () => {
      if (stream !== capturedStream || switching || handedOff) return;
      armed = false;
      void stop({ reason: 'Tab audio ended (the tab closed, navigated, or stopped sharing). The transcript is kept. Click the toolbar icon on the meeting tab, then press Record.' });
    });

    armed = true;
    return { ok: true };
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    // "Cannot capture a tab with an active stream" means another TabScribe
    // document still holds this tab. That happens on the way back from the
    // pop-out window: sidePanel.open() must fire inside the click to keep the
    // user's gesture, so the panel can load before the window has finished
    // letting go. The release is already in flight, so wait briefly and retry
    // rather than reporting a failure that fixes itself.
    if (retries > 0 && /active stream/i.test(message)) {
      await new Promise((r) => setTimeout(r, 400));
      return armCaptureAttempt({ retries: retries - 1 });
    }
    await teardown();
    return { ok: false, error: message };
  }
}

// Independent failures stay visible until that operation succeeds. Recognition
// events must not erase an unsaved-data warning, nor should Copy erase a speech error.
const issues = new Map();
function showIssue(key, message = '') {
  if (message) issues.set(key, message);
  else issues.delete(key);
  el.issues.replaceChildren(...Array.from(issues, ([source, text]) => {
    const p = document.createElement('p');
    p.dataset.source = source;
    p.textContent = text;
    return p;
  }));
  el.issues.hidden = issues.size === 0;
}

function reportUnexpected(error) {
  showIssue('unexpected', `An unexpected extension error occurred: ${error?.message || error || 'unknown error'}. The transcript is kept. Copy or Download it before reopening TabScribe.`);
}
// Last resort for an unanticipated browser callback, not a substitute for the
// operation-specific handlers below. Leave the original error in DevTools too.
window.addEventListener('unhandledrejection', event => reportUnexpected(event.reason));
window.addEventListener('error', event => reportUnexpected(event.error || event.message));

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

function makeRow(key, before = null) {
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
  el.transcript.insertBefore(row, before);
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
  confirmAction('Screen cleared', 'Screen cleared. The text is still in the download.',
                el.clearScreen);
}

function showHidden() {
  screenHidden = new Set();
  if (lastStore) render(lastStore);
}

/* ------------------------------------------------------------ unsaved work */

/**
 * A download request cannot prove the file reached disk. Protect text in either
 * channel, even when the current export preference excludes the microphone.
 * savedText remains for compatibility with older autosave and hand-off payloads;
 * those request-time flags are not evidence that deleting the text is safe.
 */
let savedText = '';

function hasUnsavedTranscript() {
  return !!((lastStore && !lastStore.isEmpty()) || mic?.hasText());
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
let autosaveQueue = Promise.resolve();
let autosaveBlocked = false;
let handoffBlocked = false;

function flushAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  if (handedOff || switching || autosaveBlocked || handoffBlocked) return Promise.resolve(false);
  const hasText = (transcriber && !transcriber.store.isEmpty()) || mic?.hasText();
  const value = hasText ? {
    snapshot: transcriber?.store.serialize() || new TranscriptStore().serialize(),
    savedText: '',
    micText: mic?.hasText() ? mic.store.serialize() : null,
    at: Date.now(),
  } : null;
  autosaveQueue = autosaveQueue.then(async () => {
    // The receiving document owns persistence after a successful hand-off.
    if (handedOff || switching || autosaveBlocked || handoffBlocked) return false;
    try {
      if (value) await chrome.storage.session.set({ [AUTOSAVE_KEY]: value });
      else await chrome.storage.session.remove(AUTOSAVE_KEY);
      showIssue('autosave');
      return true;
    } catch (e) {
      showIssue('autosave', `Transcript autosave failed: ${e?.message || e}. Keep this view open and use Download or Copy before closing.`);
      return false;
    }
  });
  return autosaveQueue;
}

function scheduleAutosave() {
  if (autosaveTimer || handedOff || switching || autosaveBlocked || handoffBlocked) return;
  autosaveTimer = setTimeout(() => { void flushAutosave(); }, 1200);
}

/** Validate all saved channels before replacing either live store. */
function restoreStoredTranscript(saved) {
  const meeting = new TranscriptStore();
  meeting.restore(saved.snapshot);
  const microphone = new TranscriptStore();
  if (saved.micText != null) microphone.restore(saved.micText);
  ensureTranscriber().store.restore(meeting.serialize());
  if (mic || !microphone.isEmpty()) {
    if (!mic) mic = new MicTranscriber({ onStateChange: onMicState, onUpdate: onMicUpdate });
    mic.store.restore(microphone.serialize());
  }
  savedText = ''; // Old download-request flags are not evidence of a completed file.
  render(transcriber.store);
}

/** Restore a transcript left behind by a previous panel document. */
async function restoreAutosave() {
  try {
    const stored = await chrome.storage.session.get(AUTOSAVE_KEY);
    const saved = stored[AUTOSAVE_KEY];
    if (!saved) return false;
    restoreStoredTranscript(saved);
    showIssue('restore');
    return !transcriber.store.isEmpty() || !!mic?.hasText();
  } catch (e) {
    // Do not overwrite an unreadable recovery copy with an empty/new document.
    autosaveBlocked = true;
    showIssue('restore', `The previous transcript could not be restored: ${e?.message || e}. Its recovery copy was not overwritten. Keep this view open and Download any new transcript before closing.`);
    return false;
  }
}

function render(store) {
  lastStore = store;
  // Hidden keys are filtered here, and only here: the store still holds them, so
  // Copy, Download, and the word count are unaffected by clearing the screen.
  const all = store.liveSegments();
  // Restoring a newer snapshot can remove rows (for example after Delete in
  // the other view). Do not leave old DOM text selectable after it leaves the
  // store. Preserve existing nodes for every key that is still present.
  const keys = new Set(all.map(segment => segment.key));
  for (const [key, entry] of nodes) {
    if (!keys.has(key)) { entry.row.remove(); nodes.delete(key); }
  }
  for (const key of screenHidden) if (!keys.has(key)) screenHidden.delete(key);
  const segs = screenHidden.size ? all.filter((s) => !screenHidden.has(s.key)) : all;

  el.empty.style.display = all.length === 0 ? '' : 'none';
  el.copy.disabled = store.isEmpty();
  el.download.disabled = el.clear.disabled = store.isEmpty() && !mic?.hasText();
  el.clearScreen.disabled = segs.length === 0;
  hiddenNoticeRefresh(store);
  refreshUnsavedUi();
  scheduleAutosave();

  const showTs = el.timestamps.checked;
  const sel = transcriptSelection();
  let deferred = 0;
  let previousRow = null;

  for (const seg of segs) {
    let entry = nodes.get(seg.key);
    if (!entry) {
      // Show may restore older rows before already-visible new speech. Insert
      // only the missing rows in store order; never move an existing selected
      // node or rebuild the transcript to repair its order.
      const before = previousRow ? previousRow.nextElementSibling : el.transcript.querySelector('.seg');
      entry = makeRow(seg.key, before);
      nodes.set(seg.key, entry);
    }
    previousRow = entry.row;
    if (entry.text === seg.text && entry.isFinal === seg.isFinal && entry.showTs === showTs) {
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
 * The fallback is NOT the status line. That line belongs to recognition, and
 * writing "Copied" into it replaced "Listening" — worse, setStatus also clears
 * the error state, so copying a passage could erase a recognition failure and
 * leave the panel looking healthy while capture was dead. The acknowledgement
 * now goes to a live region for assistive technology and a brief mark on the
 * control that was pressed, neither of which can overwrite capture's story.
 */
let didMarkTimer = null;

function confirmAction(toastText, statusText, control = null) {
  // Announced either way: the toast is decorative and `aria-live` on a element
  // that only sometimes appears is not a dependable announcement.
  if (el.actionLog) el.actionLog.textContent = statusText;
  if (showToast(toastText)) return;
  if (!control) return;
  if (didMarkTimer) clearTimeout(didMarkTimer);
  for (const b of document.querySelectorAll('button.did')) b.classList.remove('did');
  control.classList.add('did');
  didMarkTimer = setTimeout(() => control.classList.remove('did'), 1200);
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

  const requestId = ++clipboardRequestId;
  const ok = await writeClipboard(text, requestId);
  if (requestId !== clipboardRequestId) return;
  if (!ok) {
    // Do not claim success. The manual Copy button remains available.
    showIssue('copy', 'Auto-copy failed — press Ctrl+C to copy the selection.');
    return;
  }
  showIssue('copy');
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
  if (body !== undefined) el.modelBody.textContent = body;
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
              'model — roughly 300 MB. After installation, it can work ' +
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
          : 'Chrome could not finish installing the model. Check your connection and free disk space, then retry the download.',
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
          ? 'This browser does not expose on-device speech recognition. Use a current Google Chrome build with that feature enabled.'
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
  if (stopInProgress || el.record.disabled) return;
  // Only this explicit choice may supersede local preparation. Abort its wait
  // before Start's busy guard; a late install result must not revive it.
  activeStart?.abort();
  activeStart = null;
  el.localOnly.checked = false;
  savePrefsFromUi();
  hideModelPanel();
  // Reached from the notice's own button, so the activation is still live.
  await start({ gesture: true });
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

/** Explain the failed attempt, not preferences changed while it was running. */
function fatalRecognitionMessage(code, message = '') {
  const { lang, processLocally } = transcriber?.options || {
    lang: el.lang.value, processLocally: el.localOnly.checked,
  };
  const remedies = {
    'language-not-supported': processLocally
      ? `Chrome could not use on-device recognition for language ${lang}. Press Record to check the model again, or choose another language in Preferences.`
      : `Chrome's cloud service could not recognize language ${lang}. Choose another language in Preferences, then press Record.`,
    'not-allowed': 'Chrome denied speech recognition. Check permissions for TabScribe and any browser policy, then press Record to retry.',
    'service-not-allowed': 'Chrome refused the selected speech service. Check browser policy or choose another recognition mode in Preferences, then press Record.',
    'audio-capture': 'Speech recognition lost its audio input. Click the TabScribe toolbar icon on the meeting tab, then press Record.',
    'network': 'The speech service connection failed. Check your connection, then press Record to retry.',
    'bad-grammar': 'Chrome rejected the speech recognition configuration. Reload TabScribe after downloading your transcript.',
    'phrases-not-supported': 'Chrome does not support this speech recognition configuration. Update Chrome, then retry Record.',
    'restart-failed': 'Speech recognition could not restart. Press Record to retry. The transcript is kept.',
    'restart-limit': 'Speech recognition repeatedly stopped without making progress. Press Record to retry. The transcript is kept.',
  };
  const explanation = remedies[code] || 'Speech recognition failed. Press Record to retry. The transcript is kept.';
  return `${explanation} (${code || 'unknown'}${message ? `: ${message}` : ''})`;
}

/** A Transcriber that holds text without a recognition session running. */
function ensureTranscriber() {
  if (transcriber) return transcriber;
  transcriber = new Transcriber({
    onUpdate: render,
    onStatus: (s, detail = {}) => {
      // Stop owns its message even when Chrome delivers onend after its promise
      // resolves. Transcriber.stopping resets only when a new attempt starts.
      if (s === 'stopped' && (stopInProgress || transcriber?.stopping)) return;
      setState(s === 'listening' ? 'listening' : s);
      if (s === 'listening') setStatus('Listening. Select any text to copy part of it.');
      else if (s === 'restarting') setStatus('Reconnecting recognizer…');
      else if (s === 'stopped') {
        setRecording(false);
        el.record.disabled = false;
        // The optional microphone must not continue after meeting recognition ends.
        if (mic) mic.stop({ flushMs: 0 }).catch(() => {});
        if (detail.fatal) {
          setState('error');
          setStatus(fatalRecognitionMessage(detail.error, detail.message), true);
        } else if (detail.trackEnded) {
          setStatus('Tab audio ended. The transcript is kept. Click the toolbar icon on the meeting tab, then press Record.');
        } else {
          setStatus('Stopped.');
        }
      }
    },
    onError: (code, message) => {
      setState('error');
      setStatus(fatalRecognitionMessage(code, message), true);
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
 * Keep the view-switch control's visible label and accessible name in agreement.
 * They diverged after a hand-off once: the button read "Focus window" while
 * screen readers still announced "Open in window".
 */

/**
 * The visible word for each destination. It stays ONE short word: this control
 * sits in the tightest row in the product, and the longer phrases this used to
 * set ("Focus window", "Open in window") pushed Delete — and at times the gear —
 * off the right edge at 280px. The explanation lives in the tooltip, which has
 * room for it.
 */
const POPOUT_LABELS = {
  window: {text: 'Window', title: 'Move TabScribe into its own window'},
  focus: {text: 'Window', title: 'Bring the TabScribe window to the front'},
  sidebar: {text: 'Sidebar', title: 'Move TabScribe back into the browser sidebar'},
};

function setPopoutLabel(which) {
  const {text, title} = POPOUT_LABELS[which] || POPOUT_LABELS.window;
  const label = el.popout.querySelector('.popout-label');
  if (label) label.textContent = text;
  // The accessible name carries the fuller phrasing: a screen reader has no
  // width limit, and "Window" alone does not say what pressing it will do.
  el.popout.setAttribute('aria-label', title);
  el.popout.title = title;
}

/**
 * Go back to the side panel, and close this window.
 *
 * The counterpart of popOut(), and the reason the control stays visible in the
 * window: closing the window cannot bring the sidebar back on its own.
 * chrome.sidePanel.open() requires a user gesture, and a window being closed is
 * not one — so no windows.onRemoved handler can ever reopen it. A click can.
 *
 * Measured in probe/spike_back_to_panel.py on Chrome 151: sidePanel.open({tabId})
 * called from a click handler in this window resolves, and the panel appears on
 * the tab being transcribed.
 *
 * The transcript rides across in the same hand-off snapshot pop-out uses, so the
 * switch is not a reset in either direction.
 */
let switching = false;

async function releaseForTransfer() {
  switching = true;
  activeStart?.abort();
  activeStart = null;
  clearTimeout(autosaveTimer);
  autosaveTimer = null;
  await autosaveQueue;
  if (armingPromise) await armingPromise;
  if (transcriber?.recognition) await transcriber.stop({ flushMs: 400 });
  if (mic) await mic.stop({ flushMs: 400 });
  const payload = {
    snapshot: transcriber?.store.serialize() || new TranscriptStore().serialize(),
    micText: mic?.hasText() ? mic.store.serialize() : null,
    savedText: '',
  };
  await teardown();
  el.record.disabled = true;
  return payload;
}

async function recoverTransfer(wasRunning, message, released, safeToResume = false) {
  switching = false;
  if (!safeToResume) {
    // A lost reply is not a cancelled transfer: the receiver may already own it.
    handedOff = true;
    handoffBlocked = true;
    el.record.disabled = true;
    el.popout.disabled = true;
    setRecording(false);
    setState('error');
    setStatus('Recording paused in this view. The switch outcome could not be confirmed.', true);
    showIssue('switch', `${message} The switch outcome could not be confirmed. This view will not record or autosave. Copy or Download its transcript. Check the other TabScribe view; if none is open, close this view and reopen TabScribe from the toolbar icon on the meeting tab.`);
    return;
  }
  handedOff = false;
  handoffBlocked = false;
  if (released) {
    el.record.disabled = false;
    const cap = await armCapture({ retries: 3 });
    if (cap.ok && wasRunning) await start({ allowMic: true });
    else if (!cap.ok) {
      setState('error');
      setStatus(`Could not restore tab audio: ${cap.error || 'click the toolbar icon on the meeting tab'}. The transcript is kept.`, true);
    }
  }
  showIssue('switch', `${message} The transcript remains in this view.`);
  el.popout.disabled = false;
  scheduleAutosave();
}

async function backToSidebar(pendingOpen) {
  el.popout.disabled = true;
  const wasRunning = !!transcriber?.running;
  let released = false;
  let safeToResume = !handedOff;
  await switchLogReset(`backToSidebar running=${wasRunning}`);
  try {
    const announced = await workerRequest({ type: 'SWITCH_PENDING', resume: wasRunning });
    if (replyIsStale(announced)) {
      noteStaleWorker('SWITCH_PENDING', announced);
      throw new Error(STALE_WORKER_MESSAGE);
    }
    if (!announced?.ok) throw new Error(`Could not prepare the sidebar: ${announced?.error || 'no reply'}`);
    await switchLog('announced SWITCH_PENDING');
    // Opening was invoked synchronously in the click handler. Its failure must
    // be known BEFORE the source releases audio or stages any transcript.
    const opened = await pendingOpen;
    await switchLog('sidePanel.open result', opened);
    if (!opened?.ok) throw new Error(`Could not reopen the sidebar: ${opened?.error || 'no reply'}`);
    setStatus('Returning to the sidebar…');
    released = true;
    const payload = await releaseForTransfer();
    await switchLog('BACK_TO_PANEL sending', { segments: payload.snapshot.segments.length, resume: wasRunning });
    safeToResume = false;
    const handed = await workerRequest({ type: 'BACK_TO_PANEL', ...payload, resume: wasRunning });
    safeToResume = handed?.ok === false && handed.safeToResume === true;
    await switchLog('BACK_TO_PANEL sent', { ok: !!handed?.ok, error: handed?.error ?? null });
    if (!handed?.ok) throw new Error(`Could not hand the transcript to the sidebar: ${handed?.error || 'no reply'}`);
    handedOff = true;
    showIssue('switch');
    window.close();
  } catch (e) {
    if (safeToResume) {
      try { await chrome.storage.session.remove('switchPending'); } catch (cleanupError) { /* expires */ }
    }
    await recoverTransfer(wasRunning, String(e?.message || e), released, safeToResume);
    if (workerStale) setStatus(STALE_WORKER_MESSAGE, true);
  }
}

/**
 * Ask Chrome to open the side panel, synchronously, inside the click.
 *
 * Separate from backToSidebar() precisely because it must run before anything is
 * awaited: sidePanel.open() needs a live user activation, and every await in the
 * handler spends it. The promise is passed along and settled later.
 */
function requestSidebarOpen() {
  try {
    if (targetTabId === undefined || targetTabId === null) {
      return Promise.resolve({ ok: false, error: 'no tab to attach to' });
    }
    return chrome.sidePanel.open({ tabId: targetTabId })
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }));
  } catch (e) {
    return Promise.resolve({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

async function popOut() {
  el.popout.disabled = true;
  if (handoffBlocked) {
    // A failed receiver owns only a recovery snapshot. OPEN_WINDOW can create a
    // new transfer, so focus the existing window directly without sending text.
    try {
      const { popoutWindowId } = await chrome.storage.session.get('popoutWindowId');
      if (!Number.isInteger(popoutWindowId) || popoutWindowId < 0) {
        throw new Error('No existing TabScribe window could be identified.');
      }
      await chrome.windows.update(popoutWindowId, { focused: true, drawAttention: true });
    } catch (e) {
      showIssue('switch', `Could not focus the TabScribe window: ${e?.message || e}. Recording remains paused in this view. Copy or Download its transcript. Check the other view and retry the switch there; if none is open, close this view and reopen TabScribe from the toolbar icon on the meeting tab.`);
    } finally {
      el.popout.disabled = false;
    }
    return;
  }
  const wasRunning = !!transcriber?.running;
  let released = false;
  let safeToResume = !handedOff;
  await switchLogReset(`popOut running=${wasRunning}`);
  try {
    // Verify the worker before interrupting the current session.
    const host = await workerRequest({ type: 'GET_HOST_WINDOW' });
    if (replyIsStale(host)) {
      noteStaleWorker('GET_HOST_WINDOW', host);
      throw new Error(STALE_WORKER_MESSAGE);
    }
    if (!host?.ok) throw new Error(`Could not open the window: ${host?.error || 'no reply'}`);
    setStatus('Opening window…');
    let payload = {};
    if (!handedOff) {
      released = true;
      payload = await releaseForTransfer();
    }
    safeToResume = false;
    const res = await workerRequest({
      type: 'OPEN_WINDOW', ...payload, resume: wasRunning,
      sourceWindowId: host.windowId,
      width: prefs.get().windowWidth, height: prefs.get().windowHeight,
    });
    safeToResume = released && res?.ok === false && res.safeToResume === true;
    switchLog('OPEN_WINDOW reply', { ok: !!res?.ok, reused: !!res?.reused, panelClosed: !!res?.panelClosed, error: res?.error });
    if (!res?.ok) throw new Error(`Could not open the window: ${res?.error || 'no reply'}`);
    if (res.reused && released) {
      // Focusing another view is not a transfer of this document's transcript.
      await recoverTransfer(wasRunning, 'Another TabScribe window is already open; this transcript was not transferred.', true, true);
      return;
    }
    handedOff = true;
    switching = false;
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
    showIssue('switch');
    setState('idle');
    clearedSnapshot = null;
    el.undoBar.hidden = true;
    el.status.textContent = res.reused ? 'TabScribe is already open in a window.'
      : res.panelClosed ? 'Moved to its own window.' : 'Moved to its own window. You can close this panel.';
    el.status.classList.remove('error');
    el.record.disabled = true;
    setRecording(false);
    el.popout.disabled = false;
    setPopoutLabel('focus');
  } catch (e) {
    await recoverTransfer(wasRunning, String(e?.message || e), released, safeToResume);
    if (workerStale) setStatus(STALE_WORKER_MESSAGE, true);
  }
}

/**
 * Adopt the transcript the other view handed over.
 *
 * Both directions use this. Popping out writes the snapshot before the window is
 * created, so the window finds it immediately. Coming back cannot: the panel is
 * opened by sidePanel.open() inside the click, to keep the user's gesture, so
 * this document can load BEFORE backToSidebar() has written the snapshot. Hence
 * the short poll — without it the panel claims nothing, falls through to the
 * autosave, and the meeting stops.
 */
async function claimHandoff({ waitMs = 0 } = {}) {
  if (workerStale) return { received: false, resume: false };
  const deadline = Date.now() + waitMs;
  let restored = false;
  for (;;) {
    try {
      const res = await workerRequest({ type: 'CLAIM_HANDOFF', receiverId });
      if (!res?.ok) throw new Error(res?.error || 'The background service did not return a transcript.');
      if (res.handoffId) {
        switching = true;
        restoreStoredTranscript(res);
        restored = true;
        const accepted = await workerRequest({ type: 'ACK_HANDOFF', handoffId: res.handoffId, receiverId });
        if (!accepted?.ok) throw new Error(accepted?.error || 'The receiver could not confirm the transcript transfer.');
        switching = false;
        handoffBlocked = false;
        showIssue('switch');
        return { received: true, resume: !!res.resume };
      }
      if (Date.now() >= deadline) {
        if (waitMs) throw new Error('The announced transcript transfer did not arrive.');
        return { received: false, resume: false };
      }
    } catch (e) {
      switching = false;
      // A failed receiver must not overwrite the source's recovery copy or arm
      // capture independently. The source will resume or show its own failure.
      handoffBlocked = true;
      el.record.disabled = true;
      showIssue('switch', `Could not receive the transcript: ${e?.message || e}. Recording is paused in this view. Copy or Download any recovered text. If another TabScribe view is open, check it and retry the switch there; otherwise close and reopen TabScribe from the toolbar icon on the meeting tab.`);
      return { received: false, resume: false, failed: true, restored };
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function refreshTarget() {
  const res = await workerRequest({ type: 'GET_TARGET' });
  if (res?.ok) {
    targetTabId = res.tabId;
    targetTitle = res.title || `tab ${res.tabId}`;
    refreshRecordTitle();
    showIssue('target');
  } else {
    showIssue('target', `Could not identify the meeting tab: ${res?.error || 'no reply'}. Click the TabScribe toolbar icon on that tab.`);
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
let activeStart = null;
let stopInProgress = false;

async function start({ gesture = false, allowMic = false } = {}) {
  if (stopInProgress || handedOff || handoffBlocked || switching) return { ok: false, cancelled: true };
  if (activeStart && !activeStart.signal.aborted && el.record.getAttribute('aria-pressed') === 'true') {
    return { ok: false, busy: true };
  }
  activeStart?.abort();
  modelPreviewVersion += 1;
  const attempt = new AbortController();
  activeStart = attempt;
  const current = () => activeStart === attempt && !attempt.signal.aborted;
  el.record.disabled = true;
  // FIRST, synchronously: the user's click is a live gesture right now, and
  // everything below this line awaits, which would destroy it.
  //
  // micGranted is the load-bearing term. A side panel CANNOT show the microphone
  // prompt: without a stored grant, getUserMedia here is auto-rejected as
  // "Permission dismissed" and the panel would report a refusal the user was
  // never asked for. So it only opens the microphone once the grant already
  // exists; obtaining it is mic-permission.html's job, in a tab.
  //
  // `allowMic` covers the view switch, which has no live gesture — the document
  // is new — but does have a stored grant. With a grant in hand getUserMedia
  // cannot prompt, so there is nothing a gesture would protect, and requiring
  // one silently dropped the microphone every time the user moved between the
  // sidebar and the window.
  // `armed` keeps the microphone from ever queueing ahead of tab capture.
  const mayOpenMic = (gesture || allowMic) && armed && micGranted && !micBlocked;
  const pendingMic = mayOpenMic ? requestMicStream() : null;
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
    if (!current()) return { ok: false, cancelled: true };
    if (!cap.ok) {
      if (cap.needsInvocation) {
        throw new Error(
          'Click the TabScribe toolbar icon on the tab you want to transcribe, ' +
          'then press Record.'
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
        signal: attempt.signal,
        onStatus: (text) => { if (current()) setStatus(text); },
        onProgress: (info) => { if (current()) onModelProgress(info); },
      });
      if (!current()) return { ok: false, cancelled: true };
      if (!model.ok) {
        if (model.availability === 'unsupported') {
          throw new Error(
            'This Chrome build does not expose on-device speech recognition. ' +
            'Use a current Google Chrome build with on-device speech enabled, or explicitly choose cloud recognition in Preferences.'
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
    if (!current()) return { ok: false, cancelled: true };
    ensureTranscriber();
    if (graph.ctx.state === 'suspended') {
      await graph.ctx.resume();
      if (!current()) return { ok: false, cancelled: true };
      if (graph.ctx.state !== 'running') throw new Error('Chrome kept tab audio suspended. Click Record to retry audio playback.');
    }

    transcriber.start(graph.track, { lang, processLocally: localOnly });

    setRecording(true);
    el.record.disabled = false;
    if (!transcriber.running) setStatus('Starting speech recognition…');
    if (allowMic) switchLog('resume start ok');

    // Strictly after the meeting transcription is live, and never awaited into
    // its failure path: the microphone is a bonus for the saved file and must
    // not be able to break, delay, or fail the thing the user actually asked for.
    attachMic(pendingMic, lang, localOnly);
    return { ok: true };
  } catch (e) {
    if (!current()) return { ok: false, cancelled: true };
    // A failed availability poll can abandon an installation without a final
    // progress callback. Stop its UI, but retain an explicit failed-model panel.
    if (modelTimer) hideModelPanel();
    if (allowMic) switchLog('resume start FAILED', String(e && e.message ? e.message : e));
    const failure = String(e && e.message ? e.message : e);
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
    if (!current()) return { ok: false, cancelled: true };
    el.record.disabled = false;
    setRecording(false);
    setState('error');
    setStatus(`Could not start transcription: ${failure} The transcript is kept. Press Record to retry.`, true);
    return { ok: false, error: failure };
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

async function stop({ reason = '' } = {}) {
  if (stopInProgress) return;
  stopInProgress = true;
  activeStart?.abort();
  activeStart = null;
  hideModelPanel();
  setRecording(false);
  el.record.disabled = true;
  setStatus('Finishing…');
  let failure = '';
  try {
    if (mic) {
      try { await mic.stop({ flushMs: 600 }); } catch (e) { /* microphone is independent */ }
    }
    if (transcriber) {
      await transcriber.stop({ flushMs: reason ? 0 : 1500 });
      render(transcriber.store);
    }
  } catch (e) {
    failure = `Could not finish speech recognition: ${e?.message || e}. The transcript is kept; use Copy or Download.`;
    await teardown();
  } finally {
    stopInProgress = false;
    // A switch can finish while Stop is flushing. Its ownership and paused
    // failure must survive this older continuation.
    const transferOwnsView = handedOff || handoffBlocked || switching;
    if (!transferOwnsView) {
      setState(failure ? 'error' : 'idle');
      setStatus(failure || reason || 'Stopped. Transcript kept — use Copy or Download.', !!failure);
    }
    el.record.disabled = transferOwnsView;
    setRecording(false);
  }
}

// Release the capture when the panel goes away, so the tab is not held open.
window.addEventListener('pagehide', () => { teardown(); });

/**
 * The surviving panel document's way back.
 *
 * popOut() asks the worker to close this panel, but sidePanel.close() is
 * best-effort: it can fail, and some Chrome builds lack it. When it fails this
 * document stays alive behind the window, inert, with handedOff = true — and
 * when the user presses Sidebar, Chrome re-shows THIS document instead of
 * creating a new one. init() never runs again, so nothing inside init() can
 * carry the meeting back. Every earlier fix lived there, which is why none of
 * them could reach this case.
 *
 * So the switch back is handled here as well: claim the hand-off, take the tab
 * back, and resume if the window was recording. Triggered by the worker the
 * moment BACK_TO_PANEL lands (the reliable path), and by focus as a fallback.
 */
let reclaiming = false;
async function reclaimAfterSwitch({ viaFocus = false } = {}) {
  if (IS_WINDOW || armed || !handedOff || reclaiming) return;
  reclaiming = true;
  switchLog('survivor reclaim', {viaFocus});
  try {
    // Wait for the hand-off the window announced, exactly as init() does.
    let wait = 0;
    try {
      const pending = await chrome.runtime.sendMessage({ type: 'GET_SWITCH_PENDING' });
      if (pending?.ok && pending.pending) wait = SWITCH_HANDOFF_WAIT_MS;
    } catch (e) { /* no answer: claim once, without waiting */ }
    if (wait) setStatus('Bringing the transcript back…');
    const handoff = await claimHandoff({ waitMs: wait });
    switchLog('survivor claim', {waited: wait, ...handoff});
    if (handoff.failed) return;
    if (!handoff.received) {
      if (handoffBlocked) return;
      // Focus can precede SWITCH_PENDING and the return snapshot. The old
      // sidebar must not seize capture while its popup is still the owner.
      try {
        const stored = await chrome.storage.session.get('popoutWindowId');
        if (stored.popoutWindowId != null) return;
      } catch (e) { return; } // Unknown ownership is not permission to capture.
    }

    // The window may still be releasing the tab; the same retry init() uses.
    const cap = await armCapture({ retries: handoff.received ? 6 : 0 });
    switchLog('survivor arm', cap);
    if (!cap.ok) {
      if (viaFocus && !handoff.received) return; // nothing changed; stay inert
      setStatus(cap.error || 'Could not take this tab back.', true);
      return;
    }
    handedOff = false; // this document owns the tab again
    el.record.disabled = false;
    el.popout.disabled = false;
    setPopoutLabel('window');

    if (handoff.resume) {
      await start({ allowMic: true });
      return;
    }
    setStatus(handoff.received
      ? 'Back in the sidebar. Press Record to continue transcribing.'
      : 'Back in the side panel. Press Record to transcribe this tab.');
  } finally {
    reclaiming = false;
  }
}

if (!IS_WINDOW) {
  // The reliable trigger: the worker tells every panel document when the window
  // has handed off, whether or not this one ever receives focus.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'SWITCHED_BACK') reclaimAfterSwitch();
  });
  // Fallback for the case the message predates: the user closed the window by
  // hand and came back to an inert panel.
  window.addEventListener('focus', () => { reclaimAfterSwitch({ viaFocus: true }); });
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
    if (!mic) mic = new MicTranscriber({ onStateChange: onMicState, onUpdate: onMicUpdate });
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
  if (!el.includeMic.checked || !transcriber?.recognition || transcriber.stopping
      || el.record.getAttribute('aria-pressed') !== 'true') { stopStream(res.stream); return; }

  try {
    if (!mic) mic = new MicTranscriber({ onStateChange: onMicState, onUpdate: onMicUpdate });
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
      label = el.micHint.textContent;
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
  // Permission is not recognition health. Keep a terminal reason until a
  // deliberate retry or a successful microphone start clears micBlocked.
  if (micBlocked) return state;
  showIssue('microphone');
  if (micGranted) {
    setMicHint('Your own speech is added to the downloaded transcript only — '
      + 'never shown live.', false);
  } else if (state === 'denied') {
    setMicHint('Chrome is blocking the microphone for TabScribe. Allow it from the '
      + 'address-bar icon, then press Record again.', true);
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
  if (state.running) micBlocked = false;
  else if (state.reason || state.error) {
    disableMic(state.reason || 'failed', state.error);
  }
  // Whatever happened, the toolbar indicator must stop claiming the old state.
  refreshMicPermission();
  if (state.running || micBlocked) return;
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
function onMicUpdate() {
  const hasText = (transcriber && !transcriber.store.isEmpty()) || mic?.hasText();
  el.download.disabled = el.clear.disabled = !hasText;
  refreshUnsavedUi();
  scheduleAutosave();
}

function disableMic(reason, error = '') {
  micBlocked = true;
  const message = MIC_MESSAGES[reason] || MIC_MESSAGES.failed;
  setMicHint(`${message} The meeting transcript is unaffected.`, true);
  const remedy = reason === 'no-device'
    ? 'Connect a microphone, then turn the microphone off and on in Preferences to retry.'
    : reason === 'device-busy'
      ? 'Close other apps using the microphone, then turn the microphone off and on in Preferences to retry.'
      : 'To retry, turn the microphone off and on in Preferences.';
  showIssue('microphone', `${el.micHint.textContent} ${remedy}`);
  setMicIndicator(micGranted ? 'granted' : 'unknown');
  if (error) console.warn('TabScribe microphone:', reason, error);
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
    // The output boundary must disclose any fallback; never claim mic inclusion.
    throw new Error(`Microphone text could not be included: ${e?.message || e}. Both transcripts are kept`);
  }
}

// Manual and automatic copy share ownership of fallback writes and feedback.
let clipboardRequestId = 0;

async function writeClipboard(text, requestId) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // A delayed rejection must not replace a newer successful clipboard write.
    if (requestId !== clipboardRequestId) return false;
    // The Clipboard API refuses to write from an unfocused document; fall back to
    // a scratch textarea, which does not disturb the transcript selection because
    // the previous selection is restored afterwards.
    //
    // Selecting the scratch element also moves KEYBOARD FOCUS. Restoring the
    // ranges brought the highlight back but left focus on the body, so the
    // reader's next Tab started from the top of the panel. Focus is restored
    // alongside the selection, and in a `finally` so a throwing execCommand
    // cannot stand the user in a stripped state or leak the scratch node.
    const sel = window.getSelection();
    const saved = [];
    for (let i = 0; i < sel.rangeCount; i += 1) saved.push(sel.getRangeAt(i).cloneRange());
    const previouslyFocused = document.activeElement;

    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    try {
      document.body.appendChild(ta);
      ta.select();
      return document.execCommand('copy');
    } catch (e2) {
      return false;
    } finally {
      ta.remove();
      sel.removeAllRanges();
      for (const range of saved) sel.addRange(range);
      // preventScroll: returning focus must not also move the reader's view.
      if (previouslyFocused && previouslyFocused.isConnected
          && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus({ preventScroll: true });
      }
    }
  }
}

async function copy() {
  // A selection means "copy this part" — that is the whole point of being able to
  // select. With nothing selected, fall back to the entire transcript.
  const sel = transcriptSelection();
  const selected = sel ? sel.toString().trim() : '';
  const whole = transcriber ? transcriber.getText({ timestamps: el.timestamps.checked }) : '';
  const text = selected || whole;

  if (!text) { confirmAction('Nothing to copy', 'Nothing to copy yet.', el.copy); return; }

  const requestId = ++clipboardRequestId;
  const ok = await writeClipboard(text, requestId);
  if (requestId !== clipboardRequestId) return;
  if (!ok) {
    showIssue('copy', 'Copy failed — press Ctrl+C with the text selected.');
    return;
  }

  showIssue('copy');
  const words = text.split(/\s+/).filter(Boolean).length;
  confirmAction('Copied', selected
    ? `Copied the selected passage (${words} words).`
    : `Copied the whole transcript (${words} words).`, el.copy);
}



/*
 * There is deliberately no beforeunload handler.
 *
 * An earlier version showed Chrome's "You have unsaved progress" dialog. It was
 * removed at the user's request after session recovery was added. Autosave is
 * not a durable backup: writes can fail and Chrome can terminate before the
 * final write. Those failures are reported, and important text needs a verified
 * download before the browser or extension is restarted.
 *
 * It also never fired in the side panel — Chrome destroys that document without
 * running the prompt — so keeping it would have meant a warning that appeared in
 * one view and not the other.
 */

function download() {
  // Download is the one place the microphone appears: the live view and Copy
  // stay exactly as they were.
  let text, microphoneWarning = '';
  try { text = transcriptForSaving(); } catch (e) {
    // The optional channel must not block export of the core meeting.
    text = transcriber?.getText({ timestamps: el.timestamps.checked }) || '';
    if (!text) {
      showIssue('download', `Could not prepare the transcript: ${e?.message || e}. Keep this view open and retry.`);
      return false;
    }
    microphoneWarning = `This download contains meeting audio only. ${e?.message || e}. Keep this view open to recover the microphone text.`;
  }
  if (!text) { confirmAction('Nothing to download', 'Nothing to download yet.', el.download); return false; }
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
    showIssue('download', `Could not save the transcript: ${e && e.message ? e.message : e}. `
      + 'Use Copy and paste it somewhere safe.');
    return false;
  }
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* already released */ } }, 5000);
  showIssue('download');
  showIssue('microphone-export', microphoneWarning);
  // An anchor starts a request; it cannot observe cancellation or disk completion.
  // Without downloads permission, never mark this text saved on that evidence.
  refreshUnsavedUi();
  const withMic = !microphoneWarning && el.includeMic.checked && mic?.hasText();
  confirmAction('Download requested', `Download requested: ${name}${microphoneWarning ? ', meeting-only; microphone text could not be included' : withMic ? ', including your microphone' : ''}. Check Chrome’s downloads before deleting; the transcript is kept.`, el.download);
  return true;
}

// Only the most recent Clear is recoverable, in this view's memory. It is never
// persisted to disk, and remains available until used, dismissed, or replaced.
let clearedSnapshot = null;

function undoClear() {
  if (!clearedSnapshot || !transcriber) return;
  transcriber.store.prepend(clearedSnapshot.snapshot);
  if (clearedSnapshot.micText) {
    if (!mic) mic = new MicTranscriber({ onStateChange: onMicState, onUpdate: onMicUpdate });
    mic.store.prepend(clearedSnapshot.micText);
  }
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

/**
 * Delete, asked for.
 *
 * Undo backs every delete, but Undo is held in this document's memory and dies
 * with it, so deleting a transcript that never reached disk is the one case
 * where the work is genuinely unrecoverable. That case asks first; every other
 * case deletes immediately, because a confirmation that fires when nothing is
 * at stake is how people learn to click through confirmations.
 *
 * The question offers the remedy, not just the warning: downloading first is
 * almost always what the user actually wanted.
 */
function clear() {
  if (hasUnsavedTranscript()) {
    openDeleteConfirm();
    return;
  }
  performClear();
}

function openDeleteConfirm() {
  document.getElementById('confirmText').textContent = 'This transcript may not be saved. Delete it?';
  el.confirmBar.hidden = false;
  el.clear.setAttribute('aria-expanded', 'true');
  // Focus the safe choice: a keyboard Enter on an open question must not delete.
  el.confirmCancel.focus({ preventScroll: true });
}

function closeDeleteConfirm({ refocus = true } = {}) {
  el.confirmBar.hidden = true;
  el.clear.setAttribute('aria-expanded', 'false');
  if (refocus) el.transcript.focus({ preventScroll: true });
}

function downloadThenClear() {
  if (!download()) return;
  document.getElementById('confirmText').textContent = 'Check that the download finished. Delete this transcript only after your file is saved.';
  el.confirmCancel.focus({ preventScroll: true });
}

function performClear() {
  closeDeleteConfirm({ refocus: false });
  // Delete lives in the control row now, so there is no preferences panel to
  // collapse. It is still closed if the user happens to have it open, because
  // Undo appears at the bottom of the panel and a covered Undo is a lost one.
  // save:false — collapsing is a consequence of Delete, not a preference the
  // user expressed, and persisting it would also reach into the other open view.
  if (!el.prefsPanel.hidden) setPrefsOpen(false, { save: false });
  el.transcript.focus({preventScroll: true});
  if ((transcriber && !transcriber.store.isEmpty()) || mic?.hasText()) {
    // Both stores retain their elapsed offsets; prepend preserves new speech
    // and the shared capture clock when recognition continues after Delete.
    clearedSnapshot = {
      snapshot: transcriber?.store.serialize() || new TranscriptStore().serialize(),
      micText: mic?.hasText() ? mic.store.serialize() : null,
    };
    el.undoBar.hidden = false;
  }
  // Drop the DOM rows and their cached identities first, so nothing from the old
  // transcript can be reused when rendering resumes.
  nodes.clear();
  screenHidden.clear();
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
  // The Undo snapshot above includes it even when the export option is off.
  mic?.clear();

  // A pending selection inside the removed text is meaningless now.
  const sel = window.getSelection();
  if (sel && el.transcript.contains(sel.anchorNode)) sel.removeAllRanges();
  el.transcript.classList.remove('holding');
  refreshSelectionUi();

  confirmAction('Transcript deleted', 'Transcript deleted. Undo is available for the meeting and microphone text.', el.clear);
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
el.confirmCancel.addEventListener('click', () => closeDeleteConfirm());
el.confirmDelete.addEventListener('click', performClear);
el.confirmSave.addEventListener('click', downloadThenClear);

el.undoClear.addEventListener('click', undoClear);
el.undoDismiss.addEventListener('click', () => {
  clearedSnapshot = null;
  el.undoBar.hidden = true;
  el.transcript.focus({preventScroll: true});
});
// One control, two directions. In the panel it pops out; in the window it goes
// back. The sidebar request is issued FIRST and synchronously, because
// sidePanel.open() needs the click's user activation and backToSidebar() awaits
// several things before it would otherwise get there.
el.popout.addEventListener('click', () => {
  if (!IS_WINDOW) return popOut();
  const pendingOpen = requestSidebarOpen();
  return backToSidebar(pendingOpen);
});
el.useCloud.addEventListener('click', useCloudInstead);
el.retryModel.addEventListener('click', retryModel);
el.prefsBtn.addEventListener('click', (event) => {
  const opening = el.prefsPanel.hidden;
  setPrefsOpen(opening);
  // Keyboard and assistive-tech activation enters the disclosed settings.
  // Pointer activation leaves the user's transcript selection alone.
  if (opening && event.detail === 0) {
    el.prefsPanel.scrollTop = 0;
    el.lang.focus({ preventScroll: true });
  }
});
for (const control of [el.theme, el.fontSize]) {
  control.addEventListener('change', () => {
    const values = {theme: el.theme.value, fontSize: Number(el.fontSize.value)};
    applyReadingPrefs(values);
    prefs.set(values);
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // The question is nonmodal: focus may be back in the transcript. Dismiss the
  // most immediate choice first, without also collapsing Preferences.
  if (!el.confirmBar.hidden) {
    closeDeleteConfirm();
    event.preventDefault();
    return;
  }
  if (!el.prefsPanel.hidden) {
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
let modelPreviewVersion = 0;
async function previewModelState() {
  const version = ++modelPreviewVersion;
  if (!el.localOnly.checked) { hideModelPanel(); return; }
  const lang = el.lang.value;
  let availability;
  try { availability = await Transcriber.availability(lang, true); } catch (e) {
    if (version === modelPreviewVersion) onModelProgress({ phase: 'failed', error: `Could not check the speech model: ${e?.message || e}` });
    return;
  }
  if (version !== modelPreviewVersion || el.record.getAttribute('aria-pressed') === 'true') return;
  if (availability === 'available') { hideModelPanel(); return; }

  if (availability === 'downloading') {
    onModelProgress({ phase: 'downloading', availability });
    return;
  }
  if (availability === 'downloadable') {
    showModelPanel({
      title: 'First run needs a one-time download',
      body: `Transcribing ${langName(lang)} on-device needs Chrome's speech model — ` +
            'roughly 300 MB, downloaded once. Press Record and it ' +
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
async function init() {
  // Preferences first, before anything reads a control. Applying them later
  // makes the UI visibly flip, and worse, the model check and capture arming
  // below would run against defaults rather than the user's chosen values.
  prefs.onError(({ operation, error }) => {
    showIssue(`prefs-${operation}`, error ? operation === 'load'
      ? `Saved preferences could not be loaded: ${error}. Defaults are in use with the microphone kept off for safety; check Preferences before recording.`
      : `Preferences could not be saved: ${error}. This view uses your choices, but they may reset when reopened. Change a preference to retry.`
      : '');
  });
  applyPrefs(await prefs.load());
  // The view-switch control names the view it goes TO, not the one it is in.
  // Both states route through the same mapping: setting only the window case
  // here left a fresh panel on the HTML's hardcoded name while a reclaimed one
  // used the mapping's, so identical views announced differently.
  setPopoutLabel(IS_WINDOW ? 'sidebar' : 'window');
  // Read the real grant state before anything reports on the microphone. This
  // never prompts; it only decides whether Start may open the microphone and
  // whether the "Allow microphone…" button is offered.
  await refreshMicPermission();

  // Is the worker the same build as this document? One round trip, on a
  // message every worker has always answered, so an old worker replies too —
  // just without a version. Checked before anything that depends on the newer
  // messages, so a mismatch is reported here rather than surfacing later as a
  // hand-off that silently fails.
  try {
    const hello = await chrome.runtime.sendMessage({ type: 'GET_TARGET' });
    if (replyIsStale(hello)) noteStaleWorker('startup', hello);
  } catch (e) { /* the worker may be waking; the switch path re-checks */ }

  // Either view may be handed a transcript. The window receives one when the
  // user pops out; the side panel receives one when they press Sidebar to come
  // back. Claiming it in only one direction is what made the switch back stop
  // recording: the panel fell through to the autosave, which carries text but no
  // resume flag, so the meeting quietly ended.
  //
  // When a switch is genuinely in flight the window says so BEFORE its teardown,
  // so the wait tracks the actual hand-off rather than a guess at how long a
  // recognizer takes to flush. A fixed timer was the second version of this bug:
  // fast enough in a warm test, too short for a real meeting.
  let handoffWait = 0;
  if (!IS_WINDOW) {
    try {
      const pending = await chrome.runtime.sendMessage({ type: 'GET_SWITCH_PENDING' });
      if (pending?.ok && pending.pending) handoffWait = SWITCH_HANDOFF_WAIT_MS;
    } catch (e) { /* no worker answer: do not wait */ }
  }
  // Say so while waiting: this is the one path where the panel can sit for a
  // couple of seconds before showing anything, and an empty panel reads as a
  // lost meeting.
  if (handoffWait) setStatus('Bringing the transcript back…');
  let handoff = await claimHandoff({ waitMs: handoffWait });
  if (handoff.failed) {
    // Read-only recovery is safe even when ownership could not be confirmed.
    // Keep a validated handoff instead of replacing it with an older autosave.
    if (!handoff.restored) await restoreAutosave();
    return;
  }
  if (handoffWait || handoff.received) {
    switchLog('init claim', {waited: handoffWait, ...handoff});
  }

  // A pop-out hand-off carries its own text; otherwise pick up whatever the last
  // panel document left behind. Closing the side panel destroys it without any
  // warning from Chrome, so this is what keeps a meeting from disappearing.
  let restored = false;
  if (!handoff.received) {
    restored = await restoreAutosave();
  }

  await refreshTarget();
  // Retry here specifically: when this document was opened by the view switch,
  // the other view may still be releasing the tab. Every other caller wants the
  // immediate answer.
  const cap = await armCapture({ retries: handoff.received ? 6 : 0 });
  if (handoff.received) switchLog('init arm', cap);

  if (!cap.ok) {
    // A restored transcript is still here even when this tab cannot be captured
    // — reopening the panel on the wrong tab must not read as "your text is
    // gone". Say both things, in that order.
    const carried = restored ? 'Earlier transcript restored. ' : '';
    if (cap.needsInvocation) {
      setStatus(carried
        + 'Click the TabScribe toolbar icon on the tab you want to transcribe.');
    } else {
      setStatus(carried + (cap.error || 'Could not capture this tab\'s audio.'),
                !restored);
    }
    return;
  }

  if (handoff.resume) {
    // The other view was transcribing when the user switched; pick up where it
    // left off rather than making them press Record again.
    //
    // allowMic: there is no live gesture here — this document was just created —
    // but the microphone grant is stored, so getUserMedia cannot prompt and the
    // gesture would protect nothing. Without this the microphone was dropped on
    // every switch, and the indicator went green to grey with no explanation.
    await start({ allowMic: true });
    if (el.includeMic.checked && micGranted && !mic?.running) {
      setMicHint('The microphone did not reopen. Press Record twice to retry it.', false);
    }
    return;
  }
  if (restored) {
    setStatus('Earlier transcript restored. Press Record to continue, '
      + 'or Download to save it.');
    return;
  }
  setStatus(handoff.received
    ? (IS_WINDOW
        ? 'Moved to this window. Press Record to continue transcribing.'
        : 'Back in the sidebar. Press Record to continue transcribing.')
    : 'Ready. Press Record to transcribe this tab.');

  // Surface the one-time download requirement up front rather than at Start.
  previewModelState();
}

// init() returns early on several paths, so the one thing that must be said
// regardless of how it ended is said here, after it: a worker from an older
// build than this document. Every later feature quietly misbehaves against
// one, and the user cannot tell that from any other bug.
init().catch((error) => {
  setRecording(false);
  el.record.disabled = false;
  setState('error');
  showIssue('startup', `TabScribe could not finish opening: ${error?.message || error}. Copy or Download any text before reopening TabScribe.`);
}).finally(() => {
  if (workerStale) setStatus(STALE_WORKER_MESSAGE, true);
});
