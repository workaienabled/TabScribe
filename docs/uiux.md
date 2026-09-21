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

## The minimal toolbar

One row, icons only, seven controls: Record, Copy, Download, Clear screen, then
microphone status, pop-out, and the gear. Measured at 280–640px in
`probe/measure_button_row.py`; the four-button labelled row it replaced needed
430px to fit on one line, so this is both denser and less crowded.

- **Record is one toggle.** Start and Stop were mutually exclusive buttons, so a
  single control with a state is smaller and removes the "which one is live?"
  question. It renames itself (`aria-pressed` plus the accessible name) because a
  toggle that looks the same in both states is a button people press twice. It
  becomes pressed and stays *enabled* the moment it is clicked: a first-run model
  download takes minutes, and a disabled control still labelled "Start" for that
  whole time tells the user nothing and offers no way out.
- **Clear screen is not Delete.** It hides segment keys from `render()` and never
  touches the store, so Copy, the word count, and Download are unaffected. That
  divergence is visible rather than implied: a line above the transcript reports
  how much is hidden and offers **Show**. Without it, "cleared" and "deleted"
  would look identical and the download would surprise people. Delete transcript
  stays behind the gear, where the destructive action belongs.
- **Icon targets never shrink below 28x28.** The first attempt shed width at
  narrow panels by shrinking the buttons to 26px, which `ux_test.py` caught: the
  project's floor is 28px, and the gaps give up space instead.

## No browser close prompt

The native `beforeunload` prompt is intentionally removed from both views.
Session autosave helps recover after a panel close, but does not survive a full
browser exit or extension reload. A download request is not a confirmed disk
write; Download stays marked unsaved until a verified-saving mechanism exists.
Users should check their file before deleting or quitting Chrome.

## The microphone indicator

Five states, because the remedies differ: `off`, `needs-permission`, `recording`,
`blocked`, `error`. Each sets `data-state`, the accessible name, and the tooltip
together, so the meaning never rests on colour alone. Only `needs-permission` is
actionable — pressing it opens `mic-permission.html`, the one surface that can
raise Chrome's prompt. The others are status, and are disabled.

## Autosave is a recovery aid

An earlier spike measured `beforeunload` on navigation and incorrectly generalized
that result to dismissal. The extension no longer relies on that prompt at all.
Session autosave restores a previous transcript after a panel closes; failures
are now visible and an unreadable recovery copy is not silently overwritten.
The last coalesced update can still be lost on abrupt process termination.
See [the error-handling contract](error-handling.md).

## The bare shell

The title bar and the footer bar are gone; the panel is the toolbar row and the
transcript. Two things that lived in those bars still matter, so they moved
rather than vanishing:

- **Cloud recognition** used to be a badge in the title bar. It is now its own
  line above the transcript, because "this tab's audio is sent to Google" is the
  one piece of status a user must not miss.
- **Which tab is being captured** moved into the Record control's tooltip, and
  the recording dot now rides in the control row — shown only while something is
  happening, since an always-grey dot beside an idle button is noise.
- **The unsaved marker** moved onto the Download control itself, which is where
  the user would act on it. The visible word count is simply gone; it was never
  part of copying a passage or saving the file.

The pop-out keeps **icon and text**. It is the one control worth naming in place:
moving to a window is a decision, not a frequent action.

## Delete in the toolbar, beside its harmless twin

Delete moved out of the gear and into the control row, at the user's request. The
risk it creates is specific: Clear screen and Delete are twins — one empties the
view, the other empties the saved file — and side by side, losing a meeting
becomes a one-pixel mistake. Three things keep them apart:

- **Position.** Delete sits at the far end, past the gear, with Clear screen at
  the opposite end of the row beside Copy and Download.
- **Colour and icon.** Delete is a trash can in the danger colour *at rest*, not
  only on hover. A control that looks safe until the pointer is already over it
  is not a warning.
- **Name.** "Delete transcript, including from the download" says the thing Clear
  screen does not do.

Undo still backs it, and `probe/delete_control_test.py` asserts the difference
against the **downloaded bytes**, not the screen: Clear screen must leave the file
whole, Delete must empty it.

### The eighth control, and what the gate caught

Eight controls did not fit 280px. The measurement gate caught it — but only after
being fixed twice, because it was weaker than it looked:

