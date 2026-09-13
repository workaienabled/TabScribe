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
