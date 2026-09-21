"""Real panel behavior for preferences, damaged recovery data, and mic-only text."""
import json
import sys
import tempfile
import time
from ux_test import UI


def inject_reload(ui, source, ready):
    ui.chrome.send('Page.enable', session_id=ui.sid)
    script=ui.chrome.send('Page.addScriptToEvaluateOnNewDocument', session_id=ui.sid, source=source)['identifier']
    ui.chrome.send('Page.reload', session_id=ui.sid)
    ui.chrome.wait_for_js(ui.sid, ready, timeout=20)
    ui.chrome.send('Page.removeScriptToEvaluateOnNewDocument', session_id=ui.sid, identifier=script)


def issue(ui):
    return ui.js("document.getElementById('issues').innerText")


def run(ui):
    ui.fixture(3)
    inject_reload(ui, "chrome.storage.local.get=async()=>{throw new Error('preferences read denied')}",
                  "document.getElementById('issues')?.innerText.includes('Saved preferences')")
    ui.check('preference read failure visibly announces defaults and recovery',
             'Defaults' in issue(ui) and 'preferences read denied' in issue(ui), issue(ui))

    ui.fixture(3)
    ui.js("""window.realLocalSet=chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set=async()=>{throw new Error('preferences write denied')};
      document.getElementById('tsToggle').checked=true;
      document.getElementById('tsToggle').dispatchEvent(new Event('change'));""")
    ui.chrome.wait_for_js(ui.sid,"document.getElementById('issues').innerText.includes('Preferences could not be saved')")
    ui.check('preference write failure keeps the current choice and warns it may reset',
             ui.js("document.getElementById('tsToggle').checked") and 'may reset' in issue(ui), issue(ui))
    ui.js("chrome.storage.local.set=realLocalSet;document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    ui.chrome.wait_for_js(ui.sid,"!document.getElementById('issues').innerText.includes('Preferences could not be saved')")
    ui.check('successful preference retry clears the persistence error', not issue(ui), issue(ui))

    corrupt={'snapshot': {'epoch':0, 'segments':[{'key':'0:0','text':None,'isFinal':True,'startedAt':0}]}, 'at':1}
    # The preference change above re-rendered and scheduled an autosave. Let it
    # land first: the panel flushes a pending write on pagehide, so injecting
    # the damaged copy now and reloading would have the live text overwrite it.
    time.sleep(1.4)
    ui.js(f"chrome.storage.session.set({{liveTranscript:{json.dumps(corrupt)}}})")
    ui.chrome.send('Page.reload', session_id=ui.sid)
    ui.chrome.wait_for_js(ui.sid,"document.getElementById('issues')?.innerText.includes('could not be restored')")
    time.sleep(1.4)
    stored=ui.js("chrome.storage.session.get('liveTranscript').then(v=>v.liveTranscript)")
    ui.check('invalid recovery data is reported without discarding the stored original',
             stored==corrupt and 'not overwritten' in issue(ui), {'stored':stored,'message':issue(ui)})
    ui.check('invalid rows do not partially render or crash initialization',
             ui.js("document.querySelectorAll('.seg').length") == 0, issue(ui))

    mic={'epoch':1,'segments':[{'key':'0:0','text':'My own microphone sentence.','isFinal':True,'startedAt':0}]}
    saved={'snapshot':{'epoch':0,'segments':[]},'micText':mic,'at':2}
    ui.js(f"chrome.storage.session.set({{liveTranscript:{json.dumps(saved)}}})")
    ui.chrome.send('Page.reload', session_id=ui.sid)
    ui.chrome.wait_for_js(ui.sid,"!document.getElementById('downloadBtn').disabled",timeout=20)
    with tempfile.TemporaryDirectory(prefix='tabscribe-mic-only-') as downloads:
        text=ui.download_and_read(downloads)
    ui.check('microphone-only recovery can be downloaded even without a meeting row',
             'My own microphone sentence.' in text and 'You:' in text,text)
    # Download clears both channels, so the autosave question here is whether the
    # microphone text comes back with Undo and survives the next write.
    ui.undo_clear()
    time.sleep(1.4)
    stored=ui.js("chrome.storage.session.get('liveTranscript').then(v=>v.liveTranscript)")
    ui.check('autosave does not delete a microphone-only transcript restored by Undo',
             stored is not None and stored.get('micText',{}).get('segments') is not None,stored)
    ui.js("document.getElementById('clearBtn').click()")
    asked=ui.js("!document.getElementById('confirmBar').hidden")
    ui.check('microphone-only Delete still asks before destroying text',asked)
    if asked:
        ui.js("document.getElementById('confirmCancelBtn').click()")
        ui.check('Cancel retains microphone-only export',ui.js("!document.getElementById('downloadBtn').disabled"))
        ui.delete_transcript()
        ui.js("document.getElementById('undoClearBtn').click()")
        enabled=ui.js("!document.getElementById('downloadBtn').disabled")
        ui.check('Undo restores microphone-only export availability',enabled)
        if enabled:
            with tempfile.TemporaryDirectory(prefix='tabscribe-mic-undo-') as folder:
                text=ui.download_and_read(folder)
                ui.check('Undo restores actual microphone bytes, not only button state',
                         'My own microphone sentence.' in text and 'You:' in text,text)

    # Closing the panel destroys the document without a prompt, and the autosave
    # is debounced by 1.2 s. Text that reached the store in that window must not
    # vanish: the panel flushes the scheduled write on pagehide. Real user path:
    # Delete (the recovery copy is removed once the debounce fires), then Undo
    # (the text is back in the store, a write is scheduled), then close at once.
    ui.fixture(2)
    ui.delete_transcript()
    time.sleep(1.4)
    ui.check('the deleted transcript leaves the recovery copy once autosave settles',
             ui.js("chrome.storage.session.get('liveTranscript').then(v=>v.liveTranscript===undefined)"))
    ui.js("document.getElementById('undoClearBtn').click()")
    ui.chrome.send('Page.reload', session_id=ui.sid)
    ui.chrome.wait_for_js(ui.sid,"!!document.getElementById('recordBtn')",timeout=20)
    time.sleep(0.5)
    stored=ui.js("chrome.storage.session.get('liveTranscript').then(v=>v.liveTranscript)")
    ui.check('text restored by Undo survives an immediate close (pagehide flush)',
             stored is not None and len(stored.get('snapshot',{}).get('segments',[]))==2, stored)
    ui.check('and the reopened panel shows it',
             ui.js("document.querySelectorAll('.seg').length")==2)


if __name__=='__main__':
    ui=UI()
    try: run(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('persistence-errors'))
