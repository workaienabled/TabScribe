import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Transcriber, TranscriptStore } from '../extension/transcriber.js';
import { MicTranscriber, mergeTranscripts } from '../extension/mic.js';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// Execute current production controller functions unchanged. Browser output and
// DOM affordances are controlled boundaries; transcript stores are real.
function controller(names, bindings, prelude = '') {
  const functions = names.map(name => {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, `production controller function ${name} exists`);
    return match[0];
  });
  const context = vm.createContext(bindings);
  vm.runInContext(`${prelude}\n${functions.join('\n')}`, context, { filename: 'sidepanel-data-controller.js' });
  return context;
}

function element() {
  const classes = new Set(), attributes = new Map();
  return {
    textContent: '', disabled: false, hidden: false, style: {}, checked: false,
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name),
    focus() {}, contains: () => false,
    replaceChildren(...children) { this.children = children; },
    classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
  };
}

function dataController({ meeting = '', microphone = '', includeMic = true, savedText = '', extra = {} } = {}) {
  const el = Object.fromEntries(['download', 'copy', 'clear', 'transcript', 'empty',
    'timestamps', 'includeMic', 'prefsPanel', 'undoBar', 'undoLabel', 'jumpLatest',
    'hiddenNotice', 'hiddenCount'].map(name => [name, element()]));
  el.includeMic.checked = includeMic;
  el.prefsPanel.hidden = el.undoBar.hidden = true;
  const actions = [], issues = new Map();
  let confirmed = 0, h;
  const transcriber = new Transcriber({ onUpdate: store => h.render(store) });
  const mic = new MicTranscriber({ onUpdate: () => h.render(transcriber.store) });
  transcriber.t0 = mic.t0 = 100000;
  if (meeting) transcriber.store.update(0, meeting, true, 1000);
  if (microphone) mic.store.update(0, microphone, true, 2000);
  h = controller(['hasUnsavedTranscript', 'refreshUnsavedUi', 'transcriptForSaving',
    'clear', 'performClear', 'undoClear', 'clearScreen', 'hiddenNoticeRefresh', 'download',
    'restoreStoredTranscript'], {
    el, Transcriber, TranscriptStore, MicTranscriber, mergeTranscripts,
    transcriber, mic, lastStore: transcriber.store, savedText,
    clearedSnapshot: null, screenHidden: new Set(), nodes: new Map(),
    heldUpdates: false, following: true, autosaveTimer: null, clearTimeout() {},
    window: { getSelection: () => ({ anchorNode: null }) },
    document: {},
    openDeleteConfirm() { confirmed += 1; },
    closeDeleteConfirm() {}, setPrefsOpen() {}, refreshSelectionUi() {},
    onMicState() {}, onMicUpdate() {},
    ensureTranscriber: () => transcriber,
    showIssue(key, message) { if (message) issues.set(key, message); else issues.delete(key); },
    confirmAction: (...args) => actions.push(args),
    render(store) {
      h.lastStore = store;
      el.transcript.textContent = store.liveSegments()
        .filter(s => !h.screenHidden.has(s.key)).map(s => s.text).join(' ');
      h.hiddenNoticeRefresh(store);
      h.refreshUnsavedUi();
    },
    ...extra,
  });
  return { h, el, actions, issues, confirmed: () => confirmed };
}

for (const includeMic of [true, false]) {
  test(`mic-only Delete requires confirmation even when includeMic=${includeMic}`, () => {
    const c = dataController({ microphone: 'Unsaved own speech', includeMic });
    c.h.refreshUnsavedUi();
    assert.equal(c.el.download.classList.contains('unsaved'), true);
    c.h.clear();
    assert.equal(c.confirmed(), 1);
    assert.equal(c.h.mic.store.toText(), 'Unsaved own speech');
  });
}

test('legacy savedText is not proof of a completed download and cannot bypass Delete', () => {
  const c = dataController({ meeting: 'Existing meeting speech', savedText: 'Existing meeting speech' });
  c.h.clear();
  assert.equal(c.confirmed(), 1);
  assert.equal(c.h.transcriber.store.toText(), 'Existing meeting speech');
});

