// A fatal recognition error must not be erased by the "stopped" that follows.
//
// A Chrome 150 user reported "Stopped right after start", but the browser's
// error code and model state were not captured. The cause remains unproven.
// These tests establish an error-ordering contract, not a diagnosis of that
// report: a fatal onerror followed by onend must retain its reason.
//
// These cases cover already-running sessions. recognition-lifecycle.test.mjs
// also covers failures before onstart, stale events, start throws and retries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Transcriber } from '../extension/transcriber.js';

/** Minimal stand-in for Chrome's SpeechRecognition, driven by hand. */
function installFakeRecognition() {
  const instances = [];
  class FakeRecognition {
    constructor() {
      this.started = false;
      instances.push(this);
    }
    start() { this.started = true; }
    abort() {}
    stop() {}
    /** The real ordering: error first, then end. */
    fail(code) {
      this.onerror?.({ error: code, message: '' });
      this.onend?.();
    }
  }
  // transcriber.js reads the constructor off `self`, as a worker/window would.
  globalThis.self = globalThis;
  globalThis.SpeechRecognition = FakeRecognition;
  return {
    instances,
    restore() {
      delete globalThis.SpeechRecognition;
      delete globalThis.self;
    },
  };
}

function liveTrack() {
  return { readyState: 'live', stop() { this.readyState = 'ended'; } };
}

function record() {
  const events = [];
  const t = new Transcriber({
    onStatus: (s, detail) => events.push({ kind: 'status', s, detail }),
    onError: (code, message) => events.push({ kind: 'error', code, message }),
  });
  return { t, events };
}

test('a fatal error survives the stop that follows it', () => {
  const fake = installFakeRecognition();
  try {
    const { t, events } = record();
    t.start(liveTrack(), { lang: 'en-US', processLocally: true });
    t.running = true;
    fake.instances.at(-1).fail('language-not-supported');

    const error = events.find((e) => e.kind === 'error');
    assert.ok(error, 'the failure must be reported at all');
    assert.equal(error.code, 'language-not-supported');

    const stopped = events.find((e) => e.kind === 'status' && e.s === 'stopped');
    assert.ok(stopped, 'it still has to report that it stopped');
    assert.ok(events.indexOf(error) < events.indexOf(stopped),
      'the error arrives first, so the stop must not be allowed to erase it');
    assert.equal(stopped.detail?.error, 'language-not-supported',
      'the stop must carry the reason it stopped, or the host cannot keep it on screen');
    assert.equal(stopped.detail?.fatal, true,
      'a fatal stop must be distinguishable from a user pressing Stop');
  } finally {
    fake.restore();
  }
});

test('each fatal code is carried through, not flattened', () => {
  const fake = installFakeRecognition();
  try {
    for (const code of ['not-allowed', 'service-not-allowed', 'language-not-supported']) {
      const { t, events } = record();
      t.start(liveTrack(), {});
      t.running = true;
      fake.instances.at(-1).fail(code);
      const stopped = events.find((e) => e.kind === 'status' && e.s === 'stopped');
      assert.equal(stopped.detail?.error, code, `${code} must reach the host intact`);
    }
  } finally {
    fake.restore();
  }
});

test('an ordinary stop carries no error, so nothing alarming is shown', () => {
  const fake = installFakeRecognition();
  try {
    const { t, events } = record();
    t.start(liveTrack(), {});
    t.running = true;
    t.stopping = true;            // what stop() sets before it ends the session
    fake.instances.at(-1).onend?.();

    const stopped = events.find((e) => e.kind === 'status' && e.s === 'stopped');
    assert.ok(stopped, 'a deliberate stop still reports stopped');
    assert.ok(!stopped.detail?.fatal, 'a deliberate stop is not a failure');
    assert.equal(stopped.detail?.error ?? null, null,
      'and must not invent an error the user never hit');
  } finally {
    fake.restore();
  }
});

test('a dead audio track stops without claiming a recognition failure', () => {
  const fake = installFakeRecognition();
  try {
    const { t, events } = record();
    const track = liveTrack();
    t.start(track, {});
    t.running = true;
    track.readyState = 'ended';   // the tab stopped producing audio
    fake.instances.at(-1).onend?.();

    const stopped = events.find((e) => e.kind === 'status' && e.s === 'stopped');
    assert.ok(stopped, 'it reports the stop');
    assert.ok(!stopped.detail?.fatal,
      'losing the audio track is not a recognition error and must not read as one');
  } finally {
    fake.restore();
  }
});
