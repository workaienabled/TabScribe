# TabScribe

Live transcription of a Chrome tab's audio, in a side panel or a separate window.
The tab stays audible; no microphone is needed. Chrome 150+ is required for
on-device recognition. The product's scope and the founder's verbatim goal are
recorded in [`PRODUCT.md`](PRODUCT.md).

## Install and start

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select this repository's `extension/` directory.
3. Pin TabScribe. Open a tab containing a video, podcast, or meeting.
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
- **Gear:** opens grouped preferences. Escape or the close button dismisses them.
  The compact toolbar stays on one row; at narrow widths the pop-out is icon-only.
- **Find:** search transcript segments without changing the text or your selection.
  Ctrl+F / ⌘F opens it, Enter advances, Shift+Enter goes back, and Escape closes it.
- **Auto-scroll:** follows new text only while you are at the bottom. Scroll up to
  read history; **Jump to latest** returns you without changing your preference.
- **Copy:** copies your selection, or the whole transcript when nothing is selected.
  **Select to copy** is on by default. The independent **Copy toast** toggle controls
  the brief “Copied” confirmation.
- **Save:** downloads a plain-text `.txt` file, with timestamps if enabled.
- **Clear:** immediately clears text, including the current utterance, and keeps
  listening. **Undo** restores the cleared text before anything received since.
  Only the most recent Clear is recoverable; recovery is held in this view's memory
  until used, dismissed, replaced by another Clear, or the view is closed.

Preferences include spoken language, on-device mode, timestamps, auto-scroll,
select-to-copy, copy toast, System/Light/Dark appearance, and 14–20px transcript
text. They and the pop-out size are stored on this device, not synced to other
machines. Language and recognition mode apply to the next Start. The mode badge
indicates the current session's mode while recognition is running.

## Privacy and first-run download

**On-device only** is enabled by default. Chrome may need a one-time speech-model
download, roughly 300 MB per language. The notice shows elapsed time and an
indeterminate bar because Chrome does not expose a download percentage. Once the
model is ready, the notice disappears—there is no “Done” banner.

Turning off **On-device only**, or choosing **Use cloud instead**, uses Chrome's
cloud recognition and sends audio to Google's speech service. No cloud fallback
happens automatically. The extension UI has no remote fonts, analytics, or scripts.
Transcripts are kept in memory; pop-out handoff temporarily uses session storage.
Use Save before closing the view. Preferences persist; transcript history does not.

## Development and verification

`main` preserves the pre-redesign source; `chatgpt` contains this UI/UX pass.
These are local branches. This task did not publish a repository or update the rd
fleet. Fleet tooling is documented separately in [`deploy/README.md`](deploy/README.md).

Run Chrome tests only on a private virtual display and isolated test profiles:

```bash
node --test probe/recovery.test.mjs
DISPLAY=:191 python3 probe/run_regressions.py
```

Start your own Xvfb on that display first; the runner deliberately refuses common
user-display numbers. It runs tests serially because audio fixtures share port 8899.
Full logs and exact exit codes go to `artifacts/chatgpt/`. The known audio scripts
are scored by word error rate, not by visual inspection. UI fixture tests are
separate from real speech-recognition tests.

After committing verified source, `python3 make-chatgpt-package.py` builds the
separately named extension/source ZIPs under `artifacts/chatgpt/`, byte-checks every
entry, and records SHA-256 hashes. It leaves the earlier download ZIPs intact.

See [`probe/README.md`](probe/README.md) for the older probes and invocation
constraints, and [`docs/chatgpt-ui.md`](docs/chatgpt-ui.md) for this branch's changes.