- It read a **different id list** from the one in its own docstring, so the new
  control was never measured. The output quietly listed seven buttons.
- It **skipped missing elements** entirely, so a row could "fit" precisely
  because a control had vanished.
- It only checked **row count**, not horizontal overflow, and started at 300px.
  The real failure was `oneRow: true, overflow: true` at 280px.

All three are now failures, and the gate runs from 280px. The layout fix sheds
the pop-out's text label below 360px — it is the only control whose function is
reachable elsewhere, and it keeps its accessible name and tooltip. Targets stay
28×28; shrinking them is the trade this gate exists to refuse.

### A real bug this surfaced

The real-audio resume suite then failed with `aria-pressed="true"` beside a status
reading `Stopped.` — the toggle claiming to record while nothing was.

`stop()` awaits the microphone and then the recognizer's final flush, around two
seconds, and left the control **enabled** throughout. A press inside that window
started a new session that the still-running `stop()` then stomped on. That was a
genuine user-facing defect introduced when Record became a single toggle, not a
harness artifact: it is reachable by anyone who presses Record twice quickly.

The control is now disabled for the duration of the teardown, and
`delete_control_test.py` asserts it without needing audio.

## Window and panel: one control, two directions

The pop-out used to be one-way. The previous commit claimed to have closed that,
and it had not: it made a *new* panel document restore the transcript, which is a
different thing from closing the window bringing the sidebar back. A user found
the gap in the first minute of testing.

The reason no close handler can fix it: **`chrome.sidePanel.open()` requires a
user gesture, and a window being closed is not one.** Anything attempted from
`windows.onRemoved` fails with *"`sidePanel.open()` may only be called in
response to a user gesture"*. That is not a bug to work around; it is the API's
contract.

So the switch is a button, which is a gesture. One control, named for where it
goes:

| view | label | action |
|---|---|---|
| side panel | **Window** | hand off, open the pop-out, close the panel |
| pop-out window | **Sidebar** | hand off, open the panel, close the window |

Measured first in `probe/spike_back_to_panel.py` on Chrome 151:
`sidePanel.open({tabId})` called synchronously inside a click handler **in the
pop-out window** resolves, and the panel appears on the tab being transcribed.

The gesture is spent by the first `await`, so the open is issued in the click
handler *before* anything else happens, and the resulting promise is handed to
`backToSidebar()` to settle after the teardown:

```js
el.popout.addEventListener('click', () => {
  if (!IS_WINDOW) return popOut();
  const pendingOpen = requestSidebarOpen();   // synchronous, gesture alive
  return backToSidebar(pendingOpen);          // awaits teardown, then the open
});
```

Both directions carry the transcript in the same hand-off snapshot, so switching
views is never a reset. `windows.onRemoved` still releases the capture claim and
re-enables the panel for the tab, so closing the window the ordinary way leaves
the toolbar icon working — it just cannot reopen the panel for you.

### The close prompt is gone

Removed, not disabled. Once the transcript survives a close, the prompt warned
about a loss that can no longer happen, and a dialog that fires when nothing is
at stake is how people learn to dismiss dialogs without reading them. The
`warnUnsaved` preference went with it.

The quiet signal stays: the Download control is highlighted while there is
something not yet saved. That is the part worth keeping — it answers "have I
saved this?" without interrupting anything.

### The switch control's label is permanent

It is the only text in the control row, and moving between views is the thing
users need to find, so it survives every width down to 280px. Fitting it back in
cost horizontal padding on the icon buttons and, below 320px, the ⧉ glyph — never
a touch target. All eight controls stay 28×28 on one row at 280px.

### A real bug found alongside it

On the path where the tab cannot be captured, `init()` returned early with
*"Click the TabScribe toolbar icon…"* and never mentioned that a transcript had
just been restored — so reopening the panel on the wrong tab read as "your text
is gone". The restore notice now leads that message.

### Two bugs the switch shipped with

Both reported from real use, both in the resume path, and neither caught by the
suite that introduced the switch — it tested a *stopped* session moving between
views, so nothing about a live one was ever exercised.

**Recording stopped going window → sidebar.** `claimHandoff()` ran only when
`IS_WINDOW`. The window claimed its snapshot on pop-out; the panel never claimed
the one the Sidebar button wrote, fell through to the autosave — which carries
text but no resume flag — and the meeting quietly ended. Both views claim now.

