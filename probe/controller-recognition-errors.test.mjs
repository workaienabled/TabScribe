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
  let installs = 0, installed = false;
  class Recognition {
    // Report what Chrome would: the pack is downloadable until the install
    // actually completes, and available afterwards. A fake that stays
    // 'downloadable' forever would make a successful start look like a failure.
    static available() { return Promise.resolve(installed ? 'available' : 'downloadable'); }
    static install() {
      installs += 1;
      return installation.promise.then((ok) => { installed = ok !== false; return installed; });
    }
    constructor() { instances.push(this); }
    start() {} stop() {} abort() {}
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: { SpeechRecognition: Recognition } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'self', previous) : delete globalThis.self);
  const el = Object.fromEntries(['record', 'lang', 'localOnly', 'status', 'downloadModel',
    'retryModel', 'modelActions'].map(name => [name, element()]));
  el.localOnly.checked = true; el.lang.value = 'en-US';
  const track = { readyState: 'live' };
  const h = controller(['downloadModelNow', 'start', 'stop', 'ensureTranscriber', 'fatalRecognitionMessage', 'setStatus'], {
    el, Transcriber, AbortController, activeStart: null, stopInProgress: false,
    modelDownload: null,
    modelPreviewVersion: 0, armed: true, micGranted: false, micBlocked: false,
    mic: null, transcriber: null, handedOff: false, handoffBlocked: false, switching: false,
    modelTimer: null,
    graph: { track, ctx: { state: 'running' } },
    armCapture: async () => ({ ok: true }),
    hideModelPanel() {}, savePrefsFromUi() {}, onModelProgress() {}, render() {},
    attachMic() {}, switchLog() {}, teardown: async () => {}, setState() {},
    setRecording(recording) { el.record.setAttribute('aria-pressed', String(recording)); },
  });
  t.after(async () => { h.activeStart?.abort(); h.modelDownload?.abort(); await h.transcriber?.stop({ flushMs: 0 }); });
  return { h, el, instances, installation, installs: () => installs };
}

test('Download now installs the model without capturing the tab or entering recording', async t => {
  const { h, el, installation, installs } = recognitionController(t);
  const download = h.downloadModelNow(); await settle();
  assert.equal(installs(), 1, 'the control really starts Chrome\'s install');
  // The whole point of the button: no Record press, so no capture and no
  // recording state. A panel that silently began transcribing would be worse
  // than the extra click it saves.
  assert.equal(el.record.getAttribute('aria-pressed'), undefined);
  assert.equal(h.activeStart, null, 'a download is not a start attempt');
  assert.equal(el.downloadModel.disabled, true, 'the control cannot be pressed twice');
  installation.resolve(true);
  await download;
  assert.equal(el.downloadModel.disabled, false, 'the control is usable again afterwards');
  assert.equal(h.modelDownload, null, 'the finished download releases its controller');
});

test('a standalone download superseded by Record cannot revive its panel', async t => {
  const { h, el, installation, installs } = recognitionController(t);
  const download = h.downloadModelNow(); await settle();
  assert.equal(installs(), 1);
  const standalone = h.modelDownload;

  // Pressing Record while the standalone download runs: Start owns model
  // preparation from here, so the earlier wait must be abandoned. This is the
  // invariant the removed "Use cloud instead" test protected, re-pointed at the
  // control that replaced it.
  const started = h.start({ gesture: true }); await settle();
  assert.equal(standalone.signal.aborted, true, 'Record supersedes the standalone wait');
  assert.equal(el.record.getAttribute('aria-pressed'), 'true');

  const startAttempt = h.activeStart;
  installation.resolve(true); await settle();
  assert.equal(h.activeStart, startAttempt, 'a late install cannot replace the live attempt');
  assert.equal(el.record.getAttribute('aria-pressed'), 'true');
  await download;
  h.activeStart?.abort();
  await started;
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
