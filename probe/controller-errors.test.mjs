import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MIC_MESSAGES, MicTranscriber } from '../extension/mic.js';
import { Transcriber, TranscriptStore } from '../extension/transcriber.js';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// Run the production controller functions unchanged, without booting a browser or
// adding a test API to the extension. Only browser/platform boundaries are faked.
function controller(names, bindings, prelude = '') {
  const functions = names.map(name => {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, `production controller function ${name} exists`);
    return match[0];
  });
  const context = vm.createContext(bindings);
  vm.runInContext(`${prelude}\n${functions.join('\n')}`, context, { filename: 'sidepanel-controller.js' });
  return context;
}

function element() {
  const classes = new Set();
  const attributes = new Map();
  return {
    textContent: '', disabled: false, hidden: false, dataset: {},
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name),
    replaceChildren(...children) { this.children = children; },
    classList: {
      contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
  };
}

for (const [reason, error] of [
  ['denied', 'Permission blocked'],
  ['device-busy', undefined],
  ['unknown-reason', 'Device failed'],
]) {
  test(`disableMic reports ${reason} without throwing or changing meeting status`, () => {
    const warnings = [];
    const el = { micHint: element(), status: element(), micStatus: element(),
      includeMic: element(), issues: element() };
    el.includeMic.checked = true;
    el.status.textContent = 'Transcribing meeting';
    const h = controller(['disableMic', 'setMicHint', 'showIssue', 'setMicIndicator'], {
      MIC_MESSAGES, el, micBlocked: false, micGranted: true, mic: null,
      issues: new Map(), document: { createElement: element },
      console: { warn: (...args) => warnings.push(args) },
    });
    assert.doesNotThrow(() => h.disableMic(reason, error));
    assert.equal(h.micBlocked, true);
    assert.equal(el.micHint.textContent,
      `${MIC_MESSAGES[reason] || MIC_MESSAGES.failed} The meeting transcript is unaffected.`);
    assert.equal(el.micHint.classList.contains('denied'), true);
    assert.equal(el.status.textContent, 'Transcribing meeting');
    assert.deepEqual(warnings, error ? [['TabScribe microphone:', reason, error]] : []);
  });
}

function savedTranscript(text = 'Recovered meeting speech') {
  return { snapshot: { epoch: 1, segments: [
    { key: '1:0', text, isFinal: true, startedAt: 1000 },
  ] }, micText: null, savedText: '', at: 1000 };
}

