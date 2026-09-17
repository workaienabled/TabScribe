import test from 'node:test';
import assert from 'node:assert/strict';

let instance = 0;

async function fixture(t, local = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  let stored = {};
  const listeners = [];
  const storage = {
    async get() { return { prefs: structuredClone(stored) }; },
    async set(value) { stored = structuredClone(value.prefs); },
    ...local,
  };
  globalThis.chrome = {
    storage: { local: storage, onChanged: { addListener: (fn) => listeners.push(fn) } },
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous);
    else delete globalThis.chrome;
  });
  const prefs = await import(`../extension/prefs.js?prefs-errors=${++instance}`);
  return { prefs, storage, listeners, stored: () => stored };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('writes settle in request order without delaying in-memory preference changes', async (t) => {
  const firstWrite = deferred();
  t.after(() => firstWrite.resolve());
  const calls = [];
  let stored;
  const { prefs } = await fixture(t, {
    async set(value) {
      const snapshot = structuredClone(value.prefs);
      calls.push(snapshot);
      if (calls.length === 1) await firstWrite.promise;
      stored = snapshot;
    },
  });
  await prefs.load();
  const first = prefs.set({ theme: 'dark' });
  const second = prefs.set({ theme: 'light', includeMic: false });
  assert.equal(prefs.get().theme, 'light');
  assert.equal(prefs.get().includeMic, false);
  await tick();
  assert.equal(calls.length, 1, 'the second write must not race the first write');
  assert.equal(calls[0].theme, 'dark');
  firstWrite.resolve();
  const values = await Promise.all([first, second]);
  assert.equal(calls.length, 2);
  assert.equal(stored.theme, 'light');
  assert.equal(stored.includeMic, false);
  assert.deepEqual(values[1], prefs.get());
});

test('a rejected write does not poison the queue or discard newer choices', async (t) => {
  const firstWrite = deferred();
  t.after(() => firstWrite.resolve());
  const calls = [];
  let stored;
  const { prefs } = await fixture(t, {
    async set(value) {
      const snapshot = structuredClone(value.prefs);
      calls.push(snapshot);
      if (calls.length === 1) await firstWrite.promise;
      stored = snapshot;
    },
  });
  const events = [];
  prefs.onError((event) => events.push(event));
  const first = prefs.set({ theme: 'dark' });
  const second = prefs.set({ includeMic: false });
  await tick();
  assert.equal(calls.length, 1);
  firstWrite.reject(new Error('first write failed'));
  await Promise.all([first, second]);
  assert.equal(stored.theme, 'dark', 'retry carries the failed in-memory choice forward');
  assert.equal(stored.includeMic, false);
  assert.deepEqual(prefs.get(), stored);
  assert.deepEqual(events, [
    { operation: 'save', error: 'first write failed' },
    { operation: 'save', error: null },
  ]);
});

test('set accepts only supported preference keys and validated values', async (t) => {
  const { prefs, stored } = await fixture(t);
  await prefs.load();
  const valid = { lang: 'fr-FR', includeMic: false, theme: 'dark', fontSize: 17,
    timestamps: true, windowWidth: 700, windowHeight: 900 };
  assert.deepEqual(await prefs.set(valid), { ...prefs.DEFAULTS, ...valid });
  const before = prefs.get();
  const invalid = { lang: 'xx-XX', localOnly: 'false', timestamps: 1,
    autoscroll: null, selectToCopy: 0, copyToast: 'true', prefsOpen: {},
    includeMic: undefined, theme: 'neon', fontSize: 14,
    windowWidth: Number.NaN, windowHeight: Infinity, unknown: 'not a preference' };
  assert.deepEqual(await prefs.set(invalid), before);
  for (const patch of [null, undefined, 'dark', [], { windowWidth: 199, windowHeight: 10001 }]) {
    assert.deepEqual(await prefs.set(patch), before);
  }
  assert.deepEqual(await prefs.set(Object.create({ includeMic: true })), before,
    'prototype properties are not user choices');
  assert.deepEqual(stored(), before, 'invalid values must never reach storage');
});

test('load rejects malformed values with the same rules as set', async (t) => {
  const { prefs, storage } = await fixture(t, {
    async get() { return { prefs: { lang: 'fr-FR', includeMic: false,
      theme: 'neon', fontSize: 14, localOnly: 'false', windowWidth: -1,
      windowHeight: Infinity, unknown: true } }; },
  });
  assert.deepEqual(await prefs.load(), { ...prefs.DEFAULTS, lang: 'fr-FR', includeMic: false });
  for (const value of [null, undefined, 'invalid', [], 42]) {
    storage.get = async () => ({ prefs: value });
    assert.deepEqual(await prefs.load(), prefs.DEFAULTS);
  }
});

test('non-Error storage rejections are failures, including null and undefined', async (t) => {
  let reason;
  const { prefs } = await fixture(t, {
    get() { throw reason; },
    set() { throw reason; },
  });
  const events = [];
  prefs.onError((event) => events.push(event));
  for (reason of [null, undefined, 'storage unavailable', 7]) {
    await prefs.load();
    await prefs.set({ includeMic: false });
    assert.deepEqual(events.slice(-2), [
      { operation: 'load', error: String(reason) },
      { operation: 'save', error: String(reason) },
    ]);
  }
});

test('preference errors are observable without throwing and recover per operation', async (t) => {
  let readFails = true;
  let writeFails = true;
  const { prefs } = await fixture(t, {
    async get() {
      if (readFails) throw new Error('read unavailable');
      return { prefs: { theme: 'dark' } };
    },
    async set() {
      if (writeFails) throw new Error('quota exceeded');
    },
  });
  assert.equal(typeof prefs.onError, 'function', 'the UI needs a preference error observer');
  prefs.onError(() => { throw new Error('observer failed'); });
  prefs.onError(async () => { throw new Error('async observer failed'); });
  const events = [];
  const unsubscribe = prefs.onError((event) => events.push(event));

  assert.deepEqual(await prefs.load(), { ...prefs.DEFAULTS, includeMic: false });
  assert.equal(prefs.isLoaded(), true);
  const current = await prefs.set({ theme: 'light' });
  assert.equal(current.theme, 'light');
  assert.equal(prefs.get().theme, 'light', 'a failed write keeps the in-memory choice');
  assert.deepEqual(events, [
    { operation: 'load', error: 'read unavailable' },
    { operation: 'save', error: 'quota exceeded' },
  ]);

  writeFails = false;
  await prefs.set({ theme: 'dark' });
  assert.deepEqual(events.at(-1), { operation: 'save', error: null });
  assert.equal(events.length, 3, 'saving must not clear the unresolved load error');
  await prefs.set({ theme: 'light' });
  assert.equal(events.length, 3, 'ordinary success is not an error-state transition');
  readFails = false;
  assert.equal((await prefs.load()).theme, 'dark');
  assert.deepEqual(events.at(-1), { operation: 'load', error: null });
  await tick(); // Rejected async observers must not become unhandled rejections.

  unsubscribe();
  writeFails = true;
  await prefs.set({ theme: 'system' });
  assert.equal(events.length, 4, 'unsubscribed views must no longer receive events');
  await tick();
});
