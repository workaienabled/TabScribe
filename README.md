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

## Reading and controls

- **Start / Stop:** control recognition. Stop keeps the text for copying or saving.
  Starting again appends a new session instead of overwriting the previous one.
- **Open in window:** moves the transcript into a pop-out and closes the sidebar.
  If recognition was running, it resumes there. Window size is remembered.
- **Gear:** opens compact preferences in place. Escape or the gear dismisses them.
  The toolbar stays on one row; at narrow widths the pop-out is icon-only.
- **Auto-scroll:** follows new text only while you are at the bottom. Scroll up to
  read history; **Back to live** returns you without covering transcript text or
  changing your auto-scroll preference.
- **Copy selection / Copy all:** the label shows exactly what will be copied.
  **Select to copy** is on by default. The independent **Copy toast** toggle controls
  the brief “Copied” confirmation for both automatic and manual copying. Copying
  does not replace the recognition status on success. Paste the passage into your own AI chat;
  TabScribe does not send transcripts to an AI provider.
- **Download:** always downloads the entire transcript as a plain-text `.txt` file,
  even with text selected, with timestamps if enabled. Download before closing:
  transcripts are not saved automatically.
- **Include my microphone in the saved file** (on by default): also transcribes
  your own speech and merges it into the **downloaded file only**. It is never
  shown in the live transcript and never copied by Copy. See below.
- **Gear → Clear transcript:** immediately clears text, including the current
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
  show Chrome's microphone prompt at all, so TabScribe opens a normal tab
  (**Allow microphone…** under the gear) that can. Allow it once and the panel
  uses the microphone from then on, in every meeting, with no further prompts.
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
