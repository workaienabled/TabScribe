# Probes and end-to-end tests

This directory holds the capability probes that decided TabScribe's design and the
tests that verify it. Audio suites use real Chrome recognition and known audio.
`ux_test.py` and `focus_test.py` use explicit transcript fixtures in real Chrome;
they test UI behavior, not speech accuracy. `recovery.test.mjs` is a store unit test.
The current product scope is recorded in [`PRODUCT.md`](../PRODUCT.md).

## Running

```bash
# Start a private Xvfb on :191 first. Never use the user's display or profile.
DISPLAY=:191 python3 -u run_regressions.py          # all current Chrome suites, serially
DISPLAY=:191 python3 -u focus_test.py               # real clipboard + downloaded files
DISPLAY=:191 python3 -u e2e_full.py                 # 54-word business clip
DISPLAY=:191 TABSCRIBE_CLIP=sample2.wav python3 -u e2e_full.py  # 75-word technical clip
```

Exit code 0 means every check passed. Results are also written to `e2e_result.json`.

Requires `xdotool` and `xwd` (X11), and a profile at `/tmp/tabscribe-profile` holding
the downloaded SODA model. `run_probe.py --install` creates that profile.

## What the suite proves

21 checks per run:

- the extension loads and its service worker starts (manifest is valid)
- the panel does **not** auto-open, and an `onClicked` listener is registered — the
  configuration that preserves the activeTab grant
- a real toolbar click opens the side panel
- every UI control exists
- the on-device model reports `available`
- recognition reaches the `listening` state
- **the captured tab is still audible** — `chrome.tabCapture` mutes it by default
- the transcript is non-empty
- **the final sentence survives Stop** — a naive finals-only transcript loses it
- word error rate is within 15% of ground truth
- **Copy overwrites the clipboard** — the clipboard is poisoned with a sentinel first,
  so reading back pre-existing content cannot pass as success
- the clipboard text matches the spoken audio
- Clear empties the transcript

## Findings that shaped the implementation

These were measured, not assumed. Each one changed the code.

**On-device recognition is available on Linux, but not preinstalled.**
`probe.html` + `run_probe.py`. The API surface is fully present in Chrome 151
(`available()`, `install()`, `processLocally`, `quality`), and `en-US` reports
`downloadable`, not `available` — Live Caption had never been enabled on this machine.
`install()` fetches ~310 MB and then reports `available`.

**Feeding a MediaStreamTrack to the recognizer works.**
`run_track.py`. Recognition from `player.captureStream()` produced correct text with
zero substitutions.

**But a finals-only transcript silently loses the ending.**
`diagnose_gap.py`. 14 of 54 words were missing, and the interim stream showed the
recognizer had heard every one of them. Two distinct causes: the last sentence was
still interim when `stop()` discarded it, and after the media ended the track stopped
delivering frames, so a pending segment had no audio to flush on. Hence
`TranscriptStore` keeping a high-water mark for unfinalized segments, and the
`AudioContext` keep-alive node in `buildAudioGraph`.

**Chrome 151 ignores `--load-extension` entirely.**
`check_load_extension.sh`, `debug_ext.py`. Silently, with no error, even with no
remote debugging and no enterprise policy, and even for a trivial control extension.
The replacement is the CDP `Extensions.loadUnpacked` command over
`--remote-debugging-pipe`; `--remote-debugging-port` will not do (Chrome 136+ refuses
to expose extension targets over it).

**The CDP pipe needs `close_fds=False`.**
`pipe_chrome.py`. CPython runs `preexec_fn` *before* `_close_open_fds`, so descriptors
dup2'd to 3 and 4 are closed again and Chrome exits immediately with
`Remote debugging pipe file descriptors are not open.`

**`tabCapture` requires a real user invocation; host permissions do not substitute.**
An extension holding `<all_urls>` still fails with *"Extension has not been invoked
for the current page"*. This is why the test clicks the actual toolbar icon with
`xdotool` rather than synthesizing anything.

**Manifest keyboard shortcuts cannot be used to trigger it in a test.**
Chrome leaves `commands` unassigned for unpacked extensions, and hand-writing a
binding into `extensions.commands` in Preferences is ignored —
`chrome.commands.getAll()` keeps reporting `shortcut: ""`.

**`openPanelOnActionClick: true` opens the panel but does NOT grant activeTab.**
`decide_strategy2.py` — the single most important finding. Both strategies were run on
fresh profiles with a real click:

| Strategy | Panel opens | tabCapture works |
|---|---|---|
| `openPanelOnActionClick: true` | yes | **no** — "Extension has not been invoked" |
| `onClicked` → `sidePanel.open()` | yes | **yes** |

Chrome opening the panel itself does not count as invoking the extension. Since tab
audio is the whole point, the `onClicked` path is mandatory — and `sidePanel.open()`
must be called synchronously inside the listener, before any `await`, or the
user-gesture context is gone.

