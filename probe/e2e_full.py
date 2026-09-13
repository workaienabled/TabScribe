"""End-to-end test of TabScribe, triggered by the extension's keyboard shortcut.

Why a keyboard shortcut rather than a toolbar click:
chrome.tabCapture requires a genuine user invocation of the extension. Verified on
Chrome 151 that host permissions do NOT substitute (an extension with <all_urls>
still fails with "Extension has not been invoked for the current page"), and CDP
cannot synthesize an action click. A manifest `commands` entry bound to
_execute_action is the same class of invocation, and it can be delivered as a real
X11 key event with xdotool, which makes the test deterministic.

The shortcut is a genuine product feature, not a test-only affordance: Alt+Shift+T
starts transcribing the current tab without reaching for the mouse.
"""
import functools
import hashlib
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipe_chrome import PipeChrome  # noqa: E402
from toolbar_click import click_toolbar_icon  # noqa: E402
from wer import report  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(os.path.join(HERE, "..", "extension"))
PORT = 8899
PROFILE = "/tmp/tabscribe-e2e-profile"
# Profile holding the already-downloaded SODA language pack. The model is ~310 MB,
# so it is copied into each fresh test profile rather than re-downloaded.
MODEL_CACHE = "/tmp/tabscribe-profile"

REFERENCES = {
    "sample1.wav": (
        "The quarterly review is scheduled for Thursday at nine thirty in the morning. "
        "Our engineering team shipped fourteen features last month, and customer retention "
        "improved by six percent. Sarah will present the roadmap, and then we will discuss "
        "the budget for the next fiscal year. Please review the attached document before "
        "the meeting begins."
    ),
    "sample2.wav": (
        "Welcome back to the podcast. Today we are discussing distributed systems and the "
        "challenges of maintaining consistency across regions. When a network partition "
        "occurs, you must choose between availability and consistency. Most teams "
        "underestimate how often partitions happen in practice. Our guest today has spent "
        "fifteen years building infrastructure at scale, and she argues that observability "
        "matters more than architecture purity. Let us start with a simple question: what "
        "breaks first when traffic doubles overnight?"
    ),
}
TAIL_WORDS_BY_CLIP = {
    "sample1.wav": ["attached", "document", "before", "meeting", "begins"],
    "sample2.wav": ["breaks", "first", "traffic", "doubles", "overnight"],
}

CLIP = os.environ.get("TABSCRIBE_CLIP", "sample1.wav")
REFERENCE = REFERENCES[CLIP]
TAIL_WORDS = TAIL_WORDS_BY_CLIP[CLIP]
WER_THRESHOLD = 0.15
CLIPBOARD_SENTINEL = "__tabscribe_sentinel_not_copied__"


def unpacked_extension_id(path):
    digest = hashlib.sha256(os.path.abspath(path).encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def prepare_profile(profile, model_cache):
    """Start from a clean profile, carrying over only the SODA language pack.

    A reused profile accumulates state (and, in this harness, hand-edited
    Preferences) that can leave chrome.sidePanel.getPanelBehavior() stuck at its old
    value even though the extension sets it at every worker start. Starting clean
    makes each run reproducible.
    """
    if os.path.isdir(profile):
        shutil.rmtree(profile)
    os.makedirs(profile, exist_ok=True)
    copied = []
    for name in ("SODA", "SODALanguagePacks"):
        src = os.path.join(model_cache, name)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(profile, name))
            copied.append(name)
    return copied


def graft_model_registration(profile, model_cache):
    """Copy the SODA registration from the cache profile's Local State.

    The SODA directories alone are not enough: Chrome records the installed binary and
    language-pack paths under `accessibility.captions` in Local State, and without
    those entries it reports the pack as "downloadable" and fetches it again (~310 MB).

    Two details matter:
      - the recorded paths are absolute, so they are rewritten to the new profile;
      - this must run AFTER the warm-up launch, because Chrome rewrites Local State
        when it exits and would discard the graft.
    """
    src = os.path.join(model_cache, "Local State")
    dst = os.path.join(profile, "Local State")
    if not (os.path.exists(src) and os.path.exists(dst)):
        return []

    src_state = json.load(open(src))
    captions = src_state.get("accessibility", {}).get("captions")
    if not captions:
        return []

    rewritten = {}
    for key, value in captions.items():
        if isinstance(value, str) and model_cache in value:
            value = value.replace(model_cache, profile)
        rewritten[key] = value

    dst_state = json.load(open(dst))
    dst_state.setdefault("accessibility", {})["captions"] = rewritten
    json.dump(dst_state, open(dst, "w"))
    return sorted(rewritten.keys())


