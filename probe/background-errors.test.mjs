import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const clone = (value) => structuredClone(value);
const settle = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

// Run the real worker; only Chrome's external API boundary is faked.
function worker({ session = {}, overrides = {} } = {}) {
  const data = clone(session);
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const calls = [];
  const listeners = {};
  const event = (name) => ({
    addListener(fn) { (listeners[name] ||= []).push(fn); },
  });
  const api = (name, impl = async () => {}) => (...args) => {
    calls.push({ name, args: clone(args) });
    return (overrides[name] || impl)(...args);
  };
  const chrome = {
    storage: {
      session: {
        get: api('session.get', async (keys) => Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys])
            .filter((key) => key in data).map((key) => [key, clone(data[key])]))),
        set: api('session.set', async (values) => { Object.assign(data, clone(values)); }),
        remove: api('session.remove', async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        }),
      },
      local: { get: api('local.get', async () => ({})), set: api('local.set') },
    },
    runtime: {
      id: 'tabscribe',
      onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'),
      getURL: (path) => `chrome-extension://tabscribe/${path}`,
      getManifest: () => ({ action: { default_title: 'TabScribe: transcribe this tab\'s audio' } }),
      sendMessage: api('runtime.sendMessage'),
    },
    sidePanel: {
      setPanelBehavior: api('sidePanel.setPanelBehavior'), open: api('sidePanel.open'),
      close: api('sidePanel.close'), setOptions: api('sidePanel.setOptions'),
    },
    action: {
      onClicked: event('clicked'), setBadgeText: api('action.setBadgeText'),
      setTitle: api('action.setTitle'), setBadgeBackgroundColor: api('action.setBadgeBackgroundColor'),
    },
    tabs: {
      query: api('tabs.query', async () => [{ id: 7, title: 'Meeting' }]),
      create: api('tabs.create', async () => ({ id: 8 })),
      update: api('tabs.update', async () => ({ id: 22 })),
    },
    tabCapture: { getMediaStreamId: api('tabCapture.getMediaStreamId', async () => 'stream-7') },
    windows: {
      onRemoved: event('removed'), getLastFocused: api('windows.getLastFocused', async () => ({ id: 1 })),
      update: api('windows.update', async () => ({ id: 2 })),
      create: api('windows.create', async () => ({ id: 2, tabs: [{ id: 22 }] })), remove: api('windows.remove'),
    },
  };
  const warnings = [];
  const context = vm.createContext({
    chrome, Date: Clock, crypto: { randomUUID },
    setTimeout: (fn, ms) => setImmediate(() => { now += ms; fn(); }),
    console: { error: (...args) => warnings.push(args), warn: (...args) => warnings.push(args) },
    navigator: { permissions: { query: async () => ({ state: 'prompt' }) } },
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  return {
    data, calls, listeners, warnings,
    advance(ms) { now += ms; },
    async emit(name, ...args) {
      for (const fn of listeners[name] || []) await fn(...args);
      await settle();
    },
    request(message, sender = {}) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`No reply to ${message?.type}`)), 1000);
        const handled = listeners.message[0](message, sender, (reply) => {
          clearTimeout(timeout);
          resolve(clone(reply));
        });
        if (handled !== true) { clearTimeout(timeout); resolve(undefined); }
      });
    },
  };
}

test('a real sidebar without Chrome document/tab IDs can claim and ACK with its own nonce', async () => {
  const w = worker({ session: { handoffSnapshot: { snapshot: { epoch: 0, segments: [] }, resume: true } } });
  const sender = { id: 'tabscribe', url: 'chrome-extension://tabscribe/sidepanel.html' };
  const receiverId = randomUUID();
  const claim = await w.request({ type: 'CLAIM_HANDOFF', receiverId }, sender);
  assert.equal(claim.ok, true, claim.error);
  assert.ok(claim.handoffId);
  const wrong = await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId, receiverId: randomUUID() }, sender);
  assert.equal(wrong.ok, false);
  const ack = await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId, receiverId }, sender);
  assert.equal(ack.ok, true, ack.error);
  assert.equal(w.data.handoffSnapshot.state, 'accepted');
});

