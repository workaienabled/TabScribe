"""A panel talking to a worker that lacks its handlers must not fail silently.

Found in the user's real Chrome over CDP. The extension's files on disk were
current, but the service worker in memory predated them: every original
handler (GET_TARGET, GET_HOST_WINDOW, CLAIM_HANDOFF) answered, and the one added
three commits earlier (GET_SWITCH_PENDING) returned undefined. Chrome had kept
the old worker across an unpacked reload.

So BACK_TO_PANEL fell through to `return false` in the stale worker, the window
logged `sent {"ok":false}` — a boolean with no reason — no snapshot was stored,
and recording stopped. Four fixes to the hand-off logic could not touch this,
because the logic was fine; the process running it was not.

Two things are asserted here:

  1. The worker's replies carry a version, and the panel checks it at startup.
     A mismatch is REPORTED — in the status line and the switch log — instead of
     surfacing later as an unrelated failure.
  2. On the switch path, a missing or unversioned reply is treated as the stale
     worker it is: the window keeps its transcript and recording and says why,
     rather than closing itself on a hand-off that never happened.

The stale worker is simulated by intercepting sendMessage in the window, which
is exactly what the real one looked like from the window's side: known messages
answered, new ones undefined.

Real recognizer, real audio. Owns port 8899.
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
PROFILE = '/tmp/tabscribe-staleworker-profile'
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
        psid = chrome.attach(panel['targetId'])
        chrome.wait_for_js(psid, "!!document.getElementById('recordBtn')", timeout=30)

        # --- 1. a healthy pair agrees on a version --------------------------
        agree = chrome.evaluate(psid, """(async () => {
          const r = await chrome.runtime.sendMessage({type: 'GET_TARGET'});
          return {workerVersion: r && r.workerVersion,
                  panelVersion: window.PROTOCOL_VERSION ?? null,
                  status: document.getElementById('status').textContent};
        })()""", await_promise=True)
        checks.add('worker replies carry a protocol version',
                   isinstance(agree.get('workerVersion'), int), json.dumps(agree))
        checks.add('the panel knows its own protocol version',
                   isinstance(agree.get('panelVersion'), int), json.dumps(agree))
        checks.add('and a healthy pair agrees, with no warning shown',
                   agree.get('workerVersion') == agree.get('panelVersion')
                   and 'reload' not in (agree.get('status') or '').lower(), json.dumps(agree))

        # Record, pop out, so there is a live meeting to protect.
        real_click(chrome, psid, 'recordBtn')
        chrome.wait_for_js(psid, "document.getElementById('dot').dataset.state === 'listening'",
                           timeout=90)
        chrome.evaluate(sid, "(() => { const a=document.getElementById('audio'); a.currentTime=0; return a.play(); })()")
        time.sleep(6)
        real_click(chrome, psid, 'popoutBtn')
        time.sleep(6)
        win = find(chrome, 'sidepanel.html?view=window')
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
        time.sleep(2)
        before = chrome.evaluate(wsid, """({
          dot: document.getElementById('dot').dataset.state,
          segs: document.querySelectorAll('.seg').length,
        })""", await_promise=False)
        checks.add('the window is recording', before['dot'] == 'listening', json.dumps(before))

        # --- 2. now the worker is stale: new messages get no reply ----------
        # From the window's side this is exactly what the user's Chrome did:
        # original handlers answered, the newer ones returned undefined.
        chrome.evaluate(wsid, """(() => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          const NEW = new Set(['SWITCH_PENDING', 'GET_SWITCH_PENDING', 'BACK_TO_PANEL']);
          chrome.runtime.sendMessage = (msg, ...rest) => {
            if (msg && NEW.has(msg.type)) return Promise.resolve(undefined);
            return send(msg, ...rest).then((r) => {
              // An old worker's replies carry no version.
              if (r && typeof r === 'object') { const c = {...r}; delete c.workerVersion; return c; }
              return r;
            });
          };
          return true;
        })()""", await_promise=False)

        real_click(chrome, wsid, 'popoutBtn')
        time.sleep(8)

        still = find(chrome, 'sidepanel.html?view=window')
        checks.add('the window does NOT close itself on a failed hand-off', bool(still))
        if still:
            after = chrome.evaluate(wsid, """({
              dot: document.getElementById('dot').dataset.state,
              pressed: document.getElementById('recordBtn').getAttribute('aria-pressed'),
              segs: document.querySelectorAll('.seg').length,
              status: document.getElementById('status').textContent,
              popoutEnabled: !document.getElementById('popoutBtn').disabled,
            })""", await_promise=False)
            checks.add('and keeps its transcript', after['segs'] >= before['segs'], json.dumps(after))
            checks.add('and is still recording', after['dot'] == 'listening'
                       and after['pressed'] == 'true', json.dumps(after))
            checks.add('and says the extension needs reloading, not "could not reopen"',
                       'reload' in after['status'].lower()
                       and 'could not reopen' not in after['status'].lower(),
                       json.dumps(after))
            checks.add('and the switch control is usable again',
                       after['popoutEnabled'] is True, json.dumps(after))

            log = chrome.evaluate(wsid, """(async () => {
              const s = await chrome.storage.session.get('switchLog');
              return s.switchLog || [];
            })()""", await_promise=True)
            joined = '\n'.join(log)
            print('  switch log:', flush=True)
            for line in log:
                print(f'    {line}', flush=True)
            checks.add('the switch log names the stale worker as the cause',
                       'stale' in joined.lower() or 'reload' in joined.lower(), joined)
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