**The microphone went green → grey on every switch.** `start()` refused to open
the microphone without a live gesture, which is correct for an automatic resume:
a gesture-less `getUserMedia` is auto-denied and would report a refusal the user
never saw. But that reasoning does not hold once the grant is *stored* — with a
grant in hand the call cannot prompt, so there is nothing for a gesture to
protect. `start({allowMic: true})` covers exactly that case.

Two ordering problems fell out of the fix, both caused by the gesture rule:

- `sidePanel.open()` must fire inside the click, so the panel document can load
  **before** `backToSidebar()` has written the snapshot. The panel therefore has
  to wait — and *how* it waits was the third version of this bug. A fixed 2500ms
  timer passed the suite (warm model, short clip, sub-second teardown) and failed
  in real use, where the recognizer's final flush takes longer: the wait expired,
  the panel fell through to the autosave, and the meeting ended. The window now
  **announces** the switch before tearing down, so the panel waits on the actual
  hand-off instead of a guess. The remaining 20s figure is only a ceiling on a
  wait that normally ends the moment the snapshot lands.
- For the same reason the panel can reach `armCapture()` while the window still
  holds the tab, which fails with *"Cannot capture a tab with an active stream"*.
  The release is already in flight, so that specific error retries instead of
  being reported as a failure that fixes itself.

`probe/live_switch_test.py` asserts all of it against a **real recognizer over
real audio with a real microphone grant**, because both defects are about a live
session surviving a document swap. A stubbed transcriber would have passed while
the product failed — which is precisely what happened.

It also runs the switch a second time with the hand-off message **deliberately
delayed**, because the first version of this suite only ever exercised a fast
teardown and therefore could not see the timer bug. A timing fix whose test
cannot fail when the timing is wrong is not a test of anything.

### The fourth cause: the panel document that never went away

After three fixes the user still saw recording stop. Every one of those fixes
lived inside `init()`, on the assumption that pressing Sidebar creates a **new**
panel document. It usually does — but not always.

`popOut()` asks the worker to close the panel with `sidePanel.close()`, and that
call is best-effort: it can fail, and some Chrome builds do not have it. When it
fails, the old panel document stays alive behind the window, inert, with
`handedOff = true`. Pressing Sidebar then re-shows **that** document. No new
document is created, `init()` never runs, nothing claims the snapshot, and the
old document's focus handler takes the tab back with *"Press Record to
transcribe"* — the meeting has stopped with a stale transcript on screen.

The harness never showed this because `sidePanel.close()` works there. The suite
now forces the survivor by asking `OPEN_WINDOW` not to close the panel, which
reproduces exactly what a failed close leaves behind, and was red at 7/10.

The fix is a second entry point: `reclaimAfterSwitch()`, on the surviving
document, does what `init()` would have — waits for the announced hand-off,
claims it, re-arms, resumes. The worker broadcasts `SWITCHED_BACK` the moment it
stores the snapshot, so the survivor acts without depending on focus. Verified
load-bearing: with the broadcast removed, the survivor stays at `stopped`.