for (const sender of [
  { id: 'other', url: 'chrome-extension://tabscribe/sidepanel.html' },
  { id: 'tabscribe', url: 'https://example.com/sidepanel.html' },
  { id: 'tabscribe', url: 'chrome-extension://tabscribe/mic-permission.html' },
]) test('a receiver nonce is not a substitute for a trusted panel sender: ' + sender.url, async () => {
  const w = worker({ session: { handoffSnapshot: { snapshot: { epoch: 0, segments: [] } } } });
  const result = await w.request({ type: 'CLAIM_HANDOFF', receiverId: randomUUID() }, sender);
  assert.equal(result.ok, false);
  assert.notEqual(w.data.handoffSnapshot.state, 'accepted');
});

function assertVisibleFailure(w, reason) {
  assert.ok(w.calls.some((c) => c.name === 'action.setBadgeText' && c.args[0].text),
    'a closed panel cannot show the error; the toolbar must signal it');
  assert.ok(w.calls.some((c) => c.name === 'action.setTitle' && c.args[0].title.includes(reason)),
    'the toolbar tooltip must retain the actionable failure');
}

for (const operation of ['sidePanel.setPanelBehavior', 'sidePanel.open', 'session.set']) {
  test(`${operation} rejection is visible when the panel cannot report it`, async () => {
    const reason = `${operation} failed`;
    const w = worker({ overrides: { [operation]: async () => { throw new Error(reason); } } });
    await settle();
    if (operation !== 'sidePanel.setPanelBehavior') await w.emit('clicked', { id: 7, title: 'Meeting' });
    assertVisibleFailure(w, reason);
  });
}

test('a synchronous sidePanel.open failure is contained and reported', async () => {
  const w = worker({ overrides: { 'sidePanel.open': () => { throw new Error('open unavailable'); } } });
  await assert.doesNotReject(w.emit('clicked', { id: 7 }));
  assertVisibleFailure(w, 'open unavailable');
});

test('window removal storage rejection cannot escape its lifecycle listener', async () => {
  const w = worker({ overrides: { 'session.get': async () => { throw new Error('storage unavailable'); } } });
  await assert.doesNotReject(w.emit('removed', 2));
  assertVisibleFailure(w, 'storage unavailable');
});

test('null target means resolve the stored target, never capture a null tab', async () => {
  const w = worker({ session: { targetTabId: 7, targetTabTitle: 'Meeting' } });
  const reply = await w.request({ type: 'GET_STREAM_ID', tabId: null });
  assert.equal(reply.ok, true);
  assert.equal(reply.tabId, 7);
  assert.equal(reply.title, 'Meeting');
  assert.deepEqual(w.calls.find((c) => c.name === 'tabCapture.getMediaStreamId').args,
    [{ targetTabId: 7 }]);
});

for (const tabId of [-1, 1.5, '7', {}, 2147483648]) {
  test(`invalid explicit tab ID ${JSON.stringify(tabId)} is a versioned failure`, async () => {
    const w = worker();
    const reply = await w.request({ type: 'GET_STREAM_ID', tabId });
    assert.equal(reply.ok, false);
    assert.equal(reply.workerVersion, 4);
    assert.match(reply.error, /tab/i);
    assert.ok(!w.calls.some((c) => c.name === 'tabCapture.getMediaStreamId'));
  });
}

test('an invalid stored target falls back to a valid active tab', async () => {
  const w = worker({ session: { targetTabId: null, targetTabTitle: 'Old tab' } });
  const reply = await w.request({ type: 'GET_TARGET' });
  assert.equal(reply.ok, true);
  assert.equal(reply.tabId, 7);
  assert.equal(reply.title, 'Meeting');
});

