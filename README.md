# TabScribe

Focused live meeting transcription from the current Chrome tab. Copy a passage
into your chosen AI chat, then download the full transcript when the meeting ends.
Use the side panel or move it into a separate window.
The tab stays audible; no microphone is needed. Chrome 150+ is required for
on-device recognition. The product's scope and the founder's verbatim goal are
recorded in [`PRODUCT.md`](PRODUCT.md).

## Install and start

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select this repository's `extension/` directory.
3. Pin TabScribe and open your meeting tab.
4. Click TabScribe's **toolbar icon** on that tab, then press **Start**.

The toolbar click grants access to that tab. Opening the extension page directly
or through Chrome's generic side-panel menu does not grant audio capture access.
After changing the source, reload the extension at `chrome://extensions` and
reopen its panel. Save any transcript before reloading.

Chrome can keep the **old background worker running** after a reload, so the
panel from the new files ends up talking to a worker from the old ones. TabScribe
detects that and says *"TabScribe was updated but Chrome is still running the
old version"* in the status line. If you see it, reload once more at
`chrome://extensions`, or restart Chrome.

## Reading and controls

Everything lives in one row of icon controls. Each has a tooltip and an
accessible name; none carries its meaning in colour alone.

- **Record:** one toggle. Press to start, press again to stop. Stopping keeps the
  text for copying or saving, and starting again appends a new session instead of
  overwriting the previous one.
- **Clear screen:** empties what is on screen **without removing anything from the
  transcript**. A line above the transcript reports how much is hidden and offers
  **Show** to bring it back; **Download still writes everything**. This is the
  opposite of **Delete transcript**, the red control at the far right, which does
  remove the text from the saved file.
- **Microphone status:** whether your own voice is being saved — off, ready,
  recording, blocked, or not yet permitted. In that last state it is a button, and
  pressing it opens the page that can ask for permission.
- **Open in window:** moves the transcript into a pop-out and closes the sidebar.
  If recognition was running, it resumes there. Window size is remembered.
- **Gear:** opens compact preferences in place. Escape or the gear dismisses them.
  All the controls stay on one row down to 280px.
- There is no title bar and no footer: the panel is the control row and the
  transcript. Cloud recognition, when enabled, says so on its own line above the
  transcript.
- **Auto-scroll:** follows new text only while you are at the bottom. Scroll up to
  read history; **Back to live** returns you without covering transcript text or
  changing your auto-scroll preference.
- **Copy:** copies the passage you selected, or the whole transcript when nothing
  is selected; the tooltip and accessible name say which. **Select to copy** is on
  by default. The independent **Copy toast** toggle controls the brief “Copied”
  confirmation for both automatic and manual copying. Copying does not replace the
  recognition status on success. Paste the passage into your own AI chat;
  TabScribe does not send transcripts to an AI provider.
- **Download:** always downloads the entire transcript as a plain-text `.txt` file,
  even with text selected, with timestamps if enabled. Download before closing:
  transcripts are not saved automatically.
- **Your transcript survives closing either view.** It is saved continuously and
  restored the next time you open TabScribe, so closing the side panel, closing
  the pop-out window, or closing the browser does not lose the meeting. It is
  kept in browser session storage, not written to disk, and is discarded when
  Chrome fully exits, so **download before you quit Chrome**.
- **One control switches between the two views.** In the sidebar it reads
  **Window** and pops out; in the window it reads **Sidebar** and moves back,
  closing the window as it goes. Recording, the microphone, and the transcript
  all continue across the switch — it is a move, not a restart. If the switch
  cannot complete, the window stays put with the meeting still recording and
  says why, rather than closing on a hand-off that did not happen.
  Closing the pop-out with the window's own close button does *not* reopen the
  sidebar — Chrome only allows that from a click — so use **Sidebar** to switch
  back, or the toolbar icon to reopen the panel. There is no close prompt in
  either direction: nothing is lost, so nothing needs confirming. The Download
  control is highlighted whenever there is something not yet saved.
- **Include my microphone in the saved file** (on by default): also transcribes
  your own speech and merges it into the **downloaded file only**. It is never
  shown in the live transcript and never copied by Copy. See below.
- **Delete transcript** (the red control at the far end of the row, deliberately
  away from Clear screen): immediately removes the text, including the current
  utterance, and keeps listening. Preferences close to reveal **Undo**, which
  restores the cleared text before anything received since.
  Only the most recent Clear is recoverable; recovery is held in this view's memory
  until used, dismissed, replaced by another Clear, or the view is closed.

