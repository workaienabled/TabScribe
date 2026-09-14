"""The view-switch control keeps one short word for each direction.

Panel says Window, window says Sidebar, and coming back says Window again. The
label rides in the tightest row in the product, so a longer phrase is both an
inconsistency and a 280px fit risk.

Drives the real hand-off code paths rather than setting labels by hand.
"""
import sys
import time

from ux_test import UI


def measure(ui):
    return ui.js("""(() => {
      const b = document.getElementById('popoutBtn');
      const label = b.querySelector('.popout-label');
      const boxes = [...document.querySelectorAll('.controls button')]
        .map((e) => { const r = e.getBoundingClientRect(); return {id: e.id, x: r.x, right: r.right, h: r.height}; });
      return {text: label ? label.textContent.trim() : '',
              name: b.getAttribute('aria-label') || '',
              title: b.title || '',
              overflow: document.documentElement.scrollWidth > innerWidth,
              offscreen: boxes.filter((r) => r.x < 0 || r.right > innerWidth).map((r) => r.id),
              small: boxes.filter((r) => r.h < 28).map((r) => r.id)};
    })()""")


def fits(ui, where):
    """The row must still hold at the narrowest width the panel reaches."""
    for width in (280, 360):
        ui.size(width, 620)
        time.sleep(.15)
        shape = measure(ui)
        ui.check(f'{where}: the row still fits at {width}px',
                 not shape['overflow'] and shape['offscreen'] == [] and shape['small'] == [],
                 shape)
    ui.size(420, 720)
    time.sleep(.15)


def switch_label(ui):
    ui.size(420, 720)
    ui.fixture(3)

    start = measure(ui)
    ui.check('the side panel offers the window in one word',
             start['text'] == 'Window', start)
    # The exact name, not a substring: a fresh panel used to keep a hardcoded
    # aria-label while a reclaimed one reported the mapping's wording, so the
    # same visible state had two different accessible names depending on
    # history. Substring matching cannot see that.
    ui.check('and its accessible name says where it goes',
             start['name'] == 'Move TabScribe into its own window', start)
    ui.check('the visible word is contained in the accessible name (WCAG 2.5.3)',
             start['text'].lower() in start['name'].lower(), start)
    fits(ui, 'panel')

    # --- hand off for real, then come back through the real reclaim path ----
    ui.js("document.getElementById('popoutBtn').click()")
    ui.chrome.wait_for_js(
        ui.sid, "document.getElementById('recordBtn').disabled === true", timeout=20)
    handed = measure(ui)
    ui.check('after handing off, the control points at the open window',
             'window' in handed['text'].lower() and 'window' in handed['name'].lower(), handed)
    ui.check('and it stays one short word, not a sentence',
             len(handed['text'].split()) == 1, handed)
    fits(ui, 'handed off')

    # The window went away and this document took the tab back: the real
    # survivor path, which is what a user sees after closing the pop-out.
    #
    # The hand-off must genuinely succeed, or reclaimAfterSwitch returns before
    # it ever relabels the control and this suite proves nothing. Supply a real
    # snapshot and a capturable stream, exactly as the panel would receive.
    ui.js("""(() => {
      const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (msg, ...rest) => {
        if (msg && msg.type === 'CLAIM_HANDOFF') {
          return Promise.resolve({ok: true, resume: false, snapshot: {epoch: 0, segments: [
            {key: '0:0', text: 'Carried back from the window.', isFinal: true, startedAt: 0}]}});
        }
        if (msg && msg.type === 'GET_STREAM_ID') {
          return Promise.resolve({ok: true, streamId: 'test', tabId: 1, title: 'Test tab'});
        }
        return realSend(msg, ...rest);
      };
      const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (constraints) => {
        const isTab = !!(constraints && constraints.audio && constraints.audio.mandatory
                         && constraints.audio.mandatory.chromeMediaSource === 'tab');
        if (!isTab) return realGum(constraints);
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain); gain.connect(dest); osc.start();
        return Promise.resolve(dest.stream);
      };
    })()""")
    ui.js("window.dispatchEvent(new Event('focus'))")
    # Wait for the reclaim to actually land, rather than guessing at its timing.
    ui.chrome.wait_for_js(
        ui.sid, "document.getElementById('recordBtn').disabled === false", timeout=25)
    reclaimed = ui.js("""({
      segs: document.querySelectorAll('.seg').length,
      recordEnabled: !document.getElementById('recordBtn').disabled,
    })""")
    ui.check('the panel really did take the tab back',
             reclaimed['recordEnabled'] and reclaimed['segs'] >= 1, reclaimed)
    back = measure(ui)
    ui.check('coming back to the sidebar restores the same Window label',
             back['text'] == 'Window', back)
    ui.check('the accessible name comes back with it, identically to a fresh panel',
             back['name'] == start['name'], {'fresh': start['name'], 'reclaimed': back['name']})
    ui.check('and the explanation stays in the tooltip, not the label',
             len(back['title']) > len(back['text']), back)
    fits(ui, 'back in the sidebar')


if __name__ == '__main__':
    ui = UI()
    try:
        switch_label(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('switch-label'))
