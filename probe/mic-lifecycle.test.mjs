import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioGraph } from '../extension/transcriber.js';
import { MicTranscriber } from '../extension/mic.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
function mediaStream() {
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; },
    listeners: new Set(), addEventListener(type, fn) { if (type === 'ended') this.listeners.add(fn); },
    removeEventListener(type, fn) { this.listeners.delete(fn); },
    end() { this.readyState = 'ended'; for (const fn of this.listeners) fn(); } };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function browser(t) {
  const contexts = [], instances = [];
  const node = () => ({ gain: {}, offset: {}, connect() {}, disconnect() {}, start() {}, stop() {} });
  class AudioContext {
    constructor() { this.sampleRate = 100; this.destination = {}; this.closed = false; contexts.push(this); }
    createMediaStreamSource() { if (AudioContext.fail) throw new Error('graph failed'); return node(); }
    createMediaStreamDestination() { this.output = mediaStream(); return { ...node(), stream: this.output }; }
    createGain() { return node(); } createConstantSource() { return node(); }
    createBuffer(c, n) { return { getChannelData: () => new Float32Array(n) }; }
    createBufferSource() { return node(); }
    close() { this.closed = true; return AudioContext.closePending?.promise || Promise.resolve(); }
  }
  class Recognition {
    constructor() { instances.push(this); }
    start() { if (Recognition.throwStart) throw new Error('start failed'); }
    stop() {} abort() {}
  }
  for (const [name, value] of Object.entries({ AudioContext, self: { SpeechRecognition: Recognition },
    navigator: { mediaDevices: { getUserMedia: async () => mediaStream() } } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  return { AudioContext, Recognition, contexts, instances };
}

test('a partially constructed audio graph closes its AudioContext', (t) => {
  const h = browser(t); h.AudioContext.fail = true;
  assert.throws(() => buildAudioGraph(mediaStream()), /graph failed/);
  assert.equal(h.contexts[0].closed, true);
});

test('graph cleanup ends its generated track without stopping the caller-owned input', async (t) => {
  browser(t); const input = mediaStream(); const graph = buildAudioGraph(input);
  await graph.cleanup();
  assert.equal(graph.track.readyState, 'ended');
  assert.equal(input.track.readyState, 'live');
  await graph.cleanup();
});

for (const code of ['not-allowed', 'service-not-allowed', 'language-not-supported']) {
  test(`microphone ${code} is retained and releases resources before onstart`, async (t) => {
    const h = browser(t), states = [], input = mediaStream();
    const mic = new MicTranscriber({ onStateChange: s => states.push(s) });
    await mic.start(input);
    const lateEnd = h.instances[0].onend;
    h.instances[0].onerror({ error: code }); lateEnd(); await settle();
    assert.equal(input.track.readyState, 'ended');
    assert.equal(h.contexts[0].closed, true);
    assert.equal(mic.recognition, null);
    assert.equal(states.at(-1).running, false);
    assert.equal(states.at(-1).reason, code === 'not-allowed' ? 'denied' : code);
    assert.ok(states.at(-1).error);
  });
}

test('old microphone requests cannot reopen after Stop and a newer Open', async (t) => {
  browser(t); const requests = [deferred(), deferred()]; let n = 0;
  navigator.mediaDevices.getUserMedia = () => requests[n++].promise;
  const mic = new MicTranscriber(); const a = mic.open(); await mic.stop({ flushMs: 0 }); const b = mic.open();
  const old = mediaStream(), fresh = mediaStream();
  requests[0].resolve(old); const stale = await a;
  requests[1].resolve(fresh); await b;
  assert.equal(stale.reason, 'cancelled');
  assert.equal(old.track.readyState, 'ended');
  assert.equal(fresh.track.readyState, 'live');
  await mic.stop({ flushMs: 0 });
});

test('old asynchronous microphone cleanup cannot stop a replacement stream', async (t) => {
  const h = browser(t); const old = mediaStream(), fresh = mediaStream(), mic = new MicTranscriber();
  await mic.start(old); h.instances[0].onstart();
  h.AudioContext.closePending = deferred(); const closing = h.AudioContext.closePending;
  const stopped = mic.stop({ flushMs: 0 });
  navigator.mediaDevices.getUserMedia = async () => fresh;
  await mic.open(); await mic.start(fresh); h.instances.at(-1).onstart();
  closing.resolve(); await stopped;
  assert.equal(old.track.readyState, 'ended');
  assert.equal(fresh.track.readyState, 'live');
  assert.ok(mic.graph);
  assert.equal(mic.running, true);
  h.AudioContext.closePending = null; await mic.stop({ flushMs: 0 });
});

test('a stopped microphone ignores callbacks already queued by its recognizer', async (t) => {
  const h = browser(t), states = [], mic = new MicTranscriber({ onStateChange: s => states.push(s) });
  await mic.start(mediaStream());
  const rec = h.instances[0], lateStart = rec.onstart, lateResult = rec.onresult;
  await mic.stop({ flushMs: 0 }); states.length = 0;
  lateStart(); lateResult({ resultIndex: 0, results: [Object.assign([{ transcript: 'late' }], { isFinal: true })] });
  assert.equal(mic.running, false); assert.equal(mic.hasText(), false); assert.deepEqual(states, []);
});

test('an unplugged microphone reports ended and releases its graph', async (t) => {
  const h = browser(t), states = [], input = mediaStream();
  const mic = new MicTranscriber({ onStateChange: s => states.push(s) });
  await mic.start(input); h.instances[0].onstart(); input.track.end(); await settle();
  assert.equal(mic.running, false); assert.equal(h.contexts[0].closed, true);
  assert.equal(states.at(-1).reason, 'ended');
});

test('microphone retry failures are bounded and retain their reason', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = browser(t), states = [], input = mediaStream();
  const mic = new MicTranscriber({ onStateChange: s => states.push(s) });
  await mic.start(input);
  for (let i = 0; i < 12 && mic.recognition; i += 1) {
    const rec = mic.recognition; rec.onstart(); rec.onerror({ error: 'network' }); rec.onend();
    t.mock.timers.tick(5000); await settle();
  }
  assert.ok(h.instances.length <= 5);
  assert.equal(states.at(-1).reason, 'network');
  assert.equal(input.track.readyState, 'ended');
});

test('microphone results and clear notify persistence without publishing to the tab', async (t) => {
  const h = browser(t), saved = [];
  const mic = new MicTranscriber({ onUpdate: store => saved.push(store.toText()) });
  await mic.start(mediaStream()); h.instances[0].onstart();
  h.instances[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'my voice' }], { isFinal: false })] });
  mic.clear();
  assert.deepEqual(saved, ['my voice', '']);
  await mic.stop({ flushMs: 0 });
});

