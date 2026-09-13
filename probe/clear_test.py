"""Does Clear dismiss the block that is currently being transcribed?

The bug: clearing the TranscriptStore does not touch the live SpeechRecognition
session, which keeps its own results array. The next recognition event re-adds the
in-flight segment at the same result index, so the block the user just dismissed
reappears a fraction of a second later.

This test clears while a block is actively filling, then checks three things:
  - the panel empties;
  - the dismissed text does NOT come back;
  - recognition still works afterwards (a Clear that silently kills transcription
    would be a worse bug than the one being fixed).

Run:
    python3 -u clear_test.py
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
PROFILE = "/tmp/tabscribe-clear-profile"
MODEL_CACHE = "/tmp/tabscribe-profile"
CLIP = os.environ.get("TABSCRIBE_CLIP", "sample2.wav")  # 34s, plenty of runway


def unpacked_extension_id(path):
    digest = hashlib.sha256(os.path.abspath(path).encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def prepare_profile(profile, model_cache):
    if os.path.isdir(profile):
        shutil.rmtree(profile)
    os.makedirs(profile, exist_ok=True)
    for name in ("SODA", "SODALanguagePacks"):
        src = os.path.join(model_cache, name)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(profile, name))


def graft_model_registration(profile, model_cache):
    src = os.path.join(model_cache, "Local State")
    dst = os.path.join(profile, "Local State")
    if not (os.path.exists(src) and os.path.exists(dst)):
        return False
    captions = json.load(open(src)).get("accessibility", {}).get("captions")
    if not captions:
        return False
    rewritten = {
        k: (v.replace(model_cache, profile) if isinstance(v, str) and model_cache in v else v)
        for k, v in captions.items()
    }
    dst_state = json.load(open(dst))
    dst_state.setdefault("accessibility", {})["captions"] = rewritten
    json.dump(dst_state, open(dst, "w"))
    return True


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


def transcript_text(chrome, sid):
    return (chrome.evaluate(
        sid,
        "Array.from(document.querySelectorAll('#transcript .seg')).map(e => e.innerText.trim()).join(' ')",
        await_promise=False,
    ) or "").strip()


def word_count(chrome, sid):
    txt = chrome.evaluate(sid, "document.getElementById('wordCount').textContent",
                          await_promise=False) or "0"
    return int(re.match(r"\d+", txt).group())


def main():
    ext_id = unpacked_extension_id(EXT)
    checks = Checks()

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    prepare_profile(PROFILE, MODEL_CACHE)
    warm = PipeChrome(PROFILE, extensions=[], fresh=False)
    warm.launch("about:blank")
    time.sleep(3)
    warm.kill()
    time.sleep(2)
    pin_extension(PROFILE, ext_id)
    graft_model_registration(PROFILE, MODEL_CACHE)

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
        chrome.wait_for_js(panel_sid, "!!document.getElementById('recordBtn')", timeout=30)

        model = chrome.evaluate(panel_sid,
                                "SpeechRecognition.available({langs:['en-US'],processLocally:true})")
        if model != "available":
            chrome.evaluate(panel_sid, "SpeechRecognition.install({langs:['en-US'],processLocally:true})")

        print("\n=== RECOGNITION ===", flush=True)
        chrome.evaluate(panel_sid, "document.getElementById('recordBtn').click()", await_promise=False)
        started = False
        deadline = time.time() + 45
        while time.time() < deadline:
            if chrome.evaluate(panel_sid, "document.getElementById('dot').dataset.state",
                               await_promise=False) == "listening":
                started = True
                break
            time.sleep(0.5)
        checks.add("recognition started", started)
        chrome.evaluate(page_sid, "window.__play()")

        # Wait for a block that is actively filling (interim), with real text in it.
        filling = ""
        deadline = time.time() + 40
        while time.time() < deadline:
            filling = (chrome.evaluate(
                panel_sid,
                "(() => { const n = document.querySelector('#transcript .seg.interim');"
                " return n ? n.innerText.trim() : ''; })()",
                await_promise=False,
            ) or "").strip()
            if len(filling) >= 20:
                break
            time.sleep(0.2)
        print(f"  filling block: {filling!r}", flush=True)
        checks.add("a block is actively filling before Clear", len(filling) >= 20,
                   f"{len(filling)} chars")
        if len(filling) < 20:
            raise SystemExit(1)

        # Clear WHILE that block is filling.
        print("\n=== CLEAR (mid-utterance) ===", flush=True)
        chrome.evaluate(panel_sid, "document.getElementById('clearBtn').click()", await_promise=False)
        time.sleep(0.35)

        immediate = transcript_text(chrome, panel_sid)
        immediate_words = word_count(chrome, panel_sid)
        print(f"  immediately after: {immediate_words} words, {immediate!r}", flush=True)
        checks.add("panel empties immediately", immediate == "" and immediate_words == 0,
                   f"{immediate_words} words, {len(immediate)} chars")

        # The crux: does the dismissed block come back as recognition continues?
        # Sample repeatedly rather than once, so a brief reappearance is still caught.
        probe = filling[:20]
        reappeared_as = None
        stayed_empty_samples = 0
        deadline = time.time() + 4
        while time.time() < deadline:
            now = transcript_text(chrome, panel_sid)
            if probe and probe in now:
                reappeared_as = now
                break
            stayed_empty_samples += 1
            time.sleep(0.2)

        print(f"  sampled {stayed_empty_samples} times over 4s", flush=True)
        if reappeared_as:
            print(f"  REAPPEARED: {reappeared_as!r}", flush=True)
        checks.add("dismissed block does not come back", reappeared_as is None,
                   f"reappeared as {reappeared_as!r}" if reappeared_as else "stayed gone")

        # Clear must not kill transcription: new speech should still be recognised.
        print("\n=== RECOGNITION AFTER CLEAR ===", flush=True)
        new_text = ""
        deadline = time.time() + 25
        while time.time() < deadline:
            new_text = transcript_text(chrome, panel_sid)
            if len(new_text.split()) >= 4:
                break
            time.sleep(0.3)
        print(f"  new text: {new_text!r}", flush=True)
        checks.add("recognition still running after Clear", len(new_text.split()) >= 4,
                   f"{len(new_text.split())} words")
        checks.add("new text is not the dismissed block",
                   bool(new_text) and (not probe or probe not in new_text),
                   f"{new_text[:60]!r}")

        state = chrome.evaluate(panel_sid, "document.getElementById('dot').dataset.state",
                                await_promise=False)
        checks.add("panel still reports listening", state == "listening", f"state={state}")

        # Clear again with recognition stopped: must also work and stay empty.
        print("\n=== CLEAR AFTER STOP ===", flush=True)
        chrome.evaluate(panel_sid, "document.getElementById('recordBtn').click()", await_promise=False)
        deadline = time.time() + 30
        while time.time() < deadline:
            if chrome.evaluate(panel_sid, "document.getElementById('recordBtn').disabled === false",
                               await_promise=False):
                break
            time.sleep(0.5)
        chrome.evaluate(panel_sid, "document.getElementById('clearBtn').click()", await_promise=False)
        time.sleep(1.5)
        after_stop = transcript_text(chrome, panel_sid)
        checks.add("Clear works with recognition stopped", after_stop == "",
                   f"{len(after_stop)} chars")
    finally:
        with open(os.path.join(HERE, "clear_result.json"), "w") as f:
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