for (const micOnly of [false, true]) {
  test(`old autosave/handoff savedText flags remain readable but not trusted (micOnly=${micOnly})`, () => {
    const c = dataController();
    const meeting = new TranscriptStore(), microphone = new TranscriptStore();
    if (micOnly) microphone.update(0, 'Legacy own speech', true, 2000);
    else meeting.update(0, 'Legacy meeting speech', true, 1000);
    // Both autosave and view-switch restoration use this production function.
    const payload = { snapshot: meeting.serialize(),
      savedText: micOnly ? 'You: Legacy own speech' : 'Legacy meeting speech' };
    if (micOnly) payload.micText = microphone.serialize();
    c.h.restoreStoredTranscript(payload);
    assert.equal(c.h.savedText, '');
    assert.equal(c.h.transcriptForSaving(), micOnly ? 'You: Legacy own speech' : 'Legacy meeting speech');
    c.h.clear();
    assert.equal(c.confirmed(), 1);
  });
}

for (const meeting of ['', 'Old meeting']) {
  test(`Undo restores both channels on the existing clock (meeting=${!!meeting})`, () => {
    const c = dataController({ meeting, microphone: 'Old microphone', includeMic: false });
    c.h.performClear();
    assert.equal(c.h.transcriber.store.isEmpty(), true);
    assert.equal(c.h.mic.store.isEmpty(), true);
    assert.equal(c.el.undoBar.hidden, false, 'every nonempty deleted channel is recoverable');

    // Recording may continue before Undo; recovery must not replace new speech,
    // reset either clock, or move old microphone speech to the new time origin.
    c.h.transcriber.store.update(0, 'New meeting', true, 3000);
    c.h.mic.store.update(0, 'New microphone', true, 4000);
    c.h.undoClear();
    assert.equal(c.h.transcriber.t0, 100000);
    assert.equal(c.h.mic.t0, 100000);
    assert.equal(c.h.mic.store.toText(), 'Old microphone New microphone');
    assert.equal(c.h.transcriber.store.toText(), [meeting, 'New meeting'].filter(Boolean).join(' '));
    assert.equal(c.el.undoBar.hidden, true);
    c.el.includeMic.checked = true;
    c.el.timestamps.checked = true;
    assert.equal(c.h.transcriptForSaving(), [
      ...(meeting ? ['[00:01] Meeting: Old meeting'] : []),
      '[00:02] You: Old microphone', '[00:03] Meeting: New meeting', '[00:04] You: New microphone',
    ].join('\n'));
    assert.match(c.actions.at(-1)[1], /Undo is available/);
    assert.doesNotMatch(c.actions.at(-1)[1], /for the meeting text/);
  });
}

function downloadController(options = {}) {
  const blobs = [], requests = [];
  const c = dataController({ ...options, extra: {
    Blob,
    URL: {
      createObjectURL(blob) { blobs.push(blob); return `blob:output-${blobs.length}`; },
      revokeObjectURL() {},
    },
    document: { createElement(tag) {
      assert.equal(tag, 'a');
      return { click() { requests.push({ href: this.href, name: this.download }); } };
    } },
    setTimeout() {},
    ...options.extra,
  } });
  return { ...c, blobs, requests };
}

test('merge failure exports the core meeting with an explicit microphone-omission warning', async () => {
  const c = downloadController({ meeting: 'Meeting kept', microphone: 'Microphone kept',
    extra: { mergeTranscripts() { throw new Error('merge broke'); } } });
  assert.equal(c.h.download(), true);
  assert.equal(c.requests.length, 1);
  assert.equal(await c.blobs[0].text(), 'Meeting kept');
  assert.match(c.actions.at(-1)[1], /meeting.only/i);
  assert.doesNotMatch(c.actions.at(-1)[1], /including your microphone/i);
  assert.match(c.issues.get('microphone-export'), /microphone/i);
  assert.match(c.issues.get('microphone-export'), /merge broke/);
  assert.match(c.issues.get('microphone-export'), /kept|retained/i);
  // A partial export is not the meeting the user asked to save, so this is the
  // one download that must not clear: the microphone half never reached a file.
  assert.equal(c.h.transcriber.store.toText(), 'Meeting kept');
  assert.equal(c.h.mic.store.toText(), 'Microphone kept');
  assert.equal(c.el.undoBar.hidden, true, 'nothing was deleted, so there is nothing to undo');
  assert.equal(c.h.hasUnsavedTranscript(), true);
  c.h.clear();
  assert.equal(c.confirmed(), 1, 'the partial export cannot bypass Delete confirmation');
});

