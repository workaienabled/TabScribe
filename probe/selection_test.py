"""Does a text selection survive live transcript updates?

The bug: the renderer rebuilt the whole transcript container on every recognition
event (several times a second), destroying and recreating every DOM node and taking
the user's selection with it.

This test selects part of the transcript mid-recognition, lets the transcript keep
growing, and then checks that the selection is still there and still says the same
thing. It also checks that Copy copies the selection rather than the whole thing.

Run against the current extension:
    python3 -u selection_test.py

Run against a deliberately broken renderer, to prove the test detects the bug:
    python3 -u selection_test.py --broken
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
PROFILE = "/tmp/tabscribe-sel-profile"
MODEL_CACHE = "/tmp/tabscribe-profile"
CLIP = os.environ.get("TABSCRIBE_CLIP", "sample2.wav")

# The pre-fix renderer: rebuild every node on every update. Used by --broken to
# confirm this test actually fails when the bug is present.
BROKEN_RENDER = """
function render(store) {
  lastStore = store;
  const segs = store.liveSegments();
  el.empty.style.display = segs.length === 0 ? '' : 'none';
  el.words.textContent = `${store.wordCount()} words`;
  const showTs = el.timestamps.checked;
  const frag = document.createDocumentFragment();
  for (const seg of segs) {
    const div = document.createElement('div');
    div.className = 'seg' + (seg.isFinal ? '' : ' interim');
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.appendChild(document.createTextNode(seg.text.trim()));
    div.appendChild(txt);
    frag.appendChild(div);
  }
  el.transcript.replaceChildren(el.empty, frag);
  if (el.autoscroll.checked) el.transcript.scrollTop = el.transcript.scrollHeight;
}
"""


def unpacked_extension_id(path):
    digest = hashlib.sha256(os.path.abspath(path).encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def build_extension_variant(broken):
    """Return a path to the extension, optionally with the old renderer restored."""
    if not broken:
        return EXT
    dst = "/tmp/ts-ext-broken"
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    shutil.copytree(EXT, dst)
    src = open(os.path.join(dst, "sidepanel.js")).read()
    # Replace the incremental render() with the old destroy-everything version.
    start = src.index("function render(store) {")
    depth = 0
    i = src.index("{", start)
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                end = j + 1
                break
    src = src[:start] + BROKEN_RENDER.strip() + src[end:]
    open(os.path.join(dst, "sidepanel.js"), "w").write(src)
    manifest = json.load(open(os.path.join(dst, "manifest.json")))
    manifest["name"] = "TabScribe (broken renderer)"
    json.dump(manifest, open(os.path.join(dst, "manifest.json"), "w"), indent=2)
    return dst


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
    src_state = json.load(open(src))
    captions = src_state.get("accessibility", {}).get("captions")
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


def main():
    broken = "--broken" in sys.argv
    ext_path = build_extension_variant(broken)
    ext_id = unpacked_extension_id(ext_path)
    checks = Checks()

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    print(f"\n=== MODE: {'BROKEN renderer (expected to FAIL)' if broken else 'current extension'} ===",
          flush=True)
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
        chrome.send("Extensions.loadUnpacked", path=ext_path)
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

        model = chrome.evaluate(panel_sid,
                                "SpeechRecognition.available({langs:['en-US'],processLocally:true})")
        if model != "available":
            chrome.evaluate(panel_sid, "SpeechRecognition.install({langs:['en-US'],processLocally:true})")

        print("\n=== RECOGNITION ===", flush=True)
        chrome.evaluate(panel_sid, "document.getElementById('startBtn').click()", await_promise=False)
        deadline = time.time() + 45
        while time.time() < deadline:
            if chrome.evaluate(panel_sid, "document.getElementById('dot').dataset.state",
                               await_promise=False) == "listening":
                break
            time.sleep(0.5)
        chrome.evaluate(page_sid, "window.__play()")

        # Wait until at least two segments exist, so there is settled text above the
        # live one to select.
        deadline = time.time() + 60
        while time.time() < deadline:
            n = chrome.evaluate(panel_sid,
                                "document.querySelectorAll('#transcript .seg').length",
                                await_promise=False)
            if n and n >= 2:
                break
            time.sleep(0.5)
        print(f"  segments present: {n}", flush=True)
        checks.add("transcript has settled text to select", bool(n and n >= 2), f"segments={n}")

        # Select a span inside the FIRST segment: it is already final, and it is the
        # furthest from the live edge, so nothing but a full rebuild should disturb it.
        print("\n=== SELECT ===", flush=True)
        selected = chrome.evaluate(panel_sid, """
        (() => {
          const seg = document.querySelector('#transcript .seg .txt');
          if (!seg) return { ok: false, error: 'no segment' };
          const node = seg.firstChild;
          if (!node || node.length < 25) return { ok: false, error: 'segment too short' };
          const range = document.createRange();
          range.setStart(node, 4);
          range.setEnd(node, Math.min(node.length, 40));
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          return { ok: true, text: sel.toString(), words: document.getElementById('wordCount').textContent };
        })()
        """)
        print(f"  selected: {json.dumps(selected)}", flush=True)
        checks.add("selection made", selected.get("ok"), selected.get("error", ""))
        if not selected.get("ok"):
            raise SystemExit(1)

        original = selected["text"]
        words_at_selection = int(re.match(r"\d+", selected["words"]).group())

        # Let recognition keep running so the transcript genuinely updates underneath.
        print("\n=== LET THE TRANSCRIPT GROW ===", flush=True)
        grew = False
        deadline = time.time() + 25
        while time.time() < deadline:
            now = chrome.evaluate(panel_sid,
                                  "document.getElementById('wordCount').textContent",
                                  await_promise=False)
            if int(re.match(r"\d+", now).group()) > words_at_selection + 5:
                grew = True
                break
            time.sleep(0.5)
        words_now = chrome.evaluate(panel_sid, "document.getElementById('wordCount').textContent",
                                    await_promise=False)
        print(f"  words {words_at_selection} -> {words_now}", flush=True)
        checks.add("transcript updated while text was selected", grew,
                   f"{words_at_selection} -> {words_now}")

        # The actual question.
        after = chrome.evaluate(panel_sid, """
        (() => {
          const sel = window.getSelection();
          return {
            collapsed: sel.isCollapsed,
            rangeCount: sel.rangeCount,
            text: sel.toString(),
          };
        })()
        """)
        print(f"\n=== SELECTION AFTER UPDATES ===\n  {json.dumps(after)}", flush=True)

        checks.add("selection still exists", not after["collapsed"] and after["rangeCount"] > 0,
                   f"collapsed={after['collapsed']} ranges={after['rangeCount']}")
        checks.add("selection still covers the same text", after["text"] == original,
                   f"was {original!r}, now {after['text']!r}")

        # Copy must honour the selection.
        chrome.send("Browser.grantPermissions",
                    permissions=["clipboardReadWrite", "clipboardSanitizedWrite"])
        chrome.send("Target.activateTarget", targetId=panel["targetId"])
        chrome.send("Emulation.setFocusEmulationEnabled", session_id=panel_sid, enabled=True)
        time.sleep(0.3)
        chrome.evaluate(panel_sid, "document.getElementById('copyBtn').click()", await_promise=False)
        time.sleep(1.0)
        clip = (chrome.evaluate(panel_sid, "navigator.clipboard.readText()") or "").strip()
        print(f"\n=== CLIPBOARD ===\n  {clip!r}", flush=True)
        checks.add("Copy copies the selection, not the whole transcript",
                   clip == original.strip(), f"{len(clip)} chars vs selection {len(original.strip())}")

        whole = chrome.evaluate(panel_sid, "document.getElementById('wordCount').textContent",
                                await_promise=False)
        checks.add("clipboard is shorter than the full transcript",
                   len(clip.split()) < int(re.match(r"\d+", whole).group()),
                   f"{len(clip.split())} words vs {whole}")

        # With nothing selected, Copy falls back to the whole transcript.
        chrome.evaluate(panel_sid, "window.getSelection().removeAllRanges()", await_promise=False)
        time.sleep(0.5)
        chrome.evaluate(panel_sid, f"navigator.clipboard.writeText('__sentinel__')")
        chrome.evaluate(panel_sid, "document.getElementById('copyBtn').click()", await_promise=False)
        time.sleep(1.0)
        clip_all = (chrome.evaluate(panel_sid, "navigator.clipboard.readText()") or "").strip()
        checks.add("Copy with no selection still copies everything",
                   len(clip_all.split()) > len(clip.split()) and clip_all != "__sentinel__",
                   f"{len(clip_all.split())} words")
    finally:
        with open(os.path.join(HERE, "selection_result.json"), "w") as f:
            json.dump({"broken_mode": broken, "checks": checks.items, "passed": checks.passed}, f, indent=2)
        chrome.kill()
        httpd.shutdown()

    n_pass = sum(1 for c in checks.items if c["ok"])
    print("\n" + "=" * 56, flush=True)
    print(f"RESULT: {n_pass}/{len(checks.items)} checks passed — "
          f"{'PASS' if checks.passed else 'FAIL'}", flush=True)
    if broken:
        print("(broken mode: FAIL here is the expected, correct outcome)", flush=True)
    print("=" * 56, flush=True)
    sys.exit(0 if checks.passed else 1)


if __name__ == "__main__":
    main()
