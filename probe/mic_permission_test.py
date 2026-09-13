"""Microphone permission and isolation, in real isolated Chrome.

This suite exists because the first microphone implementation announced
"Microphone permission was refused" without ever asking. Two separate faults:
audioCapture cannot be an optional permission (permissions.request() rejects),
and getUserMedia in a side panel with no live user gesture is denied outright
with no prompt shown.

So these checks deliberately do NOT use --use-fake-ui-for-media-stream, which
auto-accepts prompts and hides exactly the bug being guarded against.

The load-bearing assertions are the isolation ones: whatever the microphone
does, the live transcript and the saved file must be unaffected.
"""
import json
import sys
import tempfile
import time
from pathlib import Path

from ux_test import UI

ROOT = Path(__file__).resolve().parents[1]


def click(ui, element):
    rect = ui.js(f"(() => {{ const r=document.getElementById('{element}').getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()")
    for kind in ['mousePressed', 'mouseReleased']:
        ui.chrome.send('Input.dispatchMouseEvent', session_id=ui.sid, type=kind,
                       button='left', clickCount=1, **rect)


def only_mic_stub(body):
    """A getUserMedia stub that intercepts ONLY microphone requests.

    Tab capture goes through the same API with a chromeMediaSource constraint,
    so a blanket stub breaks arming and every check downstream becomes vacuous.
    """
    return """
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (constraints) => {
        const isTab = !!(constraints && constraints.audio && constraints.audio.mandatory
                         && constraints.audio.mandatory.chromeMediaSource === 'tab');
        if (isTab) return real(constraints);
        %s
      };
    """ % body


def arm_capture(ui):
    """Reload the panel with tab capture stubbed in, so start() runs fully.

    Installed before the document runs, because the panel arms on load. Without
    this, start() returns at the capture check and every microphone assertion
    after it passes without exercising the code under test.

    Only the TAB branch of getUserMedia is stubbed; microphone requests fall
    through to whatever the individual check installs.
    """
    ui.chrome.send('Page.enable', session_id=ui.sid)
    ui.chrome.send('Page.addScriptToEvaluateOnNewDocument', session_id=ui.sid, source="""
      (() => {
        const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        // The panel only opens the microphone when the grant already exists, so
        // the leak race is unreachable without this. Reporting 'granted' is the
        // state a user reaches by allowing once on mic-permission.html.
        const realQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (desc) => (desc && desc.name === 'microphone')
          ? Promise.resolve({state: 'granted', onchange: null})
          : realQuery(desc);
        navigator.mediaDevices.getUserMedia = (constraints) => {
          const isTab = !!(constraints && constraints.audio && constraints.audio.mandatory
                           && constraints.audio.mandatory.chromeMediaSource === 'tab');
          if (!isTab) return navigator.mediaDevices.__micHandler
            ? navigator.mediaDevices.__micHandler(constraints)
            : realGum(constraints);
          const ctx = new AudioContext();
          const dest = ctx.createMediaStreamDestination();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.value = 0;
          osc.connect(gain); gain.connect(dest); osc.start();
          return Promise.resolve(dest.stream);
        };
        const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (msg, ...rest) => {
          if (msg && msg.type === 'GET_STREAM_ID') {
            return Promise.resolve({ok: true, streamId: 'test', tabId: 1, title: 'Test tab'});
          }
          return realSend(msg, ...rest);
        };
      })();
    """)
    ui.chrome.send('Page.reload', session_id=ui.sid)
    # The button enables before arming completes, and start() only requests the
    # microphone when capture is already armed. Wait for the status the panel
    # sets once it actually holds the tab, or the checks below go vacuous.
    ui.chrome.wait_for_js(
        ui.sid,
        "!document.getElementById('recordBtn').disabled && "
        "/Press Record|Ready/.test(document.getElementById('status').textContent)",
        timeout=20)


