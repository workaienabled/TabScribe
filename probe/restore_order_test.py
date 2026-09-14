"""Show restores chronological order without disturbing a selected live row."""
import sys
import tempfile
from ux_test import UI
from focus_test import click


def restore_order(ui):
    ui.fixture(2)
    ui.capture_store()
    original = ui.js("[...document.querySelectorAll('.seg .txt')].map(e=>e.textContent)")
    click(ui, 'clearScreenBtn')
    ui.js("fixtureStore.update(90,'A new sentence after clearing the screen.',false,90000);document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    ui.check('new text arrived after Clear, while the old rows stay hidden',
             ui.js("[...document.querySelectorAll('.seg .txt')].map(e=>e.textContent)") == ['A new sentence after clearing the screen.'])
    ui.chrome.send('Browser.grantPermissions', permissions=['clipboardReadWrite','clipboardSanitizedWrite'])
    ui.chrome.send('Target.activateTarget', targetId=ui.tid)
    ui.chrome.send('Emulation.setFocusEmulationEnabled', session_id=ui.sid, enabled=True)
    # Select new speech before restoring old speech. Production has no test hook.
    selected = ui.js("""(() => {
      window.selectedNode=document.querySelector('.seg .txt').firstChild;
      const r=document.createRange();r.setStart(selectedNode,0);r.setEnd(selectedNode,14);
      getSelection().removeAllRanges();getSelection().addRange(r);return getSelection().toString();
    })()""")
    ui.js("navigator.clipboard.writeText('__RESTORE_SENTINEL__')")
    click(ui, 'showHiddenBtn')
    visible = ui.js("[...document.querySelectorAll('.seg .txt')].map(e=>e.textContent)")
    expected = original + ['A new sentence after clearing the screen.']
    ui.check('Show puts old and new speech in chronological order', visible == expected, visible)
    same = ui.js("({text:getSelection().toString(),same:getSelection().anchorNode===window.selectedNode,connected:window.selectedNode.isConnected})")
    ui.check('Show preserves the selected text and existing text node',
             same['text'] == selected and same['same'] and same['connected'], same)
    # A subsequent recognizer update should still hold this selected row.
    ui.js("fixtureStore.update(90,'A new sentence after clearing the screen, with an ending.',true,90000);document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    click(ui,'copyBtn')
    copied = ui.js('navigator.clipboard.readText()')
    ui.check('Copy still writes the exact selected passage after Show and an update', copied == selected and bool(selected), copied)
    ui.js('getSelection().removeAllRanges()')
    ui.chrome.wait_for_js(ui.sid,"[...document.querySelectorAll('.seg .txt')].some(e=>e.textContent.endsWith('with an ending.'))")
    ui.js("navigator.clipboard.writeText('__ORDER_SENTINEL__')")
    click(ui,'copyBtn')
    full = ui.js('fixtureStore.toText()')
    ui.check('Copy all follows the store chronology', ui.js('navigator.clipboard.readText()') == full)
    with tempfile.TemporaryDirectory(prefix='tabscribe-order-dl-') as destination:
        written=ui.download_and_read(destination)
        ui.check('Download still contains all speech in store order', written == full and len(written)>100)
    # Repeat with another new row so this is not an accidental one-time repair.
    click(ui,'clearScreenBtn')
    ui.js("fixtureStore.update(91,'The second clear also keeps the timeline.',true,91000);document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    click(ui,'showHiddenBtn')
    order=ui.js("({dom:[...document.querySelectorAll('.seg')].map(e=>e.dataset.key),store:fixtureStore.liveSegments().map(s=>s.key)})")
    ui.check('a second Clear/Show also preserves every row in order',
             len(order['dom']) == 4 and order['dom']==order['store'], order)


if __name__=='__main__':
    ui=UI()
    try:
        restore_order(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('restore-order'))
