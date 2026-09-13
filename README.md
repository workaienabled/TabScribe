# TabScribe

Live transcription of any Chrome tab's audio, with a copy button.

Uses the same on-device speech engine as Chrome's Live Caption (SODA), so quality and
latency match Live Caption — but the text lands in a panel you can select, copy,
and save. Audio never leaves your machine.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Click the puzzle-piece icon in the toolbar and pin **TabScribe**.

Requires Chrome 150 or newer. Check yours at `chrome://version`.

## Use

1. Go to the tab you want to transcribe and start playing audio.
2. **Click the TabScribe toolbar icon.** This is required — the click is what
   authorises Chrome to capture that tab. Opening the side panel any other way will
   not work.
3. Press **Start**.
4. Text appears live. **Copy** puts the transcript on the clipboard, **Save** writes a
   `.txt` file, **Clear** empties the panel — including the block still being spoken.
   Clearing while transcribing keeps transcription running; the next thing said starts
   a fresh block.

### Copying part of the transcript

Select any text in the panel and it stays selected while transcription continues —
new speech keeps arriving underneath without disturbing it. The button changes to
**Copy selection** and copies only what you highlighted. Ctrl+C works too.

While anything is selected, a blue rule appears down the left edge of the panel: that
means autoscroll is paused and updates to the selected lines are being held back until
you click away. Nothing is lost — held text appears the moment the selection clears.

With nothing selected, **Copy** takes the whole transcript as before.

**Select to copy** (on by default) copies a selection the moment you finish making
it — no button press. The copy fires when the selection settles, not while you are
still dragging, and a small **Copied** toast confirms it. **Copy toast** silences
that confirmation without turning off the copying itself.

### Preferences

Only Start, Stop, and Open in window are always visible. Everything else —
language, on-device mode, timestamps, auto-scroll, select-to-copy, copy toast —
lives behind the gear button, which remembers whether you left it open.

The gear is an icon rather than a labelled button so all four top controls fit on
one line: with a text label the row wrapped at any panel narrower than about
430px, which is most of the time. Below 340px the pop-out button drops to its icon
too. Both are measured rather than assumed — see `probe/measure_button_row.py`.

### Settings are remembered

Language, on-device mode, timestamps, auto-scroll, select-to-copy, copy toast,
whether the preferences group is expanded, and the pop-out window's size persist
across restarts, in `chrome.storage.local`. They are stored per machine rather than
synced, since window size and language are usually machine-specific.

The side panel and a pop-out window share one set of preferences and update each
other live, so changing a toggle in one is reflected in the other rather than being
overwritten.

### Its own window

The **⧉ Open in window** button in the controls row moves TabScribe into a separate
window you can park on a second monitor or beside the tab you are listening to.

The side panel closes as the window opens, so only one copy is live. The transcript
comes with it, and if it was transcribing it keeps going without you pressing
anything. A tab can only be captured once, which is why this is a handoff rather than
two views. Close the window and the toolbar button brings the side panel back.

If your Chrome is too old to support closing a side panel programmatically, the panel
stays open and says so; the window still works.

### First run: the model download

The first time you transcribe in a given language, Chrome downloads its on-device
speech model — roughly 300 MB. TabScribe tells you before you press Start, and shows a
live notice while it runs, with elapsed time and a **Use cloud instead** escape hatch
if you would rather not wait.

There is no percentage, deliberately. Chrome's `install()` reports no download
progress at all — no progress events, no byte counts — so any percentage would be
invented. The notice shows the state Chrome actually reports plus elapsed time, and
says so on screen.

There is also no "done" state. Once the model is present the notice simply
disappears: a panel that exists only to announce its own irrelevance is noise, and
on the common path the user never needed to know a model existed.

If the download fails, the notice says so and offers **Retry download**. Nothing is
kept from a failed attempt, so a retry starts over; a stable connection matters more
than a fast one.

Once installed, the model is reused forever and works offline. Each additional
language downloads its own pack the first time you select it.

### Options

| Control | Effect |
|---|---|
| Language | Recognition language. Each language downloads its own pack on first use. |
| On-device only | Keeps audio on your machine. Uncheck to use Chrome's cloud service (sends audio to Google). |
| Timestamps | Prefixes each segment with its elapsed time. |
| Auto-scroll | Follows the newest text. |

## Notes

- The tab stays audible while being captured.
- Transcription follows the tab you started on, so you can switch tabs freely.
- If the tab navigates or closes, capture ends and the transcript is kept.
- To transcribe a different tab, click the toolbar icon on that tab.
- Chrome's own pages (`chrome://`, the Web Store) cannot be captured. That is a Chrome
  restriction, not a TabScribe one.

## Verified behaviour

Measured end to end on Chrome 151 (Linux) against known speech, scored by word error
rate:

| Clip | Accuracy | Notes |
|---|---|---|
| 54-word business script | 96.3% | only difference: "road map" vs "roadmap" |
| 75-word technical podcast | 100.0% | exact match |

Run the suite yourself:

```bash
cd probe
python3 -u e2e_full.py                              # 54-word clip, 21 checks
TABSCRIBE_CLIP=sample2.wav python3 -u e2e_full.py   # 75-word clip, 21 checks
python3 -u selection_test.py                        # selection survival, 9 checks
python3 -u selection_test.py --broken               # proves that test detects the bug
python3 -u clear_test.py                            # Clear drops the live block, 9 checks
python3 -u popout_test.py                           # pop-out window handoff, 19 checks
python3 -u model_notice_test.py                     # first-run download notice, 16 checks
python3 -u prefs_test.py                            # prefs UI, select-to-copy, toast, persistence, 48 checks
```

The main suite covers the toolbar-click grant, on-device model availability, live
capture, tab audibility during capture, transcript accuracy, the copy path, and clear.
`selection_test.py` covers selecting text mid-transcription and copying only that part;
its `--broken` mode restores the old rebuild-everything renderer and is expected to
fail, which is what shows the test would catch a regression. `clear_test.py` clears
mid-utterance and checks the dismissed block does not reappear and that transcription
keeps running. `popout_test.py` covers the window handoff: transcript carried across,
recognition resumed, no duplicate windows, and the side panel recovering the tab
afterwards. See `probe/README.md`.

## Layout

```
extension/          the extension itself — load this directory unpacked
  manifest.json      MV3 manifest
  background.js      service worker: panel opening + tab-capture stream ids
  transcriber.js     recognition core and transcript store (no DOM)
  prefs.js           persisted user preferences (chrome.storage.local)
  sidepanel.html/css/js   the panel UI, shared by the side panel and the window
probe/               capability probes and the end-to-end test suite
testdata/            generated speech used as ground truth
make-source-zip.py   rebuilds source-code.zip
```

## Packaging

```bash
python3 make-source-zip.py     # source-code.zip — full tree, extracts as tabscribe/
```

`source-code.zip` omits only regenerable artifacts: `__pycache__/`, `probe/shots/`
(rebuild with `probe/shoot_model_notice.py`), and the packaged
`tabscribe-extension.zip`. It was verified by extracting it to a clean directory and
running the full e2e suite from there — 21/21.

To load the extension without any packaging step, point Chrome's **Load unpacked** at
the `extension/` directory.
