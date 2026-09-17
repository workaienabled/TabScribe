"""Audio failures must release resources and retain the real reason."""
import sys
import time
from ux_test import UI
from error_paths_test import prepare, reload, snapshot
from transfer_errors_test import begin


def run(ui):
    prepare(ui)
    ui.js("captureTracks.forEach(t=>t.stop()); fault.graphThrows=true; document.getElementById('recordBtn').click()")
    time.sleep(.25)
    data=snapshot(ui)
    ui.check('audio graph failure keeps the specific reason visible',
             data['error'] and 'Audio graph construction failed' in data['status'], data)
    ui.check('failed graph construction releases the captured stream',
             ui.js("captureTracks.length === 2 && captureTracks.every(t=>t.readyState==='ended')"), data)

    reload(ui)
    ui.js("""captureTracks.forEach(t=>t.stop());
      Object.defineProperty(AudioContext.prototype, 'state', {configurable:true, get(){return 'suspended'}});
      AudioContext.prototype.resume=async()=>{throw new Error('Audio output blocked')};
      document.getElementById('recordBtn').click();""")
    time.sleep(.3)
    data=snapshot(ui)
    ui.check('a blocked audio context cannot claim Listening',
             data['error'] and 'Audio output blocked' in data['status'] and data['pressed']=='false', data)
    ui.check('blocked audio cleanup releases all captured tracks',
             ui.js("captureTracks.length === 2 && captureTracks.every(t=>t.readyState==='ended')"), data)

    reload(ui)
    begin(ui)
    ui.js("captureTracks.at(-1).dispatchEvent(new Event('ended'))")
    ui.chrome.wait_for_js(ui.sid, "!document.getElementById('recordBtn').disabled", timeout=6)
    data=snapshot(ui)
    ui.check('unexpected tab-audio ending retains its reason after Stop finishes',
             'Tab audio ended' in data['status'] and 'toolbar' in data['status'] and data['pressed']=='false', data)
    ui.check('audio-failure paths do not throw unhandled exceptions', not data['unhandled'], data)


if __name__=='__main__':
    ui=UI()
    try: run(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('capture-errors'))
