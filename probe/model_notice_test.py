"""Does the first-run download notice appear, and is it honest?

Runs against a profile with NO model installed, so the real first-run path executes:
the notice must appear before Start (so a slow connection is not a mid-session
surprise), during the download, and must clear once the model is ready.

It also checks the notice does NOT claim a percentage. Verified on Chrome 151 that
install() reports no progress whatsoever — no monitor callback, no downloadprogress
events, no promise affordances — and that the model lands in two jumps on disk
(0 -> 121 MB -> 323 MB). A percentage would therefore be fabricated, and asserting its
absence keeps it that way.

Run:
    python3 -u model_notice_test.py
"""
import functools
import hashlib
import http.server
import json
import os
import re
import shutil
import socketserver
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipe_chrome import PipeChrome  # noqa: E402
from toolbar_click import click_toolbar_icon  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(os.path.join(HERE, "..", "extension"))
PORT = 8899
PROFILE = "/tmp/tabscribe-model-notice"
CLIP = "sample2.wav"


def unpacked_extension_id(path):
    digest = hashlib.sha256(os.path.abspath(path).encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def pin_extension(profile, ext_id):
    p = os.path.join(profile, "Default", "Preferences")
    if not os.path.exists(p):
        return
    prefs = json.load(open(p))
    ext = prefs.setdefault("extensions", {})
    ext["pinned_extensions"] = sorted(set(ext.get("pinned_extensions", [])) | {ext_id})
    ext["ui"] = {"developer_mode": True}
    json.dump(prefs, open(p, "w"))


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


def panel_snapshot(chrome, sid):
    return chrome.evaluate(sid, """
    (() => {
      const p = document.getElementById('modelPanel');
      if (!p) return { missing: true };
      return {
        hidden: p.hidden,
        classes: p.className,
        title: document.getElementById('modelTitle').textContent.trim(),
        body: document.getElementById('modelBody').textContent.trim(),
        state: document.getElementById('modelState').textContent.trim(),
        elapsed: document.getElementById('modelElapsed').textContent.trim(),
        hint: document.getElementById('modelHint').hidden
              ? '' : document.getElementById('modelHint').textContent.trim(),
        actionsHidden: document.getElementById('modelActions').hidden,
        barAnimated: getComputedStyle(
          document.querySelector('.model-bar-fill')).animationName !== 'none',
      };
    })()
    """, await_promise=False)


def main():
    ext_id = unpacked_extension_id(EXT)
    checks = Checks()

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    # Deliberately NO model cache: this must be a genuine first run.
    if os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE)
    warm = PipeChrome(PROFILE, extensions=[], fresh=True)
    warm.launch("about:blank")
    time.sleep(3)
    warm.kill()
    time.sleep(2)
    pin_extension(PROFILE, ext_id)

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch("about:blank")
    try:
        chrome.send("Extensions.loadUnpacked", path=EXT)
        time.sleep(2)

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

        panel = None
        for _ in range(4):
            click_toolbar_icon(debug=False)
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
                break
        checks.add("side panel open", bool(panel))
        if not panel:
            raise SystemExit(1)

        panel_sid = chrome.attach(panel["targetId"])
        chrome.wait_for_js(panel_sid, "!!document.getElementById('startBtn')", timeout=30)

        avail = chrome.evaluate(panel_sid,
                                "SpeechRecognition.available({langs:['en-US'],processLocally:true})")
        checks.add("test really is a first run (model not installed)",
                   avail == "downloadable", f"availability={avail}")

        # --- BEFORE START ----------------------------------------------------
        print("\n=== NOTICE BEFORE START ===", flush=True)
        before = {}
        deadline = time.time() + 15
        while time.time() < deadline:
            before = panel_snapshot(chrome, panel_sid)
            if not before.get("hidden"):
                break
            time.sleep(0.5)
        print(f"  {json.dumps(before, indent=2)}", flush=True)

        checks.add("notice shown before pressing Start", not before.get("hidden"),
                   f"hidden={before.get('hidden')}")
        blob = f"{before.get('title','')} {before.get('body','')}".lower()
        checks.add("warns about a one-time download", "one-time" in blob or "once" in blob,
                   before.get("title", ""))
        checks.add("states the download size", "300" in blob or "mb" in blob,
                   before.get("body", "")[:70])
        checks.add("warns that slow connections take minutes", "minute" in blob or "slow" in blob,
                   before.get("body", "")[:70])
        checks.add("offers a cloud alternative",
                   not before.get("actionsHidden") and chrome.evaluate(
                       panel_sid, "!document.getElementById('useCloudBtn').hidden",
                       await_promise=False))

        # --- DURING DOWNLOAD --------------------------------------------------
        print("\n=== NOTICE DURING DOWNLOAD ===", flush=True)
        chrome.evaluate(panel_sid, "document.getElementById('startBtn').click()", await_promise=False)

        during = {}
        saw_downloading = False
        saw_elapsed = False
        saw_animated = False
        # Capture the notice's full text WHILE downloading. On a fast connection the
        # whole download can finish in ~10s, so sampling only at the end would read
        # the "Model ready" state instead of the downloading one.
        downloading_text = ""
        saw_done_state = []
        deadline = time.time() + 60
        while time.time() < deadline:
            during = panel_snapshot(chrome, panel_sid)
            state = (during.get("state") or "").lower()
            # Watch for a "Done"/"Model ready" panel throughout, not just at the
            # end: a state that appears for two seconds and vanishes would be
            # invisible to a single sample taken afterwards.
            if "done" in (during.get("classes") or "") or "ready" in (during.get("title") or "").lower():
                saw_done_state.append({"title": during.get("title"),
                                       "classes": during.get("classes")})
            if "download" in state:
                saw_downloading = True
                saw_animated = saw_animated or during.get("barAnimated")
                if not downloading_text:
                    downloading_text = chrome.evaluate(
                        panel_sid, "document.getElementById('modelPanel').innerText",
                        await_promise=False) or ""
                if re.search(r"\d+s elapsed|\d+m \d+s elapsed", during.get("elapsed", "")):
                    saw_elapsed = True
            if during.get("hidden"):
                break
            time.sleep(0.25)
        print(f"  {json.dumps(during, indent=2)}", flush=True)

        checks.add("notice reports the download is running", saw_downloading,
                   f"state={during.get('state')!r}")
        checks.add("elapsed time is shown", saw_elapsed, f"elapsed={during.get('elapsed')!r}")
        checks.add("progress bar animates (indeterminate)", saw_animated)

        # Honesty: no invented percentage, and the absence is explained. Both are
        # asserted against the text captured DURING the download.
        pct = re.findall(r"\b\d{1,3}\s?%", downloading_text)
        checks.add("no fabricated percentage shown", not pct, f"found {pct}")
        checks.add("explains why there is no percentage",
                   "percentage" in downloading_text.lower()
                   or "does not report" in downloading_text.lower(),
                   downloading_text.replace("\n", " ")[:100] or "(no downloading sample)")

        # --- AFTER: model ready, notice clears --------------------------------
        # There is deliberately no "Done"/"Model ready" state: a panel that appears
        # only to disappear is noise, and on the common path (model already
        # installed) the user never needed to know a model existed. The assertion
        # is that the notice goes away entirely.
        print("\n=== AFTER DOWNLOAD ===", flush=True)
        ready = False
        deadline = time.time() + 300
        while time.time() < deadline:
            a = chrome.evaluate(panel_sid,
                                "SpeechRecognition.available({langs:['en-US'],processLocally:true})")
            if a == "available":
                ready = True
                break
            time.sleep(2)
        checks.add("model finished downloading", ready)

        cleared = False
        deadline = time.time() + 20
        while time.time() < deadline:
            snap = panel_snapshot(chrome, panel_sid)
            if snap.get("hidden"):
                cleared = True
                break
            time.sleep(0.5)
        checks.add("notice clears once the model is ready", cleared)

        # And it never flashed a "Done" panel on the way there.
        final = panel_snapshot(chrome, panel_sid)
        checks.add("no 'Model ready' / Done state ever shown",
                   not saw_done_state and "done" not in (final.get("classes") or ""),
                   json.dumps(saw_done_state[:2]) if saw_done_state else json.dumps(final))

        # And transcription actually works afterwards.
        state = ""
        deadline = time.time() + 45
        while time.time() < deadline:
            state = chrome.evaluate(panel_sid, "document.getElementById('dot').dataset.state",
                                    await_promise=False)
            if state in ("listening", "error"):
                break
            time.sleep(0.5)
        checks.add("transcription starts after the download", state == "listening",
                   f"state={state}")
    finally:
        with open(os.path.join(HERE, "model_notice_result.json"), "w") as f:
            json.dump({"checks": checks.items, "passed": checks.passed}, f, indent=2)
        chrome.kill()
        httpd.shutdown()

    n_pass = sum(1 for c in checks.items if c["ok"])
    print("\n" + "=" * 56, flush=True)
    print(f"RESULT: {n_pass}/{len(checks.items)} checks passed — "
          f"{'PASS' if checks.passed else 'FAIL'}", flush=True)
    print("=" * 56, flush=True)
    sys.exit(0 if checks.passed else 1)


if __name__ == "__main__":
    main()
