"""Window↔panel round trip, a permanent Window label, and no close prompt.

Three changes measured together because they interact.

1. The Window control keeps its text at every width. That is what overflowed
   280px when Delete arrived, so something else in the row has to give — the
   point of these checks is that what gives is never a touch target, and never
   the word itself.

2. Chrome's "unsaved progress" prompt is gone. The transcript is persisted now,
   so the prompt warned about a loss that cannot happen; a dialog that fires when
   nothing is at stake trains people to dismiss dialogs.

3. Closing the pop-out window and opening the side panel continues where the
   window left off. Both views write the same autosave, so this asserts the round
   trip rather than a one-way hand-off.

Run with DISPLAY pointing at a private Xvfb.
"""
import json
import sys
import time

from ux_test import UI


def window_label_always_shows(ui):
    """Icon may go; the word may not."""
    for width in (280, 300, 320, 360, 430):
        ui.size(width)
        time.sleep(0.15)
        shape = ui.js("""(() => {
          const b = document.getElementById('popoutBtn');
          const label = b.querySelector('.popout-label');
          const r = b.getBoundingClientRect();
          const lr = label ? label.getBoundingClientRect() : null;
          return {labelShown: !!lr && lr.width > 0,
                  labelText: label ? label.textContent.trim() : '',
                  name: b.getAttribute('aria-label') || '',
                  w: Math.round(r.width), h: Math.round(r.height),
                  overflow: document.documentElement.scrollWidth > innerWidth};
        })()""")
        ui.check(f'the Window control still reads as text at {width}px',
                 shape['labelShown'] and len(shape['labelText']) >= 4, shape)
        ui.check(f'and the row does not overflow at {width}px',
                 shape['overflow'] is False, shape)

    # Whatever gives way to fit the word, it is not a touch target.
    ui.size(280)
    time.sleep(0.15)
    targets = ui.js("""(() => {
      const small = [];
      for (const b of document.querySelectorAll('.controls button')) {
        const r = b.getBoundingClientRect();
        if (r.height < 28 || r.width < 24) small.push({id: b.id, w: Math.round(r.width), h: Math.round(r.height)});
      }
      return small;
    })()""")
    ui.check('no control shrinks below a usable target at 280px',
             targets == [], targets)
    ui.size(420)


def no_unsaved_prompt(ui):
    """The dialog is gone, and so is the preference that controlled it."""
    ui.fixture(4)
    gone = ui.js("""(() => {
      const e = new Event('beforeunload', {cancelable: true});
      window.dispatchEvent(e);
      return {prevented: e.defaultPrevented,
              pref: !!document.getElementById('warnUnsaved'),
              segs: document.querySelectorAll('.seg').length};
    })()""")
    ui.check('an undownloaded transcript no longer blocks closing',
             gone['prevented'] is False and gone['segs'] == 4, gone)
    ui.check('the warn-before-closing preference is gone',
             gone['pref'] is False, gone)


def window_to_panel_round_trip(ui):
    """Close the window, open the panel, continue where it left off.

    The window and the side panel are the same document with a different view
    flag, and both write the same autosave. This drives the real thing: put text
    in a window-mode document, destroy it, then open a panel-mode document and
    require the text back.
    """
    ui.fixture(5, view='window')
    before = ui.js("""(() => {
      const b = document.getElementById('popoutBtn');
      // display:none, not the hidden attribute — check what is actually painted.
      const shown = !!b && b.getBoundingClientRect().width > 0;
      return {
        segs: document.querySelectorAll('.seg').length,
        text: document.getElementById('transcript').innerText.slice(0, 60),
        isWindow: document.body.classList.contains('view-window'),
        popoutShown: shown,
      };
    })()""")
    ui.check('the window view holds the transcript', before['segs'] == 5, before)
    # The control is NOT hidden here any more: it is the way back. Hiding it was
    # the defect the user hit — closing the window cannot reopen the sidebar,
    # because sidePanel.open() needs a gesture a window close does not supply.
    ui.check('the window view still offers the switch control',
             before['isWindow'] is True and before['popoutShown'] is True, before)

    # Give the autosave its coalescing window, then destroy this document the way
    # closing the window does.
    time.sleep(1.6)
    old_tid = ui.tid
    ui.tid, ui.sid = ui.chrome.new_tab(
        f'chrome-extension://{ui.ext_id}/sidepanel.html')
    ui.chrome.wait_for_js(ui.sid, "!!document.getElementById('recordBtn')", timeout=25)
    try:
        ui.chrome.send('Target.closeTarget', targetId=old_tid)
    except Exception:  # noqa: BLE001
        pass
    time.sleep(1.5)

    after = ui.js("""({
      segs: document.querySelectorAll('.seg').length,
      text: document.getElementById('transcript').innerText.slice(0, 60),
      downloadEnabled: !document.getElementById('downloadBtn').disabled,
      popout: !!document.getElementById('popoutBtn'),
      status: document.getElementById('status').textContent,
    })""")
    ui.check('the side panel continues the window\'s transcript',
             after['segs'] == before['segs'], {'before': before, 'after': after})
    ui.check('and it is the same text',
             after['text'].strip() == before['text'].strip(),
             {'before': before['text'], 'after': after['text']})
    ui.check('Download works immediately in the panel',
             after['downloadEnabled'] is True, after)
    ui.check('the panel offers the Window control again, so the toggle is round trip',
             after['popout'] is True, after)
    ui.check('the panel says the transcript was carried over',
             'restor' in after['status'].lower() or 'earlier' in after['status'].lower(),
             after)


if __name__ == '__main__':
    ui = UI()
    try:
        window_label_always_shows(ui)
        no_unsaved_prompt(ui)
        window_to_panel_round_trip(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('window-round-trip'))