function transferController({ respond, saved, extraFunctions = [] } = {}) {
  const messages = [], writes = [], timers = new Map();
  const storage = saved ? { liveTranscript: structuredClone(saved) } : {};
  const el = Object.fromEntries(['record', 'popout', 'status', 'issues', 'transcript',
    'copy', 'download', 'undoBar', 'includeMic', 'dot'].map(name => [name, element()]));
  const track = { readyState: 'live', addEventListener() {}, stop() { this.readyState = 'ended'; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  let timerId = 0, starts = 0, now = 1000;
  class Clock extends Date { static now() { return now; } }
  const h = controller([
    'claimHandoff', 'reclaimAfterSwitch', 'restoreStoredTranscript', 'restoreAutosave',
    'flushAutosave', 'scheduleAutosave', 'ensureTranscriber', 'showIssue', 'setStatus',
    'armCapture', 'armCaptureAttempt', 'teardown', 'workerRequest', 'setRecording',
    ...extraFunctions,
  ], {
    Transcriber, TranscriptStore, MicTranscriber, el, Date: Clock,
    IS_WINDOW: false, SWITCH_HANDOFF_WAIT_MS: 20000, workerStale: false,
    receiverId: 'c72a4f31-f093-4814-b65c-9a5800303a64',
    handedOff: true, switching: false, reclaiming: false, armed: false,
    armingPromise: null, graph: null, stream: null, transcriber: null, mic: null,
    targetTabId: 42, targetTitle: '', savedText: '', issues: new Map(),
    document: { createElement: element },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    chrome: {
      runtime: { async sendMessage(message) {
        messages.push(structuredClone(message));
        if (respond) {
          const reply = await respond(message);
          if (reply !== undefined) return reply;
        }
        if (message.type === 'GET_SWITCH_PENDING') return { ok: true, pending: false };
        if (message.type === 'GET_STREAM_ID') return { ok: true, tabId: 42, streamId: 'fake-stream' };
        throw new Error(`Unexpected worker request: ${message.type}`);
      } },
      storage: { session: {
        async get(key) { return { [key]: structuredClone(storage[key]) }; },
        async set(value) { writes.push(structuredClone(value)); Object.assign(storage, structuredClone(value)); },
        async remove(key) { writes.push({ removed: key }); delete storage[key]; },
      } },
    },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    buildAudioGraph: () => ({ track, cleanup: async () => {} }),
    refreshRecordTitle() {}, updateModeSummary() {}, switchLog() {}, setPopoutLabel() {},
    refreshMicPermission: async () => {}, onMicState() {}, onMicUpdate() {},
    start: async () => { starts += 1; },
    // Rendering is a boundary here; validation, restore, ownership and storage
    // scheduling execute their actual controller implementations.
    render(store) {
      el.transcript.textContent = store.toText();
      el.copy.disabled = el.download.disabled = store.isEmpty();
      h.scheduleAutosave();
    },
  }, source.slice(source.indexOf("const AUTOSAVE_KEY ="), source.indexOf('function flushAutosave(')));
  return {
    h, el, messages, writes, storage, timers, starts: () => starts,
    async tick(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
      await new Promise(setImmediate);
    },
  };
}

for (const viaFocus of [false, true]) {
  test(`failed receiver ACK stays inert during survivor reclaim (viaFocus=${viaFocus})`, async () => {
    const c = transferController({
      saved: savedTranscript('Original recovery copy'),
      respond: async message => {
        if (message.type === 'CLAIM_HANDOFF') return {
          ok: true, handoffId: 'transfer-1', resume: true, ...savedTranscript(),
        };
        if (message.type === 'ACK_HANDOFF') return { ok: false, error: 'ACK rejected' };
      },
    });
    await c.h.reclaimAfterSwitch({ viaFocus });
    assert.equal(c.messages.some(m => m.type === 'GET_STREAM_ID'), false,
      'an unaccepted receiver must not compete for capture');
    assert.equal(c.h.handedOff, true);
    assert.equal(c.h.armed, false);
    assert.equal(c.h.reclaiming, false);
    assert.equal(c.el.record.disabled, true);
    assert.equal(c.starts(), 0);
    assert.equal(await c.h.flushAutosave(), false);
    assert.deepEqual(c.writes, []);
    assert.equal(c.storage.liveTranscript.snapshot.segments[0].text, 'Original recovery copy');
    assert.equal(c.el.transcript.textContent, 'Recovered meeting speech');
    assert.match(c.h.issues.get('switch'), /ACK rejected/);
  });
}

for (const initialFailure of ['claim', 'validation', 'ack']) {
  test(`validated claim and ACK restore autosaving after ${initialFailure} failure`, async () => {
    let retry = false;
    const c = transferController({ respond: async message => {
      if (message.type === 'CLAIM_HANDOFF') {
        if (!retry && initialFailure === 'claim') throw new Error('Temporary claim rejection');
        const saved = savedTranscript();
        if (!retry && initialFailure === 'validation') saved.snapshot.segments[0].text = 42;
        return { ok: true, handoffId: 'transfer-2', resume: false, ...saved };
      }
      if (message.type === 'ACK_HANDOFF') {
        return !retry && initialFailure === 'ack'
          ? { ok: false, error: 'Temporary ACK rejection' } : { ok: true };
      }
    } });
    await c.h.reclaimAfterSwitch();
    assert.equal(await c.h.flushAutosave(), false);
    assert.deepEqual(c.writes, []);
    retry = true;
    await c.h.reclaimAfterSwitch();
    assert.equal(c.h.handedOff, false);
    assert.equal(c.h.issues.has('switch'), false);
    c.h.transcriber.store.newEpoch();
    c.h.transcriber.store.update(0, 'New acknowledged speech', true, 2000);
    c.h.render(c.h.transcriber.store);
    assert.equal(await c.h.flushAutosave(), true, 'the new owner must be able to persist new speech');
    assert.equal(c.storage.liveTranscript.snapshot.segments.at(-1).text, 'New acknowledged speech');
  });
}

test('successful handoff does not unblock overwriting a corrupt autosave recovery copy', async () => {
  const corrupt = savedTranscript();
  corrupt.snapshot.segments[0].text = 42;
  const c = transferController({ saved: corrupt, respond: async message => {
    if (message.type === 'CLAIM_HANDOFF') return { ok: true, handoffId: 'transfer-3', ...savedTranscript() };
    if (message.type === 'ACK_HANDOFF') return { ok: true };
  } });
  assert.equal(await c.h.restoreAutosave(), false);
  await c.h.reclaimAfterSwitch();
  assert.equal(c.h.handedOff, false);
  assert.equal(c.h.issues.has('switch'), false);
  assert.equal(c.h.issues.has('restore'), true);
  assert.equal(await c.h.flushAutosave(), false);
  assert.deepEqual(c.writes, []);
  assert.deepEqual(c.storage.liveTranscript, corrupt);
});

function startupController(options) {
  const c = transferController({ ...options, extraFunctions: ['init', 'replyIsStale'] });
  Object.assign(c.h, {
    handedOff: false, PROTOCOL_VERSION: 4,
    prefs: { onError() {}, load: async () => ({}) }, applyPrefs() {},
  });
  return c;
}

test('startup claim rejection displays the saved transcript without claiming capture or persistence', async () => {
  const saved = savedTranscript('Earlier saved transcript');
  const c = startupController({ saved, respond: async message => {
    if (message.type === 'GET_TARGET') return { ok: true, workerVersion: 4, tabId: 42 };
    if (message.type === 'CLAIM_HANDOFF') throw new Error('Temporary message channel failure');
  } });
  await c.h.init();
  assert.equal(c.el.transcript.textContent, 'Earlier saved transcript');
  assert.equal(c.el.copy.disabled, false);
  assert.equal(c.el.download.disabled, false);
  assert.equal(c.el.record.disabled, true);
  assert.equal(c.messages.some(m => m.type === 'GET_STREAM_ID'), false);
  assert.equal(c.starts(), 0);
  assert.equal(await c.h.flushAutosave(), false);
  assert.deepEqual(c.writes, []);
  assert.deepEqual(c.storage.liveTranscript, saved);
  const issue = c.h.issues.get('switch');
  assert.match(issue, /Temporary message channel failure/);
  assert.match(issue, /if another.*view.*open/i);
  assert.match(issue, /otherwise.*reopen.*toolbar/i);
  assert.doesNotMatch(issue, /Keep the original view open/);
});

test('startup ACK rejection keeps the validated handoff text rather than replacing it with older autosave', async () => {
  const c = startupController({ saved: savedTranscript('Older autosave'), respond: async message => {
    if (message.type === 'GET_TARGET') return { ok: true, workerVersion: 4, tabId: 42 };
    if (message.type === 'CLAIM_HANDOFF') return {
      ok: true, handoffId: 'unconfirmed-transfer', ...savedTranscript('Newer handoff text'),
    };
    if (message.type === 'ACK_HANDOFF') return { ok: false, error: 'ACK unavailable' };
  } });
  await c.h.init();
  assert.equal(c.el.transcript.textContent, 'Newer handoff text');
  assert.equal(c.el.record.disabled, true);
  assert.equal(c.messages.some(m => m.type === 'GET_STREAM_ID'), false);
  assert.equal(await c.h.flushAutosave(), false);
  assert.deepEqual(c.writes, []);
});

for (const micText of [null, { epoch: 2, segments: [] }]) {
  test(`restoring ${micText === null ? 'null' : 'empty'} microphone text removes stale survivor speech`, () => {
    const c = transferController();
    c.h.mic = new MicTranscriber();
    c.h.mic.store.restore(savedTranscript('Deleted microphone speech').snapshot);
    assert.equal(c.h.mic.hasText(), true);
    c.h.restoreStoredTranscript({ ...savedTranscript('Current meeting speech'), micText });
    assert.equal(c.h.mic.hasText(), false);
    assert.equal(c.h.transcriber.store.toText(), 'Current meeting speech');
  });
}

function sourceController(type, outcome) {
  const c = transferController({ extraFunctions: [
    'popOut', 'backToSidebar', 'releaseForTransfer', 'recoverTransfer', 'replyIsStale', 'setState',
  ], respond: async message => {
    if (message.type === 'GET_HOST_WINDOW') return { ok: true, windowId: 5, workerVersion: 4 };
    if (message.type === 'SWITCH_PENDING') return { ok: true, workerVersion: 4 };
    if (message.type === type) return outcome();
  } });
  Object.assign(c.h, {
    handedOff: false, PROTOCOL_VERSION: 4, activeStart: null,
    prefs: { get: () => ({ windowWidth: 460, windowHeight: 780 }) },
    switchLogReset: async () => {}, window: { close() {} },
  });
  c.h.restoreStoredTranscript(savedTranscript('Source transcript kept for download'));
  c.h.transcriber.running = true;
  c.invoke = () => type === 'OPEN_WINDOW'
    ? c.h.popOut() : c.h.backToSidebar(Promise.resolve({ ok: true }));
  return c;
}

for (const type of ['OPEN_WINDOW', 'BACK_TO_PANEL']) {
  test(`${type} lost positive reply leaves the source inert and its transcript available`, async () => {
    let accepted = false;
    const c = sourceController(type, () => {
      // The receiver accepted the real transfer, but the response channel died.
      accepted = true;
      throw new Error('Successful transfer reply lost');
    });
    await c.invoke();
    assert.equal(accepted, true);
    assert.equal(c.messages.some(m => m.type === 'GET_STREAM_ID'), false);
    assert.equal(c.starts(), 0);
    assert.equal(c.h.handedOff, true);
    assert.equal(c.el.record.disabled, true);
    assert.equal(c.el.download.disabled, false);
    assert.equal(c.el.transcript.textContent, 'Source transcript kept for download');
    assert.equal(await c.h.flushAutosave(), false);
    assert.equal(c.writes.some(w => w.liveTranscript), false);
    assert.match(c.h.issues.get('switch'), /Successful transfer reply lost/);
    assert.match(c.h.issues.get('switch'), /check.*other.*view/i);
    assert.match(c.h.issues.get('switch'), /reopen/i);
    assert.equal(c.el.dot.dataset.state, 'error');
    assert.equal(c.el.status.textContent, 'Recording paused in this view. The switch outcome could not be confirmed.');
  });

  test(`${type} unproven negative reply cannot resume the source`, async () => {
    const c = sourceController(type, () => ({ ok: false, error: 'Cancellation could not be persisted' }));
    await c.invoke();
    assert.equal(c.messages.some(m => m.type === 'GET_STREAM_ID'), false);
    assert.equal(c.el.record.disabled, true);
    assert.equal(await c.h.flushAutosave(), false);
  });

  test(`${type} definitive cancellation permits recovery of the source`, async () => {
    const c = sourceController(type, () => ({ ok: false, safeToResume: true, error: 'Transfer cancelled' }));
    await c.invoke();
    assert.equal(c.messages.filter(m => m.type === 'GET_STREAM_ID').length, 1);
    assert.equal(c.starts(), 1);
    assert.equal(c.h.handedOff, false);
    assert.equal(c.el.record.disabled, false);
    assert.equal(await c.h.flushAutosave(), true);
    assert.match(c.h.issues.get('switch'), /Transfer cancelled/);
  });
}

// A settled envelope from the outbound transfer is not the announced return.
test('pending return polls past a previous accepted envelope, then ACKs and resumes the new handoff', async () => {
  let claims = 0;
  const c = transferController({ respond: async message => {
    if (message.type === 'GET_SWITCH_PENDING') return { ok: true, pending: true };
    if (message.type === 'CLAIM_HANDOFF') {
      if (++claims === 1) return { ok: true, state: 'accepted', handoffId: null };
      return { ok: true, handoffId: 'new-return', resume: true, ...savedTranscript('Latest window speech') };
    }
    if (message.type === 'ACK_HANDOFF') return { ok: true };
  } });
  const reclaim = c.h.reclaimAfterSwitch();
  await new Promise(setImmediate);
  assert.equal(c.messages.some(m => m.type === 'GET_STREAM_ID'), false);
  await c.tick(120);
  await reclaim;
  assert.equal(claims, 2);
  assert.equal(c.messages.find(m => m.type === 'ACK_HANDOFF').handoffId, 'new-return');
  assert.equal(c.el.transcript.textContent, 'Latest window speech');
  assert.equal(c.starts(), 1);
  assert.equal(c.h.handedOff, false);
});

test('survivor focus before the new snapshot cannot steal capture from an existing popup', async () => {
  let staged = false;
  const c = transferController({ respond: async message => {
    if (message.type === 'GET_SWITCH_PENDING') return { ok: true, pending: staged };
    if (message.type === 'CLAIM_HANDOFF') return staged
      ? { ok: true, handoffId: 'new-return', resume: true, ...savedTranscript('Latest window speech') }
      : { ok: true, handoffId: null };
    if (message.type === 'ACK_HANDOFF') return { ok: true };
  } });
  c.storage.popoutWindowId = 2;
  c.el.record.disabled = true;
  await c.h.reclaimAfterSwitch({ viaFocus: true });
  assert.equal(c.messages.some(m => m.type === 'GET_STREAM_ID'), false);
  assert.equal(c.h.handedOff, true);
  assert.equal(c.el.record.disabled, true);
  staged = true;
  await c.h.reclaimAfterSwitch();
  assert.equal(c.h.handedOff, false);
  assert.equal(c.starts(), 1);
  assert.equal(c.el.transcript.textContent, 'Latest window speech');
});

test('an announced handoff that never arrives leaves startup read-only with saved text', async () => {
  const c = startupController({ saved: savedTranscript(), respond: async message => {
    if (message.type === 'GET_TARGET') return { ok: true, workerVersion: 4, tabId: 42 };
    if (message.type === 'GET_SWITCH_PENDING') return { ok: true, pending: true };
    if (message.type === 'CLAIM_HANDOFF') return { ok: true, handoffId: null };
  } });
  // A capture attempt is the defect, not a missing fixture dependency.
  c.h.refreshTarget = async () => {};
  c.h.previewModelState = () => {};
  const opening = c.h.init();
  await new Promise(setImmediate);
  await c.tick(20000);
  await opening;
  assert.equal(c.messages.some(m => m.type === 'GET_STREAM_ID'), false);
  assert.equal(c.el.record.disabled, true);
  assert.equal(c.el.transcript.textContent, 'Recovered meeting speech');
  assert.equal(await c.h.flushAutosave(), false);
});
