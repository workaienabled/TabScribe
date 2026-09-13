"""The minimal toolbar: one Record toggle, icon actions, and a clear-screen.

Covers the five changes requested together, because they share one row and one
set of state transitions:

  * Start and Stop merged into a single Record toggle.
  * Copy and Download moved to the top row as icons, with no visible text.
  * A clear-screen control that empties the VIEW while the download keeps
    everything — the distinction that makes it different from Delete.
  * The microphone status indicator, which doubles as the Allow control when the
    grant is missing.
  * The unsaved-work warning, asserted through the real beforeunload contract.

Run with DISPLAY pointing at a private Xvfb.
"""
import sys
import time

from ux_test import UI


def record_toggle(ui):
    """One control, two states. The old pair is gone, not merely hidden."""
    gone = ui.js("""({
      start: !!document.getElementById('startBtn'),
      stop: !!document.getElementById('stopBtn'),
      record: !!document.getElementById('recordBtn'),
    })""")
    ui.check('Start and Stop are replaced by a single Record control',
             gone['record'] and not gone['start'] and not gone['stop'], gone)

    idle = ui.js("""(() => {
      const b = document.getElementById('recordBtn');
      if (!b) return {missing: true};
      return {pressed: b.getAttribute('aria-pressed'),
              label: (b.getAttribute('aria-label') || '').toLowerCase(),
              disabled: b.disabled};
    })()""")
    ui.check('idle Record is not pressed and offers to start',
             idle.get('pressed') == 'false' and 'start' in idle.get('label', ''), idle)
    if idle.get('missing'):
        # Nothing below can mean anything without the control; report the rest as
        # failures rather than crashing on the first null.
        for name in ('pressing Record switches the same control to stop',
                     'pressing it again returns it to the start state'):
            ui.check(name, False, 'recordBtn missing')
        return

    # Drive the real control and read the real result. Arming capture is what
    # lets the click reach the recording path at all; without it this would
    # assert nothing.
    ui.arm_capture()
    live = ui.js("""(async () => {
      document.getElementById('recordBtn').click();
      await new Promise((r) => setTimeout(r, 800));
      const b = document.getElementById('recordBtn');
      return {pressed: b.getAttribute('aria-pressed'),
              label: (b.getAttribute('aria-label') || '').toLowerCase(),
              state: document.getElementById('dot').dataset.state};
    })()""")
    ui.check('pressing Record switches the same control to stop',
             live['pressed'] == 'true' and 'stop' in live['label'], live)

    back = ui.js("""(async () => {
      document.getElementById('recordBtn').click();
      await new Promise((r) => setTimeout(r, 800));
      const b = document.getElementById('recordBtn');
      return {pressed: b.getAttribute('aria-pressed'),
              label: (b.getAttribute('aria-label') || '').toLowerCase()};
    })()""")
    ui.check('pressing it again returns it to the start state',
             back['pressed'] == 'false' and 'start' in back['label'], back)


def icon_actions(ui):
    """Copy and Download live in the top row, as icons with names."""
    top = ui.js("""(() => {
      const row = document.querySelector('.controls');
      const inRow = (id) => {
        const el = document.getElementById(id);
        return !!(el && row && row.contains(el));
      };
      const shape = (id) => {
        const el = document.getElementById(id);
        if (!el) return {missing: true};
        return {
          text: el.innerText.trim(),
          hasIcon: !!el.querySelector('svg'),
          name: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          width: Math.round(el.getBoundingClientRect().width),
        };
      };
      return {
        copyInRow: inRow('copyBtn'),
        downloadInRow: inRow('downloadBtn'),
        clearInRow: inRow('clearScreenBtn'),
        copy: shape('copyBtn'),
        download: shape('downloadBtn'),
        clearScreen: shape('clearScreenBtn'),
        footerGone: !document.querySelector('footer.footer'),
      };
    })()""")
    ui.check('Copy and Download moved into the top control row',
             top['copyInRow'] and top['downloadInRow'], top)
    ui.check('the footer bar is gone entirely',
             top['footerGone'] is True, top['footerGone'])
    for key in ('copy', 'download', 'clearScreen'):
        shape = top[key]
        ui.check(f'{key} is icon-only',
                 shape.get('hasIcon') and shape.get('text') == '', shape)
        # An icon with no name is unusable with a screen reader, and a tooltip
        # is what makes it learnable with a mouse. Both, not either.
        ui.check(f'{key} still has an accessible name and a tooltip',
                 len(shape.get('name', '')) > 3 and len(shape.get('title', '')) > 3,
                 shape)