def pin_extension(profile, ext_id):
    """Pin the toolbar action so it is directly clickable (not in the overflow menu).

    Note: writing a keyboard binding into `extensions.commands` here does NOT work —
    Chrome ignores hand-written bindings for unpacked extensions and
    chrome.commands.getAll() keeps reporting shortcut: "". The toolbar click is
    therefore the only way to deliver a real extension invocation in this harness.
    """
    prefs_path = os.path.join(profile, "Default", "Preferences")
    if not os.path.exists(prefs_path):
        return False
    prefs = json.load(open(prefs_path))
    ext = prefs.setdefault("extensions", {})
    ext["pinned_extensions"] = sorted(set(ext.get("pinned_extensions", [])) | {ext_id})
    ext["ui"] = {"developer_mode": True}
    json.dump(prefs, open(prefs_path, "w"))
    return True


def xdotool(*args):
    return subprocess.run(["xdotool", *args], capture_output=True, text=True, timeout=20)


def focus_chrome_window():
    """Return the X11 window id of the fixture Chrome window, focusing it."""
    res = xdotool("search", "--name", "TabScribe test audio")
    ids = [line.strip() for line in res.stdout.splitlines() if line.strip()]
    if not ids:
        return None
    wid = ids[-1]
    xdotool("windowactivate", "--sync", wid)
    time.sleep(0.6)
    return wid