for (const includeMic of [true, false]) {
  test(`download writes the requested bytes (includeMic=${includeMic}) and then clears both channels`, async () => {
    const c = downloadController({ meeting: 'Meeting kept', microphone: 'Microphone kept', includeMic });
    assert.equal(c.h.download(), true);
    assert.equal(c.requests.length, 1);
    assert.equal(c.blobs.length, 1);
    assert.equal(await c.blobs[0].text(), includeMic
      ? 'Meeting: Meeting kept\nYou: Microphone kept' : 'Meeting kept');
    assert.equal(/including your microphone/.test(c.actions.at(-1)[1]), includeMic);

    // Download is now the whole "save it and start clean" action, so the text
    // goes after the file is requested. Both channels clear regardless of the
    // export preference: leaving microphone text behind would resurrect speech
    // in the NEXT download that the user believes they already filed away.
    assert.equal(c.h.transcriber.store.isEmpty(), true);
    assert.equal(c.h.mic.store.isEmpty(), true);
    assert.equal(c.h.hasUnsavedTranscript(), false);
    assert.equal(c.el.download.disabled, true);
    assert.equal(c.el.clear.disabled, true);

    // The anchor cannot report that the file reached disk, so the recovery copy
    // is the only safety net a cancelled save dialog has.
    assert.equal(c.el.undoBar.hidden, false, 'a downloaded delete is still undoable');
    assert.match(c.actions.at(-1)[1], /undo/i);
    c.h.undoClear();
    assert.equal(c.h.transcriptForSaving(), includeMic
      ? 'Meeting: Meeting kept\nYou: Microphone kept' : 'Meeting kept');
  });
}

test('a download that never started leaves the transcript alone', () => {
  const c = downloadController({ meeting: 'Meeting kept', microphone: 'Microphone kept',
    extra: { URL: { createObjectURL() { throw new Error('allocation failed'); },
                    revokeObjectURL() {} } } });
  assert.equal(c.h.download(), false);
  assert.equal(c.requests.length, 0);
  assert.match(c.issues.get('download'), /allocation failed/);
  assert.equal(c.h.transcriber.store.toText(), 'Meeting kept');
  assert.equal(c.h.mic.store.toText(), 'Microphone kept');
  assert.equal(c.el.undoBar.hidden, true);
  assert.equal(c.h.hasUnsavedTranscript(), true);
});

