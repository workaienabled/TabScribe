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

function transferController({ respond, saved, extraFunctions = [], getUserMedia } = {}) {
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
    'setState', 'armCapture', 'armCaptureAttempt', 'teardown', 'workerRequest', 'setRecording',
    ...extraFunctions,
  ], {
    Transcriber, TranscriptStore, MicTranscriber, el, Date: Clock,
    IS_WINDOW: false, SWITCH_HANDOFF_WAIT_MS: 20000, workerStale: false,
    receiverId: 'c72a4f31-f093-4814-b65c-9a5800303a64',
    handedOff: true, switching: false, reclaiming: false, reclaimQueued: false, armed: false,
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
    navigator: { mediaDevices: { getUserMedia: getUserMedia || (async () => stream) } },
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
    h, el, messages, writes, storage, timers, stream, starts: () => starts,
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
    'popOut', 'backToSidebar', 'releaseForTransfer', 'recoverTransfer', 'replyIsStale',
    'recordingInProgress', 'explainReadOnlyView',
  ], respond: async message => {
    if (message.type === 'GET_HOST_WINDOW') return { ok: true, windowId: 5, workerVersion: 4 };
    if (message.type === 'SWITCH_PENDING') return { ok: true, workerVersion: 4 };
    if (message.type === type) return outcome();
  } });
  Object.assign(c.h, {
    handedOff: false, PROTOCOL_VERSION: 4, activeStart: null, stopInProgress: false,
    modelDownload: null,
    prefs: { get: () => ({ windowWidth: 460, windowHeight: 780 }) },
    switchLogReset: async () => {}, window: { close() {} }, hideModelPanel() {},
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

// The user closed the pop-out window by hand. No hand-off was staged, but the
// window's last autosave — minutes of speech this survivor never heard — is the
// recovery copy. Taking the tab back must adopt that copy exactly as a fresh
// panel would, and must not autosave this document's pre-pop-out text over it.
for (const viaFocus of [false, true]) {
  test(`a survivor reclaiming a closed window's tab adopts the window's newer transcript (viaFocus=${viaFocus})`, async () => {
    const c = transferController({
      saved: savedTranscript('Twenty minutes of speech in the window'),
      respond: async message => {
        if (message.type === 'CLAIM_HANDOFF') return { ok: true, handoffId: null };
      },
    });
    // This document stopped hearing at the pop-out.
    c.h.ensureTranscriber().store.restore(savedTranscript('Speech before the pop-out').snapshot);
    c.h.render(c.h.transcriber.store);
    c.h.autosaveTimer = null; // a survivor has no pending write: it stopped long ago
    // The worker's windows.onRemoved already forgot the window.
    await c.h.reclaimAfterSwitch({ viaFocus });
    assert.equal(c.h.handedOff, false, 'the survivor owns the tab again');
    assert.equal(c.el.record.disabled, false);
    assert.equal(c.h.transcriber.store.toText(), 'Twenty minutes of speech in the window',
      'the window\'s transcript must be on screen, not the pre-pop-out copy');
    assert.equal(c.el.transcript.textContent, 'Twenty minutes of speech in the window');
    assert.equal(c.h.autosaveTimer, null, 'adopting the copy must not schedule a write of it');
    assert.equal(c.storage.liveTranscript.snapshot.segments[0].text, 'Twenty minutes of speech in the window',
      'the recovery copy survives the reclaim');
    assert.match(c.el.status.textContent, /restored/i);
  });
}

// The window is gone, so nobody else can own the tab. Even when it cannot be
// captured yet (the toolbar grant lapsed), the survivor must own the restored
// transcript: Record usable, Window a real transfer of the restored text —
// not an inert view whose only control stages an empty hand-off.
test('a survivor whose closed window\'s tab cannot be captured yet still takes ownership', async () => {
  const c = transferController({
    saved: savedTranscript('Speech recorded in the window'),
    respond: async message => {
      if (message.type === 'CLAIM_HANDOFF') return { ok: true, handoffId: null };
      if (message.type === 'GET_STREAM_ID') return {
        ok: false, needsInvocation: true,
        error: 'Extension has not been invoked for the current page (see activeTab permission).',
      };
    },
  });
  await c.h.reclaimAfterSwitch({ viaFocus: true });
  assert.equal(c.h.transcriber.store.toText(), 'Speech recorded in the window');
  assert.equal(c.h.handedOff, false, 'the window is gone; this document owns the transcript');
  assert.equal(c.el.record.disabled, false, '"press Record" must be actionable');
  assert.equal(c.el.popout.disabled, false);
  assert.match(c.el.status.textContent, /Earlier transcript restored.*toolbar icon/);
  assert.doesNotMatch(c.el.status.textContent, /activeTab permission/);
  assert.deepEqual(c.writes, [], 'adopting the copy is not a write');
  assert.equal(c.storage.liveTranscript.snapshot.segments[0].text, 'Speech recorded in the window');
});

// The window's capture may still be releasing when the survivor reacts, exactly
// as on the return path: getUserMedia fails with "active stream" until the
// other document lets go. One attempt would leave the survivor inert for good.
test('a survivor retries capture while the closed window is still releasing the tab', async () => {
  let attempts = 0;
  const c = transferController({
    saved: savedTranscript('Speech recorded in the window'),
    respond: async message => {
      if (message.type === 'CLAIM_HANDOFF') return { ok: true, handoffId: null };
    },
    getUserMedia: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('Cannot capture a tab with an active stream.');
      return c.stream;
    },
  });
  const reclaim = c.h.reclaimAfterSwitch();
  // Each failed attempt arms its 400 ms retry timer only after its rejection
  // lands: let the promise chain reach the timer before advancing the clock.
  for (let i = 0; i < 12; i += 1) {
    for (let j = 0; j < 8; j += 1) await new Promise(setImmediate);
    await c.tick(400);
  }
  await reclaim;
  assert.equal(attempts, 3);
  assert.equal(c.h.handedOff, false);
  assert.equal(c.h.armed, true);
  assert.match(c.el.status.textContent, /Earlier transcript restored/);
});

// A second trigger arriving while one reclaim is in flight (the worker's
// window-closed broadcast racing the focus fallback) must not be lost: the
// in-flight one may have read the window as still present and given up.
test('a reclaim requested during an in-flight reclaim runs once it finishes', async () => {
  let claims = 0;
  const c = transferController({
    saved: savedTranscript('Speech recorded in the window'),
    respond: async message => {
      if (message.type === 'CLAIM_HANDOFF') {
        claims += 1;
        if (claims === 1) {
          // Mid-flight: the worker's broadcast arrives. The record still says
          // the window exists, so this first reclaim will give up.
          void c.h.reclaimAfterSwitch();
        }
        return { ok: true, handoffId: null };
      }
      if (message.type === 'GET_SWITCH_PENDING' && claims === 1) {
        // The worker clears the record right after the first reclaim read it.
        delete c.storage.popoutWindowId;
      }
    },
  });
  c.storage.popoutWindowId = 2;
  await c.h.reclaimAfterSwitch({ viaFocus: true });
  for (let i = 0; i < 6; i += 1) await new Promise(setImmediate);
  assert.equal(claims, 2, 'the queued reclaim ran after the first finished');
  assert.equal(c.h.handedOff, false);
  assert.equal(c.h.armed, true);
  assert.equal(c.h.transcriber.store.toText(), 'Speech recorded in the window');
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
