"""The Window/Sidebar control is a real two-way switch.

The user reported that closing the pop-out window does not bring the sidebar
back. It cannot, and no amount of window-close handling would fix it:
chrome.sidePanel.open() requires a user gesture, and a window closing is not one.

The design that does work — the user's — is a button. In panel mode it reads
"Window" and pops out. In window mode it reads "Sidebar", opens the side panel,
and closes the window. Measured in probe/spike_back_to_panel.py on Chrome 151:
sidePanel.open({tabId}) called synchronously inside a click handler in the pop-out
window resolves, and the panel appears on the tab being transcribed.

What these checks hold:

  * The control's label and accessible name follow the view it is in.
  * In window mode it hands the transcript back and closes the window.
  * The side panel that opens has the text, so the switch is not a reset.
  * Neither direction depends on a close handler, because a close is not a
    gesture and cannot be made into one.

Run with DISPLAY pointing at a private Xvfb.
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
OUT.mkdir(parents=True, exist_ok=True)
PROFILE = '/tmp/tabscribe-switch-profile'
EXT = str(ROOT / 'extension')


class Checks:
    def __init__(self):
        self.rows = []

    def add(self, name, ok, detail=''):
        self.rows.append((name, bool(ok)))
        mark = 'PASS' if ok else 'FAIL'
        extra = f' — {detail}' if detail else ''
        print(f'  [{mark}] {name}{extra}', flush=True)

    def finish(self):
        passed = sum(1 for _, ok in self.rows if ok)
        print(f'RESULT: {passed}/{len(self.rows)} checks passed', flush=True)
        return 0 if passed == len(self.rows) else 1


def unpacked_id(path):
    import hashlib
    digest = hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


def find_target(chrome, needle, exclude=None):
    for t in chrome.targets():
        url = t.get('url', '')
        if needle in url and (exclude is None or exclude not in url):
            return t
    return None


def real_click(chrome, sid, element_id):
    """A genuine input event, because sidePanel.open() needs a live gesture."""
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
    ext_id = unpacked_id(EXT)

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    time.sleep(3)
    chrome.kill()
    time.sleep(2)
    pin_extension(PROFILE, ext_id)

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    try:
        chrome.send('Extensions.loadUnpacked', path=EXT)
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
                panel = find_target(chrome, 'sidepanel.html')
                if not panel:
                    time.sleep(0.5)
            if panel:
                break
            time.sleep(1.5)
        checks.add('the side panel opens from the toolbar', bool(panel))
        if not panel:
            return checks.finish()

        psid = chrome.attach(panel['targetId'])
        chrome.wait_for_js(psid, "!!document.getElementById('recordBtn')", timeout=30)

        # In panel mode the control offers the window.
        in_panel = chrome.evaluate(psid, """({
          text: document.querySelector('.popout-label').textContent.trim(),
          name: document.getElementById('popoutBtn').getAttribute('aria-label'),
        })""", await_promise=False)
        checks.add('in the side panel the control reads Window',
                   in_panel['text'].lower() == 'window'
                   and 'window' in (in_panel['name'] or '').lower(),
                   json.dumps(in_panel))

        # Put real text in, so the switch has something to carry. Seed through
        # the hand-off path, which is real product code. The panel does not claim
        # that snapshot itself — the window-mode document does, on load — so this
        # asserts the snapshot was written, and the window checks below prove it
        # actually arrived.
        seeded = chrome.evaluate(psid, """(async () => {
          await chrome.storage.session.set({handoffSnapshot: {
            snapshot: {epoch: 0, segments: [
              {key: '0:0', text: 'This sentence must survive the switch.',
               isFinal: true, startedAt: 0}]},
            resume: false}});
          const back = await chrome.storage.session.get('handoffSnapshot');
          return {ok: !!back.handoffSnapshot,
                  segs: back.handoffSnapshot
                    ? back.handoffSnapshot.snapshot.segments.length : 0};
        })()""", await_promise=True)
        checks.add('a transcript is staged for the switch to carry',
                   seeded.get('ok') and seeded.get('segs') == 1, json.dumps(seeded))

        # --- panel -> window --------------------------------------------------
        real_click(chrome, psid, 'popoutBtn')
        time.sleep(3)
        win = find_target(chrome, 'sidepanel.html?view=window')
        checks.add('pressing Window opens the pop-out', bool(win))
        if not win:
            return checks.finish()
        wsid = chrome.attach(win['targetId'])
        chrome.wait_for_js(wsid, "!!document.getElementById('recordBtn')", timeout=30)
        time.sleep(1.0)

        # In window mode the same control must offer the way back.
        in_window = chrome.evaluate(wsid, """(() => {
          const b = document.getElementById('popoutBtn');
          const label = b.querySelector('.popout-label');
          const r = b.getBoundingClientRect();
          return {text: label ? label.textContent.trim() : '',
                  name: b.getAttribute('aria-label') || '',
                  title: b.title || '',
                  visible: r.width > 0 && r.height > 0,
                  segs: document.querySelectorAll('.seg').length};
        })()""", await_promise=False)
        checks.add('the window keeps the transcript', in_window['segs'] == 1,
                   json.dumps(in_window))
        checks.add('in the window the control is visible, not hidden',
                   in_window['visible'] is True, json.dumps(in_window))
        checks.add('and it reads Sidebar',
                   in_window['text'].lower() == 'sidebar',
                   json.dumps(in_window))
        checks.add('with an accessible name that says where it goes',
                   'sidebar' in in_window['name'].lower()
                   or 'side panel' in in_window['name'].lower(),
                   json.dumps(in_window))

        # --- window -> panel --------------------------------------------------
        real_click(chrome, wsid, 'popoutBtn')
        time.sleep(4)

        back = find_target(chrome, 'sidepanel.html', exclude='view=window')
        checks.add('pressing Sidebar opens the side panel again', bool(back))
        window_gone = find_target(chrome, 'sidepanel.html?view=window') is None
        checks.add('and closes the pop-out window', window_gone)

        if back:
            bsid = chrome.attach(back['targetId'])
            chrome.wait_for_js(bsid, "!!document.getElementById('recordBtn')", timeout=30)
            time.sleep(1.5)
            restored = chrome.evaluate(bsid, """({
              segs: document.querySelectorAll('.seg').length,
              text: document.getElementById('transcript').innerText.slice(0, 60),
              label: document.querySelector('.popout-label').textContent.trim(),
              downloadEnabled: !document.getElementById('downloadBtn').disabled,
            })""", await_promise=False)
            checks.add('the transcript came back with it',
                       restored['segs'] == 1
                       and 'survive the switch' in restored['text'],
                       json.dumps(restored))
            checks.add('and the control offers Window again, so the switch is two-way',
                       restored['label'].lower() == 'window', json.dumps(restored))
            checks.add('Download works immediately after switching back',
                       restored['downloadEnabled'] is True, json.dumps(restored))
    finally:
        chrome.kill()
        if os.path.isdir(PROFILE):
            shutil.rmtree(PROFILE, ignore_errors=True)

    return checks.finish()


if __name__ == '__main__':
    sys.exit(main())
