import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
let load = 0;
async function page(t, getUserMedia) {
  const nodes = Object.fromEntries(['allowBtn', 'skipBtn', 'grantStatus'].map(id => [id, {
    textContent: '', disabled: false, classList: { toggle() {} },
    addEventListener(event, fn) { this[event] = fn; },
  }]));
  const reports = [];
  for (const [name, value] of Object.entries({
    document: { getElementById: id => nodes[id] },
    navigator: { mediaDevices: { getUserMedia } },
    chrome: { storage: { local: { set: async data => { reports.push(data.micGrant.outcome); } } } },
    window: { close() {}, addEventListener() {} },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The pre-fix page has no import/export syntax; Node infers CommonJS for it.
  // Clear that cache as well so each page fixture actually runs its handlers.
  delete require.cache[require.resolve('../extension/mic-permission.js')];
  await import(`../extension/mic-permission.js?test=${++load}`);
  return { nodes, reports };
}

for (const [name, message, reason] of [
  ['NotAllowedError', 'Permission dismissed', 'dismissed'],
  ['NotReadableError', 'Could not start audio source', 'device-busy'],
  ['SecurityError', 'Blocked by policy', 'denied'],
]) {
  test(`permission page reports ${reason}, not a different cause`, async (t) => {
    const h = await page(t, () => Promise.reject(Object.assign(new Error(message), { name })));
    h.nodes.allowBtn.click(); await settle();
    assert.deepEqual(h.reports, [reason]);
    assert.equal(h.nodes.allowBtn.disabled, false);
    if (reason === 'dismissed') assert.match(h.nodes.grantStatus.textContent, /dismissed/i);
    if (reason === 'device-busy') assert.match(h.nodes.grantStatus.textContent, /busy|unavailable/i);
  });
}

test('permission page classifies synchronous device failures too', async (t) => {
  const h = await page(t, () => { throw Object.assign(new Error('Missing microphone'), { name: 'NotFoundError' }); });
  h.nodes.allowBtn.click(); await settle();
  assert.deepEqual(h.reports, ['no-device']);
  assert.match(h.nodes.grantStatus.textContent, /No microphone/);
});

test('skipping while permission is pending releases a late stream without publishing granted', async (t) => {
  let resolve; const h = await page(t, () => new Promise(r => { resolve = r; }));
  h.nodes.allowBtn.click(); await h.nodes.skipBtn.click();
  let stopped = 0; resolve({ getTracks: () => [{ stop() { stopped += 1; } }] }); await settle();
  assert.equal(stopped, 1);
  assert.deepEqual(h.reports, ['skipped']);
});
