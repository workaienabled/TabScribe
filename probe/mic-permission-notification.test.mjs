import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MicTranscriber, MIC_MESSAGES, stopStream } from '../extension/mic.js';

const source = readFileSync(new URL('../extension/mic-permission.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
function page(t, { storageFailure, denied = false } = {}) {
  let closes = 0, stopped = 0;
  const reports = [];
  const nodes = Object.fromEntries(['allowBtn', 'skipBtn', 'grantStatus'].map(id => [id, {
    textContent: '', disabled: false, error: false,
    classList: { toggle(name, value) { nodes[id].error = value; } },
    addEventListener(event, fn) { this[event] = fn; },
  }]));
  const stream = { getTracks: () => [{ stop() { stopped += 1; } }] };
  t.mock.method(MicTranscriber, 'requestStream', () => Promise.resolve(denied
    ? { ok: false, reason: 'denied', error: 'permission denied' } : { ok: true, stream }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = vm.createContext({
    MicTranscriber, MIC_MESSAGES, stopStream,
    setTimeout, clearTimeout,
    document: { getElementById: id => nodes[id] },
    chrome: { storage: { local: { set(data) {
      reports.push(data.micGrant.outcome);
      if (storageFailure === 'reject') return Promise.reject(new Error('storage failed'));
      if (storageFailure === 'throw') throw new Error('storage failed');
      if (storageFailure === 'hang') return new Promise(() => {});
      return Promise.resolve();
    } } } },
    window: { close() { closes += 1; }, addEventListener() {} },
  });
  vm.runInContext(source.replace(/^import .*;$/m, ''), context, { filename: 'mic-permission.js' });
  return { nodes, reports, closes: () => closes, stopped: () => stopped };
}
for (const storageFailure of ['reject', 'throw', 'hang']) {
  test(`granted microphone remains truthful and page stays open on notification ${storageFailure}`, async t => {
    const h = page(t, { storageFailure });
    h.nodes.allowBtn.click(); await settle();
    assert.match(h.nodes.grantStatus.textContent, /Microphone allowed/, 'grant outcome must not wait for storage');
    assert.equal(h.stopped(), 1);
    assert.deepEqual(h.reports, ['granted']);
    t.mock.timers.tick(5000); await settle();
    assert.match(h.nodes.grantStatus.textContent, /panel.*not.*notified/i);
    assert.equal(h.nodes.grantStatus.error, true);
    assert.equal(h.nodes.allowBtn.textContent, 'Allowed');
    t.mock.timers.tick(10000); await settle();
    assert.equal(h.closes(), 0, 'failure warning must remain available instead of auto-closing');
  });
}

for (const storageFailure of ['reject', 'hang']) {
  test(`skipping retains the page when notification ${storageFailure}s`, async t => {
    const h = page(t, { storageFailure });
    const skipping = h.nodes.skipBtn.click(); await settle();
    t.mock.timers.tick(5000); await settle(); await skipping;
    assert.deepEqual(h.reports, ['skipped']);
    assert.match(h.nodes.grantStatus.textContent, /skipped/i);
    assert.match(h.nodes.grantStatus.textContent, /panel.*not.*notified/i);
    assert.equal(h.closes(), 0);
  });
}

test('permission denial is shown while the panel notification is hung', async t => {
  const h = page(t, { storageFailure: 'hang', denied: true });
  h.nodes.allowBtn.click(); await settle();
  assert.ok(h.nodes.grantStatus.textContent.startsWith(MIC_MESSAGES.denied));
  t.mock.timers.tick(5000); await settle();
  assert.ok(h.nodes.grantStatus.textContent.startsWith(MIC_MESSAGES.denied));
  assert.match(h.nodes.grantStatus.textContent, /panel.*not.*notified/i);
  assert.equal(h.nodes.allowBtn.disabled, false);
  assert.equal(h.closes(), 0);
});

test('successful permission report preserves the existing auto-close flow', async t => {
  const h = page(t);
  h.nodes.allowBtn.click(); await settle();
  assert.match(h.nodes.grantStatus.textContent, /Microphone allowed/);
  t.mock.timers.tick(1800); await settle();
  assert.equal(h.closes(), 1);
});