Preferences include spoken language, on-device mode, timestamps, auto-scroll,
select-to-copy, copy toast, System/Light/Dark appearance, and transcript text
size (13px default, matching the original compact panel; 15 and 17 optional).
They and the pop-out size are stored on this device, not synced to other
machines. Language and recognition mode apply to the next Start. A Cloud badge
appears only when recognition is not on-device.

## Privacy and first-run download

### Your own microphone (optional)

The tab carries every voice except yours. Turning on **Include my microphone in
the saved file** transcribes your microphone in parallel and merges it into the
file written by **Download**, labelled `You:` against `Meeting:`.

- It is **on by default**, and needs a one-time permission. A side panel cannot
  show Chrome's microphone prompt at all, so TabScribe uses a normal tab, which
  can. **That tab opens by itself the first time the extension is installed** —
  allow it once and the panel uses the microphone from then on, in every meeting,
  with no further prompts.
- The tab opens **once**, on first install only. It does not come back when Chrome
  restarts, when the extension updates or is reloaded, or if the microphone was
  already allowed or blocked. If you dismissed it, **Allow microphone…** under the
  gear opens it again on demand.
- Until that grant exists, TabScribe simply does not use the microphone. It never
  asks in the panel, because a request there is refused without ever showing you
  a prompt — which would look like a refusal you never made.
- Popping out into a window resumes the **meeting** transcript immediately but
  not the microphone: that resume is automatic, not a click. Press Stop then
  Start in the window to include your microphone there.
- If you say no, or dismiss the prompt, or have no microphone, **the meeting
  transcript is completely unaffected** — same live text, same saved file. The
  reason is reported next to the option, never as a recognition error, and the
  option stays ticked so a one-off problem does not disable it forever.
- Untick it if you would rather not be asked at all.
- It **never appears in the live transcript** and is never part of Copy. Two
  independent recognizers give no reliable relative ordering, so showing them
  interleaved live would imply an accuracy this cannot deliver. In the file the
  turns are ordered by each segment's elapsed time from the start of the session,
  which is good enough to read but is not sample-accurate turn-taking.
- Your microphone is **never played back** through the speakers, and echo
  cancellation is on so the meeting's own audio is not transcribed twice.
- If the microphone is refused, missing, busy, or fails at any point, the panel
  says which of those happened and stops retrying for that session; **the meeting
  transcript is unaffected**. Nothing about tab capture, recognition, or the live
  view depends on this feature.
- **Clear** discards captured microphone text along with the transcript, and
  **Undo** does not bring it back: restoring text you cannot see on screen into a
  file would be worse than losing it.
- With the option on but nothing heard, the saved file is byte-for-byte the
  meeting transcript.

**On-device only** is enabled by default. Chrome may need a one-time speech-model
download, roughly 300 MB per language. The notice shows elapsed time and an
indeterminate bar because Chrome does not expose a download percentage. Once the
model is ready, the notice disappears—there is no “Done” banner.

Turning off **On-device only**, or choosing **Use cloud instead**, uses Chrome's
cloud recognition and sends audio to Google's speech service. No cloud fallback
happens automatically. The extension UI has no remote fonts, analytics, or scripts.
Transcripts are kept in memory; pop-out handoff temporarily uses session storage.
Use Download before closing the view. Preferences persist; transcript history does not.

## Development and verification

`main` preserves the pre-redesign source; `uiux` is the focused compact UI.
These are local branches. This task did not publish a repository or update the rd
fleet. Fleet tooling is documented separately in [`deploy/README.md`](deploy/README.md).

Run Chrome tests only on a private virtual display and isolated test profiles:

```bash
node --test probe/recovery.test.mjs
DISPLAY=:191 python3 probe/run_regressions.py
```

Start your own Xvfb on that display first; the runner deliberately refuses common
user-display numbers. It runs tests serially because audio fixtures share port 8899.
Full logs and exact exit codes go to `artifacts/uiux/`. The known audio scripts
are scored by word error rate, not by visual inspection. UI fixture tests are
separate from real speech-recognition tests. `probe/focus_test.py` tests the core
meeting-to-copy-to-download flow against real clipboard and file contents.

After committing verified source, `python3 make-package.py` builds the
separately named extension/source ZIPs under `artifacts/uiux/`, byte-checks every
entry, and records SHA-256 hashes. It leaves the earlier download ZIPs intact.

See [`probe/README.md`](probe/README.md) for the older probes and invocation
constraints, and [`docs/uiux.md`](docs/uiux.md) for this branch's changes.
