import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MIC_MESSAGES, MicTranscriber } from '../extension/mic.js';
import { Transcriber } from '../extension/transcriber.js';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function controller(names, bindings) {
  const functions = names.map(name => {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, `production function ${name} exists`);
    return match[0];
  });
  const context = vm.createContext(bindings);
  vm.runInContext(functions.join('\n'), context, { filename: 'sidepanel-recognition-controller.js' });
  return context;
}
function element() {
  const classes = new Set(), attributes = new Map();
  return {
    textContent: '', disabled: false, hidden: false, dataset: {},
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name),
    replaceChildren(...children) { this.children = children; },
    classList: { contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
  };
}
function recognitionController(t) {
  const instances = [];
  const installation = deferred();
  let installs = 0;
  class Recognition {
    static available() { return Promise.resolve('downloadable'); }
    static install() { installs += 1; return installation.promise; }
    constructor() { instances.push(this); }
    start() {} stop() {} abort() {}
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { SpeechRecognition: Recognition } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'self', previous) : delete globalThis.self);
  const el = Object.fromEntries(['record', 'lang', 'localOnly', 'status'].map(name => [name, element()]));
  el.localOnly.checked = true; el.lang.value = 'en-US';
  const track = { readyState: 'live' };
  const h = controller(['useCloudInstead', 'start', 'stop', 'ensureTranscriber', 'fatalRecognitionMessage', 'setStatus'], {
    el, Transcriber, AbortController, activeStart: null, stopInProgress: false,
    modelPreviewVersion: 0, armed: true, micGranted: false, micBlocked: false,
    mic: null, transcriber: null, handedOff: false, handoffBlocked: false, switching: false,
    modelTimer: null,
    graph: { track, ctx: { state: 'running' } },
    armCapture: async () => ({ ok: true }),
    hideModelPanel() {}, savePrefsFromUi() {}, onModelProgress() {}, render() {},
    attachMic() {}, switchLog() {}, teardown: async () => {}, setState() {},
    setRecording(recording) { el.record.setAttribute('aria-pressed', String(recording)); },
  });
  t.after(async () => { h.activeStart?.abort(); await h.transcriber?.stop({ flushMs: 0 }); });
  return { h, el, instances, installation, installs: () => installs };
}

test('explicit cloud choice supersedes pending installation; late local completion stays inert', async t => {
  const { h, el, instances, installation, installs } = recognitionController(t);
  const local = h.start({ gesture: true }); await settle();
  assert.equal(installs(), 1);
  assert.equal(instances.length, 0, 'no cloud recognition without the user choosing it');
  assert.equal(el.localOnly.checked, true);
  const oldAttempt = h.activeStart;
  await h.useCloudInstead();
  assert.equal(oldAttempt.signal.aborted, true, 'cloud click must cancel the local attempt');
  assert.equal(el.localOnly.checked, false);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].processLocally, false);
  assert.notEqual(h.activeStart, oldAttempt);
  assert.equal((await local).cancelled, true);
  const cloudAttempt = h.activeStart, cloudStatus = el.status.textContent;
  installation.resolve(true); await settle();
  assert.equal(instances.length, 1);
  assert.equal(h.activeStart, cloudAttempt);
  assert.equal(el.status.textContent, cloudStatus);
  assert.equal(el.record.getAttribute('aria-pressed'), 'true');
});

test('delayed onend after Stop resolves preserves the tab-ended reason until the next recognizer', async t => {
  const { h, el, instances } = recognitionController(t);
  el.localOnly.checked = false;
  await h.start({ gesture: true }); instances[0].onstart();
  const end = instances[0].onend;
  const reason = 'Tab audio ended. The transcript is kept. Click the toolbar icon on the meeting tab, then press Record.';
  await h.stop({ reason });
  assert.equal(h.stopInProgress, false);
  assert.equal(el.status.textContent, reason);
  end();
  assert.equal(el.status.textContent, reason, 'onend is a later browser task, not a Stop microtask');
  assert.equal(el.record.getAttribute('aria-pressed'), 'false');
  await h.start({ gesture: true }); instances[1].onstart();
  assert.match(el.status.textContent, /^Listening/);
  instances[1].onerror({ error: 'not-allowed' }); instances[1].onend();
  assert.match(el.status.textContent, /Chrome denied speech recognition/);
  assert.equal(el.record.getAttribute('aria-pressed'), 'false');
});

test('restart-limit has its specific retry remedy', t => {
  const { h } = recognitionController(t);
  assert.match(h.fatalRecognitionMessage('restart-limit'), /repeatedly stopped without making progress/);
});

function microphoneController() {
  const el = Object.fromEntries(['micHint', 'micGrant', 'micStatus', 'includeMic', 'prefsPanel', 'status', 'issues']
    .map(name => [name, element()]));
  el.includeMic.checked = true;
  el.prefsPanel.hidden = true;
  el.status.textContent = 'Listening to the meeting.';
  const h = controller(['onMicState', 'refreshMicPermission', 'setMicIndicator', 'disableMic', 'setMicHint', 'showIssue'], {
    el, MIC_MESSAGES, MicTranscriber, mic: { running: false }, micBlocked: false, micGranted: true,
    issues: new Map(), document: { createElement: element }, console: { warn() {} },
  });
  return { h, el };
}
for (const reason of ['network', 'language-not-supported', 'ended']) {
  test(`microphone ${reason} stays visible and announced after permission refresh`, async t => {
    t.mock.method(MicTranscriber, 'permissionState', async () => 'granted');
    const { h, el } = microphoneController();
    h.onMicState({ running: false, reason, error: 'browser detail' });
    assert.match(el.micHint.textContent, new RegExp(MIC_MESSAGES[reason].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await settle();
    assert.ok(el.micHint.textContent.startsWith(MIC_MESSAGES[reason]));
    assert.equal(el.micHint.classList.contains('denied'), true);
    assert.equal(el.micStatus.dataset.state, 'error');
    assert.ok(el.micStatus.getAttribute('aria-label').includes(MIC_MESSAGES[reason]));
    assert.equal(el.prefsPanel.hidden, true);
    assert.equal(el.issues.hidden, false);
    assert.ok(el.issues.children.some(p => p.textContent.includes(MIC_MESSAGES[reason])));
    const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
    assert.match(html, /id="issues"[^>]*role="alert"/);
    assert.ok(html.indexOf('id="issues"') > html.indexOf('id="status"'), 'warning is outside closed Preferences');
    assert.equal(el.status.textContent, 'Listening to the meeting.');
    h.onMicState({ running: false }); await settle();
    assert.ok(el.micHint.textContent.startsWith(MIC_MESSAGES[reason]), 'clean stop is not recovery');
    assert.equal(el.issues.hidden, false);
    // The existing deliberate re-tick clears micBlocked; permission refresh now
    // reflects this retry instead of indefinitely retaining the old failure.
    h.micBlocked = false; await h.refreshMicPermission();
    assert.equal(el.issues.hidden, true);
    assert.equal(el.micHint.classList.contains('denied'), false);
    h.onMicState({ running: false, reason, error: 'again' }); await settle();
    h.mic.running = true; h.onMicState({ running: true }); await settle();
    assert.equal(h.micBlocked, false);
    assert.equal(el.issues.hidden, true);
    assert.equal(el.micStatus.dataset.state, 'recording');
  });
}
