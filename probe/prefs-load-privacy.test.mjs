import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const panel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
let instance = 0;

async function fixture(t, get) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const writes = [];
  globalThis.chrome = { storage: {
    local: { get, async set(value) { writes.push(value); } },
    onChanged: { addListener() {} },
  } };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous);
    else delete globalThis.chrome;
  });
  const prefs = await import(`../extension/prefs.js?load-privacy=${++instance}`);
  return { prefs, writes };
}

function preferenceWarning(prefs) {
  const issues = { hidden: true, children: [], replaceChildren(...children) { this.children = children; } };
  const context = vm.createContext({
    prefs, issues: new Map(), el: { issues },
    document: { createElement: () => ({ dataset: {}, textContent: '' }) },
  });
  const showIssue = panel.match(/^function showIssue\([^]*?^}/m)?.[0];
  const observe = panel.match(/  prefs\.onError\(\(\{ operation, error \}\) => \{[^]*?^  \}\);/m)?.[0];
  assert.ok(showIssue && observe, 'use the actual visible preference-error observer');
  vm.runInContext(`${showIssue}\n${observe}`, context);
  return issues;
}

test('failed preference load turns microphone off and surfaces the existing visible warning', async t => {
  let fail = true;
  const { prefs, writes } = await fixture(t, async () => {
    if (fail) throw new Error('persisted opt-out temporarily unreadable');
    return { prefs: { includeMic: false } };
  });
  const issues = preferenceWarning(prefs);
  const loaded = await prefs.load();
  assert.equal(loaded.includeMic, false, 'unknown persisted consent must not become a microphone opt-in');
  assert.equal(prefs.get().includeMic, false);
  assert.equal(prefs.DEFAULTS.includeMic, true, 'pristine installation default is unchanged');
  assert.equal(prefs.isLoaded(), true);
  assert.equal(issues.hidden, false);
  assert.equal(issues.children[0].dataset.source, 'prefs-load');
  assert.match(issues.children[0].textContent, /Saved preferences could not be loaded/);
  assert.match(issues.children[0].textContent, /persisted opt-out temporarily unreadable/);
  assert.deepEqual(writes, [], 'do not overwrite the unreadable saved opt-out with fallback defaults');
  fail = false;
  assert.equal((await prefs.load()).includeMic, false);
  assert.equal(issues.hidden, true, 'the same observer clears the warning on successful read');
});

test('a successful pristine preference read keeps the microphone default on', async t => {
  const { prefs } = await fixture(t, async () => ({}));
  assert.equal((await prefs.load()).includeMic, true);
  assert.equal(prefs.get().includeMic, true);
});

test('a failed reload cannot turn a previously persisted microphone opt-out back on', async t => {
  let fail = false;
  const { prefs } = await fixture(t, async () => {
    if (fail) throw new Error('storage disconnected');
    return { prefs: { includeMic: false, theme: 'dark' } };
  });
  assert.equal((await prefs.load()).includeMic, false);
  fail = true;
  assert.equal((await prefs.load()).includeMic, false);
  assert.equal(prefs.get().includeMic, false);
});
