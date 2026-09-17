import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Transcriber, TranscriptStore } from '../extension/transcriber.js';
import { MicTranscriber, MIC_MESSAGES, stopStream } from '../extension/mic.js';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const settle = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
function element() {
  const classes = new Set(), attributes = new Map();
  return {
    textContent: '', hidden: false, disabled: false, checked: false, dataset: {},
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: key => attributes.get(key),
    replaceChildren(...children) { this.children = children; },
    querySelector() { return null; },
    classList: {
      contains: name => classes.has(name),
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
  };
}
function snapshot(text) {
  const store = new TranscriptStore();
  store.newEpoch(); store.update(0, text, true, 0);
  return { snapshot: store.serialize(), micText: null, savedText: '' };
}

// Execute unmodified production controller functions and real transcribers.
// Fakes stop at browser APIs, DOM elements, audio graph and transcript rendering.
function controller(t, { respond = () => undefined, availability = async () => 'available',
  install = async () => true, focus = async () => ({ id: 2 }) } = {}) {
  const names = [
    'claimHandoff', 'restoreStoredTranscript', 'ensureTranscriber', 'fatalRecognitionMessage',
    'popOut', 'backToSidebar', 'releaseForTransfer', 'recoverTransfer', 'reclaimAfterSwitch',
    'start', 'stop', 'teardown', 'armCapture', 'armCaptureAttempt', 'workerRequest', 'replyIsStale',
    'setRecording', 'setStatus', 'setState', 'showIssue', 'flushAutosave', 'scheduleAutosave',
    'requestMicStream', 'attachMic', 'disableMic', 'onMicState', 'onMicUpdate', 'setMicHint',
    'setMicIndicator', 'refreshMicPermission', 'langName', 'showModelPanel', 'hideModelPanel',
    'startModelTimer', 'stopModelTimer', 'onModelProgress',
  ];
  const functions = names.map(name => {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, `production function ${name} exists`);
    return match[0];
  });
  const instances = [], messages = [], writes = [], focused = [], timers = new Set();
  const storage = { popoutWindowId: 2 };
  class Recognition {
    static available = availability;
    static install = install;
    constructor() { instances.push(this); }
    start() { this.onstart?.(); }
    stop() {} abort() {}
  }
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { SpeechRecognition: Recognition } });
  const el = Object.fromEntries(['record', 'popout', 'status', 'issues', 'dot', 'transcript',
    'copy', 'download', 'clear', 'undoBar', 'lang', 'localOnly', 'includeMic', 'micHint',
    'micStatus', 'micGrant', 'prefsPanel', 'modelPanel', 'modelTitle', 'modelBody',
    'modelState', 'modelHint', 'modelActions', 'modelElapsed', 'retryModel'].map(name => [name, element()]));
  el.lang.value = 'en-US'; el.prefsPanel.hidden = el.modelPanel.hidden = el.issues.hidden = true;
  const makeStream = () => {
    const track = { readyState: 'live', addEventListener() {}, stop() { this.readyState = 'ended'; } };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const h = vm.createContext({
    Transcriber, TranscriptStore, MicTranscriber, MIC_MESSAGES, stopStream, AbortController,
    el, issues: new Map(), document: { createElement: element }, console: { warn() {} },
    IS_WINDOW: false, PROTOCOL_VERSION: 4, receiverId: 'final-review-receiver', workerStale: false,
    handedOff: false, handoffBlocked: false, switching: false, reclaiming: false,
    activeStart: null, stopInProgress: false, armed: false, armingPromise: null,
    transcriber: null, mic: null, graph: null, stream: null, micGranted: false, micBlocked: false,
    autosaveTimer: null, autosaveQueue: Promise.resolve(), autosaveBlocked: false,
    AUTOSAVE_KEY: 'liveTranscript', targetTabId: 42, targetTitle: '', savedText: '', clearedSnapshot: null,
    modelPreviewVersion: 0, modelTimer: null, modelStartedAt: 0, MODEL_LANG_NAMES: {},
    SWITCH_HANDOFF_WAIT_MS: 20000,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout,
    setInterval(fn, ms) { const timer = setInterval(fn, ms); timers.add(timer); return timer; },
    clearInterval,
    chrome: {
      runtime: { async sendMessage(message) {
        messages.push(structuredClone(message));
        const reply = await respond(message);
        if (reply !== undefined) return reply;
        if (message.type === 'GET_HOST_WINDOW') return { ok: true, windowId: 5, workerVersion: 4 };
        if (message.type === 'GET_STREAM_ID') return { ok: true, tabId: 42, streamId: 'fake' };
        if (message.type === 'SWITCH_PENDING') return { ok: true, workerVersion: 4 };
        if (message.type === 'GET_SWITCH_PENDING') return { ok: true, pending: false };
        if (message.type === 'OPEN_WINDOW') return { ok: true, reused: true, windowId: 2 };
        throw new Error(`Unexpected request: ${message.type}`);
      } },
      storage: { session: {
        async get(key) { return { [key]: structuredClone(storage[key]) }; },
        async set(value) { writes.push(structuredClone(value)); Object.assign(storage, structuredClone(value)); },
        async remove(key) { writes.push({ removed: key }); delete storage[key]; },
      } },
      windows: { async update(id, options) { focused.push({ id, ...options }); return focus(id, options); } },
    },
    navigator: { mediaDevices: { getUserMedia: async () => makeStream() } },
    buildAudioGraph: stream => ({ track: stream.getAudioTracks()[0], ctx: { state: 'running' }, cleanup: async () => {} }),
    prefs: { get: () => ({ windowWidth: 460, windowHeight: 780 }) },
    window: { close() {} },
    switchLog() {}, switchLogReset: async () => {}, setPopoutLabel() {},
    refreshRecordTitle() {}, updateModeSummary() {}, refreshUnsavedUi() {}, setPrefsOpen() {},
    render(store) { el.transcript.textContent = store.toText(); h.scheduleAutosave(); },
  });
  vm.runInContext(functions.join('\n'), h, { filename: 'final-review-controller.js' });
  t.after(async () => {
    h.activeStart?.abort();
    await h.transcriber?.stop({ flushMs: 0 });
    await h.teardown();
    for (const timer of timers) clearTimeout(timer);
    if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
    else delete globalThis.self;
  });
  return { h, el, messages, storage, writes, focused, instances };
}

