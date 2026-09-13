# The `chatgpt` UI/UX pass

## Direction

Make TabScribe a quiet reading tool rather than a wall of browser controls. Keep
recognition and capture semantics intact. Do not add a framework, hosted assets,
analytics, new permissions, or new transcription services.

## Changes

- A calmer light/dark palette, stronger type hierarchy, 16px default transcript
  text, comfortable line spacing, and non-italic interim text.
- A compact toolbar with labelled Start/Stop, discoverable pop-out, and the gear.
  Controls remain on one row at the tested 280–640px widths.
- Recognition, Reading, and Copying preference groups in a scrollable disclosure
  that does not squeeze the transcript down to nothing in short windows.
- Accessible control labels, visible keyboard focus, state text alongside the
  status dot, and a mode badge distinguishing local from cloud recognition.
- A useful empty state and disabled Copy/Save/Clear controls until text exists.
- Persisted System/Light/Dark appearance and four reading sizes (14/16/18/20px).
- Respectful auto-scroll and explicit Jump to latest.
- Literal, case-insensitive Find within transcript segments, with counts and
  next/previous navigation. CSS Highlights preserve original DOM text nodes.
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
Find, and recovery in isolated Chrome. Fixture text is explicitly identified as
such and enters through the real handoff/renderer. It is not speech evidence.
`probe/recovery.test.mjs` verifies recovery keys against later recognition updates.
`probe/run_regressions.py` also runs the existing prefs, pop-out, selection, Clear,
model-notice, and two known-script WER tests. Full logs and structured outcomes
are retained under `artifacts/chatgpt/`.

## Deliberate limits

No transcript library, recording upload, automatic cloud fallback, or fleet
rollout. Find searches within each recognized segment, not across segment
boundaries. Undo is local to the current view, not a durable transcript backup.
