"""Stripped chrome, and a transcript that survives the panel closing.

Two things measured together, because one is the honest answer to the other.

The header bar and footer bar are gone: the panel is the toolbar row and the
transcript. What lived in those bars and still matters has to survive the
removal, not vanish with it — specifically the cloud-recognition warning, which
tells the user their audio leaves the machine.

The close warning cannot be the whole answer for the side panel. The user
reported, from real use, that closing the side panel and closing the whole
browser produce no dialog; a side panel is not a tab and Chrome does not run the
beforeunload prompt for it. Rather than ship a warning that only fires in one of
two modes, the transcript is persisted continuously, so closing the panel cannot
lose work in the first place. These checks hold that line: text written before a
close must come back after a reopen.

Run with DISPLAY pointing at a private Xvfb.
"""
import sys
import time

from ux_test import UI


def stripped_chrome(ui):
    """Only the toolbar row, the status line, and the transcript remain."""
    shape = ui.js("""(() => {
      const bar = document.querySelector('header.bar');
      const footer = document.querySelector('footer.footer');
      return {
        header: !!bar,
        footer: !!footer,
        wordCount: !!document.getElementById('wordCount'),
        controls: !!document.querySelector('.controls'),
        transcript: !!document.getElementById('transcript'),
        status: !!document.getElementById('status'),
      };
    })()""")
    ui.check('the header bar is gone', shape['header'] is False, shape)
    ui.check('the footer bar is gone', shape['footer'] is False, shape)
    ui.check('the visible word count is gone', shape['wordCount'] is False, shape)
    ui.check('the toolbar row and transcript remain',
             shape['controls'] and shape['transcript'], shape)
    ui.check('the status line remains for errors', shape['status'], shape)

    # With the bars gone the transcript should start near the top of the panel.
    top = ui.js("Math.round(document.getElementById('transcript').getBoundingClientRect().top)")
    ui.check('the transcript starts high in the panel, not below two bars',
             top < 80, {'top': top})


def popout_has_a_label(ui):
    """Icon AND text: the pop-out is the one control worth naming in place."""
    # At a comfortable width, where the label is the point. The narrow case is
    # asserted below, because eight controls plus a word do not fit 280px.
    ui.size(420)
    shape = ui.js("""(() => {
      const b = document.getElementById('popoutBtn');
      if (!b) return {missing: true};
      return {text: b.innerText.trim(),
              hasIcon: !!b.querySelector('.popout-icon'),
              name: b.getAttribute('aria-label') || '',
              width: Math.round(b.getBoundingClientRect().width)};
    })()""")
    ui.check('the pop-out button shows an icon and text',
             shape.get('hasIcon') and len(shape.get('text', '')) >= 4, shape)
    ui.check('the pop-out button still carries an accessible name',
             len(shape.get('name', '')) >= 4, shape)

    # Narrow: the word goes, so eight controls still fit without shrinking any
    # target below 28px. The name must survive, or the icon becomes unusable
    # with a screen reader precisely where space is tightest.
    ui.size(300)
    narrow = ui.js("""(() => {
      const b = document.getElementById('popoutBtn');
      const r = b.getBoundingClientRect();
      const label = b.querySelector('.popout-label');
      return {labelShown: !!label && label.getBoundingClientRect().width > 0,
              name: b.getAttribute('aria-label') || '',
              title: b.title || '',
              w: Math.round(r.width), h: Math.round(r.height),
              overflow: document.documentElement.scrollWidth > innerWidth};
    })()""")
    ui.check('at a narrow width the pop-out sheds its word rather than the row wrapping',
             narrow['labelShown'] is False and narrow['overflow'] is False, narrow)
    ui.check('and it keeps its name and a usable target',
             len(narrow['name']) >= 4 and len(narrow['title']) >= 4
             and narrow['w'] >= 28 and narrow['h'] >= 28, narrow)
    ui.size(420)


def cloud_warning_survives(ui):
    """Cloud recognition sends audio to Google. That must stay visible."""
    cloud = ui.js("""(() => {
      const box = document.getElementById('localOnly');
      box.checked = false; box.dispatchEvent(new Event('change'));
      const status = document.getElementById('status');
      return {statusText: status.textContent,
              statusVisible: status.getBoundingClientRect().height > 0,
              cloudEl: !!document.getElementById('cloudWarning'),
              cloudText: (document.getElementById('cloudWarning') || {}).textContent || ''};
    })()""")
    said = (cloud['statusText'] + ' ' + cloud['cloudText']).lower()
    ui.check('turning off on-device says the audio leaves the machine',
             'cloud' in said or 'google' in said, cloud)

    back = ui.js("""(() => {
      const box = document.getElementById('localOnly');
      box.checked = true; box.dispatchEvent(new Event('change'));
      const el = document.getElementById('cloudWarning');
      return {hidden: !el || el.hidden,
              text: (document.getElementById('status') || {}).textContent || ''};
    })()""")
    ui.check('on-device mode shows no cloud warning', back['hidden'], back)


def transcript_survives_a_close(ui):
    """The panel can be destroyed without warning, so it must not lose text.

    Reloading the document is exactly what the panel goes through when it is
    dismissed and reopened: a fresh document, same profile, same extension. If
    the text comes back, closing the panel is survivable whether or not Chrome
    ever shows a warning.
    """
    ui.fixture(5)
    before = ui.js("""({
      segs: document.querySelectorAll('.seg').length,
      text: document.getElementById('transcript').innerText.slice(0, 60),
    })""")
    ui.check('the fixture put text on screen', before['segs'] == 5, before)

    # Let the panel persist whatever it is going to persist.
    time.sleep(1.2)
    # Open the panel document afresh in a NEW target and close the old one: the
    # same thing a real close-and-reopen does, and it sidesteps the beforeunload
    # dialog that blocks navigating the existing document.
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
    })""")
    ui.check('the transcript survives the panel being torn down',
             after['segs'] == before['segs'], {'before': before, 'after': after})
    ui.check('and it is the same text, not a placeholder',
             after['text'].strip() == before['text'].strip(),
             {'before': before['text'], 'after': after['text']})
    ui.check('Download works immediately after reopening',
             after['downloadEnabled'], after)


if __name__ == '__main__':
    ui = UI()
    try:
        stripped_chrome(ui)
        popout_has_a_label(ui)
        cloud_warning_survives(ui)
        transcript_survives_a_close(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('bare-shell'))