test('model poll rejection stops download progress and late installation cannot resurrect it', async t => {
  const installation = deferred();
  let checks = 0;
  const c = controller(t, {
    availability: async () => {
      checks += 1;
      if (checks === 1) return 'downloadable';
      if (checks === 2) throw new Error('Availability poll rejected');
      return 'available';
    },
    install: () => installation.promise,
  });
  c.el.localOnly.checked = true;
  const starting = c.h.start();
  await settle();
  assert.equal(c.el.modelPanel.hidden, false);
  assert.equal(c.el.modelState.textContent, 'Downloading…');
  assert.notEqual(c.h.modelTimer, null);
  const result = await starting;
  assert.equal(result.ok, false);
  assert.match(result.error, /Availability poll rejected/);
  assert.match(c.el.status.textContent, /Availability poll rejected.*Press Record to retry/);
  assert.equal(c.el.record.getAttribute('aria-pressed'), 'false');
  assert.equal(c.h.modelTimer, null, 'failed preparation must stop the elapsed timer');
  assert.ok(c.el.modelPanel.hidden || c.el.modelState.textContent === 'Failed');
  const failedStatus = c.el.status.textContent, hidden = c.el.modelPanel.hidden;
  installation.resolve(true);
  await settle();
  assert.equal(c.h.modelTimer, null);
  assert.equal(c.el.modelPanel.hidden, hidden);
  assert.equal(c.el.status.textContent, failedStatus);
  assert.equal(c.el.record.getAttribute('aria-pressed'), 'false');
  assert.equal(c.instances.length, 0, 'late installation must not start recognition');
});

