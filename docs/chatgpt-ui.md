# The focused `chatgpt` UI

## Direction

Follow the founder's verbatim goal in [`PRODUCT.md`](../PRODUCT.md): live meeting
text, copying passages into an external AI chat, and downloading the entire
transcript. The earlier general-reader pass was too broad. Find has been removed,
not hidden or queued for later. No built-in AI client is part of this interface.
Recognition, capture, permissions, and privacy defaults are unchanged.

## Changes

- A readable light/dark surface, 16px default text, non-italic interim text, and
  tighter spacing so more meeting text is visible.
- A compact toolbar with labelled Start/Stop, discoverable pop-out, and the gear.
  Controls remain on one row at the tested 280–640px widths.
- Recognition, Reading, and Copying preference groups in a scrollable disclosure
  that does not squeeze the transcript down to nothing in short windows.
- Accessible control labels, visible keyboard focus, state text alongside the
  status dot, and a mode badge distinguishing local from cloud recognition.
- Brief empty-state instructions for Start, copying into an AI chat, and Download.
- Only Copy and Download in the footer. Copy states its scope: “Copy all” or
  “Copy selection.” Download always includes the entire transcript.
- Word count is screen-reader context for Copy all, not a visible dashboard stat.
- Clear is behind the gear; it closes Preferences to reveal Undo. Output actions
  are disabled until text exists.
- The same optional short “Copied” toast for both automatic and manual copying;
  no button-label flash or replacement of recognition status on success.
- Persisted System/Light/Dark appearance and four reading sizes (14/16/18/20px).
- Respectful auto-scroll and a contextual Back to live button that occupies its
  own space instead of floating over transcript text.
- A manual Stop → Start now appends fresh recognition results. The previous
  implementation reused result IDs and could overwrite earlier transcript text.
- Undo for the most recent Clear. Recovery preserves incoming text and its active
  recognition keys; it is held only in memory, never added to saved preferences.

## Preserved behavior

Default-on select-to-copy; separate optional short “Copied” toast; remembered
window size; transcript handoff and sidebar closure on pop-out; audible tab
passthrough; immediate Clear of the in-flight utterance; honest model download
notice with no percentage and no “Done” state.

## Verification

`probe/ux_test.py` covers shell layout, persisted reading controls, navigation,
and recovery in isolated Chrome. Fixture text is explicitly identified as
such and enters through the real handoff/renderer. It is not speech evidence.
`probe/recovery.test.mjs` verifies recovery keys against later recognition updates.
`probe/focus_test.py` verifies the focused workflow, including real clipboard
contents after sentinel writes and actual downloaded `.txt` files with timestamps
on/off while a passage is selected. Its intended UX failures were recorded before
the corresponding production changes in `artifacts/chatgpt/focus-before.log`.
`probe/run_regressions.py` also runs the existing prefs, pop-out, selection, Clear,
model-notice, and two known-script WER tests. Full logs and structured outcomes
are retained under `artifacts/chatgpt/`.

## Deliberate limits

No Find, transcript library, built-in AI, recording upload, automatic cloud
fallback, or fleet rollout. Undo is local to the current view, not a durable
transcript backup. Download before closing the panel or window.
