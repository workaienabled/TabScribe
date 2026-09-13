"""Delete in the toolbar, without becoming a misclick away from Clear screen.

Delete was behind the gear because it destroys work. In the toolbar it sits
beside Clear screen, which is its harmless twin: one empties the view and leaves
the download intact, the other removes the text from the download too. If those
two read the same, people lose meetings.

So moving it is only correct if the difference survives the move. These checks
hold that line:

  * Delete is in the control row, not in preferences.
  * It is visually and semantically distinct from Clear screen — its own icon,
    the danger role, and separated from the safe actions in the row.
  * Its accessible name says it affects the download, which is the thing Clear
    screen does not do.
  * Undo still catches the mistake, and the two controls really do different
    things to the saved file.

The last one is the point of the whole suite: it asserts against the downloaded
bytes, not against the screen.

Run with DISPLAY pointing at a private Xvfb.
"""
import sys
import time

from ux_test import UI


def delete_is_in_the_toolbar(ui):
    where = ui.js("""(() => {
      const btn = document.getElementById('clearBtn');
      if (!btn) return {missing: true};
      const row = document.querySelector('.controls');
      const prefs = document.getElementById('prefsPanel');
      return {
        inRow: row.contains(btn),
        inPrefs: prefs.contains(btn),
        name: btn.getAttribute('aria-label') || btn.textContent.trim(),
        title: btn.title || '',
        hasIcon: !!btn.querySelector('svg'),
        text: btn.textContent.trim(),
      };
    })()""")
    ui.check('Delete transcript is in the control row', where.get('inRow') is True, where)
    ui.check('Delete transcript is no longer in preferences',
             where.get('inPrefs') is False, where)
    ui.check('it is an icon like the rest of the row',
             where.get('hasIcon') and where.get('text') == '', where)
    name = (where.get('name', '') + ' ' + where.get('title', '')).lower()
    ui.check('its name says it removes the text from the download',
             'download' in name or 'saved' in name, where)


def delete_cannot_be_mistaken_for_clear_screen(ui):
    """The safe twin and the destructive one must not read alike."""
    pair = ui.js("""(() => {
      const del = document.getElementById('clearBtn');
      const clr = document.getElementById('clearScreenBtn');
      const ds = getComputedStyle(del), cs = getComputedStyle(clr);
      const dsvg = del.querySelector('svg')?.innerHTML || '';
      const csvg = clr.querySelector('svg')?.innerHTML || '';
      const row = [...document.querySelectorAll('.controls > *')];
      return {
        sameColour: ds.color === cs.color,
        sameIcon: dsvg === csvg,
        delDanger: del.classList.contains('danger'),
        adjacent: Math.abs(row.indexOf(del) - row.indexOf(clr)) === 1,
        delName: del.getAttribute('aria-label') || '',
        clrName: clr.getAttribute('aria-label') || '',
      };
    })()""")
    ui.check('Delete and Clear screen do not share an icon',
             pair['sameIcon'] is False, pair)
    ui.check('Delete is coloured as a destructive action',
             pair['delDanger'] and pair['sameColour'] is False, pair)
    ui.check('Delete is not sitting immediately beside Clear screen',
             pair['adjacent'] is False, pair)
    ui.check('their names describe different consequences',
             pair['delName'].lower() != pair['clrName'].lower(), pair)


def the_two_really_differ(ui, download_dir):
    """Assert the difference against the saved file, not the screen.

    Clear screen must leave the download whole; Delete must empty it. Anything
    less than reading the bytes would pass even if the two had been wired to the
    same handler.
    """
    ui.fixture(6)
    ui.js("document.getElementById('clearScreenBtn').click()")
    time.sleep(0.4)
    kept = ui.download_and_read(download_dir)
    ui.check('Clear screen leaves the downloaded transcript whole',
             kept.count('Segment') >= 6, {'chars': len(kept)})

    ui.js("document.getElementById('showHiddenBtn').click()")
    time.sleep(0.3)
    ui.js("document.getElementById('clearBtn').click()")
    time.sleep(0.5)
    after = ui.js("""({
      segs: document.querySelectorAll('.seg').length,
      downloadDisabled: document.getElementById('downloadBtn').disabled,
      undoShown: !document.getElementById('undoBar').hidden,
    })""")
    ui.check('Delete empties the transcript', after['segs'] == 0, after)
    ui.check('Download has nothing left to write',
             after['downloadDisabled'] is True, after)
    ui.check('Delete offers Undo, so a misclick is recoverable',
             after['undoShown'] is True, after)

    ui.js("document.getElementById('undoClearBtn').click()")
    time.sleep(0.5)
    restored = ui.js("document.querySelectorAll('.seg').length")
    ui.check('Undo brings the transcript back', restored == 6, {'segs': restored})


def preferences_still_make_sense(ui):
    """Removing a control must not leave an empty or broken panel."""
    prefs = ui.js("""(() => {
      document.getElementById('prefsBtn').click();
      const p = document.getElementById('prefsPanel');
      return {
        open: !p.hidden,
        controls: p.querySelectorAll('input, select, button').length,
        bottom: Math.round(p.getBoundingClientRect().bottom),
        viewport: innerHeight,
      };
    })()""")
    ui.check('preferences still open and still hold their settings',
             prefs['open'] and prefs['controls'] >= 6, prefs)
    ui.check('preferences still fit on screen',
             prefs['bottom'] <= prefs['viewport'] + 1, prefs)
    ui.js("document.getElementById('prefsBtn').click()")


def stop_cannot_be_raced(ui):
    """Pressing Record during stop() must not leave the toggle lying.

    stop() awaits the microphone and the recognizer's final flush — around two
    seconds. A press inside that window used to call start(), which stop() then
    overwrote, leaving aria-pressed="true" beside a status reading "Stopped."
    Found by the real-audio resume suite; asserted here without needing audio.
    """
    ui.fixture(3)
    raced = ui.js("""(async () => {
      const btn = document.getElementById('recordBtn');
      // Enter the recording state the way a real press does, then immediately
      // ask to stop and press again while the teardown is still running.
      btn.setAttribute('aria-pressed', 'true');
      const stopClick = btn.click();
      await new Promise((r) => setTimeout(r, 60));
      const midway = {pressed: btn.getAttribute('aria-pressed'),
                      disabled: btn.disabled};
      btn.click();            // the racing press
      await new Promise((r) => setTimeout(r, 2600));
      return {midway,
              pressed: btn.getAttribute('aria-pressed'),
              status: document.getElementById('status').textContent,
              dot: document.getElementById('dot').dataset.state};
    })()""")
    ui.check('the control is disabled while stopping, so the race cannot start',
             raced['midway']['disabled'] is True, raced)
    ui.check('the toggle and the status agree after a racing press',
             not (raced['pressed'] == 'true' and 'Stopped' in raced['status']),
             raced)


if __name__ == '__main__':
    import tempfile

    ui = UI()
    try:
        with tempfile.TemporaryDirectory(prefix='tabscribe-delete-dl-') as downloads:
            delete_is_in_the_toolbar(ui)
            delete_cannot_be_mistaken_for_clear_screen(ui)
            the_two_really_differ(ui, downloads)
            preferences_still_make_sense(ui)
            stop_cannot_be_raced(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('delete-control'))
