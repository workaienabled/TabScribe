# The focused `uiux` UI

## Direction

Follow the founder's verbatim goal in [`PRODUCT.md`](../PRODUCT.md): live meeting
text, copying passages into an external AI chat, and downloading the entire
transcript. The earlier general-reader pass added Find, 16px type, and extra
chrome. `main` was denser and easier to scan in a side panel. This branch keeps
the meeting copy/download flow and restores that compactness.

## Changes

- 13px default transcript type, 1.45 line height, full-width segments. Optional
  15px and 17px remain in Preferences.
- Header is one row: status dot, title, truncated tab name. No brand mark. A
  Cloud badge appears only when recognition is not on-device.
- Compact Start/Stop/pop-out/gear row. Preferences expand in document flow, like
  the original panel, instead of an overlay card. Gear or Escape closes them.
- One-line empty state for Start, copy-into-AI, and Download.
- Footer: compact word count, **Copy all** / **Copy selection**, and **Download**.
  Download always includes the entire transcript.
- Clear stays behind the gear and still offers Undo. Copy uses the optional short
  “Copied” toast without replacing recognition status.
- Respectful auto-scroll and a contextual Back to live control that does not
  cover transcript text.
- Stop → Start appends a new session. Undo recovers the most recent Clear without
  colliding with text that arrived after it.

## Preserved behavior

Default-on select-to-copy; separate optional short “Copied” toast; remembered
window size; transcript handoff and sidebar closure on pop-out; audible tab
passthrough; immediate Clear of the in-flight utterance; honest model download
notice with no percentage and no “Done” state. No Find.

## Verification

`probe/ux_test.py` covers compact shell layout, persisted reading controls,
navigation, and recovery. `probe/focus_test.py` checks the meeting copy/download
flow against real clipboard contents and downloaded files. Audio WER suites remain
separate. Logs go to `artifacts/uiux/`.

## Deliberate limits

No Find, transcript library, built-in AI, recording upload, automatic cloud
fallback, or fleet rollout. Undo is local to the current view. Download before
closing the panel or window.

## Merge review fixes

Found by driving the real UI in `probe/robustness_test.py` (stages `robustness`
and `review`), each reproduced as a failing check before the fix:

- Copy and Download were completely silent when the copy toast was switched off.
  Both now fall back to the status line; auto-copy stays quiet, which is what the
  toggle is actually for.
- A failed Download did nothing at all. It now reports the failure and points at
  Copy all, because losing a whole meeting silently is the worst outcome here.
- The pop-out button's accessible name stayed "Open in window" after hand-off
  while it visibly read "Focus window".
- Clicking pop-out again after hand-off tried to re-arm a tab the window already
  held, which can only fail. It now just focuses the window.
- The Copied toast covered the Undo bar.
- A throw after `transcriber.start()` tore the audio graph down while leaving the
  recognizer running against a dead track, producing an endless restart loop.
- Stored window dimensions were used without validation.

From the independent reviewer:

- A pending Undo survived the pop-out hand-off, letting a dead side panel restore
  and export a transcript the live window no longer had.
- With Preferences and the model notice both open in a short window, the footer
  was pushed off-screen and **Download became unreachable** — everything except
  the transcript was `flex: none` under `overflow: hidden`. The two optional
  panels now shrink; they already scroll internally.
- A stored language was trusted on a bare `typeof` check, so a bad value produced
  a false "Chrome cannot do this" error. Values arriving from the other view were
  not validated at all.
- Clear persisted `prefsOpen: false` as if the user had chosen it, and pushed that
  into the other open view.
- Undo spliced two clocks into the saved file, because Clear restarted `t0`.
- Two failure messages still named the old `Save`/`Copy` buttons, and the undo
  bar's discard control announced itself as "Dismiss undo".

Two tests were strengthened after the reviewer showed they could pass while the
behaviour they name was broken: the preferences fallback now asserts the parsed
store rather than a `select` that silently ignores unknown values, and the manual
copy check no longer demands total silence on success.