def clear_screen(ui, download_dir):
    """Clearing the screen must not change what Download writes."""
    ui.fixture(6)
    before = ui.js("document.querySelectorAll('.seg').length")

    present = ui.js("""({
      clear: !!document.getElementById('clearScreenBtn'),
      notice: !!document.getElementById('hiddenNotice'),
      show: !!document.getElementById('showHiddenBtn'),
    })""")
    if not (present['clear'] and present['notice'] and present['show']):
        for name in ('clearing the screen empties the visible transcript',
                     'a notice says the text is still in the download',
                     'Download stays available after clearing the screen',
                     'the downloaded file still holds every cleared line',
                     'the cleared text can be brought back to the screen'):
            ui.check(name, False, present)
        return

    ui.js("document.getElementById('clearScreenBtn').click()")
    time.sleep(.4)
    after = ui.js("""({
      segs: document.querySelectorAll('.seg').length,
      notice: !document.getElementById('hiddenNotice').hidden,
      noticeText: document.getElementById('hiddenNotice').textContent.trim(),
      downloadEnabled: !document.getElementById('downloadBtn').disabled,
    })""")
    ui.check('clearing the screen empties the visible transcript',
             after['segs'] == 0 and before > 0, {'before': before, 'after': after})
    ui.check('a notice says the text is still in the download',
             after['notice'] and 'download' in after['noticeText'].lower(), after)
    ui.check('Download stays available after clearing the screen',
             after['downloadEnabled'], after)

    # The claim is about the FILE, so read the file. Assert on content rather
    # than line count: without timestamps the segments join into a paragraph.
    written = ui.download_and_read(download_dir)
    present = sum(1 for i in range(1, before + 1) if f'Segment {i}.' in written)
    ui.check('the downloaded file still holds every cleared line',
             present == before,
             {'found': present, 'expected': before, 'chars': len(written)})
    ui.check('the download is not the empty screen',
             'Example text' not in written or len(written) > 80,
             written[:120])

    restored = ui.js("""(() => {
      document.getElementById('showHiddenBtn').click();
      return {segs: document.querySelectorAll('.seg').length,
              notice: !document.getElementById('hiddenNotice').hidden};
    })()""")
    ui.check('the cleared text can be brought back to the screen',
             restored['segs'] == before and not restored['notice'], restored)


def mic_indicator(ui):
    """The indicator names its state, and offers the fix when one is needed."""
    shape = ui.js("""(() => {
      const el = document.getElementById('micStatusBtn');
      if (!el) return {missing: true};
      return {state: el.dataset.state,
              name: (el.getAttribute('aria-label') || ''),
              title: el.getAttribute('title') || '',
              text: el.innerText.trim(),
              inRow: !!document.querySelector('.controls').contains(el)};
    })()""")
    if shape.get('missing'):
        for name in ('the microphone indicator sits in the control row',
                     'it is icon-only but still named',
                     'it reports a concrete state rather than a generic one',
                     'the indicator reports its state honestly'):
            ui.check(name, False, 'micStatusBtn missing')
        return
    ui.check('the microphone indicator sits in the control row', shape.get('inRow'), shape)
    ui.check('it is icon-only but still named',
             shape.get('text') == '' and len(shape.get('name', '')) > 3, shape)
    ui.check('it reports a concrete state rather than a generic one',
             shape.get('state') in ('off', 'needs-permission', 'recording', 'blocked', 'error'),
             shape)

    # Without a grant the indicator must be the way to get one.
    needs = ui.js("""(() => {
      const el = document.getElementById('micStatusBtn');
      return {state: el.dataset.state,
              name: (el.getAttribute('aria-label') || '').toLowerCase(),
              actionable: !el.disabled};
    })()""")
    if needs['state'] == 'needs-permission':
        ui.check('with no permission the indicator offers to allow it',
                 needs['actionable'] and 'allow' in needs['name'], needs)
    else:
        ui.check('a non-prompting state is reported honestly',
                 'refus' not in needs['name'] and 'denied' not in needs['name'], needs)


