# UI/UX refinement pass

## Scope

Keep the 13px, full-width transcript and one compact toolbar. Improve the existing
capture → select/copy → download workflow without adding a header, footer, search,
AI integration, dependencies, permissions, or a new capture lifecycle.

The `uiux` branch was recreated from `master` in `/home/a/tabscribe-uiux`.
The loaded `/home/a/tabscribe` checkout, personal Chrome, and remote desktops
were not reloaded or deployed to. Screenshots use labelled example text;
they are not transcription evidence.

## Changes and evidence

- **Quiet toolbar.** Neutral actions lose redundant boxes. Record, unsaved
  Download, microphone state, expanded Preferences, and destructive color remain
  distinct. Delete is aligned with its neighbors. The recording dot attaches to
  Record instead of pushing Delete off-screen at 280px. The disabled microphone
  indicator stays readable: disabled means it has no click action, not that the
  microphone stopped. Incoming text now meets a 4.5:1 light-theme contrast gate.
  The default transcript size, spacing, and Window/Sidebar labels are unchanged.
- **Preferences.** Two semantic groups separate transcription from reading/copying.
  All six checkbox labels have at least 28px hit height, without shrinking the
  transcript's default type. The drawer scrolls rather than covering the transcript.
  Keyboard activation reveals and focuses Language; Escape returns to the gear.
  Reopening after scrolling also reveals the focused control. Pointer activation
  does not force focus or reset the reader's selection.
- **Confirmation and feedback.** Buttons wrap in narrow panels, with all actions
  on-screen and at least 28px tall. The toast sits above the actual feedback bars,
  not a guessed fixed bar height. Escape cancels an open Delete question even when
  focus moved back to the transcript, without also closing Preferences. Download
  and delete, explicit Delete, Cancel, and Undo retain their existing semantics.
- **Restoring cleared text.** Missing rows are inserted in store order, rather
  than appended after newer speech. Existing selected nodes are never moved or
  replaced. Tests verify two Clear/Show cycles, exact selected clipboard output,
  full clipboard output, and the downloaded file contents.

Each new behavior had a failing regression before its implementation. Independent
review caught two CSS-state specificity issues and a scrolled-focus issue; each
received an additional failing test and a verified correction. The unchanged
master baseline completed all 30 suites with zero failing exits.

## Re-run

Use an agent-owned X display and fresh Chrome profiles. Run fixture-audio suites
serially because they share port 8899. Do not use the person's signed-in browser.

```sh
DISPLAY=:193 /usr/bin/python3 probe/run_regressions.py
node --test probe/recovery.test.mjs probe/mic-merge.test.mjs
/usr/bin/python3 probe/mic_cleanup_test.py
DISPLAY=:194 /usr/bin/python3 probe/shoot_ui.py
```

The serial runner includes `ui_refinement_test.py`, `preferences_refinement_test.py`,
`feedback_refinement_test.py`, and `restore_order_test.py`. Results and screenshots
are local under `artifacts/uiux/`; the full runner writes `regression-results.json`.

## Test teardown

The first full run had zero failed behavioral assertions, but the microphone
suite exited nonzero after its 12/12 result: a late Chrome profile write raced
`TemporaryDirectory` cleanup (`ENOTEMPTY`). It is preserved locally in
`artifacts/uiux-first-run/`, not counted as a successful full run.

The microphone harness now kills Chrome, then retries deletion of its owned
session directory only for `ENOTEMPTY`, at most 20 attempts. Permission errors
and persistent failures remain fatal. Three fault-injection unit tests failed
before the change and pass after it; three real microphone-suite reruns also
completed with zero exits. This is test teardown only, not an extension change.

## Deliberately unchanged

Capture ownership, recognition, view handoff, autosave, microphone isolation,
copy/download scope, default preferences, and manifest permissions. Native Chrome
close warnings remain absent. No claim is made about real-meeting accuracy.

The existing download implementation initiates Chrome's download with a Blob link.
Without a downloads permission it cannot verify later cancellation or disk failure;
this pass does not expand permissions or claim it solved that limitation.