## Microphone in the saved file

Optional, on by default, and deliberately isolated in `extension/mic.js`. A
second `SpeechRecognition` transcribes the microphone into its own store, merged
into the download only. `probe/spike_mic.py` measured the premise first on Chrome
151: two recognizers run concurrently and starting the second does not disturb
the first. Ordering uses each segment's elapsed offset; both sides are labelled.
Any failure stops the microphone for that session and leaves the meeting
transcript untouched.

### The permission bug, and what it taught

The first implementation announced "Microphone permission was refused" without
ever prompting. It took three rounds to find the real rule, and the first two
fixes were both wrong:

1. `audioCapture` **cannot** be an optional permission. `chrome.permissions
   .request({permissions:['audioCapture']})` rejects with *"Only permissions
   specified in the manifest may be requested"* (`probe/spike_permission.py`).
2. So it was moved to a required manifest permission — also wrong. Chrome warns
   **"'audioCapture' is only allowed for packaged apps, but this is a
   extension."** and grants nothing. It is a Chrome-App permission; extensions
   have no manifest permission for the microphone at all.
3. The actual rule, measured in `probe/spike_real_grant.py`: the microphone is a
   normal **content setting on the extension's origin**. A side panel cannot
   raise the prompt — `getUserMedia` there is rejected `NotAllowedError`
   "Permission dismissed" with nothing shown — but once the grant exists for
   `chrome-extension://<id>`, the side panel opens the microphone **silently**
   (`permissionState: 'granted'`, a real stream).

Google's own `offscreen-user-media` sample uses exactly this shape: prompt from a
page in a tab, then capture from a surface that cannot prompt.

So `extension/mic-permission.html` is a normal extension page, opened in a tab by
the **Allow microphone…** button under the gear. It asks once; the grant persists
for the origin and every later session just works. `MicTranscriber
.permissionState()` reads that state without prompting, and `start()` opens the
microphone only when it is already `granted` — so the panel can never again
report a refusal the user was not asked for.

The fix is structural. `start({gesture})` takes the caller's word for whether a
live user activation exists, and the microphone is requested **synchronously**
as the first statement, before any `await`:

```js
const pendingMic = (gesture && armed && micGranted && !micBlocked)
  ? requestMicStream() : null;
```

Every term is load-bearing. `gesture: true` is passed by exactly three callers,
all real clicks: the Start button and the two buttons in the model notice; the
pop-out resume and the re-arm after a hand-off pass the default `false`.
`micGranted` is the one that prevents the original bug outright — without a
stored grant the panel does not call `getUserMedia` at all. `armed` keeps the
microphone from ever queueing ahead of the tab-capture request the user came for.

`classify()` names what actually failed (`denied`, `dismissed`, `no-device`,
`device-busy`, `unsupported`, `failed`), and only a real denial says the
microphone is blocked. There is deliberately no `no-gesture` reason: Chrome
reports a gesture-less rejection as "Permission dismissed", indistinguishable
from a real dismissal, which is why the gesture is guaranteed by the caller
instead of detected after the fact.

`MicTranscriber` owns the in-flight request, so unticking the option while the
prompt is still open releases the stream that arrives afterwards instead of
leaving the recording indicator lit. `start()` guards on `this.recognition`
rather than `this.running`, because `running` is only set inside `onstart`, a
task later — two rapid Starts would otherwise each build a graph and leak a
microphone. The microphone shares the meeting's `t0`, so a microphone attached
mid-session still sorts its lines where they were spoken.

A failure no longer unticks the option. It sets a session-local `micBlocked` flag
so Start stops re-prompting, while the user's stored preference survives;
re-ticking the box clears it and retries immediately, using the tick as the
gesture.

The first mic test passed against this bug because
`--use-fake-ui-for-media-stream` auto-accepts prompts. `probe/mic_permission_test.py`
deliberately runs without it, and `e2e_full.py` now runs the known-audio check in
both modes: permission granted and permission denied both transcribe the meeting
at **96.3%**, the same as with no microphone feature at all.
