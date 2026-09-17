import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

// Real worker message handlers, storage transactions and ownership lock. Time and
// Chrome APIs are deterministic; no browser, ports or extension test hooks.
function worker({ failBeforeStage = false, failCancellation = false, loseStageReply = false } = {}) {
  const data = { targetTabId: 42 };
  const listeners = {};
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const noop = async () => {};
  let now = 1000, serial = 0;
  class Clock extends Date { static now() { return now; } }
  const chrome = {
    storage: {
      session: {
        async get(key) { return { [key]: structuredClone(data[key]) }; },
        async set(values) {
          if (failCancellation && values.handoffSnapshot?.state === 'cancelled') {
            throw new Error('Cancellation storage unavailable');
          }
          Object.assign(data, structuredClone(values));
          if (loseStageReply && values.handoffSnapshot?.state === 'pending') {
            throw new Error('Stage write response lost');
          }
        },
        async remove(key) { delete data[key]; },
      },
      local: { get: async () => ({}), set: noop },
    },
    runtime: {
      onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'),
      getURL: path => `chrome-extension://tabscribe/${path}`,
      getManifest: () => ({ action: { default_title: 'TabScribe' } }), sendMessage: noop,
    },
    sidePanel: { setPanelBehavior: noop, open: noop, close: noop, async setOptions() {
      if (failBeforeStage) throw new Error('Sidebar unavailable before transfer');
    } },
    action: { onClicked: event('clicked'), setBadgeText: noop, setTitle: noop, setBadgeBackgroundColor: noop },
    tabs: { query: async () => [{ id: 42 }], create: noop, update: noop },
    tabCapture: { getMediaStreamId: async () => 'unused' },
    windows: { onRemoved: event('removed'), getLastFocused: async () => ({ id: 1 }),
      update: noop, remove: noop, async create() {
        if (failBeforeStage) throw new Error('Popup unavailable before transfer');
        return { id: 2, tabs: [{ id: 22 }] };
      } },
  };
  const context = vm.createContext({
    chrome, Date: Clock, crypto: { randomUUID: () => `transfer-${++serial}` },
    setTimeout: (fn, ms) => setImmediate(() => { now += ms; fn(); }),
    console: { warn() {}, error() {} },
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  return {
    data, context,
    request(message, sender = { documentId: 'receiver' }) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`No reply to ${message.type}`)), 1000);
        listeners.message(message, sender, reply => { clearTimeout(timeout); resolve(structuredClone(reply)); });
      });
    },
  };
}

test('missing handoff cannot be treated as a proven cancellation', async () => {
  const w = worker();
  await assert.rejects(w.context.cancelHandoff('missing-transfer'), /could not be confirmed/i);
});

for (const type of ['OPEN_WINDOW', 'BACK_TO_PANEL']) {
  test(`${type} failure before staging explicitly permits source recovery`, async () => {
    const w = worker({ failBeforeStage: true });
    const reply = await w.request({ type });
    assert.equal(reply.ok, false);
    assert.equal(reply.safeToResume, true);
    assert.equal(w.data.handoffSnapshot, undefined);
  });

  test(`${type} durable cancellation explicitly permits source recovery`, async () => {
    const w = worker();
    const reply = await w.request({ type });
    assert.equal(reply.ok, false);
    assert.equal(w.data.handoffSnapshot.state, 'cancelled');
    assert.equal(reply.safeToResume, true);
    const lateAck = await w.request({ type: 'ACK_HANDOFF', handoffId: w.data.handoffSnapshot.id });
    assert.equal(lateAck.ok, false);
  });

  test(`${type} failed cancellation does not permit source recovery`, async () => {
    const w = worker({ failCancellation: true });
    const reply = await w.request({ type });
    assert.equal(reply.ok, false);
    assert.equal(reply.safeToResume, false);
    assert.equal(w.data.handoffSnapshot.state, 'pending');
  });

  test(`${type} ambiguous stage write does not permit source recovery`, async () => {
    const w = worker({ loseStageReply: true });
    const reply = await w.request({ type });
    assert.equal(reply.ok, false);
    assert.equal(reply.safeToResume, false);
    assert.equal(w.data.handoffSnapshot.state, 'pending');
  });
}
