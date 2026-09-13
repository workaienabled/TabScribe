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

After committing verified source, `python3 make-uiux-package.py` builds the
separately named extension/source ZIPs under `artifacts/uiux/`, byte-checks every
entry, and records SHA-256 hashes. It leaves the earlier download ZIPs intact.

See [`probe/README.md`](probe/README.md) for the older probes and invocation
constraints, and [`docs/uiux.md`](docs/uiux.md) for this branch's changes.