for (const type of ['GET_TARGET', 'GET_STREAM_ID', 'GET_HOST_WINDOW']) {
  test(`${type} cannot claim success without a valid target`, async () => {
    const w = worker({ overrides: {
      'tabs.query': async () => [], 'windows.getLastFocused': async () => ({ id: -1 }),
    } });
    const reply = await w.request({ type });
    assert.equal(reply.ok, false);
    assert.equal(reply.workerVersion, 4);
    assert.ok(reply.error);
  });
}

test('invalid toolbar tabs fail visibly without calling sidePanel.open', async () => {
  const w = worker();
  await w.emit('clicked', { id: null });
  assert.ok(!w.calls.some((c) => c.name === 'sidePanel.open'));
  assertVisibleFailure(w, 'tab');
});

test('unknown messages are not claimed or answered by the worker', async () => {
  const w = worker();
  let replies = 0;
  const handled = w.listeners.message[0]({ type: 'SWITCHED_BACK' }, {}, () => { replies += 1; });
  assert.equal(handled, false);
  await settle();
  assert.equal(replies, 0);
});

test('a disconnected response channel cannot cause an unhandled async rejection', async () => {
  const w = worker();
  assert.equal(w.listeners.message[0]({ type: 'GET_TARGET' }, {}, () => {
    throw new Error('response channel closed');
  }), true);
  await settle();
  assert.ok(w.warnings.some((args) => args.some((value) => String(value).includes('response channel closed'))));
});

const transfer = {
  snapshot: { epoch: 1, segments: [{ key: 'a', text: 'Latest meeting', startedAt: 2 }] },
  resume: true,
  micText: { epoch: 1, segments: [{ key: 'm', text: 'My words', startedAt: 3 }] },
  savedText: 'Previously downloaded text',
};
const receiver = { documentId: 'receiver-document', tab: { id: 22 } };

test('claim upgrades legacy snapshots without deleting them; owner ACK makes recovery durable', async () => {
  const w = worker({ session: { handoffSnapshot: transfer, switchPending: { at: Date.now() } } });
  const claim = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
  assert.equal(claim.ok, true);
  assert.equal(claim.workerVersion, 4);
  assert.ok(claim.handoffId);
  assert.deepEqual(claim.micText, transfer.micText);
  assert.equal(claim.savedText, transfer.savedText);
  assert.deepEqual(w.data.handoffSnapshot.snapshot, transfer.snapshot, 'claim must retain the only snapshot');
  assert.equal(w.data.handoffSnapshot.state, 'pending');

  const wrongOwner = await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, { documentId: 'other' });
  assert.equal(wrongOwner.ok, false);
  assert.equal(w.data.handoffSnapshot.state, 'pending');
  const ack = await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver);
  assert.equal(ack.ok, true);
  assert.equal(w.data.handoffSnapshot.state, 'accepted');
  assert.deepEqual(w.data.liveTranscript.snapshot, transfer.snapshot);
  assert.deepEqual(w.data.liveTranscript.micText, transfer.micText);
  assert.equal(w.data.liveTranscript.savedText, transfer.savedText);
  assert.equal(w.data.switchPending, undefined);
  assert.ok(w.calls.some((c) => c.name === 'session.set'
    && c.args[0].handoffSnapshot?.state === 'accepted' && c.args[0].liveTranscript),
  'acceptance and recovery copy must be one storage write');
  const next = await w.request({ type: 'CLAIM_HANDOFF' }, { documentId: 'reloaded' });
  assert.equal(next.snapshot, null, 'reload must not resurrect an accepted handoff');
});

test('concurrent documents cannot both claim a pending transfer', async () => {
  const w = worker({ session: { handoffSnapshot: transfer } });
  const replies = await Promise.all([
    w.request({ type: 'CLAIM_HANDOFF' }, receiver),
    w.request({ type: 'CLAIM_HANDOFF' }, { documentId: 'other' }),
  ]);
  assert.equal(replies.filter((reply) => reply.snapshot).length, 1);
  assert.deepEqual(w.data.handoffSnapshot.snapshot, transfer.snapshot);
});

