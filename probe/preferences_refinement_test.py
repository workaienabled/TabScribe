"""Preferences stay compact, grouped, keyboard-friendly, and easy to hit."""
import sys
from ux_test import UI


def key(ui, name, code, vk):
    for kind in ('keyDown', 'keyUp'):
        ui.chrome.send('Input.dispatchKeyEvent', session_id=ui.sid, type=kind,
                       key=name, code=code, windowsVirtualKeyCode=vk)


def preferences(ui):
    ui.fixture(12)
    ui.js("document.getElementById('prefsBtn').focus()")
    key(ui, ' ', 'Space', 32)
    opened = ui.js("({open:!document.getElementById('prefsPanel').hidden, focus:document.activeElement.id})")
    ui.check('keyboard-open moves focus into settings, not toward Delete',
             opened['open'] and opened['focus'] == 'langSel', opened)
    groups = ui.js("[...document.querySelectorAll('#prefsPanel fieldset')].map(f=>({name:f.querySelector('legend')?.textContent.trim(),controls:[...f.querySelectorAll('input,select')].map(x=>x.id)}))")
    ui.check('capture and reading/copy options have named semantic groups',
             len(groups) == 2 and all(g['name'] and g['controls'] for g in groups)
             and any('langSel' in g['controls'] and 'includeMic' in g['controls'] for g in groups)
             and any('selectToCopy' in g['controls'] and 'themeSel' in g['controls'] for g in groups), groups)
    for width, height in ((280, 320), (360, 620), (640, 440)):
        ui.size(width, height)
        geometry = ui.js("""(() => {
          const panel=document.getElementById('prefsPanel'), r=panel.getBoundingClientRect();
          const labels=[...panel.querySelectorAll('label.check')].map(e=>{
            const b=e.getBoundingClientRect();return {text:e.textContent.trim(),w:b.width,h:b.height};
          });
          const t=document.getElementById('transcript').getBoundingClientRect();
          return {labels,panelBottom:r.bottom,transcriptTop:t.top,transcriptHeight:t.height,
                  overflow:document.documentElement.scrollWidth>innerWidth};
        })()""")
        ui.check(f'{width}x{height}: six full labels have at least 28px hit height',
                 len(geometry['labels']) == 6 and all(r['h'] >= 28 and r['w'] >= 28 for r in geometry['labels']), geometry)
        ui.check(f'{width}x{height}: settings do not cover or squeeze out the transcript',
                 not geometry['overflow'] and geometry['panelBottom'] <= geometry['transcriptTop']
                 and geometry['transcriptHeight'] >= 80, geometry)
    # Native pointer activation near the label's far edge, not the checkbox.
    ui.size(360, 620)
    ui.js("document.getElementById('selectToCopy').scrollIntoView({block:'nearest'})")
    before = ui.js("document.getElementById('selectToCopy').checked")
    point = ui.js("(() => {const r=document.getElementById('selectToCopy').closest('label').getBoundingClientRect();return {x:r.right-5,y:r.top+r.height/2};})()")
    for kind in ('mousePressed', 'mouseReleased'):
        ui.chrome.send('Input.dispatchMouseEvent', session_id=ui.sid, type=kind,
                       button='left', clickCount=1, **point)
    ui.check('the full label toggles its real checkbox', ui.js("document.getElementById('selectToCopy').checked") != before)
    ui.chrome.wait_for_js(ui.sid, f"document.getElementById('selectToCopy').checked === {str(not before).lower()}")
    # Escape uses native keyboard delivery and returns focus to the disclosure.
    ui.js("document.getElementById('selectToCopy').focus()")
    scrolled = ui.js("""(() => {
      const panel=document.getElementById('prefsPanel');
      panel.scrollTop=panel.scrollHeight;
      return {scrollTop:panel.scrollTop,maxScrollTop:panel.scrollHeight-panel.clientHeight};
    })()""")
    ui.check('preferences are scrolled to the bottom before closing',
             scrolled['scrollTop'] > 0 and scrolled['scrollTop'] == scrolled['maxScrollTop'], scrolled)
    key(ui, 'Escape', 'Escape', 27)
    closed = ui.js("({closed:document.getElementById('prefsPanel').hidden,focus:document.activeElement.id})")
    ui.check('Escape closes settings and returns to the gear', closed['closed'] and closed['focus'] == 'prefsBtn', closed)
    key(ui, ' ', 'Space', 32)
    reopened = ui.js("""(() => {
      const panel=document.getElementById('prefsPanel'), r=panel.getBoundingClientRect();
      const lang=document.getElementById('langSel').getBoundingClientRect();
      const top=r.top+panel.clientTop, left=r.left+panel.clientLeft;
      return {open:!panel.hidden,focus:document.activeElement.id,scrollTop:panel.scrollTop,
              lang:lang.toJSON(),viewport:{top,left,bottom:top+panel.clientHeight,right:left+panel.clientWidth}};
    })()""")
    lang, viewport = reopened['lang'], reopened['viewport']
    ui.check('keyboard reopening reveals the focused Language control inside preferences',
             reopened['open'] and reopened['focus'] == 'langSel'
             and lang['width'] > 0 and lang['height'] > 0
             and lang['top'] >= viewport['top'] and lang['bottom'] <= viewport['bottom']
             and lang['left'] >= viewport['left'] and lang['right'] <= viewport['right'], reopened)
    key(ui, 'Escape', 'Escape', 27)
    ui.chrome.send('Page.reload', session_id=ui.sid)
    ui.chrome.wait_for_js(ui.sid, "document.getElementById('status').textContent.length>0")
    ui.check('the changed option persists after a real reload', ui.js("document.getElementById('selectToCopy').checked") == (not before))
    ui.check('closed settings stay closed after a real reload', ui.js("document.getElementById('prefsPanel').hidden"))


if __name__ == '__main__':
    ui=UI()
    try:
        preferences(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('preferences-refinement'))
