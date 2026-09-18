# Error handling and verification

TabScribe must report the failed operation, preserve available transcript text,
and offer a safe next step. An API error is evidence of that failure, not proof
of an underlying cause. In particular, the reported Chrome 150 failure remains
unexplained: updating Chrome and restarting it changed two variables.

## Audited boundaries

| Boundary | Failure behavior | Regression coverage |
| --- | --- | --- |
| Recognition start, end, restart | Keep the error code and detail, including failures before `onstart`. Reset Record, bound failed retries and startup waits, ignore superseded recognizers. Do not switch to cloud. A retried code (`network`, `audio-capture`) is shown as reconnecting, not as a terminal failure with a "press Record" remedy; the remedy arrives only if retries run out. `Transcriber.active` is the recording-in-progress test: it covers the gap between a session ending and its scheduled restart, and is false once Stop begins. | `recognition-lifecycle.test.mjs`, `fatal-status.test.mjs`, `final-review-errors.test.mjs`, `error_paths_test.py` |
| Model availability and installation | Preserve policy/API exceptions instead of claiming the API is missing. Bound the wait; cancelling stops this caller's progress and prevents late recording. Chrome may continue its own download. Render error detail as text. | `model-errors.test.mjs`, `error_paths_test.py` |
| Tab capture and audio playback | Release partial captures/graphs, report blocked audio output, retain the tab-ended reason after cleanup. Retry only the known handoff active-stream race. | `capture_errors_test.py`, `mic-lifecycle.test.mjs`, real-audio suites |
| Optional microphone | Keep permission, device, language, service and track-ended failures distinct. Show acquisition failures even with Preferences closed. Release late grants and failed/replaced streams. Main tab recognition remains independent. The microphone attaches during the recognizer's restart gap, and an open panel picks up the grant `mic-permission.html` reports (a `granted` report clears an earlier session failure). | `mic-lifecycle.test.mjs`, `mic-permission-errors.test.mjs`, `final-review-errors.test.mjs`, `review_errors_test.py`, existing mic/browser suites |
| Worker startup, toolbar action, window lifecycle | Contain rejected Chrome API calls. If no panel can open, use the existing toolbar badge/title to show the failure. Validate tab IDs. | `background-errors.test.mjs` |
| View transfer | Stop and snapshot both channels. A claim reserves data; only the restoring document can acknowledge it. Do not close the source before acknowledgement. An uncertain view stays read-only until ownership is resolved; neither Stop, Window nor Sidebar can bypass that guard or stage its stale copy. Expired/failed transfers cannot be accepted late. `resume` follows what the user sees as recording, including a Start still preparing and the restart gap; the released document stops any scheduled restart and its download notice. A focus-only press from a handed-off panel that fails is reported as a failed focus, not as an unconfirmed transfer. A failed receiver replaces its waiting status with the paused state. | `background-errors.test.mjs`, `controller-errors.test.mjs`, `final-review-errors.test.mjs`, `transfer_errors_test.py`, `review_errors_test.py`, existing view-switch/live-switch suites |
| Preferences | Validate values on both reads and writes. Keep in-memory choices on write failure and report that persistence failed. Serialize this document’s writes and clear each warning only after that operation recovers. If loading fails, keep the optional microphone off until the choice can be checked; the next write re-reads storage first so the fallback never overwrites the saved choice, and the controls are re-applied once the read recovers. | `prefs-errors.test.mjs`, `persistence_errors_test.py` |
| Autosave and restore | Warn to Download or Copy before closing when autosave fails. Validate snapshots before changing live stores. Do not overwrite unreadable recovery data. Preserve microphone-only text and remove stale visible rows after a replacement snapshot. A scheduled autosave is flushed on `pagehide`, so the last seconds before a close are not lost; restoring a copy never schedules a write of it, and a document with nothing scheduled writes nothing. | `snapshot-safety.test.mjs`, `final-review-errors.test.mjs`, `output_errors_test.py`, `persistence_errors_test.py` |
| Copy | Try the browser clipboard and legacy fallback; if both fail, show the manual-copy remedy without replacing the recognition message. A late failure cannot overwrite a newer copy. | `output_errors_test.py`, existing real-clipboard suites |
| Download and Delete | A browser download request is not proof of a completed file. Keep the transcript and its unsaved marker. “Download first” leaves explicit Delete/Cancel available after the user checks Chrome's downloads. Undo restores both channels. If microphone merging fails, meeting-only export remains available with an explicit omission warning. | `output_errors_test.py`, `delete_confirm_test.py`, real-file download suites |
| Unexpected UI callback | Show a persistent warning without destroying text or claiming another operation failed. Keep the original exception in DevTools. | `output_errors_test.py` |