test('failed ACK storage write retains the pending snapshot and never claims acceptance', async () => {
  const w = worker({ session: { handoffSnapshot: transfer }, overrides: {
    'session.set': async (values) => {
      if (values.liveTranscript) throw new Error('recovery write failed');
      Object.assign(w.data, clone(values));
    },
  } });
  const claim = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
  const ack = await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver);
  assert.equal(ack.ok, false);
  assert.match(ack.error, /recovery write failed/);
  assert.equal(w.data.handoffSnapshot.state, 'pending');
  assert.deepEqual(w.data.handoffSnapshot.snapshot, transfer.snapshot);
});

test('pending flag removal failure cannot undo a durable ACK', async () => {
  const w = worker({ session: { handoffSnapshot: transfer, switchPending: { at: Date.now() } }, overrides: {
    'session.remove': async () => { throw new Error('remove unavailable'); },
  } });
  const claim = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
  assert.equal(claim.ok, true);
  const ack = await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver);
  assert.equal(ack.ok, true);
  assert.equal(w.data.handoffSnapshot.state, 'accepted');
  assert.deepEqual(w.data.liveTranscript.snapshot, transfer.snapshot);
});

test('ACK after its transfer deadline is rejected without deleting the snapshot', async () => {
  const w = worker({ session: { handoffSnapshot: transfer } });
  const claim = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
  w.advance(16000);
  const ack = await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver);
  assert.equal(ack.ok, false);
  assert.notEqual(w.data.handoffSnapshot.state, 'accepted');
  assert.deepEqual(w.data.handoffSnapshot.snapshot, transfer.snapshot);
});

test('focusing an existing window does not replace its pending transfer', async () => {
  const w = worker({ session: { popoutWindowId: 2, handoffSnapshot: transfer } });
  const reply = await w.request({ type: 'OPEN_WINDOW', snapshot: { segments: [{ text: 'Old panel' }] } });
  assert.equal(reply.ok, true);
  assert.equal(reply.reused, true);
  assert.deepEqual(w.data.handoffSnapshot, transfer);
  assert.ok(!w.calls.some((c) => c.name === 'windows.create'));
});

test('focus failure does not assume a live window disappeared and start another capture', async () => {
  const w = worker({ session: { popoutWindowId: 2, handoffSnapshot: transfer }, overrides: {
    'windows.update': async () => { throw new Error('focus unavailable'); },
  } });
  const reply = await w.request({ type: 'OPEN_WINDOW', ...transfer });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /focus unavailable/);
  assert.ok(!w.calls.some((c) => c.name === 'windows.create'));
  assert.deepEqual(w.data.handoffSnapshot, transfer);
});

test('window creation failure retains the previous handoff unchanged', async () => {
  const previous = { ...transfer, id: 'accepted-old', state: 'accepted' };
  const w = worker({ session: { handoffSnapshot: previous }, overrides: {
    'windows.create': async () => { throw new Error('create failed'); },
  } });
  const reply = await w.request({ type: 'OPEN_WINDOW', snapshot: { segments: [] } });
  assert.equal(reply.ok, false);
  assert.deepEqual(w.data.handoffSnapshot, previous);
  assert.ok(!w.calls.some((c) => c.name === 'sidePanel.close'));
});