**The activeTab grant and the stream id both expire.**
A stream id minted at panel-open is dead by the time a first-run model download
finishes. TabScribe therefore opens the capture stream immediately when the panel
opens, and Start only controls recognition.

**A reused Chrome profile produces phantom failures.**
`getPanelBehavior()` stayed stuck at a stale value in a profile whose Preferences had
been hand-edited. The suite now starts from a clean profile every run and grafts the
SODA registration (`accessibility.captions` in `Local State`, with absolute paths
rewritten) so the model is available without re-downloading.

**Start recognition before playback.**
Pressing Start while audio is already playing loses whatever was spoken in between —
correct behaviour, but it was being scored as a recognition error. With the order
fixed, the technical clip transcribes at 100.0%.

**Rebuilding the transcript on every update destroys the user's selection.**
`selection_test.py`. The original renderer called `replaceChildren` on each
recognition event — several times a second — so every DOM node was destroyed and
recreated, and any selection collapsed to empty. Running the test against that
renderer (`--broken`) reproduces it exactly: `collapsed: true`, selected text `""`,
and Copy grabbing the whole transcript instead of the highlighted part. The fix is
incremental rendering (one persistent node per segment, mutating the text node in
place rather than reassigning `textContent`), skipping any node the selection
intersects until the selection clears, and pausing autoscroll while selecting.

**Clearing the store does not dismiss the utterance in flight.**
`clear_test.py`. Clear emptied the DOM but left the live `SpeechRecognition` session
untouched, and that session owns its own results array. The in-flight utterance kept
the same result index, so the next event re-added the block the user had just
dismissed — measured reappearing immediately, on the very first sample after the
click, and Clear-after-Stop also left text behind. The fix is `Transcriber.reset()`:
`abort()` (unlike `stop()`) discards buffered audio without emitting a final result,
and a fresh session is started so transcription continues. Handlers are detached
before aborting, because `abort()` fires `onend`, which would otherwise trigger the
auto-restart path and race the new session.

**A tab can only be captured once, so popping out must be a handoff.**
`probe_popout.py`, run before any pop-out feature code was written. Three findings:
an extension page in a popup window *can* hold a tab capture, and keeps it while that
window is focused; a second `getMediaStreamId()` on an already-captured tab fails with
`"Cannot capture a tab with an active stream."`; and `GET_TARGET` correctly reports
the audio tab from inside the popup because the target is read from
`storage.session`, not from `tabs.query({currentWindow: true})` — which would have
returned the popup's own tab. So the side panel releases capture and hands its
transcript over, and the window restores it and re-arms.

**A late recognizer `end` event overwrites the hand-off message.**
`popout_test.py`. `transcriber.stop()` resolves before the recognition session's own
`end` event fires, and that late event ran the normal "Stopped." status path — so the
side panel claimed it was merely stopped rather than explaining the tab had moved to a
window. Fixed with a `handedOff` flag checked in `setStatus()`, which also guards the
focus-recovery handler.

**Chrome's `install()` reports no download progress, so no percentage is possible.**
`probe_download_progress.py`, run before any notice UI was designed. On Chrome 151 the
Prompt-API style `monitor` callback is never invoked, zero `downloadprogress` events
fire, and the returned promise has no own properties — matching the spec, where
`install(options)` simply resolves to a boolean. Sampling the model directory during a
real download showed it landing in two jumps (0 → 121 MB → 323 MB over ~10s on a fast
link), so even a byte-based estimate would misrepresent it. The one genuine signal is
`available()`, which reports `downloading` while a pack is being fetched. The notice is
therefore built on that state plus elapsed time, with an indeterminate bar, and says on
screen why there is no percentage. `model_notice_test.py` asserts the absence of any
`NN%` string so a future change cannot quietly start fabricating one.

**`chrome.sidePanel.close()` exists, but only `{windowId}` works.**
`probe_sidepanel_close.py`. Chrome 151 does expose `close()` (plus `onOpened` and
`onClosed`), contrary to the long-standing assumption that panels can only be opened
programmatically. It requires a `CloseOptions` argument, and the shape matters:
`close({})` rejects with "At least one of `tabId` and `windowId` must be provided";
`close({tabId})` rejects with "No active tab-specific side panel for tabId" because
this panel is window-scoped, not tab-scoped; `close({windowId})` resolves and the
panel disappears. `setOptions({enabled: false})` does **not** close an already-open
panel — it resolved, the panel stayed, and re-enabling made it spring back open — so
it is not a usable fallback. The side panel cannot see its own host window id, so it
asks the service worker, which reads `sender.tab.windowId`.

**Auto-copy must fire when the selection settles, not on `selectionchange`.**
`prefs_test.py`. `selectionchange` fires continuously throughout a drag, so copying
from it would put dozens of partial fragments on the clipboard and leave whichever
one happened to fire last. Auto-copy listens on `mouseup` / `keyup` / `dblclick`
instead, and dedupes against the last copied string so an unchanged selection
(clicking inside it, a focus change) does not copy repeatedly.

