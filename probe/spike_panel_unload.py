"""Spike: does the SIDE PANEL document honour beforeunload?

The previous spike closed the panel with Target.closeTarget, which is a
CDP-level force close and may bypass beforeunload regardless of what the
document wants. That makes its "no dialog" result inconclusive.

This asks the fair question instead: with a beforeunload handler installed and
a real user activation present, does NAVIGATING the side panel document get
blocked by a dialog, the way it does in a tab?

Either answer is useful:
  blocked  -> the panel document honours beforeunload, and the remaining
              question is only whether Chrome's panel-dismiss path triggers it.
  allowed  -> the side panel cannot warn at all, and the feature can only be
              honest about covering the pop-out window and page closes.

Throwaway. Run with DISPLAY on a private Xvfb.
"""
import json
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipe_chrome import PipeChrome  # noqa: E402
from toolbar_click import click_toolbar_icon  # noqa: E402
from e2e_full import pin_extension  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
PROFILE = '/tmp/tabscribe-panelunload-profile'


def record(findings, key, value):
    findings[key] = value
    (OUT / 'panel-unload-spike.json').write_text(json.dumps(findings, indent=2))
    print(f'{key}: {json.dumps(value)}', flush=True)


def main():
    findings = {}
    ext = str(ROOT / 'extension')
    import hashlib
    digest = hashlib.sha256(os.path.abspath(ext).encode()).hexdigest()[:32]
    ext_id = ''.join(chr(ord('a') + int(c, 16)) for c in digest)

    if os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE)
    warm = PipeChrome(PROFILE, extensions=[], fresh=False)
    warm.launch('about:blank')
    time.sleep(3)
    warm.kill()
    time.sleep(2)
    pin_extension(PROFILE, ext_id)

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    try:
        chrome.send('Extensions.loadUnpacked', path=ext)
        time.sleep(2)
        tid, sid = chrome.new_tab(
            'data:text/html,<title>TabScribe test audio</title><h1>fixture</h1>')
        chrome.send('Target.activateTarget', targetId=tid)
        time.sleep(2)

        panel = None
        for _ in range(4):
            click_toolbar_icon()
            deadline = time.time() + 8
            while time.time() < deadline and not panel:
                for t in chrome.targets():
                    if 'sidepanel.html' in t.get('url', ''):
                        panel = t
                        break
                time.sleep(0.5)
            if panel:
                break
            time.sleep(1.5)
        record(findings, 'panel_opened', bool(panel))
        if not panel:
            raise SystemExit('side panel never opened')

        psid = chrome.attach(panel['targetId'])
        chrome.wait_for_js(psid, "!!document.getElementById('startBtn')", timeout=30)
        chrome.send('Page.enable', session_id=psid)
        chrome.evaluate(psid, """(() => {
          window.addEventListener('beforeunload', (e) => {
            e.preventDefault();
            e.returnValue = '';
            return '';
          });
          return true;
        })()""", await_promise=False)

        # A real click inside the panel, so sticky activation exists.
        rect = chrome.evaluate(psid, """(() => {
          const r = document.getElementById('prefsBtn').getBoundingClientRect();
          return {x: r.x + r.width / 2, y: r.y + r.height / 2};
        })()""", await_promise=False)
        for kind in ('mousePressed', 'mouseReleased'):
            chrome.send('Input.dispatchMouseEvent', session_id=psid, type=kind,
                        button='left', clickCount=1, **rect)
        time.sleep(0.5)
        record(findings, 'panel_activation', chrome.evaluate(
            psid, "navigator.userActivation ? navigator.userActivation.hasBeenActive : 'n/a'",
            await_promise=False))

        blocked = False
        try:
            chrome.send('Page.navigate', session_id=psid, url='about:blank')
        except RuntimeError as e:
            blocked = 'timeout' in str(e)
        record(findings, 'panel_navigate_blocked_by_dialog', blocked)
        try:
            chrome.send('Page.handleJavaScriptDialog', session_id=psid, accept=True)
            record(findings, 'panel_dialog_dismissed', True)
        except Exception as e:  # noqa: BLE001
            record(findings, 'panel_dialog_dismissed', f'no dialog: {e}')
    finally:
        chrome.kill()

    print(json.dumps(findings, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
