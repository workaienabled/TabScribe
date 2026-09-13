"""Robustness checks for the merge review, in real isolated Chrome.

These exercise error and hand-off paths that the feature tests do not: explicit
actions must confirm themselves even when the optional toast is silenced, a
failed download must say so, the pop-out control must not contradict its
accessible name, and a second pop-out click must focus the existing window
rather than attempting a second capture of an already-captured tab.

Transcript text is an explicit UI fixture, not speech evidence.
Run with DISPLAY pointing at a private Xvfb: python3 probe/robustness_test.py
"""
import sys
import time
import argparse

from ux_test import UI


def click(ui, element):
    rect = ui.js(f"(() => {{ const r=document.getElementById('{element}').getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()")
    for kind in ['mousePressed', 'mouseReleased']:
        ui.chrome.send('Input.dispatchMouseEvent', session_id=ui.sid, type=kind,
                       button='left', clickCount=1, **rect)


def robustness(ui):
    ui.size(380, 700)
    ui.fixture(3)
    ui.capture_store()
    ui.chrome.send('Browser.grantPermissions', permissions=['clipboardReadWrite', 'clipboardSanitizedWrite'])
    ui.chrome.send('Target.activateTarget', targetId=ui.tid)
    ui.chrome.send('Emulation.setFocusEmulationEnabled', session_id=ui.sid, enabled=True)

    # --- explicit actions must confirm themselves with the toast silenced -----
    ui.js("""(() => {
      const t = document.getElementById('copyToast');
      t.checked = false; t.dispatchEvent(new Event('change'));
      document.getElementById('status').textContent = '';
    })()""")
    time.sleep(.2)
    ui.js("navigator.clipboard.writeText('__NOT_COPIED__')")
    click(ui, 'copyBtn')
    time.sleep(.4)
    state = ui.js("({status: document.getElementById('status').textContent, clip: null})")
    copied = ui.js("navigator.clipboard.readText()")
    ui.check('manual Copy confirms in the status line when the toast is off',
             bool(state['status'].strip()) and 'copied' in state['status'].lower(), state)
    ui.check('manual Copy with the toast off still copies the transcript',
             copied.startswith('Segment 1.'), copied[:40])

    ui.js("document.getElementById('status').textContent = ''")
    click(ui, 'downloadBtn')
    time.sleep(.6)
    downloaded = ui.js("document.getElementById('status').textContent")
    ui.check('Download confirms that a file was written',
             bool(downloaded.strip()) and 'download' in downloaded.lower(), downloaded)

    # --- a failed download must not be silent --------------------------------
    ui.js("""(() => {
      window.__realCreate = URL.createObjectURL;
      URL.createObjectURL = () => { throw new Error('disk is full'); };
      document.getElementById('status').textContent = '';
    })()""")
    click(ui, 'downloadBtn')
    time.sleep(.4)
    failed = ui.js("""({
      text: document.getElementById('status').textContent,
      isError: document.getElementById('status').classList.contains('error'),
    })""")
    ui.check('a failed Download reports the failure instead of doing nothing',
             bool(failed['text'].strip()) and failed['isError'], failed)
    ui.js("URL.createObjectURL = window.__realCreate")

    # --- the quiet toast must not sit on top of the recovery bar -------------
    ui.js("""(() => {
      const t = document.getElementById('copyToast');
      t.checked = true; t.dispatchEvent(new Event('change'));
      document.getElementById('undoBar').hidden = false;
      const toast = document.getElementById('toast');
      toast.hidden = false; toast.classList.add('show');
    })()""")
    time.sleep(.2)
    overlap = ui.js("""(() => {
      const a = document.getElementById('toast').getBoundingClientRect();
      const b = document.getElementById('undoBar').getBoundingClientRect();
      return {overlaps: !(a.bottom <= b.top || a.top >= b.bottom), toast: a.bottom, undo: b.top};
    })()""")
    ui.check('the Copied toast never covers the Undo bar', not overlap['overlaps'], overlap)
    ui.js("""(() => {
      document.getElementById('undoBar').hidden = true;
      const toast = document.getElementById('toast');
      toast.classList.remove('show'); toast.hidden = true;
    })()""")

    # --- pop-out hand-off: accessible name, and focus instead of re-capture ---
    click(ui, 'popoutBtn')
    ui.chrome.wait_for_js(ui.sid, "document.getElementById('startBtn').disabled === true", timeout=15)
    handed = ui.js("""(() => {
      const b = document.getElementById('popoutBtn');
      return {label: b.querySelector('.popout-label').textContent.trim(),
              aria: b.getAttribute('aria-label'),
              status: document.getElementById('status').textContent};
    })()""")
    ui.check('the pop-out accessible name matches its visible label after hand-off',
             handed['label'] == handed['aria'], handed)

    ui.js("document.getElementById('status').textContent = ''")
    click(ui, 'popoutBtn')
    time.sleep(1.2)
    again = ui.js("""(() => ({
      status: document.getElementById('status').textContent,
      isError: document.getElementById('status').classList.contains('error'),
      startDisabled: document.getElementById('startBtn').disabled,
      label: document.getElementById('popoutBtn').querySelector('.popout-label').textContent.trim(),
      popoutDisabled: document.getElementById('popoutBtn').disabled,
    }))()""")
    # Re-arming is impossible while the window holds the tab, so a second click
    # must focus that window rather than fail trying to capture the tab twice.
    ui.check('a second pop-out click does not report a capture error',
             not again['isError'] and 'active stream' not in again['status'].lower(), again)
    ui.check('a second pop-out click leaves the hand-off state intact',
             again['startDisabled'] and again['label'] == 'Focus window'
             and not again['popoutDisabled'], again)


