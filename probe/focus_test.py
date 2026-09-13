"""Focused product flow in real isolated Chrome: select/copy, full download.

The transcript is an explicit UI fixture, not speech-recognition evidence. Audio
is exercised separately by e2e_full.py. Downloads are read from a fresh directory;
clipboard writes must replace a sentinel.
"""
import tempfile
import time
from pathlib import Path
import sys
from ux_test import UI, ROOT


def click(ui, element):
    # Native pointer activation, not element.click(): preserves the real user
    # gesture and exercises any selection/focus changes caused by clicking.
    rect = ui.js(f"(() => {{ const r=document.getElementById('{element}').getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()")
    for kind in ['mousePressed', 'mouseReleased']:
        ui.chrome.send('Input.dispatchMouseEvent', session_id=ui.sid, type=kind,
                       button='left', clickCount=1, **rect)


def focus(ui):
    ui.size(360)
    empty = ui.js("document.getElementById('emptyHint').innerText.toLowerCase()")
    ui.check('empty state explains meeting → copy → AI → download',
             all(word in empty for word in ['meeting','copy','ai','download']), empty)
    ui.check('no app Find UI or extra transcript toolbar', ui.js("!document.getElementById('findBtn') && !document.getElementById('findPanel') && !document.querySelector('.transcript-tools')"))
    ui.check('search module removed rather than hidden', not (ROOT/'extension/transcript-search.js').exists())
    ui.check('browser Find shortcut is not intercepted', ui.js("(() => { const e=new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}); document.dispatchEvent(e); return !e.defaultPrevented; })()"))
    ui.check('the footer holds status only, no duplicate actions', ui.js("document.querySelectorAll('.footer button').length === 0"))
    ui.check('copy and download are in the one control row', ui.js("(() => { const r=document.querySelector('.controls'); return r.contains(document.getElementById('copyBtn')) && r.contains(document.getElementById('downloadBtn')); })()"))
    ui.check('Clear is an occasional action inside Preferences', ui.js("document.getElementById('prefsPanel').contains(document.getElementById('clearBtn'))"))
    ui.check('download is named explicitly', ui.js("document.getElementById('downloadBtn').getAttribute('aria-label') === 'Download transcript'"))
    ui.check('no title bar or footer bar', ui.js("!document.querySelector('header.bar') && !document.querySelector('footer.footer')"))
    ui.fixture(3)
    ui.capture_store()
    # The fixture restores a stopped store. Enable the control only to exercise
    # the real Stop handler's output wording; this is not an audio-capture test.
    ui.js("document.getElementById('recordBtn').setAttribute('aria-pressed','true')")
    click(ui, 'recordBtn')
    ui.chrome.wait_for_js(ui.sid, "document.getElementById('status').textContent.startsWith('Stopped.')")
    stopped = ui.js("document.getElementById('status').textContent")
    ui.check('Stop points to the visible Download action', 'Download' in stopped and 'Save' not in stopped, stopped)
    ui.check('unselected copy action states full scope', ui.js("document.getElementById('copyBtn').getAttribute('aria-label') === 'Copy transcript'"))
    ui.chrome.send('Browser.grantPermissions', permissions=['clipboardReadWrite','clipboardSanitizedWrite'])
    ui.chrome.send('Target.activateTarget', targetId=ui.tid)
    ui.chrome.send('Emulation.setFocusEmulationEnabled', session_id=ui.sid, enabled=True)
    ui.js("navigator.clipboard.writeText('__NOT_COPIED__')")
    selected = ui.js("""(() => {
      const node=document.querySelector('.seg .txt').firstChild;
      const start=node.data.indexOf('We discussed');
      const r=document.createRange(); r.setStart(node,start); r.setEnd(node,start+'We discussed the roadmap'.length);
      const s=getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      return s.toString();
    })()""")
    ui.chrome.wait_for_js(ui.sid, "document.getElementById('copyBtn').getAttribute('aria-label') === 'Copy selected passage'")
    time.sleep(.25)
    copied = ui.js('navigator.clipboard.readText()')
    ui.check('select-to-copy puts the exact passage on the real clipboard', bool(selected) and copied==selected, {'selected':selected,'clipboard':copied})
    ui.check('copy label describes the selected passage', ui.js("document.getElementById('copyBtn').getAttribute('aria-label') === 'Copy selected passage'"))
    ui.js("document.getElementById('copyToast').checked=false; document.getElementById('copyToast').dispatchEvent(new Event('change')); window.statusBeforeCopy=document.getElementById('status').textContent")
    time.sleep(1.2)
    ui.js("navigator.clipboard.writeText('__MANUAL_SENTINEL__')")
    click(ui, 'copyBtn')
    time.sleep(.25)
    ui.check('manual copy still copies only the selected passage', ui.js('navigator.clipboard.readText()')==selected)
    # The toggle silences the toast, which fires on every selection while reading.
    # It must not silence an action the user explicitly pressed: with no toast and
    # no status, Copy looked broken. Auto-copy stays quiet (asserted in prefs_test).
    ui.check('manual copy respects the toast toggle but still acknowledges itself', ui.js("!document.getElementById('toast').classList.contains('show') && /copied/i.test(document.getElementById('status').textContent) && document.getElementById('copyBtn').getAttribute('aria-label') === 'Copy selected passage'"))
    whole = ui.js('fixtureStore.toText()')
    with tempfile.TemporaryDirectory(prefix='tabscribe-download-test-') as directory:
        for timestamps in [False, True]:
            # The filename has one-second precision. Separate destinations avoid
            # mistaking an overwritten same-name file for a missing download.
            destination = Path(directory) / str(timestamps)
            destination.mkdir()
            ui.chrome.send('Browser.setDownloadBehavior', behavior='allow', downloadPath=str(destination))
            ui.js(f"document.getElementById('tsToggle').checked={str(timestamps).lower()}; document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
            # Refresh selection after the explicit formatting change; Download
            # must ignore it and save the whole store, including the final segment.
            ui.js("(() => { const n=document.querySelector('.seg .txt').firstChild; const r=document.createRange();r.setStart(n,0);r.setEnd(n,9);getSelection().removeAllRanges();getSelection().addRange(r); })()")
            expected = ui.js(f'fixtureStore.toText({{timestamps:{str(timestamps).lower()}}})')
            click(ui, 'downloadBtn')
            deadline = time.monotonic()+12
            saved = set()
            while time.monotonic()<deadline:
                saved = set(destination.glob('*.txt'))
                if saved and not list(destination.glob('*.crdownload')):
                    break
                time.sleep(.1)
            text = next(iter(saved)).read_text() if len(saved)==1 else ''
            ui.check(f'Download saves the whole transcript with timestamps={timestamps}',
                     bool(text) and text==expected and 'Segment 3.' in text,
                     {'files':len(saved),'characters':len(text)})
    ui.js("getSelection().removeAllRanges();document.getElementById('tsToggle').checked=false;document.getElementById('tsToggle').dispatchEvent(new Event('change'));document.getElementById('copyToast').checked=true;document.getElementById('copyToast').dispatchEvent(new Event('change'))")
    time.sleep(.2)
    ui.js("navigator.clipboard.writeText('__WHOLE_SENTINEL__')")
    click(ui,'copyBtn')
    time.sleep(.2)
    ui.check('Copy all copies the whole transcript with no selection', ui.js('navigator.clipboard.readText()')==whole)
    ui.check('manual copy uses the optional short Copied toast', ui.js("document.getElementById('toast').classList.contains('show') && document.getElementById('toast').textContent==='Copied' && document.getElementById('copyBtn').getAttribute('aria-label')==='Copy transcript'"))
    for width in [280,320,360,640]:
        ui.size(width,620)
        ui.check(f'copy/download stay on screen at {width}px', ui.js("(() => {const buttons=[...document.querySelectorAll('.controls button')].map(e=>e.getBoundingClientRect());return buttons.every(r=>r.x>=0 && r.right<=innerWidth) && document.documentElement.scrollWidth<=innerWidth && Math.max(...buttons.map(r=>r.top))<Math.min(...buttons.map(r=>r.bottom));})()"))
    ui.fixture(80)
    ui.size(360, 420)
    ui.js("document.getElementById('transcript').scrollTop=0")
    time.sleep(.2)
    ui.check('Back to live is contextual and never overlaps transcript text', ui.js("(() => {const b=document.getElementById('jumpLatestBtn'),r=b.getBoundingClientRect(),t=document.getElementById('transcript').getBoundingClientRect();return !b.hidden && b.textContent.includes('Back to live') && r.top>=t.bottom;})()"))
    click(ui,'prefsBtn')
    ui.js("document.getElementById('clearBtn').scrollIntoView({block:'nearest'})")
    click(ui,'clearBtn')
    ui.check('Clear closes Preferences so the recovery action is visible', ui.js("document.getElementById('prefsPanel').hidden && !document.getElementById('undoBar').hidden"))


if __name__=='__main__':
    ui=UI()
    try:
        focus(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('focus'))
