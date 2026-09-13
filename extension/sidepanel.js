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

const el = {
  start: document.getElementById('startBtn'),
  stop: document.getElementById('stopBtn'),
  copy: document.getElementById('copyBtn'),
  download: document.getElementById('downloadBtn'),
  clear: document.getElementById('clearBtn'),
  popout: document.getElementById('popoutBtn'),
  lang: document.getElementById('langSel'),
  localOnly: document.getElementById('localOnly'),
  timestamps: document.getElementById('tsToggle'),
  autoscroll: document.getElementById('autoscroll'),
  selectToCopy: document.getElementById('selectToCopy'),
  copyToast: document.getElementById('copyToast'),
  prefsBtn: document.getElementById('prefsBtn'),
  prefsPanel: document.getElementById('prefsPanel'),
  toast: document.getElementById('toast'),
  transcript: document.getElementById('transcript'),
  empty: document.getElementById('emptyHint'),
  status: document.getElementById('status'),
  dot: document.getElementById('dot'),
  target: document.getElementById('target'),
  words: document.getElementById('wordCount'),
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
    el.target.textContent = res.title || `tab ${res.tabId}`;
    el.target.title = res.title || '';

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

function render(store) {
  lastStore = store;
  const segs = store.liveSegments();

  el.empty.style.display = segs.length === 0 ? '' : 'none';
  el.words.textContent = `${store.wordCount()} words`;

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
  if (el.autoscroll.checked && !sel) {
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }
}

function refreshSelectionUi() {
  const sel = transcriptSelection();
  const selecting = !!sel;
  el.copy.textContent = selecting ? 'Copy selection' : 'Copy';
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
  if (!el.copyToast.checked) return;
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
    setStatus('Auto-copy failed — press Ctrl+C, or use Copy.', true);
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
  if (!el.start.disabled) await start();
}

async function retryModel() {
  el.retryModel.hidden = true;
  if (!el.start.disabled) await start();
}

/* ---------------------------------------------------------------- preferences */

/** Push stored values onto the controls. Call BEFORE anything reads them. */
function applyPrefs(p) {
  el.lang.value = p.lang;
  el.localOnly.checked = p.localOnly;
  el.timestamps.checked = p.timestamps;
  el.autoscroll.checked = p.autoscroll;
  el.selectToCopy.checked = p.selectToCopy;
  el.copyToast.checked = p.copyToast;
  setPrefsOpen(p.prefsOpen, { save: false });
}

/** Show or hide the preferences group. */
function setPrefsOpen(open, { save = true } = {}) {
  el.prefsPanel.hidden = !open;
  el.prefsBtn.setAttribute('aria-expanded', String(!!open));
  if (save) prefs.set({ prefsOpen: !!open });
}

/** Persist whatever the controls currently say. */
function savePrefsFromUi() {
  return prefs.set({
    lang: el.lang.value,
    localOnly: el.localOnly.checked,
    timestamps: el.timestamps.checked,
    autoscroll: el.autoscroll.checked,
    selectToCopy: el.selectToCopy.checked,
    copyToast: el.copyToast.checked,
  });
}

// The side panel and the pop-out window are separate documents sharing one
// store. Without this, changing a toggle in one and then in the other would
// clobber the first change.
prefs.onChange((diff) => {
  if (diff.lang !== undefined) el.lang.value = diff.lang;
  if (diff.localOnly !== undefined) el.localOnly.checked = diff.localOnly;
  if (diff.timestamps !== undefined) {
    el.timestamps.checked = diff.timestamps;
    if (lastStore) render(lastStore);
  }
  if (diff.autoscroll !== undefined) el.autoscroll.checked = diff.autoscroll;
  if (diff.selectToCopy !== undefined) el.selectToCopy.checked = diff.selectToCopy;
  if (diff.copyToast !== undefined) el.copyToast.checked = diff.copyToast;
  if (diff.prefsOpen !== undefined) setPrefsOpen(diff.prefsOpen, { save: false });
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
      handedOff = false;
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
    el.status.textContent = res.panelClosed
      ? 'Moved to its own window.'
      : 'Moved to its own window. You can close this panel.';
    el.status.classList.remove('error');
    el.start.disabled = true;
    el.stop.disabled = true;
    el.popout.disabled = false;
    el.popout.querySelector('.popout-label').textContent = 'Focus window';
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
    el.target.textContent = res.title || `tab ${res.tabId}`;
    el.target.title = res.title || '';
  }
}

async function start() {
  el.start.disabled = true;
  setState('starting');
  setStatus('Preparing…');

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

    el.stop.disabled = false;
    setStatus('Listening. Select any text to copy part of it.');
  } catch (e) {
    setState('error');
    setStatus(String(e && e.message ? e.message : e), true);
    await teardown();
    el.start.disabled = false;
  }
}