The same survivor is also what is left when the user closes the window by hand.
Nothing is staged then; the window's last autosave is the only copy of what it
heard. The survivor adopts that copy and takes the tab back (it was sitting on
"Moved to its own window" with its pre-pop-out text, and would have autosaved
over the window's copy), triggered by a `WINDOW_CLOSED` broadcast the worker
sends after clearing the window record, with focus as the fallback.

### The fifth cause, found in the user's own Chrome

The switch log the user pasted ended at `BACK_TO_PANEL sent {"ok":false}` — a
boolean with no reason, because that is all the log line recorded. Attached to
the real browser over CDP, the reason was visible in one probe: every original
message (`GET_TARGET`, `GET_HOST_WINDOW`, `CLAIM_HANDOFF`) answered, and every
message added in the last three commits returned `undefined`. The files on disk
were current. **The service worker in memory was not** — Chrome had kept the
old one running across the unpacked reload.

Nothing errored. The old worker simply fell through to `return false` for the
messages it did not know, the window read that as a failed hand-off, and —
this is the part that cost the meeting — **closed itself anyway**, because the
close was gated on the panel opening, not on the hand-off succeeding. The panel
came up with nothing to claim; the window that still held the transcript was
gone.

Four fixes to the hand-off logic could not touch this. The logic was fine. The
process running it was three commits behind.

Three things changed:

- **Every worker reply carries `workerVersion`**, and the panel checks it on
  the first message at startup. A mismatch is reported in the status line and
  the switch log as *"TabScribe was updated but Chrome is still running the old
  version"* — the one message that would have ended this in a minute.
- **The switch is gated on the announcement.** `SWITCH_PENDING` is sent before
  anything is torn down; an unversioned or missing reply stops the switch there,
  with the meeting untouched.
- **The window closes only when the hand-off actually succeeded** — worker
  confirmed *and* panel open. On any failure it re-arms, resumes if it was
  recording, and says why.

`probe/stale_worker_test.py` simulates the stale worker from the window's side
(known messages answered, new ones `undefined`, no version) and was red at 4/10:
the window closed itself on a hand-off that never happened, exactly as reported.

The wider lesson is in `docs/` and the skill: **the switch log recorded a
boolean where it needed a reason.** `{"ok":false}` told us something failed;
`{"ok":false, "reply":"undefined"}` would have named the stale worker on the
spot.

### The switch log

Four attempts, each fixing a cause the harness could reproduce and missing the
one the user hit. So the extension now records every step of a view switch in
session storage — announced, handed over, claimed, armed, resumed, with the
document that did each. The next report of this bug can carry the sequence
rather than the symptom. (It was briefly shown under the gear; see below for why
it no longer is.)

## Download saves and clears, and Delete asks

The original “Download and delete” design treated an anchor click as a completed
write with nothing behind it, so a cancelled or failed browser download simply
lost the transcript. With unchanged permissions, completion is still
unobservable — the fix is not to pretend otherwise but to make the optimistic
delete survivable.

Download therefore writes the file and clears the transcript in one press, which
is what ending a meeting actually means, and leaves **Undo** holding the text for
as long as the view is open. The acknowledgement says the transcript was cleared
and asks the user to check Chrome’s downloads before closing; it never claims the
file is on disk. A partial export is the one exception: when microphone text
cannot be merged, the download keeps the transcript, because clearing would
destroy the half that never reached the file.

Delete still asks whenever the text is not on disk, and its confirmation offers
**Download first**, **Delete**, and **Cancel**. Download first now answers the
question outright — it saves and clears, and the bar closes with it. Cancel and
Escape preserve the transcript, initial focus remains on Cancel, and Undo backs
every deletion either control performs.

## The switch log is gone from the panel

The step-by-step record of a view switch stays — it costs one session-storage
write per step and the regression suites read it — but its disclosure in the
gear panel has been removed. It was developer output in a product whose point is
minimalism, and it had done its job. Read it when debugging with:

```js
chrome.storage.session.get('switchLog')
```

from the panel's devtools console.

## Error evidence and Chrome compatibility

The historical Chrome 150 failure has no captured error code or model state,
so its cause is unknown. The audit reproduced a distinct message-loss bug:
`onerror` followed by `onend` could overwrite the cause, including before the
recognizer ever fired `onstart`. Terminal status now carries the code and detail.
The UI names the failed attempt’s language and local/cloud mode, offers a remedy,
and does not infer “model missing” from `language-not-supported` alone.

The manifest’s 139 floor is based on the listed API introduction versions, not
an end-to-end run on Chrome 139. Current browser verification runs on Chrome
151.0.7922.137. The static compatibility test checks the modeled API table; it
does not establish behavior on every distribution or historical browser build.

See [error handling and verification](error-handling.md) for the current contract.

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

That page is also opened automatically on first install, from
`offerMicrophonePageOnce()` in the service worker, so the permission is settled
before the user is in a meeting. It is guarded three ways, because a tab that
keeps coming back is worse than no tab at all:

- a stored `micPageShown` flag — `chrome.runtime.onInstalled` fires with reason
  `'install'` on **every** load of an unpacked extension, not only the first
  (measured in `probe/spike_install_event.py`), so the reason alone would reopen
  the tab on every developer reload;
- the live permission state, so a profile that has already granted **or blocked**
  the microphone is never interrupted;
- `reason === 'install'`, so updates and browser restarts never trigger it.

The flag is written *before* the tab is opened, so a failure to open cannot turn
into a tab that retries forever.

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