Independent operation warnings are displayed as text in an accessible, scrollable
alert region. Recognition status continues to report capture/recognition; a later
“Listening” callback cannot erase a failed autosave or failed Copy warning.

The audit covers all executable extension modules (`background.js`, `sidepanel.js`,
`transcriber.js`, `mic.js`, `mic-permission.js`, `prefs.js`) and the panel/permission
page markup. Icon assets and the manifest do not have runtime error paths.

## Verified release check

Chrome **151.0.7922.137**, isolated profiles on a private display: all **42
browser suites** exited successfully, with **663 reported checks**, plus the
control-row layout gate. All **266 Node tests** passed with no failures,
cancellations, or skips. Known-audio accuracy unchanged at 96.3% and 100.0%.
`probe/count_run.py` derives these numbers from the run's own artifacts and
fails if a registered suite did not run or reported fewer passes than checks.

This pass followed an independent review of the previous error-handling
commit. It found three further defects in the view-switch paths (a failed
receiver window could clear its read-only state through Sidebar and overwrite
the source's newer copy; a failed focus from a handed-off panel was reported as
an unconfirmed transfer and disabled the only remaining control; a switch
during a first-run model download dropped `resume` and left the download
notice counting in the inert view) plus a recognizer-restart gap, a missing
listener for the permission page's report, a lost final autosave on close,
retried recognizer errors shown as terminal, and a preference-load fallback
that the next write persisted. Each was reproduced as a failing test before
the fix. The verdict is at `artifacts/uiux/review-error-handling-pass2.json`.

The review's one uncertain item was then confirmed in real Chrome: when the
user closes the pop-out window by hand and a surviving panel document sits
behind it, no hand-off is staged, so the survivor stayed inert on "Moved to its
own window" with its pre-pop-out text (69 words on screen against the window's
90), and its next autosave would have overwritten the window's recovery copy.
The survivor now adopts the recovery copy and takes the tab back, as a fresh
panel's `init()` does; the worker broadcasts `WINDOW_CLOSED` after clearing the
window record so the survivor does not depend on a focus event that may arrive
first or never; a reclaim requested mid-flight is queued rather than dropped;
and a focus-only Window press for a window that is gone is refused by the
worker (`windowGone`) instead of creating a new receiver whose empty hand-off
would acknowledge over the recovery copy. `probe/switch_survivor_test.py`
covers the closed-by-hand case end to end.

Local evidence: `artifacts/uiux/regression-results.json`, per-suite logs, and
`artifacts/uiux/review-error-handling-pass2.json`. These are generated
verification artifacts; source and reproducible tests are in the repository.

## Verification and limits

Run `DISPLAY=:191 python3 probe/run_regressions.py` on a private virtual display.
The runner retains per-suite logs and exact exit codes under `artifacts/uiux/`.
Fault-injection tests replace only browser/API boundaries and exercise production
controllers, stores and DOM. They are not evidence of speech accuracy. The real
audio suites use known clean single-speaker scripts, not real meetings.

No new permissions are added. Without `downloads` permission, TabScribe cannot
observe a failed, cancelled or completed browser download. It therefore never
automatically deletes text or clears the unsaved marker after an anchor click.
Reliable automatic “save and delete” remains a separate permission decision.

Session storage survives a panel close, not a browser exit or extension reload.
An abrupt process kill, disk failure or browser crash can prevent the last
coalesced autosave. Download and verify important transcripts. Chrome-internal
faults cannot all be induced deterministically; the tests verify the exposed API
failure contracts and normal end-to-end paths, not every possible OS/browser fault.
