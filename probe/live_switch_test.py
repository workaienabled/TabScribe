"""Switching views must not stop the meeting, or silently drop the microphone.

Two defects reported from real use, both on the new Window/Sidebar switch:

  1. Going window -> sidebar STOPS recording. claimHandoff() runs only when
     IS_WINDOW, so the panel never claims the snapshot the window just wrote. It
     falls through to the autosave, which carries no resume flag, and the meeting
     quietly ends.

  2. The microphone indicator goes green -> grey across the switch. The resume
     path calls start() with no gesture, and start() refuses to open the
     microphone without one — deliberately, because a gesture-less getUserMedia
     is auto-denied and would report a refusal the user never saw. But the switch
     IS a click, so that gesture exists and is being thrown away.

These are asserted with a REAL recognizer running over real fixture audio,
because both bugs are about a live session surviving a document swap. A stubbed
transcriber would pass while the product failed.

Run with DISPLAY pointing at a private Xvfb. Owns port 8899, so never run it
concurrently with another audio suite.
"""
import functools
import http.server
import json
import os
import shutil
import socketserver
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipe_chrome import PipeChrome  # noqa: E402
from toolbar_click import click_toolbar_icon  # noqa: E402
from e2e_full import (pin_extension, prepare_profile, unpacked_extension_id,  # noqa: E402
                      graft_model_registration, MODEL_CACHE, PORT, CLIP, HERE)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
OUT.mkdir(parents=True, exist_ok=True)
PROFILE = '/tmp/tabscribe-liveswitch-profile'
EXT = str(ROOT / 'extension')


class Checks:
    def __init__(self):
        self.rows = []

    def add(self, name, ok, detail=''):
        self.rows.append((name, bool(ok)))
        print(f'  [{"PASS" if ok else "FAIL"}] {name}'
              + (f' — {detail}' if detail else ''), flush=True)

    def finish(self):
        passed = sum(1 for _, ok in self.rows if ok)
        print(f'RESULT: {passed}/{len(self.rows)} checks passed', flush=True)
        return 0 if passed == len(self.rows) else 1


def find_target(chrome, needle, exclude=None):
    for t in chrome.targets():
        url = t.get('url', '')
        if needle in url and (exclude is None or exclude not in url):
            return t
    return None


def real_click(chrome, sid, element_id):
    """A genuine input event: the gesture is the whole point of these checks."""
    rect = chrome.evaluate(sid, f"""(() => {{
      const r = document.getElementById('{element_id}').getBoundingClientRect();
      return {{x: r.x + r.width / 2, y: r.y + r.height / 2}};
    }})()""", await_promise=False)
    for kind in ('mousePressed', 'mouseReleased'):
        chrome.send('Input.dispatchMouseEvent', session_id=sid, type=kind,
                    button='left', clickCount=1, **rect)


def state_of(chrome, sid):
    return chrome.evaluate(sid, """({
      pressed: document.getElementById('recordBtn').getAttribute('aria-pressed'),
      dot: document.getElementById('dot').dataset.state,
      mic: document.getElementById('micStatusBtn').dataset.state,
      segs: document.querySelectorAll('.seg').length,
      status: document.getElementById('status').textContent,
      issues: document.getElementById('issues')?.innerText || '',
      recordDisabled: document.getElementById('recordBtn').disabled,
    })""", await_promise=False)


