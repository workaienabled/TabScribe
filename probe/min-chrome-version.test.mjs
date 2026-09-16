// The declared minimum Chrome version must match the APIs actually used.
//
// It was "150" — a guess, and wrong in the direction that hurts: it refused
// installation on browsers that could run the extension perfectly well. A user
// on Chrome 150 hit a different failure entirely (a missing on-device language
// pack, reported as a bare "Stopped"), which is exactly the kind of confusion a
// bogus version floor creates: the number invites you to blame the version.
//
// The floor is set by the newest API the extension REQUIRES. Anything used
// behind a try/catch with a real fallback does not raise it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
const sources = ['background.js', 'sidepanel.js', 'transcriber.js', 'mic.js', 'prefs.js']
  .map((f) => readFileSync(join(root, 'extension', f), 'utf8'))
  .join('\n');

// Chrome version each capability shipped in. Sources:
//   SpeechRecognition on-device (processLocally / available() / install()):
//     MDN browser-compat-data, api/SpeechRecognition.json -> chrome 139
//   sidePanel base 114, open() 116, close() 141:
//     developer.chrome.com/docs/extensions/reference/api/sidePanel
//   storage.session 102, tabCapture.getMediaStreamId 71, CSS :has() 105
const REQUIRES = [
  { api: 'SpeechRecognition.available (on-device)', since: 139, used: /SR\.available|processLocally/ },
  { api: 'chrome.sidePanel.open', since: 116, used: /sidePanel\.open/ },
  { api: 'chrome.sidePanel.setOptions', since: 114, used: /sidePanel\.setOptions/ },
  { api: 'chrome.storage.session', since: 102, used: /storage\.session/ },
  { api: 'chrome.tabCapture.getMediaStreamId', since: 71, used: /getMediaStreamId/ },
];

// Used, but guarded with a working fallback, so it must NOT raise the floor.
const OPTIONAL = [
  { api: 'chrome.sidePanel.close', since: 141, used: /sidePanel\.close/ },
];

test('every API the extension requires is covered by minimum_chrome_version', () => {
  const declared = Number(manifest.minimum_chrome_version);
  assert.ok(Number.isInteger(declared), 'minimum_chrome_version must be declared');

  const required = REQUIRES.filter((r) => r.used.test(sources));
  assert.ok(required.length > 0, 'the detection patterns must actually match the source');

  for (const r of required) {
    assert.ok(declared >= r.since,
      `${r.api} needs Chrome ${r.since}, but the manifest declares ${declared}`);
  }
});

test('the floor is not higher than anything actually requires', () => {
  const declared = Number(manifest.minimum_chrome_version);
  const needed = Math.max(...REQUIRES.filter((r) => r.used.test(sources)).map((r) => r.since));
  assert.equal(declared, needed,
    `minimum_chrome_version is ${declared} but the newest required API needs ${needed}. `
    + 'A floor higher than the real requirement locks out browsers that work.');
});

test('optional APIs are guarded, and do not raise the floor', () => {
  const declared = Number(manifest.minimum_chrome_version);
  for (const o of OPTIONAL) {
    if (!o.used.test(sources)) continue;
    assert.ok(declared < o.since,
      `${o.api} is listed as optional; if the floor already covers it, promote it to REQUIRES`);
    // It must be inside a try/catch, or calling it on an older Chrome throws.
    // Match the CALL, not the many comments that name it: `chrome.` prefix and
    // an argument. Then check the nearest preceding block opener is a `try {`.
    const call = sources.search(/chrome\.sidePanel\.close\(\s*\{/);
    assert.ok(call > 0, `${o.api} call site should be findable in the source`);
    const before = sources.slice(0, call);
    const lastTry = before.lastIndexOf('try {');
    const lastCatch = before.lastIndexOf('catch');
    assert.ok(lastTry > lastCatch,
      `${o.api} must be called inside try/catch, since older Chrome lacks it`);
  }
});