test('window metadata write failure closes only a blank popup and retains previous data', async () => {
  const previous = { ...transfer, id: 'accepted-old', state: 'accepted' };
  const w = worker({ session: { handoffSnapshot: previous }, overrides: {
    'session.set': async (values) => {
      if ('popoutWindowId' in values) throw new Error('window metadata failed');
      Object.assign(w.data, clone(values));
    },
  } });
  const reply = await w.request({ type: 'OPEN_WINDOW', ...transfer, sourceWindowId: 1 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /window metadata failed/);
  assert.deepEqual(w.data.handoffSnapshot, previous);
  assert.equal(w.calls.find((c) => c.name === 'windows.create').args[0].url, 'about:blank');
  assert.ok(w.calls.some((c) => c.name === 'windows.remove' && c.args[0] === 2));
  assert.ok(!w.calls.some((c) => c.name === 'tabs.update' || c.name === 'sidePanel.close'));
});

for (const type of ['OPEN_WINDOW', 'BACK_TO_PANEL']) {
  test(`${type} waits for receiver ACK before reporting success or closing the source`, async () => {
    const w = worker({ session: { targetTabId: 7, popoutWindowId: type === 'BACK_TO_PANEL' ? 2 : undefined } });
    let completed = false;
    const result = w.request({ type, ...transfer, sourceWindowId: 1 }).then((reply) => {
      completed = true;
      return reply;
    });
    await settle();
    assert.equal(completed, false, 'creating/opening a view is not successful delivery');
    assert.ok(!w.calls.some((c) => c.name === 'sidePanel.close'));
    const claim = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
    assert.deepEqual(claim.snapshot, transfer.snapshot);
    assert.deepEqual(claim.micText, transfer.micText);
    assert.equal(claim.savedText, transfer.savedText);
    const ack = await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver);
    assert.equal(ack.ok, true);
    const reply = await result;
    assert.equal(reply.ok, true);
    if (type === 'OPEN_WINDOW') {
      assert.equal(reply.panelClosed, true);
      const accepted = w.calls.findIndex((c) => c.name === 'session.set' && c.args[0].handoffSnapshot?.state === 'accepted');
      assert.ok(w.calls.findIndex((c) => c.name === 'sidePanel.close') > accepted);
    } else {
      assert.ok(w.calls.some((c) => c.name === 'runtime.sendMessage' && c.args[0].type === 'SWITCHED_BACK'));
      assert.equal(w.data.popoutWindowId, undefined);
    }
  });

  test(`${type} timeout preserves data and rejects a receiver ACK that arrives late`, async () => {
    const w = worker({ session: { targetTabId: 7 } });
    const result = w.request({ type, ...transfer, sourceWindowId: 1 });
    await settle();
    const claim = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
    const reply = await result;
    assert.equal(reply.ok, false);
    assert.match(reply.error, /timed out|expired/i);
    assert.equal(w.data.handoffSnapshot.state, 'cancelled');
    assert.deepEqual(w.data.handoffSnapshot.snapshot, transfer.snapshot);
    assert.ok(!w.calls.some((c) => c.name === 'sidePanel.close'));
    const ack = await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver);
    assert.equal(ack.ok, false);
    assert.equal((await w.request({ type: 'CLAIM_HANDOFF' }, receiver)).snapshot, null);
  });
}

test('failed cancellation storage cannot let the receiver reclaim or accept the failed transfer', async () => {
  let claim;
  const w = worker({ overrides: {
    'tabs.update': async () => {
      claim = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
      throw new Error('receiver navigation failed');
    },
    'session.set': async (values) => {
      if (values.handoffSnapshot?.state === 'cancelled') throw new Error('cancellation storage failed');
      Object.assign(w.data, clone(values));
    },
    'windows.remove': async () => { throw new Error('window cleanup failed'); },
  } });
  const result = await w.request({ type: 'OPEN_WINDOW', ...transfer });
  assert.equal(result.ok, false);
  assert.deepEqual(w.data.handoffSnapshot.snapshot, transfer.snapshot);
  assert.equal((await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver)).ok, false);
  assert.equal((await w.request({ type: 'CLAIM_HANDOFF' }, receiver)).snapshot, null);
});

for (const operation of ['session.get', 'session.set']) {
  test(`claim ${operation} failure returns an error and preserves the original envelope`, async () => {
    const w = worker({ session: { handoffSnapshot: transfer }, overrides: {
      [operation]: async () => { throw new Error(`${operation} unavailable`); },
    } });
    const result = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
    assert.equal(result.ok, false);
    assert.match(result.error, /unavailable/);
    assert.deepEqual(w.data.handoffSnapshot, transfer);
  });
}