def main():
    checks = Checks()
    if os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE)
    ext_id = unpacked_extension_id(EXT)
    prepare_profile(PROFILE, MODEL_CACHE)

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    # Measured in e2e_full: --use-fake-device-for-media-stream and
    # --use-fake-ui-for-media-stream both break tabCapture in this harness with
    # "Cannot capture a tab with an active stream", with the microphone feature
    # off as well — so they would test the flag, not the feature. The microphone
    # permission is granted over CDP below instead, and getUserMedia opens a real
    # silent input device, leaving tab capture alone.
    warm = PipeChrome(PROFILE, extensions=[], fresh=False)
    warm.launch('about:blank')
    time.sleep(3)
    warm.kill()
    time.sleep(2)
    # Pin only after Default/Preferences exists, and before the real launch.
    pin_extension(PROFILE, ext_id)
    graft_model_registration(PROFILE, MODEL_CACHE)

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    try:
        chrome.send('Extensions.loadUnpacked', path=EXT)
        time.sleep(2)
        # Grant the microphone on the extension's own origin, the way the real
        # grant page does, so start() may open it without a prompt.
        try:
            chrome.send('Browser.grantPermissions',
                        origin=f'chrome-extension://{ext_id}',
                        permissions=['audioCapture'])
        except Exception:  # noqa: BLE001
            pass
        tid, sid = chrome.new_tab(f'http://127.0.0.1:{PORT}/player.html?clip={CLIP}')
        chrome.wait_for_js(sid, "!!document.getElementById('audio')", timeout=20)
        chrome.send('Target.activateTarget', targetId=tid)
        time.sleep(1.5)

        panel = None
        for _ in range(4):
            click_toolbar_icon()
            deadline = time.time() + 8
            while time.time() < deadline and not panel:
                panel = find_target(chrome, 'sidepanel.html')
                if not panel:
                    time.sleep(0.5)
            if panel:
                break
            time.sleep(1.5)
        checks.add('the side panel opens', bool(panel))
        if not panel:
            return checks.finish()
        psid = chrome.attach(panel['targetId'])
        chrome.wait_for_js(psid, "!!document.getElementById('recordBtn')", timeout=30)

        # Microphone on, which is the default, and confirm the option is ticked.
        mic_on = chrome.evaluate(psid, """(() => {
          const box = document.getElementById('includeMic');
          if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change')); }
          return box.checked;
        })()""", await_promise=False)
        checks.add('the microphone option is on', mic_on is True)

        # Start for real, with a real click, so the microphone may open.
        real_click(chrome, psid, 'recordBtn')
        chrome.wait_for_js(psid, "document.getElementById('dot').dataset.state === 'listening'",
                           timeout=90)
        chrome.evaluate(sid, "(() => { const a=document.getElementById('audio'); a.currentTime=0; return a.play(); })()")
        time.sleep(8)
        live = state_of(chrome, psid)
        checks.add('the panel is recording', live['pressed'] == 'true'
                   and live['dot'] == 'listening', json.dumps(live))
        checks.add('and the microphone indicator is live',
                   live['mic'] == 'recording', json.dumps(live))

        # --- panel -> window --------------------------------------------------
        real_click(chrome, psid, 'popoutBtn')
        time.sleep(6)
        win = find_target(chrome, 'sidepanel.html?view=window')
        checks.add('the window opens', bool(win))
        if not win:
            return checks.finish()
        wsid = chrome.attach(win['targetId'])
        chrome.wait_for_js(wsid, "!!document.getElementById('recordBtn')", timeout=30)
        try:
            chrome.wait_for_js(wsid, "document.getElementById('dot').dataset.state === 'listening'",
                               timeout=45)
        except RuntimeError:
            pass
        time.sleep(3)
        in_win = state_of(chrome, wsid)
        checks.add('recording continues in the window',
                   in_win['pressed'] == 'true' and in_win['dot'] == 'listening',
                   json.dumps(in_win))
        checks.add('the microphone is still live in the window',
                   in_win['mic'] == 'recording', json.dumps(in_win))

        # --- window -> sidebar ------------------------------------------------
        real_click(chrome, wsid, 'popoutBtn')
        time.sleep(6)
        back = find_target(chrome, 'sidepanel.html', exclude='view=window')
        checks.add('the sidebar opens again', bool(back))
        if not back:
            return checks.finish()
        bsid = chrome.attach(back['targetId'])
        chrome.wait_for_js(bsid, "!!document.getElementById('recordBtn')", timeout=30)
        try:
            chrome.wait_for_js(bsid, "document.getElementById('dot').dataset.state === 'listening'",
                               timeout=45)
        except RuntimeError:
            pass
        time.sleep(3)
        in_panel = state_of(chrome, bsid)
        checks.add('recording continues in the sidebar',
                   in_panel['pressed'] == 'true' and in_panel['dot'] == 'listening',
                   json.dumps(in_panel))
        checks.add('the microphone is still live in the sidebar',
                   in_panel['mic'] == 'recording', json.dumps(in_panel))
        checks.add('and the transcript came with it',
                   in_panel['segs'] > 0, json.dumps(in_panel))

        # --- the same switch, with a teardown that takes its time ------------
        # The window writes its snapshot only AFTER stopping the recognizer and
        # releasing the capture. On a warm model with a short clip that takes
        # well under a second; a real meeting's final flush, on a busy machine,
        # takes several. If the panel waits a fixed interval it gives up, falls
        # through to the autosave — which carries text but no resume flag — and
        # the meeting silently ends with the transcript still on screen.
        #
        # Delaying the hand-off message reproduces that without pretending to
        # know the real number. The panel must wait for the snapshot, not for a
        # timer.
        real_click(chrome, bsid, 'popoutBtn')
        time.sleep(6)
        win2 = find_target(chrome, 'sidepanel.html?view=window')
        checks.add('the window opens again', bool(win2))
        if not win2:
            return checks.finish()
        w2sid = chrome.attach(win2['targetId'])
        chrome.wait_for_js(w2sid, "!!document.getElementById('recordBtn')", timeout=30)
        try:
            chrome.wait_for_js(w2sid, "document.getElementById('dot').dataset.state === 'listening'",
                               timeout=45)
        except RuntimeError:
            pass
        time.sleep(2)

        chrome.evaluate(w2sid, """(() => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (msg, ...rest) => {
            if (msg && msg.type === 'BACK_TO_PANEL') {
              return new Promise((resolve) => setTimeout(
                () => resolve(send(msg, ...rest)), 4000));
            }
            return send(msg, ...rest);
          };
          return true;
        })()""", await_promise=False)

        real_click(chrome, w2sid, 'popoutBtn')
        time.sleep(12)
        back2 = find_target(chrome, 'sidepanel.html', exclude='view=window')
        checks.add('the sidebar opens despite the slow hand-off', bool(back2))
        if back2:
            b2sid = chrome.attach(back2['targetId'])
            chrome.wait_for_js(b2sid, "!!document.getElementById('recordBtn')", timeout=30)
            try:
                chrome.wait_for_js(b2sid, "document.getElementById('dot').dataset.state === 'listening'",
                                   timeout=45)
            except RuntimeError:
                pass
            time.sleep(2)
            slow = state_of(chrome, b2sid)
            checks.add('recording survives a slow teardown',
                       slow['pressed'] == 'true' and slow['dot'] == 'listening',
                       json.dumps(slow))
            checks.add('and so does the microphone',
                       slow['mic'] == 'recording', json.dumps(slow))
    finally:
        try:
            chrome.kill()
        finally:
            httpd.shutdown()
            if os.path.isdir(PROFILE):
                shutil.rmtree(PROFILE, ignore_errors=True)

    return checks.finish()


if __name__ == '__main__':
    sys.exit(main())