def review(ui):
    """Findings from the independent merge review, each reproduced first."""
    ui.size(380, 700)

    # A pending Undo must not survive the hand-off. The window now owns the
    # transcript; a dead panel resurrecting a divergent copy would let the user
    # download text the live view no longer has.
    ui.fixture(3)
    ui.capture_store()
    ui.js("""(() => {
      document.getElementById('prefsBtn').click();
      document.getElementById('clearBtn').click();
    })()""")
    time.sleep(.3)
    ui.check('Clear offers Undo before the hand-off',
             ui.js("!document.getElementById('undoBar').hidden"))
    click(ui, 'popoutBtn')
    ui.chrome.wait_for_js(ui.sid, "document.getElementById('startBtn').disabled === true", timeout=15)
    ui.check('handing the tab over drops the pending Undo',
             ui.js("document.getElementById('undoBar').hidden"))

    # Clear collapses Preferences as a consequence, not as a stored choice.
    ui.js("chrome.storage.local.set({prefs: {prefsOpen: true}})")
    ui.chrome.send('Page.reload', session_id=ui.sid)
    ui.chrome.wait_for_js(ui.sid, "document.getElementById('status').textContent.length > 0")
    ui.fixture(2)
    ui.capture_store()
    ui.js("document.getElementById('clearBtn').click()")
    time.sleep(.4)
    stored = ui.js("(async () => (await chrome.storage.local.get('prefs')).prefs.prefsOpen)()")
    ui.check('Clear does not rewrite the stored Preferences-open choice', stored is True, stored)

    # Optional panels must never push the core Download control off-screen.
    ui.size(320, 380)
    ui.js("""(() => {
      document.getElementById('modelPanel').hidden = false;
      const p = document.getElementById('prefsPanel');
      p.hidden = false;
      document.getElementById('prefsBtn').setAttribute('aria-expanded', 'true');
    })()""")
    time.sleep(.3)
    fits = ui.js("""(() => {
      const f = document.querySelector('.footer').getBoundingClientRect();
      const t = document.getElementById('transcript').getBoundingClientRect();
      return {footerBottom: f.bottom, viewport: innerHeight, transcript: t.height};
    })()""")
    ui.check('Download stays on screen with both optional panels open',
             fits['footerBottom'] <= fits['viewport'] + 1, fits)

    # Failure messages must name controls that exist.
    labels = ui.js("""(() => {
      const html = document.documentElement.innerHTML;
      return {save: /\\bSave\\b/.test(document.querySelector('.footer').innerText),
              download: document.getElementById('downloadBtn').textContent.trim()};
    })()""")
    ui.check('the footer has no control named Save', not labels['save'], labels)

    # The only irreversible control in the undo bar must say what it does.
    ui.check('Discard recovery copy is named for its effect',
             ui.js("document.getElementById('undoDismiss').getAttribute('aria-label') === 'Discard recovery copy'"),
             ui.js("document.getElementById('undoDismiss').getAttribute('aria-label')"))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', nargs='?', default='robustness',
                        choices=['robustness', 'review'])
    args = parser.parse_args()
    ui = UI()
    try:
        globals()[args.stage](ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish(args.stage))
