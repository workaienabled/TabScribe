import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptStore } from '../extension/transcriber.js';

const valid = () => ({ epoch: 1, segments: [
  { key: '1:0', text: 'Restored speech', isFinal: false, startedAt: 1000 },
] });
for (const action of ['restore', 'prepend']) {
  for (const [name, change] of [
    ['non-string text', s => s.segments.push({ key: '1:1', text: 42, isFinal: false, startedAt: 0 })],
    ['duplicate key', s => s.segments.push({ ...s.segments[0] })],
    ['invalid clock', s => { s.segments[0].startedAt = Infinity; }],
    ['negative clock', s => { s.segments[0].startedAt = -1; }],
    ['invalid final flag', s => { s.segments[0].isFinal = 'false'; }],
    ['invalid epoch', s => { s.epoch = '1'; }],
    ['missing key', s => { delete s.segments[0].key; }],
  ]) {
    test(`${action} rejects ${name} atomically`, () => {
      const store = new TranscriptStore(); store.update(0, 'Keep existing speech', false, 0);
      const before = store.serialize(), bad = valid(); change(bad);
      assert.throws(() => store[action](bad), /snapshot/i);
      assert.deepEqual(store.serialize(), before);
      assert.equal(store.byKey.size, 1);
    });
  }
}

test('restore advances beyond the highest restored recognition key', () => {
  const store = new TranscriptStore(); const snapshot = valid(); snapshot.segments[0].key = '20:0';
  store.restore(snapshot);
  assert.ok(store.epoch > 20);
  store.newEpoch(); store.update(0, 'New speech', false, 5000);
  assert.equal(store.toText(), 'Restored speech New speech');
});