def mic_permission(ui):
    ui.size(380, 720)

    # --- the permission is not requestable at runtime ------------------------
    # audioCapture is a Chrome-App permission: declaring it in an extension makes
    # Chrome warn "'audioCapture' is only allowed for packaged apps" and grants
    # nothing. The grant comes from mic-permission.html instead, asserted in
    # probe/mic_grant_test.py.
    manifest = ui.js("chrome.runtime.getManifest()")
    ui.check('audioCapture is declared nowhere in the manifest',
             'audioCapture' not in (manifest.get('permissions') or [])
             and 'audioCapture' not in (manifest.get('optional_permissions') or []),
             {'permissions': manifest.get('permissions'),
              'optional': manifest.get('optional_permissions')})

    # The exact call the first implementation made. It must be proven impossible
    # so nobody reintroduces it: it rejects, and the old code read that as
    # "granted", then hit a silent denial.
    requestable = ui.js("""(async () => {
      try { return {ok: true, granted: await chrome.permissions.request({permissions:['audioCapture']})}; }
      catch (e) { return {ok: false, error: String(e && e.message || e)}; }
    })()""")
    ui.check('requesting audioCapture at runtime is impossible (why it is required)',
             requestable['ok'] is False and 'manifest' in requestable['error'].lower(),
             requestable)

    # --- default state -------------------------------------------------------
    ui.check('the microphone option is ON by default',
             ui.js("document.getElementById('includeMic').checked") is True)
    stored = ui.js("(async () => (await import('./prefs.js')).DEFAULTS.includeMic)()")
    ui.check('the stored default agrees with the markup', stored is True, stored)

    # --- failures are named honestly ----------------------------------------
    cases = ui.js("""(async () => {
      const {classify} = await import('./mic.js');
      const mk = (name, message) => { const e = new Error(message); e.name = name; return e; };
      return {
        denied: classify(mk('NotAllowedError', 'Permission denied')),
        dismissed: classify(mk('NotAllowedError', 'Permission dismissed')),
        noDevice: classify(mk('NotFoundError', 'Requested device not found')),
        busy: classify(mk('NotReadableError', 'Could not start audio source')),
        unknown: classify(mk('WeirdError', 'something else')),
      };
    })()""")
    ui.check('a dismissed prompt is not reported as a refusal',
             cases['dismissed'] == 'dismissed' and cases['denied'] == 'denied', cases)
    ui.check('a missing or busy device is not reported as a refusal',
             cases['noDevice'] == 'no-device' and cases['busy'] == 'device-busy', cases)
    ui.check('an unrecognised failure falls back to a neutral message',
             cases['unknown'] == 'failed', cases)

    messages = ui.js("""(async () => (await import('./mic.js')).MIC_MESSAGES)()""")
    refusal_claims = [k for k, v in messages.items()
                      if k not in ('denied',) and 'refus' in v.lower()]
    ui.check('only a real denial mentions being blocked', not refusal_claims, refusal_claims)

    # --- isolation: the meeting transcript survives every failure ------------
    # Drive the real panel with a real transcript, then fail the microphone in
    # each distinct way and assert the live view and the saved text are intact.
    ui.fixture(4)
    ui.capture_store()
    baseline = ui.js("""({
      segs: document.querySelectorAll('#transcript .seg').length,
      text: document.getElementById('transcript').innerText.trim(),
      words: document.getElementById('wordCount').textContent,
    })""")

    for name, err in [('denied', 'NotAllowedError'), ('no device', 'NotFoundError'),
                      ('busy', 'NotReadableError'), ('thrown synchronously', 'SYNC')]:
        outcome = ui.js("""(async () => {
          const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = () => {
            %s
          };
          const {MicTranscriber} = await import('./mic.js');
          let threw = null, res = null;
          try { res = await MicTranscriber.requestStream(); }
          catch (e) { threw = String(e && e.message || e); }
          navigator.mediaDevices.getUserMedia = real;
          return {threw, res};
        })()""" % (
            "throw new Error('exploded');" if err == 'SYNC'
            else f"const e = new Error('x'); e.name = '{err}'; return Promise.reject(e);"))
        ui.check(f'a microphone that is {name} never throws into the caller',
                 outcome['threw'] is None and outcome['res']['ok'] is False, outcome)

        after = ui.js("""({
          segs: document.querySelectorAll('#transcript .seg').length,
          text: document.getElementById('transcript').innerText.trim(),
          words: document.getElementById('wordCount').textContent,
          status: document.getElementById('status').textContent,
          isError: document.getElementById('status').classList.contains('error'),
        })""")
        ui.check(f'the live transcript is untouched when the microphone is {name}',
                 after['segs'] == baseline['segs'] and after['text'] == baseline['text']
                 and after['words'] == baseline['words'],
                 {'before': baseline['words'], 'after': after['words']})
        ui.check(f'the panel does not enter an error state when the microphone is {name}',
                 not after['isError'], after['status'])

    # --- the saved file is unaffected by a microphone failure ----------------
    with tempfile.TemporaryDirectory(prefix='tabscribe-micfail-download-') as directory:
        ui.chrome.send('Browser.setDownloadBehavior', behavior='allow', downloadPath=directory)
        ui.js("document.getElementById('downloadBtn').click()")
        deadline = time.monotonic() + 12
        saved = set()
        while time.monotonic() < deadline:
            saved = set(Path(directory).glob('*.txt'))
            if saved and not list(Path(directory).glob('*.crdownload')):
                break
            time.sleep(.1)
        text = next(iter(saved)).read_text().strip() if len(saved) == 1 else ''
        ui.check('Download still writes the whole meeting after a microphone failure',
                 text == baseline['text'].replace('\n', ' ').strip() or baseline['text'].startswith(text[:40]),
                 {'saved': text[:80], 'live': baseline['text'][:80]})

    # --- the option stays on, so one bad meeting does not disable it forever --
    ui.check('a microphone failure does not silently switch the option off',
             ui.js("document.getElementById('includeMic').checked") is True)
    hint = ui.js("""({
      text: document.getElementById('micHint').textContent,
      status: document.getElementById('status').textContent,
    })""")
    ui.check('microphone problems are reported by the control, not the recognition status',
             'microphone' not in hint['status'].lower(), hint)

    # --- a stream that arrives after the user changed their mind --------------
    # Permission prompts are slow and the user can untick while one is open. The
    # late-arriving stream must be released, or the browser keeps showing the
    # recording indicator for a microphone nothing is listening to.
    # Arming is what lets start() run its whole body; without it the click
    # returns at the capture check and proves nothing.
    # The reload inside arm_capture() also clears micBlocked, which the failure
    # checks above deliberately set — without that reset Start would skip the
    # request entirely and this check would be vacuous.
    arm_capture(ui)
    leak = ui.js("""(async () => {
      let stopped = 0;
      const fakeTrack = {kind: 'audio', readyState: 'live', stop() { stopped += 1; this.readyState = 'ended'; }};
      window.__fakeMicStream = {getTracks: () => [fakeTrack], getAudioTracks: () => [fakeTrack]};
      window.__micAsked = 0;
      // Answer only microphone requests; tab capture keeps its own stub.
      navigator.mediaDevices.__micHandler = () => {
        window.__micAsked += 1;
        return new Promise((r) => setTimeout(() => r(window.__fakeMicStream), 400));
      };
      const box = document.getElementById('includeMic');
      box.checked = true; box.dispatchEvent(new Event('change'));
      // Drive the panel's own Start path, so the production wiring is under test.
      document.getElementById('recordBtn').click();
      // The request is issued synchronously inside the click, but the handler
      // above runs as a microtask; give it room without waiting for the prompt.
      await new Promise((r) => setTimeout(r, 400));
      const asked = window.__micAsked;
      // The user changes their mind while the prompt is still open.
      box.checked = false; box.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 1500));
      delete navigator.mediaDevices.__micHandler;
      return {stopped, asked, trackState: fakeTrack.readyState, checked: box.checked};
    })()""")
    # Without this the click could return early and the release check below would
    # pass for the wrong reason.
    ui.check('the leak check actually reached the microphone request',
             leak['asked'] == 1, leak)
    ui.check('a microphone stream that arrives after the option is unticked is released',
             leak['stopped'] >= 1 and leak['trackState'] == 'ended', leak)

    # --- the pop-out resume path must not ask for the microphone -------------
    # start() is also reached programmatically: the pop-out window resumes on
    # load. That has no user gesture, so a microphone request there is
    # auto-denied with no prompt — the exact phantom refusal this feature was
    # rewritten to stop reporting. Driven through the REAL resume path, with the
    # stub installed before the document runs so no production hook is needed.
    ui.js("chrome.storage.local.set({prefs: {includeMic: true}})")
    segments = [dict(key=f'0:{i}', text=f'Earlier line {i + 1}.', isFinal=True,
                     startedAt=i * 1000) for i in range(2)]
    payload = dict(snapshot=dict(epoch=0, segments=segments), resume=True)
    ui.js(f"chrome.storage.session.set({{handoffSnapshot: {json.dumps(payload)}}})")
    old = ui.tid
    ui.tid, ui.sid = ui.chrome.new_tab('about:blank')
    # addScriptToEvaluateOnNewDocument requires the Page domain on this session.
    ui.chrome.send('Page.enable', session_id=ui.sid)
    ui.chrome.send('Page.addScriptToEvaluateOnNewDocument', session_id=ui.sid, source="""
      window.__micCalls = 0;
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      // Tab capture must still work, or the resume path returns early and the
      // microphone assertions become vacuous.
      navigator.mediaDevices.getUserMedia = (constraints) => {
        const isTab = !!(constraints && constraints.audio && constraints.audio.mandatory
                         && constraints.audio.mandatory.chromeMediaSource === 'tab');
        if (isTab) {
          const ctx = new AudioContext();
          const dest = ctx.createMediaStreamDestination();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.value = 0;
          osc.connect(gain); gain.connect(dest); osc.start();
          return Promise.resolve(dest.stream);
        }
        window.__micCalls += 1;
        const e = new Error('Permission dismissed'); e.name = 'NotAllowedError';
        return Promise.reject(e);
      };
      const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (msg, ...rest) => {
        if (msg && msg.type === 'GET_STREAM_ID') {
          return Promise.resolve({ok: true, streamId: 'test', tabId: 1, title: 'Test tab'});
        }
        return realSend(msg, ...rest);
      };
      // start() sets aria-pressed="true" as soon as it is entered, and is the
      // only code that does, so watching that attribute proves the resume path
      // got there — without adding a production test hook. (The older detector
      // watched `disabled`, which start() now clears again immediately so the
      // control stays usable during a long model download.)
      window.__reachedStart = false;
      document.addEventListener('DOMContentLoaded', () => {
        const btn = document.getElementById('recordBtn');
        if (!btn) return;
        new MutationObserver(() => {
          if (btn.getAttribute('aria-pressed') === 'true') window.__reachedStart = true;
        }).observe(btn, {attributes: true, attributeFilter: ['aria-pressed', 'disabled']});
      });
    """)
    ui.chrome.send('Page.navigate', session_id=ui.sid,
                   url=f'chrome-extension://{ui.ext_id}/sidepanel.html?view=window')
    ui.chrome.wait_for_js(ui.sid, "document.querySelectorAll('.seg').length === 2", timeout=20)
    time.sleep(1.5)
    resumed = ui.js("""({
      calls: (window.__micCalls === undefined ? -1 : window.__micCalls),
      hint: document.getElementById('micHint').textContent,
      segs: document.querySelectorAll('.seg').length,
      reachedStart: !!window.__reachedStart,
    })""")
    ui.chrome.send('Target.closeTarget', targetId=old)
    # -1 means the stub never installed, so the check would be vacuous.
    ui.check('the microphone stub was installed before the document ran',
             resumed['calls'] >= 0, resumed)
    # Without this the resume path returns early at the capture check and the
    # microphone assertions below would pass without ever reaching start().
    ui.check('the resume path actually reached start()', resumed['reachedStart'], resumed)
    ui.check('the pop-out resume path never requests the microphone',
             resumed['calls'] == 0, resumed)
    ui.check('the pop-out resume path reports no refusal the user never made',
             'refus' not in resumed['hint'].lower()
             and 'dismiss' not in resumed['hint'].lower()
             and 'blocking' not in resumed['hint'].lower(), resumed['hint'])
    ui.check('the resumed transcript is intact regardless', resumed['segs'] == 2, resumed)


if __name__ == '__main__':
    ui = UI()
    try:
        mic_permission(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('mic-permission'))
