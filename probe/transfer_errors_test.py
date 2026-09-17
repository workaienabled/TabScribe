"""View transfer rejection must preserve the source and its useful error."""
import sys
import time
from ux_test import UI
from error_paths_test import prepare, reload, snapshot


def begin(ui):
    ui.js("document.getElementById('includeMic').checked=false; document.getElementById('recordBtn').click()")
    ui.chrome.wait_for_js(ui.sid, "document.getElementById('dot').dataset.state === 'listening'")


def details(ui):
    value = snapshot(ui)
    value.update(ui.js("""({issues: document.getElementById('issues')?.innerText || '',
      switchDisabled: document.getElementById('popoutBtn').disabled,
      calls: msgCalls})"""))
    return value


def run(ui):
    ui.fixture(3)
    prepare(ui)
    begin(ui)
    ui.js("fault.failType='OPEN_WINDOW'; fault.safeToResume=true; document.getElementById('popoutBtn').click()")
    ui.chrome.wait_for_js(ui.sid, "!document.getElementById('popoutBtn').disabled", timeout=20)
    time.sleep(.15)
    data = details(ui)
    ui.check('a definitively cancelled pop-out resumes source recognition', data['pressed']=='true' and data['state']=='listening', data)
    ui.check('failed pop-out retains the transcript and specific error',
             data['segs']==3 and 'Injected OPEN_WINDOW failure' in data['issues'], data)
    ui.check('rejected pop-out is not an unhandled promise', not data['unhandled'], data)

    ui.chrome.send('Page.navigate', session_id=ui.sid, url=f'chrome-extension://{ui.ext_id}/sidepanel.html?view=window')
    ui.chrome.wait_for_js(ui.sid, "!!window.fault && /Ready|restored/.test(document.getElementById('status').textContent)")
    begin(ui)
    ui.js("chrome.sidePanel.open=async()=>{}; fault.failType='SWITCH_PENDING'; document.getElementById('popoutBtn').click()")
    ui.chrome.wait_for_js(ui.sid, "!document.getElementById('popoutBtn').disabled", timeout=20)
    data = details(ui)
    ui.check('a current worker refusing switch does not tear down recording',
             data['pressed']=='true' and 'BACK_TO_PANEL' not in data['calls'], data)
    ui.check('storage refusal is not misdiagnosed as stale Chrome',
             'Injected SWITCH_PENDING failure' in data['issues'] and 'old version' not in data['issues'], data)

    reload(ui)
    begin(ui)
    ui.js("chrome.sidePanel.open=async()=>{throw new Error('gesture denied')}; document.getElementById('popoutBtn').click()")
    ui.chrome.wait_for_js(ui.sid, "!document.getElementById('popoutBtn').disabled", timeout=20)
    data = details(ui)
    ui.check('a rejected panel open never transfers away source ownership',
             data['pressed']=='true' and 'BACK_TO_PANEL' not in data['calls'], data)
    ui.check('the panel open failure names its cause', 'gesture denied' in data['issues'], data)


if __name__=='__main__':
    ui=UI()
    try: run(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('transfer-errors'))
