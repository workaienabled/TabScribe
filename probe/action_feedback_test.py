"""Acknowledgement and focus survive the paths that used to disturb them.

Recognition status and copy/download acknowledgement are separate channels, so
confirming a copy must not overwrite what capture is doing. The clipboard
fallback must return keyboard focus as well as the visible selection.

Real Chrome, real clipboard, real fixture transcript. The transcript text is a
UI fixture, not recognition evidence.
"""
import sys
import time

from focus_test import click
from ux_test import UI

# The announcement channel does not exist yet in the pre-fix code. Read it
# defensively so this suite reports a failed ASSERTION rather than dying with a
# TypeError, which would prove nothing about the behaviour under test.
ANNOUNCED = "(document.getElementById('actionLog') || {}).textContent || ''"


def failing_state(ui):
    """Put the panel in a genuine recognition error, via the real Record path."""
    click(ui, 'recordBtn')
    ui.chrome.wait_for_js(
        ui.sid, "document.getElementById('status').classList.contains('error')", timeout=15)
    return ui.js("document.getElementById('status').textContent")


def acknowledgement(ui):
    ui.size(380, 700)
    ui.fixture(3)
    ui.capture_store()
    ui.chrome.send('Browser.grantPermissions',
                   permissions=['clipboardReadWrite', 'clipboardSanitizedWrite'])
    ui.chrome.send('Target.activateTarget', targetId=ui.tid)
    ui.chrome.send('Emulation.setFocusEmulationEnabled', session_id=ui.sid, enabled=True)
    ui.js("""(() => {
      const t = document.getElementById('copyToast');
      t.checked = false; t.dispatchEvent(new Event('change'));
    })()""")

    # --- the capture story must survive an explicit Copy --------------------
    failed = failing_state(ui)
    ui.check('the panel really is reporting a recognition failure',
             'error' in ui.js("document.getElementById('status').className"), failed)
    ui.js("navigator.clipboard.writeText('__NOT_COPIED__')")
    click(ui, 'copyBtn')
    time.sleep(.4)
    after = ui.js("""({
      text: document.getElementById('status').textContent,
      isError: document.getElementById('status').classList.contains('error'),
      announced: """ + ANNOUNCED + """,
      toastShown: document.getElementById('toast').classList.contains('show'),
      done: document.getElementById('copyBtn').classList.contains('did'),
    })""")
    copied = ui.js('navigator.clipboard.readText()')
    ui.check('copying really wrote the transcript to the clipboard',
             copied.startswith('Segment 1.'), copied[:40])
    ui.check('a copy does not overwrite the recognition status',
             after['text'] == failed, {'before': failed, **after})
    ui.check('and does not clear the recognition error',
             after['isError'] is True, after)
    ui.check('the copy still acknowledges itself on its own control',
             after['done'] is True and not after['toastShown'], after)
    ui.check('and announces itself to assistive technology',
             'copied' in after['announced'].lower(), after)

    # --- the same for Download, which shares the acknowledgement path -------
    ui.js("(() => { const l = document.getElementById('actionLog'); if (l) l.textContent = ''; })()")
    click(ui, 'downloadBtn')
    time.sleep(.6)
    saved = ui.js("""({
      text: document.getElementById('status').textContent,
      isError: document.getElementById('status').classList.contains('error'),
      announced: """ + ANNOUNCED + """,
      done: document.getElementById('downloadBtn').classList.contains('did'),
    })""")
    ui.check('a download does not overwrite the recognition status',
             saved['text'] == failed and saved['isError'] is True, saved)
    ui.check('the download acknowledges itself and is announced',
             saved['done'] is True and 'download' in saved['announced'].lower(), saved)

    # --- a real failure must still reach the status line --------------------
    ui.js("""(() => {
      window.__realCreate = URL.createObjectURL;
      URL.createObjectURL = () => { throw new Error('disk is full'); };
    })()""")
    click(ui, 'downloadBtn')
    time.sleep(.4)
    broke = ui.js("""({
      text: document.getElementById('issues').innerText,
      isError: !document.getElementById('issues').hidden,
    })""")
    ui.check('a failed download reports independently of recognition status',
             broke['isError'] is True and 'could not save' in broke['text'].lower(), broke)
    ui.js("URL.createObjectURL = window.__realCreate")

    # --- with the toast ON, nothing changes about the status ---------------
    ui.js("""(() => {
      const t = document.getElementById('copyToast');
      t.checked = true; t.dispatchEvent(new Event('change'));
      document.getElementById('status').textContent = 'Listening…';
      document.getElementById('status').classList.remove('error');
    })()""")
    click(ui, 'copyBtn')
    time.sleep(.4)
    quiet = ui.js("""({
      text: document.getElementById('status').textContent,
      toastShown: document.getElementById('toast').classList.contains('show'),
    })""")
    ui.check('with the toast on, the toast confirms and the status is left alone',
             quiet['toastShown'] is True and quiet['text'] == 'Listening…', quiet)

    # One action, one announcement. Both the toast and the log carried
    # role="status" aria-live="polite", so with the toast at its default ON a
    # single Copy queued two utterances. The toast is the sighted channel; the
    # log is the announced one.
    channels = ui.js("""(() => {
      const live = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')]
        .filter((e) => e.getAttribute('aria-hidden') !== 'true')
        .map((e) => e.id || e.className);
      return {live, toastHidden: document.getElementById('toast').getAttribute('aria-hidden')};
    })()""")
    ui.check('only one region announces an action, so a copy is not read twice',
             'toast' not in channels['live'] and 'actionLog' in channels['live'], channels)


