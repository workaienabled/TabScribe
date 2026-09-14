"""Delete asks before destroying work that is not on disk — and only then.

Delete is backed by Undo, so a confirmation could be pure friction. It is not,
for one reason: Undo lives in this document's memory and dies with it, so a
Delete on a transcript that was never downloaded is the one case where the loss
is unrecoverable. That is exactly the case the user named.

So the gate is the file, not the click: confirm when the transcript differs from
what last reached disk, stay silent when it does not. A confirmation that fires
when nothing is at stake is how people learn to click through confirmations.

And because the real remedy is almost always "save it first", the confirmation
offers that as an action rather than only a warning.

What is asserted:

  * unsaved  -> Delete asks, and the transcript is still there while it asks
  * Cancel   -> nothing was destroyed
  * confirm  -> the transcript goes, and Undo still backs it
  * saved    -> Delete is immediate, with no question
  * new speech after a download makes it unsaved again, so it asks again
  * "Download and delete" writes the real file AND clears, in one action

Run with DISPLAY pointing at a private Xvfb.
"""
import sys
import tempfile
import time

from ux_test import UI


def confirm_state(ui):
    return ui.js("""(() => {
      const bar = document.getElementById('confirmBar');
      return {
        shown: !!bar && !bar.hidden,
        text: bar ? bar.innerText.replace(/\\s+/g, ' ').trim() : '',
        segs: document.querySelectorAll('.seg').length,
        undoShown: !document.getElementById('undoBar').hidden,
        deletePressed: document.getElementById('clearBtn').getAttribute('aria-expanded'),
      };
    })()""")


def asks_when_the_work_is_not_on_disk(ui):
    ui.fixture(4)
    before = confirm_state(ui)
    ui.check('the panel starts with a transcript and no question',
             before['segs'] == 4 and before['shown'] is False, before)

    ui.js("document.getElementById('clearBtn').click()")
    time.sleep(.2)
    asked = confirm_state(ui)
    ui.check('Delete asks before destroying an undownloaded transcript',
             asked['shown'] is True, asked)
    ui.check('and the transcript is still there while it asks',
             asked['segs'] == 4, asked)
    ui.check('the question says what is at stake, in words',
             'download' in asked['text'].lower()
             and any(w in asked['text'].lower() for w in ('not', "n't", 'never')),
             asked)
    ui.check('the Delete control reports the open question to assistive tech',
             asked['deletePressed'] == 'true', asked)


def cancel_destroys_nothing(ui):
    ui.js("document.getElementById('confirmCancelBtn').click()")
    time.sleep(.2)
    after = confirm_state(ui)
    ui.check('Cancel puts the question away', after['shown'] is False, after)
    ui.check('and the transcript is untouched', after['segs'] == 4, after)
    ui.check('and nothing was deleted, so there is nothing to undo',
             after['undoShown'] is False, after)

    # Escape is the other way out of a question.
    ui.js("document.getElementById('clearBtn').click()")
    time.sleep(.15)
    ui.js("""document.getElementById('confirmBar')
             .dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))""")
    time.sleep(.2)
    esc = confirm_state(ui)
    ui.check('Escape also cancels, without destroying anything',
             esc['shown'] is False and esc['segs'] == 4, esc)


def confirming_deletes_and_undo_still_works(ui):
    ui.js("document.getElementById('clearBtn').click()")
    time.sleep(.15)
    ui.js("document.getElementById('confirmDeleteBtn').click()")
    time.sleep(.3)
    gone = confirm_state(ui)
    ui.check('confirming deletes the transcript', gone['segs'] == 0, gone)
    ui.check('the question closes with it', gone['shown'] is False, gone)
    ui.check('and Undo still backs the delete', gone['undoShown'] is True, gone)

    ui.js("document.getElementById('undoClearBtn').click()")
    time.sleep(.3)
    back = confirm_state(ui)
    ui.check('Undo brings it back', back['segs'] == 4, back)


def downloaded_work_is_deleted_without_a_question(ui, download_dir):
    written = ui.download_and_read(download_dir)
    ui.check('the transcript really reached disk',
             'Segment 1.' in written and len(written) > 80,
             written[:70])

    ui.js("document.getElementById('clearBtn').click()")
    time.sleep(.3)
    quiet = confirm_state(ui)
    ui.check('a downloaded transcript is deleted without a question',
             quiet['shown'] is False and quiet['segs'] == 0, quiet)
    ui.check('and Undo still backs that too', quiet['undoShown'] is True, quiet)
    ui.js("document.getElementById('undoClearBtn').click()")
    time.sleep(.3)