test('downloading an empty transcript deletes nothing and offers no undo', () => {
  const c = downloadController();
  assert.equal(c.h.download(), false);
  assert.equal(c.requests.length, 0);
  assert.equal(c.el.undoBar.hidden, true);
  assert.match(c.actions.at(-1)[0], /nothing to download/i);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clipboardController(firstWrite) {
  let clipboard = 'poisoned clipboard', selected = 'Older passage A', scratch = null;
  const actions = [], issues = new Map(), writes = [], scratchValues = [];
  const selection = { rangeCount: 0, removeAllRanges() {}, addRange() {} };
  const h = controller(['writeClipboard', 'copy', 'autoCopySelection'], {
    el: { copy: element(), timestamps: element(), selectToCopy: { checked: true } },
    transcriber: null, lastAutoCopied: '',
    transcriptSelection: () => ({ toString: () => selected }),
    navigator: { clipboard: { writeText(text) {
      writes.push(text);
      if (writes.length === 1) return firstWrite(text, value => { clipboard = value; });
      clipboard = text;
      return Promise.resolve();
    } } },
    window: { getSelection: () => selection },
    document: {
      body: { appendChild() {} }, activeElement: null,
      createElement(tag) {
        assert.equal(tag, 'textarea');
        return { value: '', style: {},
          select() { scratch = this; scratchValues.push(this.value); },
          remove() { scratch = null; },
        };
      },
      execCommand(command) {
        assert.equal(command, 'copy');
        assert.ok(scratch, 'fallback copies the selected textarea, not a claimed success');
        clipboard = scratch.value;
        return true;
      },
    },
    confirmAction: (...args) => actions.push(args),
    showToast: text => actions.push([text]),
    showIssue(key, message) { if (message) issues.set(key, message); else issues.delete(key); },
  }, source.match(/^let clipboardRequestId = .*;$/m)?.[0] || '');
  return { h, writes, actions, issues, scratchValues,
    clipboard: () => clipboard, select: text => { selected = text; } };
}

for (const first of ['copy', 'autoCopySelection']) {
  for (const second of ['copy', 'autoCopySelection']) {
    test(`late ${first} failure cannot overwrite newer ${second} clipboard bytes or feedback`, async () => {
      const pending = deferred();
      const c = clipboardController(() => pending.promise);
      const older = c.h[first]();
      c.select('Latest passage B has distinct content');
      await c.h[second]();
      assert.equal(c.clipboard(), 'Latest passage B has distinct content');
      assert.equal(c.actions.length, 1);
      const latestFeedback = c.actions.slice();
      pending.reject(new Error('old clipboard write denied'));
      await older;
      assert.equal(c.clipboard(), 'Latest passage B has distinct content',
        'a stale scratch-textarea fallback must not replace the latest payload');
      assert.deepEqual(c.scratchValues, []);
      assert.deepEqual(c.actions, latestFeedback);
      assert.equal(c.issues.size, 0);
      if (second === 'autoCopySelection') assert.equal(c.h.lastAutoCopied, 'Latest passage B has distinct content');
    });
  }
}

test('late clipboard success acknowledgement cannot replace newer auto-copy feedback', async () => {
  const pending = deferred();
  const c = clipboardController((text, commit) => { commit(text); return pending.promise; });
  const older = c.h.autoCopySelection();
  c.select('Latest auto copy');
  await c.h.autoCopySelection();
  pending.resolve();
  await older;
  assert.equal(c.clipboard(), 'Latest auto copy');
  assert.equal(c.h.lastAutoCopied, 'Latest auto copy');
  assert.equal(c.actions.length, 1);
});

test('latest failed clipboard API request still copies exact bytes through fallback', async () => {
  const c = clipboardController(() => Promise.reject(new Error('not focused')));
  c.select('Only requested passage');
  await c.h.copy();
  assert.equal(c.clipboard(), 'Only requested passage');
  assert.deepEqual(c.scratchValues, ['Only requested passage']);
  assert.equal(c.actions.length, 1);
  assert.equal(c.issues.size, 0);
});

test('Delete removes screen-hidden keys before recognition reuses them', () => {
  const c = dataController({ meeting: 'Hidden old speech' });
  c.h.clearScreen();
  assert.equal(c.el.transcript.textContent, '');
  assert.equal(c.el.hiddenNotice.hidden, false);
  const key = c.h.transcriber.store.liveSegments()[0].key;
  c.h.performClear();
  c.h.transcriber.store.update(0, 'Visible new speech', true, 3000);
  assert.equal(c.h.transcriber.store.liveSegments()[0].key, key, 'reset really reused the old key');
  c.h.render(c.h.transcriber.store);
  assert.equal(c.el.transcript.textContent, 'Visible new speech');
  assert.equal(c.el.hiddenNotice.hidden, true);
  assert.equal(c.h.screenHidden.size, 0);
});

test('empty channels do not show unsaved work', () => {
  const c = dataController();
  assert.equal(c.h.hasUnsavedTranscript(), false);
  c.h.refreshUnsavedUi();
  assert.equal(c.el.download.classList.contains('unsaved'), false);
});