def fallback_focus(ui):
    """The clipboard fallback runs when the document is not focused."""
    ui.fixture(3)
    ui.capture_store()
    ui.chrome.send('Browser.grantPermissions',
                   permissions=['clipboardReadWrite', 'clipboardSanitizedWrite'])
    ui.chrome.send('Target.activateTarget', targetId=ui.tid)
    ui.chrome.send('Emulation.setFocusEmulationEnabled', session_id=ui.sid, enabled=True)
    # Force the real fallback: the modern API rejects exactly as it does from an
    # unfocused document, and execCommand actually performs the copy.
    ui.js("navigator.clipboard.writeText = () => Promise.reject(new Error('not focused'))")
    ui.js("navigator.clipboard.writeText('__NOT_COPIED__').catch(() => {})")

    picked = ui.js("""(() => {
      document.getElementById('transcript').focus();
      const node = document.querySelector('.seg .txt').firstChild;
      const start = node.data.indexOf('We discussed');
      const r = document.createRange();
      r.setStart(node, start); r.setEnd(node, start + 'We discussed the roadmap'.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return {focused: document.activeElement.id, text: s.toString()};
    })()""")
    ui.check('the transcript holds keyboard focus and a selection',
             picked['focused'] == 'transcript' and picked['text'] == 'We discussed the roadmap',
             picked)

    ui.js("document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))")
    time.sleep(.8)
    landed = ui.js("""({
      focused: document.activeElement ? document.activeElement.id : '',
      selection: getSelection().toString(),
      scratch: document.querySelectorAll('textarea').length,
    })""")
    ui.check('the fallback really copied the exact passage',
             ui.js('navigator.clipboard.readText()') == picked['text'], landed)
    ui.check('the fallback leaves keyboard focus where the reader had it',
             landed['focused'] == 'transcript', landed)
    ui.check('and restores the visible selection',
             landed['selection'] == picked['text'], landed)
    ui.check('and leaves no scratch element behind',
             landed['scratch'] == 0, landed)

    # A fallback that cannot copy must not strand focus either.
    ui.js("""(() => {
      window.__realExec = document.execCommand;
      document.execCommand = () => { throw new Error('denied'); };
      document.getElementById('transcript').focus();
    })()""")
    click(ui, 'copyBtn')
    time.sleep(.5)
    refused = ui.js("""({
      focused: document.activeElement ? document.activeElement.id : '',
      scratch: document.querySelectorAll('textarea').length,
      isError: !document.getElementById('issues').hidden && document.getElementById('issues').innerText.includes('Copy failed'),
    })""")
    # A real pointer press focuses the button itself, so THAT is where focus
    # must come back to. The defect being guarded is focus landing nowhere.
    ui.check('a failed copy still returns focus and cleans up',
             refused['focused'] == 'copyBtn' and refused['scratch'] == 0, refused)
    ui.check('and a failed copy is reported as an error',
             refused['isError'] is True, refused)
    ui.js("document.execCommand = window.__realExec")


if __name__ == '__main__':
    ui = UI()
    try:
        acknowledgement(ui)
        fallback_focus(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('action-feedback'))
