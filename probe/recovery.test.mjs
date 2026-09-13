import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptStore } from '../extension/transcriber.js';

test('recover cleared history before new text without colliding with live results', () => {
  const store = new TranscriptStore();
  store.update(0, 'Earlier transcript.', false, 1000);
  const old = store.serialize();
  store.clear();
  store.update(0, 'Fresh interim', false, 2000);
  assert.equal(typeof store.prepend, 'function', 'recoverable Clear needs a history-prepend operation');
  store.prepend(old);
  assert.equal(store.toText(), 'Earlier transcript. Fresh interim');
  assert.equal(store.segments[0].isFinal, true);
  store.update(0, 'Fresh completed sentence.', true, 2000);
  assert.equal(store.toText(), 'Earlier transcript. Fresh completed sentence.');
  assert.equal(store.byKey.size, store.segments.length);
  store.prepend(old);
  assert.equal(store.byKey.size, store.segments.length);
  assert.equal(new Set(store.segments.map(s => s.key)).size, 3);
});