for (const [name, reason, remedy] of [
  ['NotFoundError', 'no-device', /connect.*microphone/i],
  ['NotReadableError', 'device-busy', /close.*(apps|applications).*microphone/i],
  ['NotAllowedError', 'denied', /allow.*(address-bar|settings)/i],
]) {
  test(`microphone acquisition ${name} is visible outside Preferences while meeting continues`, async t => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      mediaDevices: { getUserMedia: async () => { throw new DOMException('Device unavailable', name); } },
      permissions: { query: async () => ({ state: 'granted' }) },
    } });
    t.after(() => previous ? Object.defineProperty(globalThis, 'navigator', previous) : delete globalThis.navigator);
    const c = controller(t);
    assert.equal((await c.h.start()).ok, true);
    const meeting = c.h.transcriber.recognition, status = c.el.status.textContent;
    c.el.includeMic.checked = true;
    await c.h.refreshMicPermission();
    assert.equal(c.el.micStatus.dataset.state, 'off');
    await c.h.attachMic(c.h.requestMicStream(), 'en-US', false);
    assert.equal(c.el.issues.hidden, false, 'acquisition errors need a visible alert');
    assert.ok(c.h.issues.get('microphone').includes(MIC_MESSAGES[reason]));
    assert.match(c.h.issues.get('microphone'), remedy);
    assert.match(c.h.issues.get('microphone'), /off and on in Preferences/);
    assert.equal(c.el.micStatus.dataset.state, 'error');
    assert.ok(c.el.micStatus.getAttribute('aria-label').includes(MIC_MESSAGES[reason]));
    await c.h.refreshMicPermission();
    assert.equal(c.el.issues.hidden, false);
    assert.equal(c.el.micStatus.dataset.state, 'error');
    assert.equal(c.el.prefsPanel.hidden, true);
    assert.equal(c.h.transcriber.running, true);
    assert.equal(c.h.transcriber.recognition, meeting);
    assert.equal(c.el.record.getAttribute('aria-pressed'), 'true');
    assert.equal(c.el.status.textContent, status);
  });
}

for (const flag of ['handedOff', 'handoffBlocked', 'switching']) {
  test(`start enforces ${flag} even when the Record button is enabled`, async t => {
    const c = controller(t);
    c.h[flag] = true;
    c.el.record.disabled = false;
    const result = await c.h.start({ gesture: true, allowMic: true });
    assert.equal(result.ok, false);
    assert.equal(c.messages.some(m => m.type === 'GET_STREAM_ID'), false);
    assert.equal(c.instances.length, 0);
    assert.equal(c.h.armed, false);
  });
}

for (const direction of ['OPEN_WINDOW', 'BACK_TO_PANEL']) {
  test(`Stop overlap preserves paused transfer error (${direction})`, async t => {
    const c = controller(t, { respond: message => {
      if (message.type === direction) throw new Error('Accepted transfer reply lost');
    } });
    assert.equal((await c.h.start()).ok, true);
    assert.equal(c.h.transcriber.running, true);
    const stopping = c.h.stop();
    assert.equal(c.h.stopInProgress, true);
    if (direction === 'OPEN_WINDOW') await c.h.popOut();
    else await c.h.backToSidebar(Promise.resolve({ ok: true }));
    assert.equal(c.el.record.disabled, true);
    assert.equal(c.el.dot.dataset.state, 'error');
    const pausedStatus = c.el.status.textContent;
    await stopping;
    assert.equal(c.h.stopInProgress, false);
    assert.equal(c.el.record.disabled, true, 'an older Stop must not re-enable Record');
    assert.equal(c.el.dot.dataset.state, 'error', 'an older Stop must not clear the paused indicator');
    assert.equal(c.el.status.textContent, pausedStatus);
    assert.equal(c.h.handedOff, true);
    assert.equal(c.h.handoffBlocked, true);
    assert.equal(await c.h.flushAutosave(), false);
    const captureRequests = c.messages.filter(m => m.type === 'GET_STREAM_ID').length;
    assert.equal((await c.h.start({ gesture: true })).ok, false);
    assert.equal(c.messages.filter(m => m.type === 'GET_STREAM_ID').length, captureRequests);
    assert.equal(c.instances.length, 1);
  });
}

for (const direction of ['OPEN_WINDOW', 'BACK_TO_PANEL']) {
  test(`proven cancellation still resumes with the real start guard (${direction})`, async t => {
    const c = controller(t, { respond: message => {
      if (message.type === direction) return { ok: false, safeToResume: true, error: 'Transfer cancelled' };
    } });
    assert.equal((await c.h.start()).ok, true);
    if (direction === 'OPEN_WINDOW') await c.h.popOut();
    else await c.h.backToSidebar(Promise.resolve({ ok: true }));
    assert.equal(c.h.handedOff, false);
    assert.equal(c.h.handoffBlocked, false);
    assert.equal(c.h.switching, false);
    assert.equal(c.h.transcriber.running, true);
    assert.equal(c.el.record.getAttribute('aria-pressed'), 'true');
    assert.equal(c.instances.length, 2);
  });
}

