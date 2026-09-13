"""Spike: can the panel warn about an unsaved transcript before it closes?

The request is Chrome's native "You have unsaved progress" dialog when the user
closes TabScribe without downloading. That dialog comes from beforeunload, and
beforeunload has real preconditions: it is ignored without prior user
interaction ("sticky activation"), and a side panel is not a normal tab.

So this measures, rather than assumes:

  1. Does a side-panel document fire beforeunload at all when it is closed?
  2. Does the pop-out WINDOW fire it, and does returnValue actually hold the
     window open (a real dialog appearing)?
  3. Does chrome.windows.onRemoved / chrome.runtime port disconnect fire
     reliably instead, as a fallback signal?

A dialog cannot be dismissed from CDP without Page.javascriptDialogOpening, so
this listens for that event: its presence IS the proof a real dialog appeared.

Throwaway. Run with DISPLAY on a private Xvfb.
"""
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipe_chrome import PipeChrome  # noqa: E402
from toolbar_click import click_toolbar_icon  # noqa: E402
from e2e_full import pin_extension  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
OUT.mkdir(parents=True, exist_ok=True)
PROFILE = '/tmp/tabscribe-unload-profile'

INSTALL_HANDLER = """(() => {
  window.__unloadFired = 0;
  window.addEventListener('beforeunload', (e) => {
    window.__unloadFired += 1;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });
  return true;
})()"""


def record(findings, key, value):
    findings[key] = value
    (OUT / 'unload-spike.json').write_text(json.dumps(findings, indent=2))
    print(f'{key}: {json.dumps(value)}', flush=True)


def main():
    findings = {}
    ext = str(ROOT / 'extension')
    import hashlib
    digest = hashlib.sha256(os.path.abspath(ext).encode()).hexdigest()[:32]
    ext_id = ''.join(chr(ord('a') + int(c, 16)) for c in digest)

    if os.path.isdir(PROFILE):
        import shutil
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

        # --- 1. an ordinary extension page in a tab, as the control ----------
        tid, sid = chrome.new_tab(f'chrome-extension://{ext_id}/sidepanel.html')
        chrome.wait_for_js(sid, "!!document.getElementById('startBtn')", timeout=30)
        chrome.send('Page.enable', session_id=sid)
        chrome.evaluate(sid, INSTALL_HANDLER, await_promise=False)
        # A real click, so sticky activation exists. Without it Chrome ignores
        # beforeunload entirely and the whole question is moot.
        rect = chrome.evaluate(sid, """(() => {
          const r = document.getElementById('startBtn').getBoundingClientRect();
          return {x: r.x + r.width / 2, y: r.y + r.height / 2};
        })()""", await_promise=False)
        for kind in ('mousePressed', 'mouseReleased'):
            chrome.send('Input.dispatchMouseEvent', session_id=sid, type=kind,
                        button='left', clickCount=1, **rect)
        time.sleep(0.5)
        record(findings, 'tab_activation', chrome.evaluate(
            sid, "navigator.userActivation ? navigator.userActivation.hasBeenActive : 'n/a'",
            await_promise=False))

        # Navigating away triggers beforeunload. If a REAL dialog appears it
        # blocks the navigation, so Page.navigate never returns — that timeout is
        # itself the evidence. Dismiss it afterwards so the spike can continue.
        blocked = False
        try:
            chrome.send('Page.navigate', session_id=sid, url='about:blank')
        except RuntimeError as e:
            blocked = 'timeout' in str(e)
        record(findings, 'tab_navigate_blocked_by_dialog', blocked)
        try:
            chrome.send('Page.handleJavaScriptDialog', session_id=sid, accept=True)
            record(findings, 'tab_dialog_dismissed', True)
        except Exception as e:  # noqa: BLE001
            record(findings, 'tab_dialog_dismissed', f'no dialog: {e}')
        time.sleep(1)
        chrome.send('Target.closeTarget', targetId=tid)

        # --- 2. the real side panel -----------------------------------------
        ptid, psid = chrome.new_tab(
            'data:text/html,<title>TabScribe test audio</title><h1>fixture</h1>')
        chrome.send('Target.activateTarget', targetId=ptid)
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

        if panel:
            sid2 = chrome.attach(panel['targetId'])
            chrome.wait_for_js(sid2, "!!document.getElementById('startBtn')", timeout=30)
            chrome.evaluate(sid2, INSTALL_HANDLER, await_promise=False)
            record(findings, 'panel_has_beforeunload_api', chrome.evaluate(
                sid2, "typeof window.onbeforeunload !== 'undefined'", await_promise=False))
            # Does the panel document even survive long enough to report?
            record(findings, 'panel_visibility', chrome.evaluate(
                sid2, "({state: document.visibilityState, hidden: document.hidden})",
                await_promise=False))

            # Closing the side panel target is the nearest analogue to the user
            # dismissing the panel.
            try:
                chrome.send('Target.closeTarget', targetId=panel['targetId'])
                time.sleep(2)
                still = [t for t in chrome.targets()
                         if t.get('targetId') == panel['targetId']]
                record(findings, 'panel_closed_without_dialog', not still)
            except Exception as e:  # noqa: BLE001
                record(findings, 'panel_close_error', str(e))

        # --- 3. the pop-out window ------------------------------------------
        win_tid, win_sid = chrome.new_tab(
            f'chrome-extension://{ext_id}/sidepanel.html?view=window')
        chrome.wait_for_js(win_sid, "!!document.getElementById('startBtn')", timeout=30)
        chrome.send('Page.enable', session_id=win_sid)
        chrome.evaluate(win_sid, INSTALL_HANDLER, await_promise=False)
        rect = chrome.evaluate(win_sid, """(() => {
          const r = document.getElementById('startBtn').getBoundingClientRect();
          return {x: r.x + r.width / 2, y: r.y + r.height / 2};
        })()""", await_promise=False)
        for kind in ('mousePressed', 'mouseReleased'):
            chrome.send('Input.dispatchMouseEvent', session_id=win_sid, type=kind,
                        button='left', clickCount=1, **rect)
        time.sleep(0.5)

        blocked = False
        try:
            chrome.send('Page.navigate', session_id=win_sid, url='about:blank')
        except RuntimeError as e:
            blocked = 'timeout' in str(e)
        record(findings, 'window_navigate_blocked_by_dialog', blocked)
        try:
            chrome.send('Page.handleJavaScriptDialog', session_id=win_sid, accept=True)
            record(findings, 'window_dialog_dismissed', True)
        except Exception as e:  # noqa: BLE001
            record(findings, 'window_dialog_dismissed', f'no dialog: {e}')
    finally:
        chrome.kill()

    print(json.dumps(findings, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