async function teardown() {
  armed = false;
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
  el.stop.disabled = true;
  setStatus('Finishing…');
  if (transcriber) {
    // Give the recognizer a moment to finalize the sentence in flight.
    await transcriber.stop({ flushMs: 1500 });
    render(transcriber.store);
  }
  // The capture stays armed so Start works again without another toolbar click.
  setState('idle');
  setStatus('Stopped. Transcript kept — use Copy or Save.');
  el.start.disabled = false;
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
      el.start.disabled = false;
      el.popout.disabled = false;
      el.popout.querySelector('.popout-label').textContent = 'Open in window';
      setStatus('Back in the side panel. Press Start to transcribe this tab.');
    }
  });
}

/* ------------------------------------------------------------------- output */

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

function flash(button, label) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = label;
  setTimeout(() => {
    button.textContent = transcriptSelection() ? 'Copy selection' : 'Copy';
    delete button.dataset.label;
  }, 1200);
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
  flash(el.copy, 'Copied');
  setStatus(selected
    ? `Copied selection (${words} words).`
    : `Copied whole transcript (${words} words).`);
}

function download() {
  const text = transcriber ? transcriber.getText({ timestamps: el.timestamps.checked }) : '';
  if (!text) { setStatus('Nothing to save yet.'); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transcript-${stamp}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function clear() {
  // Drop the DOM rows and their cached identities first, so nothing from the old
  // transcript can be reused when rendering resumes.
  nodes.clear();
  heldUpdates = false;
  el.transcript.replaceChildren(el.empty);
  el.empty.style.display = '';
  el.words.textContent = '0 words';

  // Clearing the store alone would leave the in-flight utterance alive inside the
  // recognition session, and it would reappear on the next event. reset() abandons
  // that session and starts a fresh one when recognition is running.
  if (transcriber) {
    transcriber.reset();
  }

  // A pending selection inside the removed text is meaningless now.
  const sel = window.getSelection();
  if (sel && el.transcript.contains(sel.anchorNode)) sel.removeAllRanges();
  el.transcript.classList.remove('holding');
  el.copy.textContent = 'Copy';

  setStatus(transcriber?.running
    ? 'Cleared. Still listening.'
    : 'Cleared.');
}

el.start.addEventListener('click', start);
el.stop.addEventListener('click', stop);
el.copy.addEventListener('click', copy);
el.download.addEventListener('click', download);
el.clear.addEventListener('click', clear);
el.popout.addEventListener('click', popOut);
el.useCloud.addEventListener('click', useCloudInstead);
el.retryModel.addEventListener('click', retryModel);
el.prefsBtn.addEventListener('click', () => {
  setPrefsOpen(el.prefsPanel.hidden);
});
el.copyToast.addEventListener('change', savePrefsFromUi);
el.timestamps.addEventListener('change', () => {
  savePrefsFromUi();
  if (lastStore) render(lastStore);
});
el.autoscroll.addEventListener('change', savePrefsFromUi);
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

  let handoff = { received: false, resume: false };
  if (IS_WINDOW) {
    handoff = await claimHandoff();
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
    await start();
    return;
  }
  setStatus(handoff.received
    ? 'Moved to this window. Press Start to continue transcribing.'
    : 'Ready. Press Start to transcribe this tab.');

  // Surface the one-time download requirement up front rather than at Start.
  previewModelState();
})();
