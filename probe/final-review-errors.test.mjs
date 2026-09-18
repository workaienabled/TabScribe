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
    'setMicIndicator', 'refreshMicPermission', 'onMicGrantReported', 'langName', 'showModelPanel', 'hideModelPanel',
    'startModelTimer', 'stopModelTimer', 'onModelProgress', 'onPageHide', 'restoreAutosave',
    'recordingInProgress', 'explainReadOnlyView',
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
    handedOff: false, handoffBlocked: false, switching: false, reclaiming: false, reclaimQueued: false,
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
    // The user pressed Stop first. Stop is still flushing, so `running` has not
    // dropped yet, but the receiver must not be asked to resume a stopped meeting.
    assert.equal(c.messages.find(m => m.type === direction).resume, false,
      'a switch during Stop must not resume recording in the receiver');
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

// Chrome ends a continuous session and the Transcriber schedules a restart. For
// that gap the recognizer is null and running is false, yet the user still sees
// Record pressed. A view switch here must carry the recording over and must not
// leave a timer that restarts recognition inside the released document.
for (const direction of ['OPEN_WINDOW', 'BACK_TO_PANEL']) {
  test(`a switch during the recognizer's restart gap keeps recording (${direction})`, async t => {
    const c = controller(t, { respond: message => {
      if (message.type === 'OPEN_WINDOW') return { ok: true, reused: false, panelClosed: true };
      if (message.type === 'BACK_TO_PANEL') return { ok: true, tabId: 42 };
    } });
    assert.equal((await c.h.start()).ok, true);
    c.instances[0].onend();
    assert.equal(c.h.transcriber.running, false);
    assert.equal(c.h.transcriber.recognition, null);
    assert.equal(c.el.record.getAttribute('aria-pressed'), 'true');
    if (direction === 'OPEN_WINDOW') await c.h.popOut();
    else await c.h.backToSidebar(Promise.resolve({ ok: true }));
    assert.equal(c.h.handedOff, true);
    for (const type of direction === 'OPEN_WINDOW' ? ['OPEN_WINDOW'] : ['SWITCH_PENDING', 'BACK_TO_PANEL']) {
      assert.equal(c.messages.find(m => m.type === type).resume, true,
        `${type} must ask the receiver to resume what the user saw as recording`);
    }
    const status = c.el.status.textContent;
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(c.instances.length, 1, 'the released document must not restart recognition');
    assert.equal(c.h.transcriber.running, false);
    assert.equal(c.el.status.textContent, status, 'a late restart must not rewrite the hand-off message');
    assert.notEqual(c.el.dot.dataset.state, 'listening');
  });
}

