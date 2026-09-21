"""Failure messages must be visible without hiding recognition or losing text."""
import sys
import time
from ux_test import UI


def state(ui):
    return ui.js("""({
      status: document.getElementById('status').textContent,
      issues: document.getElementById('issues')?.innerText || '',
      segs: document.querySelectorAll('.seg').length,
      unsaved: document.getElementById('downloadBtn').classList.contains('unsaved'),
      confirm: !document.getElementById('confirmBar').hidden,
      undo: !document.getElementById('undoBar').hidden,
      announcement: document.getElementById('actionLog').textContent,
    })""")


def blocked_download(ui):
    ui.fixture(3)
    ui.chrome.send('Browser.setDownloadBehavior', behavior='deny')
    ui.js("document.getElementById('clearBtn').click(); document.getElementById('confirmSaveBtn').click()")
    time.sleep(.25)
    data = state(ui)
    # Download clears optimistically: the anchor cannot see the denial, so the
    # text goes and Undo is the only thing standing between the user and a lost
    # meeting. That makes the recovery bar load-bearing, not decorative.
    ui.check('a denied download still leaves the text recoverable', data['undo'], data)
    ui.check('download feedback does not claim the file reached disk',
             'requested' in data['announcement'].lower()
             and 'check' in data['announcement'].lower(), data)
    ui.check('and it says the transcript was cleared, so the loss is not a surprise',
             'cleared' in data['announcement'].lower(), data)

    ui.js("document.getElementById('undoClearBtn').click()")
    time.sleep(.3)
    back = state(ui)
    ui.check('Undo restores every row after a download that never arrived',
             back['segs'] == 3, back)
    ui.check('the restored transcript is marked unsaved again', back['unsaved'], back)


def output_errors(ui):
    ui.fixture(3)
    before = state(ui)['status']
    ui.js("""navigator.clipboard.writeText = async () => {throw new DOMException('Denied', 'NotAllowedError')};
      document.execCommand = () => false;
      document.getElementById('copyBtn').click();""")
    time.sleep(.2)
    data = state(ui)
    ui.check('failed Copy is visible and offers manual copy',
             'Copy failed' in data['issues'] and 'Ctrl+C' in data['issues'], data)
    ui.check('failed Copy does not erase capture status or transcript',
             data['status'] == before and data['segs'] == 3, data)
    ui.js("URL.createObjectURL = () => {throw new Error('allocation failed')}; document.getElementById('downloadBtn').click()")
    data = state(ui)
    ui.check('download construction error is visible with a safe alternative',
             'allocation failed' in data['issues'] and 'Copy' in data['issues'], data)
    ui.check('download error preserves transcript and capture status',
             data['segs'] == 3 and data['status'] == before and data['unsaved'], data)


def autosave_errors(ui):
    ui.fixture(3)
    ui.capture_store()
    ui.js("""window.realSet = chrome.storage.session.set.bind(chrome.storage.session);
      chrome.storage.session.set = async (data) => {
        if ('liveTranscript' in data) throw new Error('QUOTA_BYTES exceeded');
        return realSet(data);
      };
      document.getElementById('tsToggle').dispatchEvent(new Event('change'));
    """)
    time.sleep(1.5)
    data = state(ui)
    ui.check('autosave quota failure warns to download before closing',
             'autosave' in data['issues'].lower() and 'Download' in data['issues'], data)
    ui.check('autosave failure leaves the live transcript usable', data['segs'] == 3, data)
    ui.js("chrome.storage.session.set = realSet; document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    time.sleep(1.5)
    data = state(ui)
    ui.check('successful autosave retry clears only its warning', 'autosave' not in data['issues'].lower(), data)


def unexpected_errors(ui):
    ui.fixture(3)
    before = state(ui)['status']
    ui.js("setTimeout(() => { void Promise.reject(new Error('Unexpected boundary failure')); }, 0)")
    time.sleep(.2)
    data = state(ui)
    ui.check('an unexpected rejected UI action is visible rather than console-only',
             'Unexpected boundary failure' in data['issues'] and 'Download' in data['issues'], data)
    ui.check('the last-resort warning does not erase the transcript or core status',
             data['segs'] == 3 and data['status'] == before, data)


if __name__ == '__main__':
    ui = UI()
    try:
        blocked_download(ui)
        output_errors(ui)
        autosave_errors(ui)
        unexpected_errors(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('output-errors'))