test('a tab identity is accepted only when no document identity exists', async () => {
  const w = worker({ session: { handoffSnapshot: transfer } });
  const claim = await w.request({ type: 'CLAIM_HANDOFF' }, { tab: { id: 22 } });
  assert.ok(claim.handoffId);
  assert.equal((await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, { tab: { id: 23 } })).ok, false);
  assert.equal((await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, { tab: { id: 22 } })).ok, true);
});

test('duplicate ACK never replaces newer autosaved speech with the old handoff', async () => {
  const w = worker({ session: { handoffSnapshot: transfer } });
  const claim = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
  assert.equal((await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver)).ok, true);
  const current = { snapshot: { segments: [{ text: 'More recent speech' }] }, micText: null, savedText: '', at: 1 };
  w.data.liveTranscript = clone(current);
  assert.equal((await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver)).ok, true);
  assert.deepEqual(w.data.liveTranscript, current);
});

test('an empty idle transcript can still be claimed and acknowledged', async () => {
  const w = worker();
  const pending = w.request({ type: 'OPEN_WINDOW', snapshot: null, resume: false });
  await settle();
  const claim = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
  assert.deepEqual(claim.snapshot.segments, []);
  assert.equal(claim.resume, false);
  assert.equal((await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver)).ok, true);
  assert.equal((await pending).ok, true);
});

test('simultaneous pop-out requests cannot create two capture receivers', async () => {
  const w = worker();
  const first = w.request({ type: 'OPEN_WINDOW', ...transfer });
  const second = await w.request({ type: 'OPEN_WINDOW', ...transfer });
  assert.equal(second.ok, false);
  await settle();
  const claim = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
  assert.equal((await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver)).ok, true);
  assert.equal((await first).ok, true);
  assert.equal(w.calls.filter((c) => c.name === 'windows.create').length, 1);
});

test('toolbar status APIs failing do not create an unhandled error loop', async () => {
  const w = worker({ overrides: {
    'sidePanel.open': async () => { throw new Error('open failed'); },
    'action.setBadgeText': async () => { throw new Error('badge failed'); },
    'action.setTitle': async () => { throw new Error('title failed'); },
  } });
  await assert.doesNotReject(w.emit('clicked', { id: 7 }));
  assert.ok(w.warnings.length > 0);
});

test('window removal never sends an invalid stored tab to sidePanel.setOptions', async () => {
  const w = worker({ session: { popoutWindowId: 2, targetTabId: null } });
  await w.emit('removed', 2);
  assert.ok(!w.calls.some((c) => c.name === 'sidePanel.setOptions'));
});

for (const type of ['OPEN_WINDOW', 'BACK_TO_PANEL']) {
  test(`${type} remains successful if bookkeeping APIs fail after durable acceptance`, async () => {
    let accepted = false;
    const w = worker({ session: { targetTabId: 7 }, overrides: {
      'session.get': async (keys) => {
        if (accepted) throw new Error('storage reads stopped');
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter((key) => key in w.data).map((key) => [key, clone(w.data[key])]));
      },
      'session.set': async (values) => {
        Object.assign(w.data, clone(values));
        if (values.handoffSnapshot?.state === 'accepted') accepted = true;
      },
      'session.remove': async () => { throw new Error('cleanup unavailable'); },
      'sidePanel.close': async () => { throw new Error('close unavailable'); },
    } });
    const pending = w.request({ type, ...transfer, sourceWindowId: 1 });
    await settle();
    const claim = await w.request({ type: 'CLAIM_HANDOFF' }, receiver);
    assert.equal((await w.request({ type: 'ACK_HANDOFF', handoffId: claim.handoffId }, receiver)).ok, true);
    assert.equal((await pending).ok, true, 'the source must not reacquire accepted capture');
    assert.deepEqual(w.data.liveTranscript.snapshot, transfer.snapshot);
    assert.ok(!w.calls.some((c) => c.name === 'windows.remove'));
  });
}