// A real microphone: getUserMedia resolves, the audio graph builds, and the
// permission state is whatever the test says it is right now.
function microphoneBrowser(t, { permission = () => 'granted' } = {}) {
  const node = () => ({ gain: {}, offset: {}, connect() {}, disconnect() {}, start() {}, stop() {} });
  const liveStream = () => {
    const track = { readyState: 'live', stop() { this.readyState = 'ended'; }, addEventListener() {}, removeEventListener() {} };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  class AudioContext {
    constructor() { this.sampleRate = 100; this.destination = {}; }
    createMediaStreamSource() { return node(); }
    createMediaStreamDestination() { return { ...node(), stream: liveStream() }; }
    createGain() { return node(); } createConstantSource() { return node(); }
    createBuffer(c, n) { return { getChannelData: () => new Float32Array(n) }; }
    createBufferSource() { return node(); }
    async close() {}
  }
  for (const [name, value] of Object.entries({ AudioContext, navigator: {
    mediaDevices: { getUserMedia: async () => liveStream() },
    permissions: { query: async () => ({ state: permission() }) },
  } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
}

test('the microphone still attaches during the recognizer\'s restart gap', async t => {
  microphoneBrowser(t);
  const c = controller(t);
  c.el.includeMic.checked = true;
  await c.h.refreshMicPermission();
  assert.equal((await c.h.start()).ok, true);
  c.instances[0].onend();
  assert.equal(c.h.transcriber.recognition, null, 'the gap: no recognizer until the scheduled restart');
  assert.equal(c.el.record.getAttribute('aria-pressed'), 'true');
  await c.h.attachMic(c.h.requestMicStream(), 'en-US', true);
  assert.equal(c.h.mic?.running, true, 'a scheduled restart is not a stopped meeting');
  assert.match(c.el.micHint.textContent, /being transcribed/);
  assert.equal(c.h.micBlocked, false);
});

// mic-permission.html reports its outcome through chrome.storage.local and
// tells the user "TabScribe will use it automatically from now on". A panel
// that is already open must hear that report: otherwise it keeps offering the
// Allow button and records the meeting in progress without the microphone.
test('an open panel picks up the grant the permission page reports', async t => {
  let permission = 'prompt';
  microphoneBrowser(t, { permission: () => permission });
  const c = controller(t);
  assert.ok(/chrome\.storage\.onChanged\.addListener\(onMicGrantReported\)/.test(source),
    'the panel must subscribe to the permission page\'s report');
  c.el.includeMic.checked = true;
  await c.h.refreshMicPermission();
  assert.equal(c.h.micGranted, false);
  assert.equal(c.el.micGrant.hidden, false, 'no grant yet: the Allow button is offered');
  assert.equal((await c.h.start()).ok, true);
  assert.equal(c.h.mic?.running ?? false, false, 'without a grant, Start must not open the microphone');

  permission = 'granted';
  await c.h.onMicGrantReported({ micGrant: { newValue: { outcome: 'granted', at: 1 } } }, 'local');
  await settle();
  assert.equal(c.h.micGranted, true);
  assert.equal(c.el.micGrant.hidden, true, 'the Allow button is withdrawn once the grant exists');
  assert.equal(c.h.mic?.running, true, 'the meeting in progress gains the microphone');
  assert.match(c.el.micHint.textContent, /being transcribed/);
  assert.equal(c.el.micStatus.dataset.state, 'recording');
  assert.equal(c.h.transcriber.running, true, 'the meeting recognizer is untouched');
  assert.equal(c.instances.length, 2, 'one meeting recognizer plus one microphone recognizer');
});

test('a grant reported while idle only refreshes the permission state', async t => {
  let permission = 'prompt';
  microphoneBrowser(t, { permission: () => permission });
  const c = controller(t);
  c.el.includeMic.checked = true;
  await c.h.refreshMicPermission();
  permission = 'granted';
  await c.h.onMicGrantReported({ micGrant: { newValue: { outcome: 'granted', at: 1 } } }, 'local');
  await settle();
  assert.equal(c.h.micGranted, true);
  assert.equal(c.el.micGrant.hidden, true);
  assert.equal(c.h.mic?.running ?? false, false, 'nothing is recording, so nothing opens the microphone');
  assert.equal(c.instances.length, 0);
});

test('the panel ignores unrelated storage changes and other areas', async t => {
  let queries = 0;
  microphoneBrowser(t, { permission: () => { queries += 1; return 'prompt'; } });
  const c = controller(t);
  await c.h.onMicGrantReported({ prefs: { newValue: {} } }, 'local');
  await c.h.onMicGrantReported({ micGrant: { newValue: { outcome: 'granted', at: 1 } } }, 'session');
  await settle();
  assert.equal(queries, 0);
});

// A microphone failure recorded earlier this session stops Start from retrying
// (micBlocked). The permission page's "granted" report means the device just
// worked; keeping the old failure would make the user toggle the option to get
// what they were promised. Any other outcome is not evidence of recovery.
for (const [outcome, permission, blockedAfter] of [
  ['granted', 'granted', false],
  ['denied', 'denied', true],
  ['skipped', 'prompt', true],
]) {
  test(`a "${outcome}" report ${blockedAfter ? 'keeps' : 'clears'} an earlier microphone failure`, async t => {
    microphoneBrowser(t, { permission: () => permission });
    const c = controller(t);
    c.el.includeMic.checked = true;
    c.h.disableMic('device-busy', 'Device was busy');
    assert.equal(c.h.micBlocked, true);
    assert.equal(c.el.issues.hidden, false);
    await c.h.onMicGrantReported({ micGrant: { newValue: { outcome, at: 1 } } }, 'local');
    await settle();
    assert.equal(c.h.micBlocked, blockedAfter);
    assert.equal(c.h.issues.has('microphone'), blockedAfter, 'the stale failure leaves with the block');
    if (!blockedAfter) assert.doesNotMatch(c.el.micHint.textContent, /busy/);
  });
}

// Closing the panel destroys the document without any prompt (measured). The
// autosave is debounced by 1.2 s, so the last words spoken before a close were
// only persisted if the timer happened to fire first. pagehide is the one
// notification the panel does get, so the pending write is issued there.
test('closing the panel flushes the pending autosave before releasing capture', async t => {
  const c = controller(t);
  assert.ok(/window\.addEventListener\('pagehide', onPageHide\)/.test(source),
    'the panel must flush on pagehide, not only tear down');
  assert.equal((await c.h.start()).ok, true);
  c.h.transcriber.store.update(0, 'Final words before closing', true, 0);
  c.h.render(c.h.transcriber.store);
  assert.equal(c.writes.some(w => w.liveTranscript), false, 'debounced: nothing written yet');
  c.h.onPageHide();
  await settle();
  const saved = c.writes.filter(w => w.liveTranscript).at(-1);
  assert.ok(saved, 'the pending snapshot is written on pagehide');
  assert.equal(saved.liveTranscript.snapshot.segments[0].text, 'Final words before closing');
  assert.equal(c.h.armed, false, 'capture is still released');
});

test('a handed-off document does not overwrite the receiver\'s copy on pagehide', async t => {
  const c = controller(t, { respond: message => {
    if (message.type === 'OPEN_WINDOW') return { ok: true, reused: false, panelClosed: true };
  } });
  assert.equal((await c.h.start()).ok, true);
  c.h.transcriber.store.update(0, 'Moved to the window', true, 0);
  await c.h.popOut();
  assert.equal(c.h.handedOff, true);
  c.writes.length = 0;
  c.h.onPageHide();
  await settle();
  assert.equal(c.writes.some(w => w.liveTranscript), false);
});

// A receiver that waited for an announced transfer and then failed must not be
// left saying "Bringing the transcript back…" next to its failure alert.
test('a failed receive replaces the waiting status with the paused state', async t => {
  const c = controller(t, { respond: message => {
    if (message.type === 'CLAIM_HANDOFF') return { ok: false, error: 'Claim storage rejected' };
  } });
  c.h.setStatus('Bringing the transcript back…');
  const handoff = await c.h.claimHandoff({ waitMs: 20000 });
  assert.equal(handoff.failed, true);
  assert.doesNotMatch(c.el.status.textContent, /Bringing/);
  assert.match(c.el.status.textContent, /paused in this view/i);
  assert.equal(c.el.dot.dataset.state, 'error');
  assert.match(c.h.issues.get('switch'), /Claim storage rejected/);
});

// The surviving sidebar reclaiming after the window closed gets the same
// remedy wording as a fresh panel when Chrome wants a new toolbar click.
test('survivor reclaim explains a missing invocation like a fresh panel does', async t => {
  let returned = false;
  const c = controller(t, { respond: message => {
    if (message.type === 'OPEN_WINDOW') return { ok: true, reused: false, panelClosed: false };
    if (message.type === 'CLAIM_HANDOFF') return {
      ok: true, handoffId: 'returned', resume: false, ...snapshot('Text from the window'),
    };
    if (message.type === 'ACK_HANDOFF') return { ok: true };
    // The activeTab grant from the original toolbar click is gone by the time
    // the window closes; Chrome wants a new click.
    if (message.type === 'GET_STREAM_ID' && returned) return {
      ok: false, needsInvocation: true,
      error: 'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.',
    };
  } });
  assert.equal((await c.h.start()).ok, true);
  await c.h.popOut();
  returned = true;
  await c.h.reclaimAfterSwitch();
  assert.equal(c.h.transcriber.store.toText(), 'Text from the window', 'the transcript came back');
  assert.match(c.el.status.textContent, /Transcript restored.*Click the TabScribe toolbar icon/);
  assert.doesNotMatch(c.el.status.textContent, /activeTab permission/);
  assert.equal(c.h.handedOff, false, 'the transcript is owned here now');
  assert.equal(c.el.record.disabled, false, '"press Record" must be actionable');
  assert.equal(c.el.popout.disabled, false);
  assert.equal(await c.h.flushAutosave(), true, 'the owner persists its copy');
});

// Closing the panel before init() has restored anything must not touch the
// recovery copy a previous document left behind: an empty store here means
// "not restored yet", not "nothing to keep". Only a write that is already
// scheduled — speech rendered since the last flush — is worth issuing.
test('closing before the restore completes leaves the recovery copy alone', async t => {
  const c = controller(t);
  c.storage.liveTranscript = snapshot('Previous document\'s last words');
  c.h.onPageHide();
  await settle();
  assert.deepEqual(c.writes, [], 'no write and no removal');
  assert.equal(c.storage.liveTranscript.snapshot.segments[0].text, 'Previous document\'s last words');
});

// Restoring the recovery copy renders it, and a render schedules an autosave —
// of the very text that was just read back. That write is redundant, and it is
// dangerous: another document (a pop-out window acknowledging a hand-off) can
// write a newer copy in the meantime, and this document's stale copy would then
// overwrite it 1.2 s later, or on pagehide. Only new content earns a write.
test('restoring the recovery copy does not schedule a write of it', async t => {
  const c = controller(t);
  c.storage.liveTranscript = snapshot('Restored from a previous document');
  assert.equal(await c.h.restoreAutosave(), true);
  assert.equal(c.h.autosaveTimer, null, 'a restore-only render must not schedule an autosave');
  // Someone else owns the newest copy now.
  c.storage.liveTranscript = snapshot('Newer copy written by the pop-out window');
  c.h.onPageHide();
  await settle();
  assert.deepEqual(c.writes, []);
  assert.equal(c.storage.liveTranscript.snapshot.segments[0].text, 'Newer copy written by the pop-out window');
});

/* ------------------------------------------------ independent review findings */

// A window that failed to receive a transfer is read-only (handoffBlocked). Its
// Sidebar button must not stage its stale copy, announce a switch the sidebar
// would wait for, or clear the block and start autosaving over the source's
// newer copy. popOut() already guards this; backToSidebar() must too.
test('Sidebar in a failed-receiver window stays read-only and never overwrites the newer copy', async t => {
  const c = controller(t, { respond: message => {
    if (message.type === 'CLAIM_HANDOFF') return {
      ok: true, handoffId: 'failed-window', ...snapshot('stale receiver copy'),
    };
    if (message.type === 'ACK_HANDOFF') return { ok: false, error: 'ACK storage rejected' };
  } });
  c.h.IS_WINDOW = true;
  assert.equal((await c.h.claimHandoff()).failed, true);
  assert.equal(c.h.handoffBlocked, true);
  // The source resumed after the worker cancelled the transfer and kept recording.
  c.storage.liveTranscript = snapshot('NEWER speech from the resumed source');
  c.messages.length = 0;
  await c.h.backToSidebar(Promise.resolve({ ok: false, error: 'no tab to attach to' }));
  assert.equal(c.h.handoffBlocked, true, 'a failed receiver cannot clear its own block');
  assert.deepEqual(c.messages.map(m => m.type), [], 'nothing announced, nothing staged');
  assert.equal(c.el.record.disabled, true);
  assert.equal(c.el.popout.disabled, false, 'the control is usable again');
  assert.equal(await c.h.flushAutosave(), false);
  assert.equal(c.h.autosaveTimer, null, 'no autosave scheduled');
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(c.storage.liveTranscript.snapshot.segments[0].text, 'NEWER speech from the resumed source');
  assert.match(c.h.issues.get('switch'), /Copy or Download/);
});

// An inert, handed-off panel presses Window only to focus the pop-out. If that
// focus fails, nothing about ownership changed: the window still records. The
// panel must say so and keep its one control usable, not declare an
// unconfirmed transfer and disable itself for good.
for (const failure of ['rejected', 'stale worker', 'GET_HOST_WINDOW failed']) {
  test(`a failed focus from an inert panel is not an unconfirmed transfer (${failure})`, async t => {
    let handedOver = false;
    const c = controller(t, { respond: message => {
      if (message.type === 'GET_HOST_WINDOW' && handedOver && failure === 'stale worker') return { ok: true, windowId: 5 };
      if (message.type === 'GET_HOST_WINDOW' && handedOver && failure === 'GET_HOST_WINDOW failed') return { ok: false, error: 'No browser window', workerVersion: 4 };
      if (message.type === 'OPEN_WINDOW' && !handedOver) return { ok: true, reused: false, panelClosed: false };
      if (message.type === 'OPEN_WINDOW') return { ok: false, safeToResume: true, error: 'focus unavailable' };
    } });
    assert.equal((await c.h.start()).ok, true);
    c.h.transcriber.store.update(0, 'Handed to the window', true, 0);
    await c.h.popOut();
    assert.equal(c.h.handedOff, true);
    handedOver = true;
    await c.h.popOut();
    assert.equal(c.h.handedOff, true, 'the window still owns the recording');
    assert.equal(c.h.handoffBlocked, false, 'a focus failure is not an unconfirmed transfer');
    assert.equal(c.el.popout.disabled, false, 'the only remaining control must stay usable');
    assert.doesNotMatch(c.el.status.textContent, /could not be confirmed/);
    assert.match(c.h.issues.get('switch'), /focus/i);
    assert.equal(c.messages.some(m => m.type === 'GET_STREAM_ID' && c.messages.indexOf(m) > 2), false,
      'an inert panel must not re-arm capture');
    assert.equal(c.h.transcriber.store.toText(), 'Handed to the window');
  });
}

// The inert panel presses Window, but the window was closed by hand. The worker
// says so instead of creating a new receiver (which would stage an empty
// hand-off over the window's transcript). The panel must take the tab back with
// the window's last autosave, not report a focus failure.
test('Window pressed after the pop-out was closed by hand takes the tab back with the window\'s transcript', async t => {
  let handedOver = false;
  const c = controller(t, { respond: message => {
    if (message.type === 'OPEN_WINDOW' && !handedOver) return { ok: true, reused: false, panelClosed: false };
    if (message.type === 'OPEN_WINDOW') {
      assert.equal(message.focusOnly, true, 'an inert panel only asks to focus');
      assert.equal(message.snapshot, undefined, 'and sends no text');
      return { ok: false, safeToResume: false, windowGone: true, error: 'The TabScribe window is no longer open.' };
    }
    if (message.type === 'CLAIM_HANDOFF') return { ok: true, handoffId: null };
  } });
  assert.equal((await c.h.start()).ok, true);
  c.h.transcriber.store.update(0, 'Before the pop-out', true, 0);
  await c.h.popOut();
  assert.equal(c.h.handedOff, true);
  handedOver = true;
  delete c.storage.popoutWindowId;
  c.storage.liveTranscript = snapshot('Everything the window heard');
  await c.h.popOut();
  assert.equal(c.h.handedOff, false, 'the panel owns the tab again');
  assert.equal(c.h.handoffBlocked, false);
  assert.equal(c.h.transcriber.store.toText(), 'Everything the window heard');
  assert.equal(c.el.record.disabled, false);
  assert.equal(c.el.popout.disabled, false);
  assert.equal(c.h.issues.has('switch'), false, 'nothing failed');
  assert.match(c.el.status.textContent, /Earlier transcript restored/);
  assert.equal(c.storage.liveTranscript.snapshot.segments[0].text, 'Everything the window heard');
});

// Record was pressed and Start is still preparing (model download, arming).
// The user sees recording; the transcriber may not exist yet. A switch now must
// carry `resume` so the receiver continues, and the released document must not
// keep a live download panel ticking behind the window.
for (const direction of ['OPEN_WINDOW', 'BACK_TO_PANEL']) {
  test(`a switch while Start is still preparing resumes in the receiver (${direction})`, async t => {
    const installation = deferred();
    const c = controller(t, {
      availability: async () => 'downloadable',
      install: () => installation.promise,
      respond: message => {
        if (message.type === 'OPEN_WINDOW') return { ok: true, reused: false, panelClosed: true };
        if (message.type === 'BACK_TO_PANEL') return { ok: true, tabId: 42 };
      },
    });
    c.el.localOnly.checked = true;
    const starting = c.h.start({ gesture: true });
    await settle();
    assert.equal(c.el.record.getAttribute('aria-pressed'), 'true');
    assert.equal(c.el.modelPanel.hidden, false, 'the download notice is up');
    assert.notEqual(c.h.modelTimer, null);
    if (direction === 'OPEN_WINDOW') await c.h.popOut();
    else await c.h.backToSidebar(Promise.resolve({ ok: true }));
    assert.equal((await starting).cancelled, true);
    assert.equal(c.h.handedOff, true);
    assert.equal(c.messages.find(m => m.type === direction).resume, true,
      'the receiver must continue what the user started');
    assert.equal(c.h.modelTimer, null, 'the released document must not keep counting');
    assert.equal(c.el.modelPanel.hidden, true);
    installation.resolve(true);
    await settle();
    assert.equal(c.instances.length, 0, 'a late install result must not start recognition here');
  });
}

// Chrome reports 'network' or 'audio-capture' and ends the session; the
// Transcriber retries on its own. Showing "press Record" for that moment sends
// the user to STOP a session that is about to recover. The remedy belongs to
// the terminal 'stopped' notification, which only arrives if retries run out.
for (const code of ['network', 'audio-capture']) {
  test(`a retried recognizer error (${code}) is not shown as a terminal failure`, async t => {
    const c = controller(t);
    assert.equal((await c.h.start()).ok, true);
    const rec = c.instances[0];
    rec.onerror({ error: code, message: 'transient' });
    assert.notEqual(c.el.dot.dataset.state, 'error', 'still recording as far as the user is concerned');
    assert.equal(c.el.status.classList.contains('error'), false);
    assert.doesNotMatch(c.el.status.textContent, /press Record/i);
    assert.match(c.el.status.textContent, new RegExp(`${code}.*reconnect|reconnect.*${code}`, 'i'));
    rec.onend();
    assert.match(c.el.status.textContent, /Reconnecting/);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(c.instances.length, 2, 'the transcriber restarted on its own');
    c.instances[1].onstart();
    assert.match(c.el.status.textContent, /Listening/);
    assert.equal(c.el.record.getAttribute('aria-pressed'), 'true');
  });
}

test('a fatal recognizer error keeps its remedy in the status line', async t => {
  const c = controller(t);
  assert.equal((await c.h.start()).ok, true);
  c.instances[0].onerror({ error: 'not-allowed', message: 'policy' });
  assert.match(c.el.status.textContent, /Chrome denied speech recognition.*press Record/i);
  assert.equal(c.el.dot.dataset.state, 'error');
  c.instances[0].onend();
  assert.match(c.el.status.textContent, /Chrome denied speech recognition/);
  assert.equal(c.el.record.getAttribute('aria-pressed'), 'false');
});

test('a retried error that exhausts its budget ends with the remedy', async t => {
  const c = controller(t);
  assert.equal((await c.h.start()).ok, true);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rec = c.instances.at(-1);
    rec.onerror({ error: 'network', message: 'down' });
    rec.onend();
    await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt + 50));
  }
  assert.match(c.el.status.textContent, /connection failed.*press Record/i);
  assert.equal(c.el.dot.dataset.state, 'error');
  assert.equal(c.el.record.getAttribute('aria-pressed'), 'false');
});

// The focus-only failure branch applies to a document that had ALREADY handed
// off. A live panel whose pop-out fails before anything was released must go
// through the ordinary recovery: it still owns the recording.
for (const failure of ['GET_HOST_WINDOW failed', 'stale worker']) {
  test(`a live panel whose pop-out fails before release keeps recording (${failure})`, async t => {
    const c = controller(t, { respond: message => {
      if (message.type === 'GET_HOST_WINDOW') {
        return failure === 'stale worker' ? { ok: true, windowId: 5 } : { ok: false, error: 'No browser window', workerVersion: 4 };
      }
    } });
    assert.equal((await c.h.start()).ok, true);
    await c.h.popOut();
    assert.equal(c.h.handedOff, false, 'nothing was handed off');
    assert.equal(c.h.transcriber.active, true, 'still recording here');
    assert.equal(c.el.record.getAttribute('aria-pressed'), 'true');
    assert.equal(c.el.popout.disabled, false);
    assert.doesNotMatch(c.h.issues.get('switch'), /window still holds/i);
    assert.match(c.h.issues.get('switch'), /remains in this view/);
    // The stale-worker message itself is covered by stale_worker_test.py in a real Chrome.
  });
}