test('throwing microphone observers cannot reject start, updates or cleanup', async (t) => {
  const h = browser(t), input = mediaStream();
  const mic = new MicTranscriber({ onUpdate: () => { throw new Error('observer'); },
    onStateChange: () => { throw new Error('observer'); } });
  assert.equal((await mic.start(input)).ok, true);
  assert.doesNotThrow(() => h.instances[0].onstart());
  assert.doesNotThrow(() => h.instances[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'my voice' }], { isFinal: true })] }));
  await mic.stop({ flushMs: 0 }); assert.equal(input.track.readyState, 'ended');
});

test('graph cleanup closes the context even if an output track refuses stop', async (t) => {
  const h = browser(t); const graph = buildAudioGraph(mediaStream());
  graph.track.stop = () => { throw new Error('track failed'); };
  await graph.cleanup(); assert.equal(h.contexts[0].closed, true);
});

test('clear discards buffered microphone speech instead of resurrecting it in the saved file', async (t) => {
  const h = browser(t), mic = new MicTranscriber();
  await mic.start(mediaStream()); h.instances[0].onstart();
  const lateResult = h.instances[0].onresult;
  const result = { resultIndex: 0, results: [Object.assign([{ transcript: 'deleted microphone speech' }], { isFinal: false })] };
  lateResult(result); mic.clear(); lateResult(result);
  assert.equal(mic.store.toText(), '');
  assert.equal(h.instances.length, 2);
  await mic.stop({ flushMs: 0 });
});

test('a microphone recognizer that never starts releases the microphone on timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = browser(t), input = mediaStream(), states = [];
  const mic = new MicTranscriber({ onStateChange: s => states.push(s) });
  await mic.start(input); t.mock.timers.tick(15000); await settle();
  assert.equal(states.at(-1)?.reason, 'start-timeout');
  assert.equal(input.track.readyState, 'ended');
  assert.equal(h.contexts[0].closed, true);
});

test('rejected async microphone observers are isolated too', async (t) => {
  const h = browser(t), input = mediaStream();
  const mic = new MicTranscriber({ onUpdate: async () => { throw new Error('async observer'); },
    onStateChange: async () => { throw new Error('async observer'); } });
  await mic.start(input); h.instances[0].onstart();
  h.instances[0].onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'my voice' }], { isFinal: true })] });
  await mic.stop({ flushMs: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.track.readyState, 'ended');
});

test('an already ended microphone stream is not reported as started', async (t) => {
  const h = browser(t), input = mediaStream(), mic = new MicTranscriber();
  input.track.stop(); const result = await mic.start(input);
  assert.equal(result.ok, false); assert.equal(result.reason, 'ended');
  assert.equal(h.instances.length, 0);
});

test('a never-settling AudioContext.close cannot indefinitely block meeting Stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = browser(t), input = mediaStream(), mic = new MicTranscriber();
  await mic.start(input); h.instances[0].onstart();
  h.AudioContext.closePending = deferred();
  let settled = false; const stopping = mic.stop({ flushMs: 0 }).then(() => { settled = true; });
  assert.equal(input.track.readyState, 'ended');
  t.mock.timers.tick(1000); await settle();
  assert.equal(settled, true); await stopping;
});

test('a microphone retry already queued before Clear cannot replace the fresh recognizer', async (t) => {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { const id = timers.length + 1; timers.push({ fn, ms, id }); return id; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const h = browser(t), mic = new MicTranscriber();
  await mic.start(mediaStream()); h.instances[0].onstart(); h.instances[0].onend();
  const queued = timers.find(timer => timer.ms === 250);
  mic.clear(); queued.fn();
  assert.equal(h.instances.length, 2);
  await mic.stop({ flushMs: 0 });
});
