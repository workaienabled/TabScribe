"""The switch back must work even when the old panel document survives.

popOut() asks the worker to close the side panel with sidePanel.close(). That
call is best-effort: it can fail, and on some Chrome builds it does not exist.
When it fails, the old panel document stays alive behind the pop-out window,
inert, with handedOff = true.

Pressing Sidebar in the window then re-shows THAT document. No new document is
created, init() never runs, the hand-off snapshot is never claimed, and the old
document's focus handler takes the tab back with "Press Record to transcribe" —
the meeting has stopped, with a stale transcript on screen.

Every previous fix lived inside init(), so none of them could reach this case,
and the harness could not show it because sidePanel.close() works there. This
suite forces the survivor by asking OPEN_WINDOW not to close the panel — a field
the message already carries — and requires the switch back to resume recording
regardless of which panel document Chrome ends up showing.

Real recognizer, real audio, real microphone grant. Owns port 8899.
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
PROFILE = '/tmp/tabscribe-survivor-profile'
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


def panels(chrome):
    return [t for t in chrome.targets()
            if 'sidepanel.html' in t.get('url', '') and 'view=window' not in t.get('url', '')]


def find(chrome, needle, exclude=None):
    for t in chrome.targets():
        url = t.get('url', '')
        if needle in url and (exclude is None or exclude not in url):
            return t
    return None


def real_click(chrome, sid, element_id):
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

    warm = PipeChrome(PROFILE, extensions=[], fresh=False)
    warm.launch('about:blank')
    time.sleep(3)
    warm.kill()
    time.sleep(2)
    pin_extension(PROFILE, ext_id)
    graft_model_registration(PROFILE, MODEL_CACHE)

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    try:
        chrome.send('Extensions.loadUnpacked', path=EXT)
        time.sleep(2)
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
                panel = find(chrome, 'sidepanel.html')
                if not panel:
                    time.sleep(0.5)
            if panel:
                break
            time.sleep(1.5)
        checks.add('the side panel opens', bool(panel))
        if not panel:
            return checks.finish()
        first_panel_id = panel['targetId']
        psid = chrome.attach(first_panel_id)
        chrome.wait_for_js(psid, "!!document.getElementById('recordBtn')", timeout=30)

        real_click(chrome, psid, 'recordBtn')
        chrome.wait_for_js(psid, "document.getElementById('dot').dataset.state === 'listening'",
                           timeout=90)
        chrome.evaluate(sid, "(() => { const a=document.getElementById('audio'); a.currentTime=0; return a.play(); })()")
        time.sleep(8)
        live = state_of(chrome, psid)
        checks.add('the panel is recording', live['dot'] == 'listening', json.dumps(live))

        # Force the survivor: pop out WITHOUT closing this panel document. The
        # OPEN_WINDOW message already carries closePanel; only the harness sets
        # it, and it reproduces exactly what a failed sidePanel.close() leaves.
        chrome.evaluate(psid, """(() => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (msg, ...rest) => {
            if (msg && msg.type === 'OPEN_WINDOW') msg = {...msg, closePanel: false};
            return send(msg, ...rest);
          };
          return true;
        })()""", await_promise=False)
        real_click(chrome, psid, 'popoutBtn')
        time.sleep(6)
        win = find(chrome, 'sidepanel.html?view=window')
        checks.add('the window opens', bool(win))
        survivors = panels(chrome)
        checks.add('and the old panel document is still alive (the case under test)',
                   any(t['targetId'] == first_panel_id for t in survivors),
                   json.dumps([t['targetId'][:12] for t in survivors]))
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
        checks.add('recording continues in the window', in_win['dot'] == 'listening',
                   json.dumps(in_win))

        # --- Sidebar, with the survivor in play -------------------------------
        real_click(chrome, wsid, 'popoutBtn')
        time.sleep(10)
        after = panels(chrome)
        checks.add('a side panel is showing after the switch', len(after) >= 1,
                   json.dumps([t['targetId'][:12] for t in after]))

        # Whichever document Chrome shows, it must be the live one. Read them
        # all: a stale survivor sitting next to a fresh one is also a failure,
        # because the user sees only one and cannot tell which.
        states = []
        for t in after:
            try:
                s = chrome.attach(t['targetId'])
                chrome.wait_for_js(s, "!!document.getElementById('recordBtn')", timeout=20)
                try:
                    chrome.wait_for_js(
                        s, "document.getElementById('dot').dataset.state === 'listening'",
                        timeout=40)
                except RuntimeError:
                    pass
                st = state_of(chrome, s)
                st['reused'] = t['targetId'] == first_panel_id
                states.append(st)
            except Exception as e:  # noqa: BLE001
                states.append({'error': str(e)[:100]})
        print(f'  panel documents after switch: {json.dumps(states)}', flush=True)

        recording = [s for s in states if s.get('dot') == 'listening' and s.get('pressed') == 'true']
        checks.add('recording resumed in the side panel', len(recording) >= 1,
                   json.dumps(states))
        checks.add('with the transcript from the window',
                   any(s.get('segs', 0) >= in_win['segs'] for s in recording),
                   json.dumps({'window_segs': in_win['segs'], 'panels': states}))
        checks.add('and no panel document is left saying "Press Record"',
                   not any('Press Record' in (s.get('status') or '') for s in states),
                   json.dumps([s.get('status') for s in states]))
        checks.add('the microphone is live again too',
                   any(s.get('mic') == 'recording' for s in recording), json.dumps(states))

        # The diagnostic must tell the story of what just happened, in order,
        # from a document that survived the whole switch. This is what the next
        # bug report is expected to carry.
        if after:
            s = chrome.attach(after[0]['targetId'])
            log = chrome.evaluate(s, """(async () => {
              const stored = await chrome.storage.session.get('switchLog');
              return stored.switchLog || [];
            })()""", await_promise=True)
            print('  switch log:', flush=True)
            for line in log:
                print(f'    {line}', flush=True)
            joined = '\n'.join(log)
            checks.add('the switch log records the window announcing the switch',
                       'announced SWITCH_PENDING' in joined)
            checks.add('and the snapshot being handed over',
                       'BACK_TO_PANEL sending' in joined and '"resume":true' in joined)
            checks.add('and the survivor claiming it',
                       'survivor claim' in joined and '"received":true' in joined)
            checks.add('and recording resuming',
                       'resume start ok' in joined)
            # The log is no longer shown in the panel — it is developer output,
            # and this UI is meant to be minimal. The RECORD must still exist
            # (read via chrome.storage.session), which the checks above assert,
            # and it must NOT be rendered, which this one does.
            checks.add('the log is kept out of the panel UI',
                       chrome.evaluate(s, """(() => (!document.getElementById('switchLog')
                                                && !document.getElementById('switchLogText')))()""",
                                       await_promise=False))
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