def new_speech_after_saving_asks_again(ui):
    """The file is stale the moment anything is said after it was written."""
    ui.capture_store()
    added = ui.js("""(() => {
      const store = window.fixtureStore;
      if (store) store.update(999, 'Something said after the download.', true, 99000);
      document.getElementById('tsToggle').dispatchEvent(new Event('change'));
      return {applied: !!store, segs: document.querySelectorAll('.seg').length};
    })()""")
    ui.check('the append reached the real store and rendered',
             added['applied'] is True and added['segs'] == 5, added)

    ui.js("document.getElementById('clearBtn').click()")
    time.sleep(.2)
    asks = confirm_state(ui)
    ui.check('speech after a download makes Delete ask again',
             asks['shown'] is True and asks['segs'] == 5, asks)
    ui.js("document.getElementById('confirmCancelBtn').click()")
    time.sleep(.15)


def download_and_delete_does_both(ui, download_dir):
    """The remedy the question offers must actually be a remedy."""
    ui.js("document.getElementById('clearBtn').click()")
    time.sleep(.15)
    shown = confirm_state(ui)
    ui.check('the question offers saving as the way out', shown['shown'] is True, shown)

    written = ui.download_and_read(download_dir, trigger='confirmSaveBtn')
    ui.check('Download and delete writes the whole transcript, including the new line',
             'Segment 1.' in written and 'Something said after the download.' in written,
             written[-90:])
    time.sleep(.4)
    after = confirm_state(ui)
    ui.check('and then deletes it, which is what the user asked for',
             after['segs'] == 0, after)
    ui.check('the question closes', after['shown'] is False, after)
    ui.check('and Undo backs it', after['undoShown'] is True, after)


def the_question_does_not_cover_other_status(ui):
    """A question that hides other content is worse than no question.

    The first version of this bar was absolutely positioned at the bottom of the
    panel, where the TOAST also lives. "Screen cleared" landed squarely on top of
    the sentence, covering the words "been downloaded" — the part that explains
    what is at stake. Caught in a screenshot, and then nearly mis-fixed twice:
    the first assertion checked the wrong element (`.hidden-notice`, which lives
    at the top and never collided), so it passed against the broken layout.

    The check is therefore: with a toast actually on screen, the bar must
    intersect nothing — toast, transcript rows, or status line.
    """
    ui.fixture(6)
    ui.size(360, height=430)
    # Clear screen raises the toast; that is the element that collided.
    ui.js("document.getElementById('clearScreenBtn').click()")
    time.sleep(.15)
    ui.js("document.getElementById('clearBtn').click()")
    time.sleep(.25)

    overlap = ui.js("""(() => {
      const bar = document.getElementById('confirmBar');
      if (!bar || bar.hidden) return {error: 'no confirmation shown'};
      const a = bar.getBoundingClientRect();
      const hits = (el) => {
        if (!el || el.hidden) return false;
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) return false;
        return !(a.right <= b.left || a.left >= b.right
              || a.bottom <= b.top || a.top >= b.bottom);
      };
      const toast = document.getElementById('toast');
      const covered = [];
      if (hits(toast)) covered.push('toast');
      if (hits(document.querySelector('.hidden-notice'))) covered.push('screen-cleared notice');
      for (const seg of document.querySelectorAll('.seg')) {
        if (hits(seg)) { covered.push('transcript text'); break; }
      }
      if (hits(document.getElementById('status'))) covered.push('status line');
      const text = document.getElementById('confirmText').getBoundingClientRect();
      return {covered, toastShown: !!toast && !toast.hidden,
              textVisible: text.width > 40 && text.bottom <= innerHeight + 1};
    })()""")
    ui.check('a toast is actually on screen, so the check is not vacuous',
             overlap.get('toastShown') is True, overlap)
    ui.check('the question covers no other content',
             overlap.get('covered') == [], overlap)
    ui.check('and its own text is fully on screen',
             overlap.get('textVisible') is True, overlap)
    ui.js("document.getElementById('confirmCancelBtn').click()")
    time.sleep(.15)


if __name__ == '__main__':
    ui = UI()
    try:
        with tempfile.TemporaryDirectory(prefix='tabscribe-confirm-dl-') as downloads:
            asks_when_the_work_is_not_on_disk(ui)
            cancel_destroys_nothing(ui)
            confirming_deletes_and_undo_still_works(ui)
            downloaded_work_is_deleted_without_a_question(ui, downloads)
            new_speech_after_saving_asks_again(ui)
            download_and_delete_does_both(ui, downloads)
            the_question_does_not_cover_other_status(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('delete-confirm'))