**The empty-state placeholder lives inside `#transcript`.**
Two test bugs in a row came from this. Counting words via
`#transcript.innerText` counted the "Click Start to transcribe…" placeholder, so
the test proceeded believing it had transcript text. Then a selection built over
the placeholder's text nodes produced a range with `rangeCount: 1` and
`isCollapsed: false` but `toString() === ""` — because the placeholder is
`display:none` once real text arrives, and `toString()` reflects rendered text.
That looked exactly like a broken auto-copy. Both now scope strictly to `.seg`
elements. `debug_selection.py` is the trace that separated the two.

**A "done" state that only disappears is noise.**
The model notice used to show "Model ready" for 2.5 seconds after a download.
Removed: on the common path (model already installed) the user never needed to know
a model existed. `model_notice_test.py` now samples the panel continuously
throughout the download rather than once at the end, because a state that appears
for two seconds and vanishes is invisible to a single sample taken afterwards.

**Feedback that fires on every selection has to be small.**
The auto-copy confirmation was a full-pane background flash. With select-to-copy on,
that fires on every selection while reading, which is exactly the wrong place for a
large animation. Replaced with a short "Copied" toast above the footer, and given
its own toggle so the confirmation can be silenced without disabling the copying.

**"Fits on one line" is a measurement, not an impression.**
`measure_button_row.py` reports how many rows the top buttons occupy across panel
widths from 300px to 480px. The labelled *Preferences* button fit only at 430px and
above — the width the screenshots happened to use — and wrapped everywhere below.
The gear icon (112px → 33px) fixed 360px and up; 300–320px additionally needed the
pop-out button to drop its text label. Now one row at every width tested.

Two traps in that measurement. Grouping buttons into rows by an exact `top` value
reports a wrap when an icon-only button is merely 2px shorter than its neighbours;
group by vertical overlap instead. And the 2px difference was itself a real defect
(`align-self: stretch` fixes it), so the noisy signal was worth reading rather than
silencing.

**`install()` resolving does not mean the recognizer is ready.**
An `e2e_full.py` run scored 0% accuracy with all 54 words deleted, immediately after
a fresh model install. Not a product fault: Chrome registers the pack
asynchronously, so a `start()` issued right after `install()` resolves can attach to
nothing. The suite now polls `available()` until it settles and waits a few seconds
more. Re-running without the fix passed, which is exactly why it needed fixing — an
intermittent 0% is worse than a consistent one.

## Files

| File | Purpose |
|---|---|
| `e2e_full.py` | the end-to-end suite |
| `selection_test.py` | selection survives live updates; `--broken` proves it detects the bug |
| `clear_test.py` | Clear dismisses the in-flight block and transcription keeps running |
| `probe_popout.py` | design probe: can a popup window hold the capture, and can two? |
| `probe_sidepanel_close.py` | design probe: can the extension close its own side panel? |
| `popout_test.py` | the pop-out handoff end to end, incl. the panel closing |
| `probe_download_progress.py` | design probe: does install() expose real progress? (it does not) |
| `model_notice_test.py` | first-run notice: shown, honest, clears when ready |
| `prefs_test.py` | preferences disclosure, select-to-copy, copy toast, persistence, window size |
| `measure_button_row.py` | how many rows the top buttons occupy, across panel widths |
| `debug_selection.py` | traces why a programmatic Selection reads back empty |
| `shoot_model_notice.py` | renders each notice state to `shots/` for visual review |
| `pipe_chrome.py` | CDP client over `--remote-debugging-pipe` |
| `toolbar_click.py` | finds the toolbar icon by colour and clicks it via xdotool; includes an XWD decoder |
| `wer.py` | word error rate scoring with number normalization |
| `run_probe.py` / `probe.html` | on-device API and model availability probe |
| `run_track.py` / `track.html` | MediaStreamTrack recognition probe |
| `diagnose_gap.py` | interim-vs-final analysis that found the tail loss |
| `decide_strategy2.py` | the activeTab strategy comparison |
| `check_load_extension.sh` | proves `--load-extension` is dead |
| `cleanup.sh` | kills stale test Chromes and frees the port |

`cleanup.sh` matches only the chrome binary and inspects `/proc` for the profile path,
killing by explicit PID. Two rules it encodes, both learned the hard way:

- **Never `pkill -f tabscribe`.** That pattern also matches the calling shell and kills
  the caller.
- **Match both test profile prefixes.** Suite fixtures live under `/tmp/tabscribe*` but
  design probes use `/tmp/ts-*`. An earlier version matched only the first, so eleven
  orphaned probe processes stayed running while cleanup reported success. The user's
  real browser has no `/tmp` profile and is never matched — verified by spawning a
  decoy on `/tmp/ts-*` and confirming it dies while the user's Chrome keeps running.