test('accepted return to the surviving sidebar resumes through the real start guard', async t => {
  const c = controller(t, { respond: message => {
    if (message.type === 'OPEN_WINDOW') return { ok: true, reused: false, panelClosed: false };
    if (message.type === 'CLAIM_HANDOFF') return {
      ok: true, handoffId: 'accepted-return', resume: true, ...snapshot('Latest popup speech'),
    };
    if (message.type === 'ACK_HANDOFF') return { ok: true };
  } });
  assert.equal((await c.h.start()).ok, true);
  await c.h.popOut();
  assert.equal(c.h.handedOff, true);
  assert.equal(c.h.armed, false);
  await c.h.reclaimAfterSwitch();
  assert.equal(c.h.handedOff, false);
  assert.equal(c.h.handoffBlocked, false);
  assert.equal(c.h.transcriber.running, true);
  assert.equal(c.h.transcriber.store.toText(), 'Latest popup speech');
  assert.equal(c.el.record.disabled, false);
  assert.equal(c.el.record.getAttribute('aria-pressed'), 'true');
  assert.equal(await c.h.flushAutosave(), true);
});

test('manual Stop still permits restart and appends to the kept meeting', async t => {
  const c = controller(t);
  assert.equal((await c.h.start()).ok, true);
  c.h.transcriber.store.update(0, 'Before manual stop', true, 0);
  await c.h.stop();
  assert.equal(c.el.record.disabled, false);
  assert.equal(c.el.dot.dataset.state, 'idle');
  assert.match(c.el.status.textContent, /Stopped.*Transcript kept/);
  assert.equal((await c.h.start({ gesture: true })).ok, true);
  assert.equal(c.h.transcriber.running, true);
  c.h.transcriber.store.update(0, 'After restart', true, 10);
  assert.match(c.h.transcriber.store.toText(), /Before manual stop\s+After restart/);
  assert.equal(c.instances.length, 2);
});

for (const target of ['existing', 'missing', 'focus rejected']) {
  test(`failed fresh receiver Window stays read-only (${target})`, async t => {
    const c = controller(t, {
      respond: message => {
        if (message.type === 'CLAIM_HANDOFF') return {
          ok: true, handoffId: 'failed-return', ...snapshot('speech at failed return'),
        };
        if (message.type === 'ACK_HANDOFF') return { ok: false, error: 'ACK storage rejected' };
      },
      focus: async () => {
        if (target === 'focus rejected') throw new Error('Window focus failed');
        return { id: 2 };
      },
    });
    assert.equal((await c.h.claimHandoff()).failed, true);
    assert.equal(c.h.handedOff, false, 'fresh receiver, not an old source');
    c.storage.liveTranscript = snapshot('new speech after source resumed');
    if (target === 'missing') delete c.storage.popoutWindowId;
    await c.h.popOut();
    assert.equal(c.h.handoffBlocked, true, 'Window must not clear failed ownership');
    assert.equal(c.h.armed, false);
    assert.equal(c.el.record.disabled, true);
    assert.equal(c.messages.some(m => m.type === 'GET_STREAM_ID'), false);
    assert.equal(await c.h.flushAutosave(), false);
    assert.deepEqual(c.writes, []);
    assert.equal(c.storage.liveTranscript.snapshot.segments[0].text, 'new speech after source resumed');
    assert.equal(c.el.transcript.textContent, 'speech at failed return');
    assert.equal(c.messages.some(m => m.type === 'OPEN_WINDOW'), false,
      'focus-only must not create a new receiver if the existing popup vanishes');
    if (target === 'existing') assert.deepEqual(c.focused, [{ id: 2, focused: true, drawAttention: true }]);
    assert.equal(c.el.issues.hidden, false);
    assert.match(c.h.issues.get('switch'), /Copy or Download/);
    assert.match(c.h.issues.get('switch'), /toolbar/);
    assert.equal(c.el.popout.disabled, false);
  });
}
