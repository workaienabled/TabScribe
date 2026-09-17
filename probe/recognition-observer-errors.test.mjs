import test from 'node:test';
import assert from 'node:assert/strict';
import { Transcriber } from '../extension/transcriber.js';

const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
function harness(t, observers) {
  const instances = [], warnings = [], events = [];
  class Recognition {
    constructor() { instances.push(this); }
    start() { if (Recognition.fail) throw new Error('browser start failed'); }
    stop() {} abort() { this.aborted = true; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { SpeechRecognition: Recognition } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'self', previous) : delete globalThis.self);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const transcriber = new Transcriber({ onStatus: (status, detail) => events.push({ status, detail }), ...observers });
  t.after(() => transcriber.stop({ flushMs: 0 }));
  transcriber.start({ readyState: 'live' });
  return { instances, warnings, events, transcriber, Recognition };
}

test('throwing status observer cannot prevent bounded retries and terminal cleanup', t => {
  const h = harness(t, { onStatus() { throw new Error('private transcript must not enter logs'); } });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rec = h.transcriber.recognition;
    assert.ok(rec);
    assert.doesNotThrow(() => rec.onend());
    assert.equal(rec.onend, null);
    assert.equal(h.transcriber.startTimer, null);
    t.mock.timers.tick(2500);
  }
  assert.equal(h.instances.length, 4);
  assert.equal(h.transcriber.recognition, null);
  assert.equal(h.transcriber.retryTimer, null);
  assert.equal(h.warnings.length, 4);
  assert.ok(h.warnings.every(args => JSON.stringify(args) === JSON.stringify(['TabScribe recognition observer failed:', 'onStatus'])));
});

for (const path of ['timeout', 'restart']) {
  test(`throwing error observer cannot swallow terminal ${path} status`, t => {
    const h = harness(t, { onError() { throw new Error('private data'); } });
    if (path === 'restart') {
      h.instances[0].onstart(); h.Recognition.fail = true; h.instances[0].onend();
    }
    assert.doesNotThrow(() => t.mock.timers.tick(15000));
    assert.equal(h.events.at(-1).status, 'stopped');
    assert.equal(h.events.at(-1).detail.error, path === 'timeout' ? 'start-timeout' : 'restart-failed');
    assert.equal(h.transcriber.recognition, null);
    assert.equal(h.transcriber.retryTimer, null);
    assert.equal(h.transcriber.startTimer, null);
    assert.deepEqual(h.warnings, [['TabScribe recognition observer failed:', 'onError']]);
  });
}

test('throwing update observer cannot reject Stop or discard captured text', async t => {
  const h = harness(t, { onUpdate() { throw new Error('private data'); } });
  const rec = h.instances[0];
  assert.doesNotThrow(() => rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'retained words' }], { isFinal: true })] }));
  await assert.doesNotReject(h.transcriber.stop({ flushMs: 0 }));
  assert.doesNotThrow(() => rec.onend());
  assert.equal(h.transcriber.store.toText(), 'retained words');
  assert.equal(h.transcriber.recognition, null);
  assert.equal(h.transcriber.startTimer, null);
  assert.ok(h.warnings.every(args => JSON.stringify(args) === JSON.stringify(['TabScribe recognition observer failed:', 'onUpdate'])));
});

for (const observer of ['onStatus', 'onError', 'onUpdate']) {
  test(`rejected ${observer} observer is contained and logs only its code`, async t => {
    const h = harness(t, { [observer]: async () => { throw new Error('private transcript'); } });
    const rec = h.instances[0];
    if (observer === 'onStatus') rec.onstart();
    if (observer === 'onError') rec.onerror({ error: 'network' });
    if (observer === 'onUpdate') rec.onresult({ resultIndex: 0, results: [] });
    await settle();
    assert.deepEqual(h.warnings, [['TabScribe recognition observer failed:', observer]]);
    await h.transcriber.stop({ flushMs: 0 });
    rec.onend(); await settle();
    assert.equal(h.transcriber.recognition, null);
    assert.equal(h.transcriber.startTimer, null);
    assert.ok(h.warnings.every(args => !JSON.stringify(args).includes('private')));
  });
}
