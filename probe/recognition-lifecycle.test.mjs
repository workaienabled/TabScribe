import test from 'node:test';
import assert from 'node:assert/strict';
import { Transcriber } from '../extension/transcriber.js';

function harness(t) {
  const instances = [];
  class Recognition {
    constructor() { this.aborts = 0; this.stops = 0; instances.push(this); }
    start() { if (Recognition.throwStart) throw new Error('start exploded'); }
    stop() { this.stops += 1; }
    abort() { this.aborts += 1; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { SpeechRecognition: Recognition } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'self', previous) : delete globalThis.self);
  const events = [];
  const transcriber = new Transcriber({
    onStatus: (status, detail) => events.push({ status, detail }),
    onError: (code, message) => events.push({ code, message }),
  });
  t.after(() => transcriber.stop({ flushMs: 0 }));
  const track = { readyState: 'live' };
  return { instances, Recognition, events, transcriber, track };
}

for (const error of ['not-allowed', 'service-not-allowed', 'language-not-supported']) {
  test(`startup ${error} survives onend before onstart`, (t) => {
    const h = harness(t);
    h.transcriber.start(h.track);
    const rec = h.instances[0];
    rec.onerror({ error, message: 'original detail' });
    rec.onend();
    assert.deepEqual(h.events.at(-1), { status: 'stopped', detail: { fatal: true, error, message: 'original detail' } });
    assert.equal(h.instances.length, 1);
  });
}

test('a fresh attempt clears a previous fatal error', (t) => {
  const h = harness(t);
  h.transcriber.start(h.track);
  h.instances[0].onstart();
  h.instances[0].onerror({ error: 'not-allowed' });
  h.instances[0].onend();
  h.transcriber.start(h.track);
  assert.equal(h.transcriber.lastError, null);
});

test('callbacks already queued by a superseded recognizer cannot alter its replacement', (t) => {
  const h = harness(t);
  h.transcriber.start(h.track);
  const rec = h.instances[0];
  const late = { start: rec.onstart, end: rec.onend, error: rec.onerror, result: rec.onresult };
  h.transcriber.start(h.track);
  h.events.length = 0;
  late.start(); late.error({ error: 'not-allowed' }); late.end();
  late.result({ resultIndex: 0, results: [Object.assign([{ transcript: 'stale text' }], { isFinal: true })] });
  assert.deepEqual(h.events, []);
  assert.equal(h.transcriber.store.toText(), '');
  assert.equal(h.instances.length, 2);
  assert.equal(rec.aborts, 1);
});

test('synchronous start failure releases the failed recognizer and preserves the exception', (t) => {
  const h = harness(t);
  h.Recognition.throwStart = true;
  assert.throws(() => h.transcriber.start(h.track), /start exploded/);
  assert.equal(h.transcriber.recognition, null);
  assert.equal(h.transcriber.running, false);
  assert.equal(h.instances[0].aborts, 1);
  assert.equal(h.instances[0].onend, null);
});

test('stop before onstart prevents late start from claiming listening', async (t) => {
  const h = harness(t);
  h.transcriber.start(h.track);
  const lateStart = h.instances[0].onstart;
  await h.transcriber.stop({ flushMs: 0 });
  lateStart();
  assert.equal(h.transcriber.running, false);
  assert.equal(h.events.some(e => e.status === 'listening'), false);
});

for (const error of ['network', 'audio-capture', 'no-speech', null]) {
  test(`rapid empty ${error || 'no-start'} sessions stop retrying`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const h = harness(t);
    h.transcriber.start(h.track);
    for (let i = 0; i < 12 && h.transcriber.recognition; i += 1) {
      const rec = h.transcriber.recognition;
      if (error) { rec.onstart(); rec.onerror({ error }); }
      rec.onend();
      t.mock.timers.tick(5000);
    }
    assert.ok(h.instances.length <= 5, 'failed recognizers must not loop forever');
    assert.equal(h.events.at(-1).status, 'stopped');
    assert.equal(h.events.at(-1).detail.fatal, true);
    assert.equal(h.events.at(-1).detail.error, error || 'restart-limit');
  });
}

test('useful speech and ordinary long silence do not exhaust the retry budget', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness(t);
  h.transcriber.start(h.track);
  for (let i = 0; i < 12; i += 1) {
    const rec = h.transcriber.recognition;
    assert.ok(rec, 'normal long meetings must keep transcribing');
    rec.onstart();
    if (i % 2) {
      rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: `turn ${i}` }], { isFinal: true })] });
    } else {
      t.mock.timers.tick(15000);
      rec.onerror({ error: 'no-speech' });
    }
    rec.onend();
    t.mock.timers.tick(5000);
  }
  assert.equal(h.instances.length, 13);
  assert.equal(h.events.some(e => e.detail?.fatal), false);
});

test('a pending retry is delayed and cancelled by stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness(t);
  h.transcriber.start(h.track); h.instances[0].onstart(); h.instances[0].onend();
  assert.equal(h.instances.length, 1, 'avoid a tight restart loop');
  await h.transcriber.stop({ flushMs: 0 });
  t.mock.timers.tick(30000);
  assert.equal(h.instances.length, 1);
});

test('restart start() throwing emits a terminal reason', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness(t);
  h.transcriber.start(h.track); h.instances[0].onstart();
  h.Recognition.throwStart = true; h.instances[0].onend();
  t.mock.timers.tick(5000);
  assert.deepEqual(h.events.at(-1), { status: 'stopped', detail: { fatal: true, error: 'restart-failed', message: 'start exploded' } });
  assert.equal(h.transcriber.recognition, null);
});

test('reset preserves the capture clock and reports a replacement start failure', (t) => {
  const h = harness(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  h.transcriber.start(h.track); h.instances[0].onstart();
  t.mock.timers.tick(5000); h.transcriber.reset();
  assert.equal(h.transcriber.t0, 1000);
  h.instances.at(-1).onstart(); h.Recognition.throwStart = true; h.transcriber.reset();
  assert.equal(h.events.at(-1).status, 'stopped');
  assert.equal(h.events.at(-1).detail.error, 'restart-failed');
});

test('stop falls back to abort if the recognizer stop method throws', async (t) => {
  const h = harness(t); h.transcriber.start(h.track);
  h.instances[0].stop = () => { throw new Error('stop failed'); };
  await h.transcriber.stop({ flushMs: 0 });
  assert.equal(h.instances[0].aborts, 1);
  assert.equal(h.transcriber.recognition, null);
});

test('a recognizer that emits no startup events has a bounded wait', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness(t); h.transcriber.start(h.track);
  t.mock.timers.tick(15000);
  assert.equal(h.events.at(-1)?.status, 'stopped');
  assert.equal(h.events.at(-1)?.detail.error, 'start-timeout');
  assert.equal(h.transcriber.recognition, null);
  assert.equal(h.instances[0].aborts, 1);
});

test('a retry callback already queued before a new Start cannot replace it', (t) => {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { const id = timers.length + 1; timers.push({ fn, ms, id }); return id; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const h = harness(t); h.transcriber.start(h.track); h.instances[0].onstart(); h.instances[0].onend();
  const queued = timers.find(timer => timer.ms === 250);
  h.transcriber.start(h.track); queued.fn();
  assert.equal(h.instances.length, 2);
});
