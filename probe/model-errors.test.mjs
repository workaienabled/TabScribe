import test from 'node:test';
import assert from 'node:assert/strict';
import { Transcriber } from '../extension/transcriber.js';

function api(t, sr) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { SpeechRecognition: sr } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'self', previous) : delete globalThis.self);
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

test('an availability policy error is not a missing browser API', async (t) => {
  const error = new DOMException('Blocked by policy', 'NotAllowedError');
  api(t, { available: async () => { throw error; } });
  await assert.rejects(Transcriber.availability(), e => e === error);
  await assert.rejects(Transcriber.ensureModel(), e => e === error);
});

test('cancelling model setup settles promptly and suppresses late progress', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const install = deferred(); let checks = 0;
  api(t, { available: async () => (++checks, 'downloadable'), install: () => install.promise });
  const controller = new AbortController(); const progress = [];
  let outcome = 'pending';
  const task = Transcriber.ensureModel('en-US', { signal: controller.signal, onProgress: p => progress.push(p) })
    .then(() => { outcome = 'resolved'; }, e => { outcome = e.name; });
  await settle(); controller.abort(); await settle();
  assert.equal(outcome, 'AbortError');
  const count = progress.length;
  install.resolve(true); t.mock.timers.tick(10000); await settle(); await task;
  assert.equal(progress.length, count);
  assert.equal(checks, 1);
});

test('a never-settling model API times out instead of trapping Start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  api(t, { available: () => new Promise(() => {}) });
  let outcome = 'pending';
  const task = Transcriber.ensureModel('en-US', { timeoutMs: 2000 })
    .then(() => { outcome = 'resolved'; }, e => { outcome = e.name; });
  t.mock.timers.tick(2000); await settle();
  assert.equal(outcome, 'TimeoutError'); await task;
});

test('installation wait is also bounded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  api(t, { available: async () => 'downloadable', install: () => new Promise(() => {}) });
  let outcome = 'pending';
  const task = Transcriber.ensureModel('en-US', { timeoutMs: 2000 })
    .then(() => { outcome = 'resolved'; }, e => { outcome = e.name; });
  await settle(); t.mock.timers.tick(2000); await settle();
  assert.equal(outcome, 'TimeoutError'); await task;
});

test('already cancelled model setup does not invoke browser APIs', async (t) => {
  let calls = 0;
  api(t, { available: async () => (++calls, 'available') });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(Transcriber.ensureModel('en-US', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});