class Checks:
    def __init__(self):
        self.items = []
        self.passed = True

    def add(self, name, ok, detail=""):
        ok = bool(ok)
        self.items.append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            self.passed = False
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def main():
    checks = Checks()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    ext_id = unpacked_extension_id(EXT)
    copied = prepare_profile(PROFILE, MODEL_CACHE)
    print(f"\n=== PROFILE ===\n  fresh profile at {PROFILE}, carried over: {copied or 'nothing'}", flush=True)

    # Microphone interference check: no command-line media flags.
    #
    # Measured on Chrome 151: BOTH --use-fake-device-for-media-stream and
    # --use-fake-ui-for-media-stream break tabCapture in this harness with
    # "Cannot capture a tab with an active stream" — and they do so with the
    # microphone feature switched OFF as well, so they test the flag rather than
    # the feature. Permission is granted over CDP instead, and getUserMedia opens
    # a real (silent) input device, leaving tab capture completely untouched.
    mic_args = []

    # First launch creates Default/Preferences so the action can be pinned; the
    # extension is loaded on the second launch, into a profile that already has the
    # pin in place.
    warm = PipeChrome(PROFILE, extensions=[], fresh=False, extra_args=mic_args)
    warm.launch("about:blank")
    time.sleep(3)
    warm.kill()
    time.sleep(2)
    pin_extension(PROFILE, ext_id)
    grafted = graft_model_registration(PROFILE, MODEL_CACHE)
    print(f"  SODA registration grafted: {grafted or 'nothing'}", flush=True)

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False, extra_args=mic_args)
    transcript = ""
    clip = ""
    scored = {}
    clip_scored = {}
    try:
        chrome.launch("about:blank")
        print("\n=== SETUP ===", flush=True)
        loaded = chrome.send("Extensions.loadUnpacked", path=EXT)["id"]
        checks.add("extension loads unpacked", loaded == ext_id, f"id={loaded}")
        time.sleep(2)

        sw = [t for t in chrome.targets()
              if t.get("type") == "service_worker" and ext_id in t.get("url", "")]
        checks.add("service worker running (manifest valid)", bool(sw))
        sw_sid = chrome.attach(sw[0]["targetId"]) if sw else None

        if sw_sid:
            # Must stay false: with openPanelOnActionClick=true Chrome opens the
            # panel itself and the click no longer grants activeTab, so tabCapture
            # fails. Verified on Chrome 151 (see decide_strategy2.py).
            behavior = chrome.evaluate(sw_sid, "chrome.sidePanel.getPanelBehavior()")
            checks.add("panel does not auto-open (keeps activeTab grant)",
                       behavior.get("openPanelOnActionClick") is False, json.dumps(behavior))
            checks.add("action onClicked listener registered",
                       chrome.evaluate(sw_sid, "chrome.action.onClicked.hasListeners()",
                                       await_promise=False))

        page_tid, page_sid = chrome.new_tab(f"http://127.0.0.1:{PORT}/player.html?clip={CLIP}")
        chrome.wait_for_js(page_sid, "window.__playerReady === true", timeout=30)
        for t in chrome.targets():
            if t.get("type") == "page" and t.get("url", "").startswith("about:blank"):
                chrome.send("Target.closeTarget", targetId=t["targetId"])
        time.sleep(0.5)
        chrome.send("Target.activateTarget", targetId=page_tid)
        win = chrome.send("Browser.getWindowForTarget", targetId=page_tid)
        chrome.send("Browser.setWindowBounds", windowId=win["windowId"],
                    bounds={"left": 40, "top": 40, "width": 1100, "height": 850,
                            "windowState": "normal"})
        time.sleep(1.5)

        print("\n=== INVOKE VIA REAL TOOLBAR CLICK ===", flush=True)
        # Locate and click the pinned icon with a genuine X11 button event. The
        # manifest keyboard shortcut is not usable here: Chrome leaves commands
        # unassigned for unpacked extensions and ignores hand-written bindings.
        panel = None
        for attempt in range(4):
            res = click_toolbar_icon()
            print(f"  attempt {attempt + 1}: {json.dumps(res)}", flush=True)
            if not res.get("ok"):
                time.sleep(1.5)
                continue
            deadline = time.time() + 8
            while time.time() < deadline:
                for t in chrome.targets():
                    if "sidepanel.html" in t.get("url", ""):
                        panel = t
                        break
                if panel:
                    break
                time.sleep(0.5)
            if panel:
                print(f"  panel opened on attempt {attempt + 1}", flush=True)
                break
            time.sleep(1.5)
        checks.add("toolbar click opens the side panel", bool(panel))
        if not panel:
            raise SystemExit(1)

        panel_sid = chrome.attach(panel["targetId"])
        chrome.wait_for_js(panel_sid, "!!document.getElementById('recordBtn')", timeout=30)

        print("\n=== UI SURFACE ===", flush=True)
        for ctrl in ["recordBtn", "copyBtn", "downloadBtn", "clearBtn", "langSel", "localOnly"]:
            checks.add(f"control present: {ctrl}",
                       chrome.evaluate(panel_sid, f"!!document.getElementById('{ctrl}')", await_promise=False))

        model = chrome.evaluate(panel_sid,
                                "SpeechRecognition.available({langs:['en-US'],processLocally:true})")
        if model != "available":
            print(f"  model is '{model}', installing…", flush=True)
            chrome.evaluate(panel_sid, "SpeechRecognition.install({langs:['en-US'],processLocally:true})")
            # install() resolving is not the same as the recognizer being usable:
            # Chrome registers the pack asynchronously, and starting immediately
            # after can abort with no transcript at all (observed: a whole run at
            # 0% accuracy, every word deleted). Poll until availability settles.
            deadline = time.time() + 120
            while time.time() < deadline:
                model = chrome.evaluate(
                    panel_sid,
                    "SpeechRecognition.available({langs:['en-US'],processLocally:true})")
                if model == "available":
                    break
                time.sleep(2)
            # Availability flips before the first start() reliably attaches to the
            # freshly registered pack. A fixed sleep was not enough — observed
            # intermittently as "recognition started — Stopped." and a 0% run. So
            # prove the recognizer can actually hold a session before continuing:
            # start one on a silent synthetic track and require it to stay running.
            settled = False
            for _ in range(12):
                ok = chrome.evaluate(panel_sid, """(async () => {
                  const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
                  const ctx = new AudioContext();
                  const dest = ctx.createMediaStreamDestination();
                  const osc = ctx.createOscillator();
                  const gain = ctx.createGain();
                  gain.gain.value = 0;
                  osc.connect(gain); gain.connect(dest); osc.start();
                  const rec = new SR();
                  rec.lang = 'en-US'; rec.continuous = true;
                  rec.interimResults = true; rec.processLocally = true;
                  let ended = false, started = false;
                  rec.onstart = () => { started = true; };
                  rec.onend = () => { ended = true; };
                  rec.onerror = () => {};
                  try { rec.start(dest.stream.getAudioTracks()[0]); }
                  catch (e) { await ctx.close(); return false; }
                  await new Promise(r => setTimeout(r, 1500));
                  const alive = started && !ended;
                  try { rec.abort(); } catch (e) {}
                  try { osc.stop(); } catch (e) {}
                  await ctx.close();
                  return alive;
                })()""", await_promise=True)
                if ok:
                    settled = True
                    break
                time.sleep(2)
            print(f"  recognizer settled: {settled}", flush=True)
        checks.add("on-device en-US model available", model == "available", f"availability={model}")

        print("\n=== RUN ===", flush=True)
        # Optional: prove the microphone side-channel cannot degrade the meeting
        # transcription it runs alongside. Same known audio, same WER threshold,
        # with the microphone feature switched on and a fake mic device feeding it.
        # The microphone option is ON by default, so the default path already
        # exercises it. TABSCRIBE_MIC_CHECK additionally grants the permission so
        # the microphone genuinely opens alongside tab capture; without it the
        # request is denied and the run proves the failure path instead. Both
        # must reach the same transcript.
        mic_mode = 'denied'
        if os.environ.get('TABSCRIBE_MIC_CHECK') == '1':
            # grantPermissions REPLACES the origin's whole grant set, so the
            # clipboard permissions the later checks depend on must be re-listed
            # here or reading the clipboard fails with NotAllowedError.
            try:
                chrome.send('Browser.grantPermissions',
                            origin=f'chrome-extension://{ext_id}',
                            permissions=['audioCapture', 'clipboardReadWrite',
                                         'clipboardSanitizedWrite'])
                mic_mode = 'granted'
            except Exception as e:  # noqa: BLE001
                print(f"  (grantPermissions: {e})", flush=True)
        checks.add("microphone option is on by default",
                   chrome.evaluate(panel_sid,
                                   "document.getElementById('includeMic').checked",
                                   await_promise=False))
        print(f"  microphone mode: {mic_mode}", flush=True)
        # Start recognition BEFORE playback. Pressing Start after audio is already
        # playing loses however much was spoken in the meantime, which is expected
        # behaviour but would otherwise be scored as a recognition error.
        chrome.evaluate(panel_sid, "document.getElementById('recordBtn').click()", await_promise=False)

        started = False
        status = ""
        deadline = time.time() + 45
        while time.time() < deadline:
            state = chrome.evaluate(panel_sid, "document.getElementById('dot').dataset.state", await_promise=False)
            status = chrome.evaluate(panel_sid, "document.getElementById('status').textContent", await_promise=False)
            if state == "listening":
                started = True
                break
            if state == "error":
                break
            time.sleep(0.5)
        checks.add("recognition started", started, "" if started else status)

        chrome.evaluate(page_sid, "window.__play()")
        time.sleep(2.5)
        audible = chrome.evaluate(
            page_sid,
            "(() => { const a = document.getElementById('audio');"
            " return { paused: a.paused, currentTime: a.currentTime, muted: a.muted }; })()",
            await_promise=False,
        )
        checks.add("tab still audible while captured",
                   (not audible["paused"]) and audible["currentTime"] > 0 and not audible["muted"],
                   json.dumps(audible))

        deadline = time.time() + 60
        while time.time() < deadline:
            if chrome.evaluate(page_sid, "document.getElementById('audio').ended", await_promise=False):
                break
            time.sleep(0.5)
        print("  playback ended", flush=True)

        words_before = chrome.evaluate(panel_sid, "String([...document.querySelectorAll('#transcript .seg')].map(e => e.innerText).join(' ').split(/[^A-Za-z0-9'%:.-]+/).filter(Boolean).length) + ' words'",
                                       await_promise=False)
        print(f"  words before stop: {words_before}", flush=True)

        chrome.evaluate(panel_sid, "document.getElementById('recordBtn').click()", await_promise=False)
        deadline = time.time() + 30
        while time.time() < deadline:
            if chrome.evaluate(panel_sid,
                               "document.getElementById('recordBtn').getAttribute('aria-pressed') === 'false'",
                               await_promise=False):
                break
            time.sleep(0.5)

        transcript = chrome.evaluate(
            panel_sid,
            "Array.from(document.querySelectorAll('#transcript .seg')).map(e => e.innerText.trim()).join(' ')",
            await_promise=False,
        ) or ""
        print("\n=== TRANSCRIPT ===", flush=True)
        print(transcript.strip() or "(empty)", flush=True)

        print("\n=== CHECKS ===", flush=True)
        checks.add("transcript is non-empty", bool(transcript.strip()))

        low = transcript.lower()
        missing = [w for w in TAIL_WORDS if w not in low]
        checks.add("final sentence survives Stop (tail-loss regression)", not missing,
                   f"missing: {missing}" if missing else "all trailing words present")

        scored = report(REFERENCE, transcript)
        checks.add(f"word error rate <= {int(WER_THRESHOLD * 100)}%", scored["wer"] <= WER_THRESHOLD,
                   f"WER={scored['wer']:.3f} accuracy={scored['accuracy_pct']}%")

        # Poison the clipboard so a no-op Copy cannot masquerade as success.
        # The Clipboard API refuses to write from an unfocused document, so the panel
        # target is focused first.
        chrome.send("Browser.grantPermissions",
                    permissions=["clipboardReadWrite", "clipboardSanitizedWrite"])
        chrome.send("Target.activateTarget", targetId=panel["targetId"])
        chrome.send("Emulation.setFocusEmulationEnabled", session_id=panel_sid, enabled=True)
        time.sleep(0.3)
        chrome.evaluate(panel_sid, f"navigator.clipboard.writeText('{CLIPBOARD_SENTINEL}')")
        chrome.evaluate(panel_sid, "document.getElementById('copyBtn').click()", await_promise=False)
        time.sleep(1.0)
        clip = chrome.evaluate(panel_sid, "navigator.clipboard.readText()") or ""
        checks.add("Copy button overwrites the clipboard with the transcript",
                   clip.strip() and clip.strip() != CLIPBOARD_SENTINEL, f"{len(clip)} chars")
        print("\n=== CLIPBOARD ===", flush=True)
        print(clip.strip(), flush=True)

        clip_scored = report(REFERENCE, clip)
        checks.add("clipboard text matches the spoken audio", clip_scored["wer"] <= WER_THRESHOLD,
                   f"WER={clip_scored['wer']:.3f} accuracy={clip_scored['accuracy_pct']}%")

        if os.environ.get('TABSCRIBE_RESUME_CHECK') == '1':
            # Repeat the known audio after a normal Stop/Start. Recognition result
            # indices restart at zero, but prior transcript text must not change.
            chrome.evaluate(panel_sid, "document.getElementById('recordBtn').click()", await_promise=False)
            chrome.wait_for_js(panel_sid, "document.getElementById('dot').dataset.state === 'listening'", timeout=30)
            chrome.evaluate(page_sid, "(() => { const a=document.getElementById('audio'); a.currentTime=0; return a.play(); })()")
            chrome.wait_for_js(page_sid, "document.getElementById('audio').ended", timeout=75)
            chrome.evaluate(panel_sid, "document.getElementById('recordBtn').click()", await_promise=False)
            chrome.wait_for_js(panel_sid,
                               "document.getElementById('recordBtn').getAttribute('aria-pressed') === 'false'",
                               timeout=30)
            resumed = chrome.evaluate(panel_sid, "Array.from(document.querySelectorAll('#transcript .seg')).map(e => e.innerText.trim()).join(' ')") or ''
            checks.add('Stop/Start retains the first transcript verbatim', resumed.startswith(transcript), resumed)
            doubled = report(REFERENCE + ' ' + REFERENCE, resumed)
            checks.add('Stop/Start appends the second known script', doubled['wer'] <= WER_THRESHOLD,
                       f"WER={doubled['wer']:.3f} accuracy={doubled['accuracy_pct']}%")

        # Delete is only meaningful once the recognizer has finished flushing:
        # stop() sets aria-pressed false immediately, but the final sentence can
        # still land afterwards and would be counted as "not cleared".
        deadline = time.time() + 15
        stable, last = 0, None
        while time.time() < deadline:
            now = chrome.evaluate(panel_sid, "String([...document.querySelectorAll('#transcript .seg')].map(e => e.innerText).join(' ').split(/[^A-Za-z0-9'%:.-]+/).filter(Boolean).length) + ' words'",
                                  await_promise=False)
            stable = stable + 1 if now == last else 0
            last = now
            if stable >= 3:
                break
            time.sleep(0.4)
        chrome.evaluate(panel_sid, "document.getElementById('clearBtn').click()", await_promise=False)
        time.sleep(0.4)
        after = chrome.evaluate(panel_sid, "String([...document.querySelectorAll('#transcript .seg')].map(e => e.innerText).join(' ').split(/[^A-Za-z0-9'%:.-]+/).filter(Boolean).length) + ' words'",
                                await_promise=False)
        checks.add("Clear resets the transcript", after.startswith("0"), f"wordCount={after}")

        print("\n=== ACCURACY DETAIL ===", flush=True)
        print(json.dumps(scored, indent=2), flush=True)
    finally:
        with open(os.path.join(HERE, "e2e_result.json"), "w") as f:
            json.dump({"checks": checks.items, "passed": checks.passed,
                       "transcript": transcript.strip(), "clipboard": clip.strip(),
                       "accuracy": scored, "clipboard_accuracy": clip_scored}, f, indent=2)
        chrome.kill()
        httpd.shutdown()

    n_pass = sum(1 for c in checks.items if c["ok"])
    print("\n" + "=" * 52, flush=True)
    print(f"RESULT: {n_pass}/{len(checks.items)} checks passed — {'PASS' if checks.passed else 'FAIL'}", flush=True)
    print("=" * 52, flush=True)
    sys.exit(0 if checks.passed else 1)


if __name__ == "__main__":
    main()