def unsaved_warning(ui, download_dir):
    """The warning is armed only when there is something unsaved to lose.

    Asserted through the real contract: a beforeunload listener that calls
    preventDefault is what makes Chrome show its dialog, so the test dispatches a
    real cancelable beforeunload event and reads defaultPrevented. No production
    test hook, and nothing that would pass if the listener were removed.
    """
    ui.fixture(4)
    # capture_store() must run AFTER this fixture's reload: it intercepts the
    # live render to expose the real store, and a navigation discards it.
    ui.capture_store()
    present = ui.js("!!document.getElementById('warnUnsaved')")
    if not present:
        for name in ('an undownloaded transcript arms the close warning',
                     'the Download control marks the transcript unsaved',
                     'downloading disarms the close warning',
                     'and the Download control stops marking it',
                     'new speech after a download makes it unsaved again',
                     'the warning can be turned off'):
            ui.check(name, False, 'warnUnsaved missing')
        return
    armed = ui.js("""(() => {
      const e = new Event('beforeunload', {cancelable: true});
      window.dispatchEvent(e);
      return {prevented: e.defaultPrevented,
              dot: document.getElementById('downloadBtn').classList.contains('unsaved')};
    })()""")
    ui.check('an undownloaded transcript arms the close warning',
             armed['prevented'] is True, armed)
    ui.check('the Download control marks the transcript unsaved', armed['dot'], armed)

    ui.download_and_read(download_dir)
    saved = ui.js("""(() => {
      const e = new Event('beforeunload', {cancelable: true});
      window.dispatchEvent(e);
      return {prevented: e.defaultPrevented,
              dot: document.getElementById('downloadBtn').classList.contains('unsaved')};
    })()""")
    ui.check('downloading disarms the close warning', saved['prevented'] is False, saved)
    ui.check('and the Download control stops marking it', saved['dot'] is False, saved)

    # New speech after a save must re-arm it, or the second half of a meeting
    # would close silently. Appending through the real store, via the same
    # test-only interception capture_store() uses, rather than a production hook.
    again = ui.js("""(async () => {
      const store = window.fixtureStore;
      if (store) {
        // The real API the recognizer uses, so this exercises the same path a
        // live sentence would take. No re-render needed: hasUnsavedTranscript()
        // reads the store, which is the point of comparing text rather than
        // tracking a dirty flag.
        store.update(999, 'Something said after saving.', true, 99000);
      }
      const e = new Event('beforeunload', {cancelable: true});
      window.dispatchEvent(e);
      return {prevented: e.defaultPrevented, applied: !!store,
              dot: document.getElementById('downloadBtn').classList.contains('unsaved')};
    })()""")
    ui.check('the append reached the real store',
             again['applied'] is True, again)
    ui.check('new speech after a download makes it unsaved again',
             again['prevented'] is True, again)

    # Turning the warning off must actually turn it off.
    off = ui.js("""(() => {
      const box = document.getElementById('warnUnsaved');
      box.checked = false; box.dispatchEvent(new Event('change'));
      const e = new Event('beforeunload', {cancelable: true});
      window.dispatchEvent(e);
      return {prevented: e.defaultPrevented};
    })()""")
    ui.check('the warning can be turned off', off['prevented'] is False, off)


if __name__ == '__main__':
    import tempfile

    ui = UI()
    try:
        with tempfile.TemporaryDirectory(prefix='tabscribe-toolbar-dl-') as downloads:
            record_toggle(ui)
            icon_actions(ui)
            clear_screen(ui, downloads)
            mic_indicator(ui)
            unsaved_warning(ui, downloads)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('minimal-toolbar'))
