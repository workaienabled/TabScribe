"""Fault injection at browser boundaries, with the real panel/DOM/controller.

These are failure-path tests, not evidence of recognition accuracy. Faults replace
only Chrome API boundaries; production code contains no test hooks. Healthy speech,
clipboard and downloads remain covered by the real-browser regression suites.
"""
import json
import sys
import time

from ux_test import UI

BOOT = r"""
(() => {
  window.fault = {};
  window.unhandled = [];
  window.recognizers = [];
  window.captureTracks = [];
  addEventListener('unhandledrejection', e => unhandled.push(String(e.reason)));
  addEventListener('error', e => unhandled.push(String(e.message)));
  class Recognition {
    static async available() {
      if (fault.availabilityError) throw new DOMException('Policy blocked the availability check', 'NotAllowedError');
      return fault.availability || 'available';
    }
    static async install() {
      if (fault.holdInstall) return new Promise(resolve => { window.finishInstall = resolve; });
      if (fault.installError) throw new Error(fault.installError);
      return false;
    }
    constructor() { recognizers.push(this); }
    start() {
      if (fault.startThrows) throw new DOMException('Recognizer failed to start', 'InvalidStateError');
      if (!fault.beforeStart) queueMicrotask(() => this.onstart?.());
    }
    stop() { queueMicrotask(() => this.onend?.()); }
    abort() { queueMicrotask(() => this.onend?.()); }
    fail(code, message='') { this.onerror?.({error:code, message}); this.onend?.(); }
  }
  window.SpeechRecognition = Recognition;
  const createSource = AudioContext.prototype.createMediaStreamSource;
  AudioContext.prototype.createMediaStreamSource = function(...args) {
    if (fault.graphThrows) throw new Error('Audio graph construction failed');
    return createSource.apply(this, args);
  };
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    if (!constraints?.audio?.mandatory) return gum(constraints);
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const source = ctx.createConstantSource(); source.offset.value = 0;
    source.connect(dest); source.start();
    captureTracks.push(...dest.stream.getTracks());
    return dest.stream;
  };
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  window.msgCalls = [];
  chrome.runtime.sendMessage = (msg, ...args) => {
    msgCalls.push(msg?.type);
    if (fault.rejectType === msg?.type) return Promise.reject(new Error('Injected ' + msg.type + ' failure'));
    if (fault.failType === msg?.type) return Promise.resolve({ok:false, error:'Injected ' + msg.type + ' failure', workerVersion:4, safeToResume:fault.safeToResume===true});
    if (msg?.type === 'GET_STREAM_ID') return Promise.resolve({ok:true, streamId:'fixture', tabId:1, title:'Fault test', workerVersion:window.PROTOCOL_VERSION});
    return send(msg, ...args);
  };
})();
"""


def snapshot(ui):
    return ui.js("""({
      status: document.getElementById('status').textContent,
      error: document.getElementById('status').classList.contains('error'),
      pressed: document.getElementById('recordBtn').getAttribute('aria-pressed'),
      disabled: document.getElementById('recordBtn').disabled,
      state: document.getElementById('dot').dataset.state,
      segs: document.querySelectorAll('.seg').length,
      unhandled: window.unhandled,
    })""")


def prepare(ui):
    ui.chrome.send('Page.enable', session_id=ui.sid)
    ui.chrome.send('Page.addScriptToEvaluateOnNewDocument', session_id=ui.sid, source=BOOT)
    reload(ui)


def reload(ui):
    ui.chrome.send('Page.reload', session_id=ui.sid)
    ui.chrome.wait_for_js(ui.sid, "!!window.fault && /Ready|restored|Press Record/.test(document.getElementById('status').textContent)", timeout=20)
    ui.js("document.getElementById('includeMic').checked = false")


def fatal(ui):
    for before in [False, True]:
        for local in [True, False]:
            reload(ui)
            ui.js(f"""(() => {{
              fault.beforeStart = {json.dumps(before)};
              document.getElementById('localOnly').checked = {json.dumps(local)};
              document.getElementById('recordBtn').click();
            }})()""")
            ui.chrome.wait_for_js(ui.sid, 'recognizers.length > 0')
            ui.js("recognizers.at(-1).fail('language-not-supported', 'test service detail')")
            time.sleep(.2)
            state = snapshot(ui)
            ui.check(f'fatal language failure remains an error (beforeStart={before}, local={local})',
                     state['error'] and 'language' in state['status'].lower(), state)
            ui.check('fatal stop resets Record and offers a retry',
                     state['pressed'] == 'false' and not state['disabled'], state)
            ui.check('language failure does not invent a missing model diagnosis',
                     'not installed' not in state['status'].lower(), state)
            if not local:
                ui.check('cloud failure is not described as a local-model failure',
                         'cloud' in state['status'].lower() and 'on-device' not in state['status'].lower(), state)
            ui.check('fatal path produces no unhandled exceptions', not state['unhandled'], state)


def model_failures(ui):
    reload(ui)
    ui.js("fault.availabilityError = true; document.getElementById('recordBtn').click()")
    time.sleep(.4)
    state = snapshot(ui)
    ui.check('availability rejection reports its cause, not a nonexistent API',
             state['error'] and 'Policy blocked' in state['status'] and '150' not in state['status'], state)

    reload(ui)
    ui.js("""fault.availability = 'downloadable'; fault.installError = '<b id="injected-error">blocked</b>';
      document.getElementById('recordBtn').click();""")
    time.sleep(.4)
    data = ui.js("""({text: document.getElementById('modelBody').textContent,
      injected: !!document.getElementById('injected-error'), errors: unhandled})""")
    ui.check('model failure detail is text, never injected HTML',
             not data['injected'] and '<b' in data['text'], data)
    ui.check('model failure is handled without unhandled rejections', not data['errors'], data)

    reload(ui)
    ui.js("fault.holdInstall = true; fault.availability = 'downloadable'; document.getElementById('recordBtn').click()")
    ui.chrome.wait_for_js(ui.sid, "typeof finishInstall === 'function'")
    ui.js("document.getElementById('recordBtn').click()")
    ui.chrome.wait_for_js(ui.sid, "!document.getElementById('recordBtn').disabled", timeout=6)
    ui.js("fault.availability = 'available'; finishInstall(true)")
    time.sleep(.4)
    data = snapshot(ui)
    ui.check('cancelling a model download cannot later start recognition',
             ui.js('recognizers.length') == 0 and data['pressed'] == 'false', data)
    ui.check('cancelled preparation stops its progress UI',
             ui.js("document.getElementById('modelPanel').hidden"), data)


if __name__ == '__main__':
    ui = UI()
    try:
        prepare(ui)
        fatal(ui)
        model_failures(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('error-paths'))
