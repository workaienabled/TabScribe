"""Does the pop-out window work, and does the handoff keep everything alive?

Design constraint, established by probe_popout.py before any feature code was written:
a tab can only be captured once. A second getMediaStreamId on an already-captured tab
fails with "Cannot capture a tab with an active stream." So popping out cannot be a
second view of a live capture — it has to be a handoff, and the interesting failures
are all in that handover:

  - transcript text lost in transit
  - the window opening but never acquiring the capture (dead UI)
  - recognition not resuming, so the window looks alive but transcribes nothing
  - the second pop-out spawning a duplicate window instead of focusing the first
  - the side panel left permanently inert after the window closes

Run:
    python3 -u popout_test.py
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
PROFILE = "/tmp/tabscribe-popout-e2e"
MODEL_CACHE = "/tmp/tabscribe-profile"
CLIP = os.environ.get("TABSCRIBE_CLIP", "sample2.wav")


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
    txt = chrome.evaluate(sid, "String([...document.querySelectorAll('#transcript .seg')].map(e => e.innerText).join(' ').split(/[^A-Za-z0-9'%:.-]+/).filter(Boolean).length) + ' words'",
                          await_promise=False) or "0"
    return int(re.match(r"\d+", txt).group())


def find_window_target(chrome):
    for t in chrome.targets():
        if "view=window" in t.get("url", ""):
            return t
    return None


def find_panel_target(chrome):
    """The side panel document, excluding the popped-out window."""
    for t in chrome.targets():
        if "sidepanel.html" in t.get("url", "") and "view=window" not in t.get("url", ""):
            return t
    return None


def open_panel_via_toolbar(chrome, tries=4):
    """Click the real toolbar icon until the side panel appears."""
    for _ in range(tries):
        click_toolbar_icon(debug=False)
        deadline = time.time() + 8
        while time.time() < deadline:
            t = find_panel_target(chrome)
            if t:
                return t
            time.sleep(0.4)
    return None


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
        sw = [t for t in chrome.targets()
              if t.get("type") == "service_worker" and ext_id in t.get("url", "")][0]
        sw_sid = chrome.attach(sw["targetId"])

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

        panel = open_panel_via_toolbar(chrome)
        checks.add("side panel open", bool(panel))
        if not panel:
            raise SystemExit(1)

        panel_sid = chrome.attach(panel["targetId"])
        chrome.wait_for_js(panel_sid, "!!document.getElementById('recordBtn')", timeout=30)

        # The button must be genuinely visible and labelled, not a bare glyph tucked
        # into a corner where it goes unnoticed.
        btn = chrome.evaluate(panel_sid, """
        (() => {
          const b = document.getElementById('popoutBtn');
          if (!b) return { missing: true };
          const cs = getComputedStyle(b);
          const r = b.getBoundingClientRect();
          return {
            text: b.innerText.trim(),
            name: b.getAttribute("aria-label") || "",
            width: Math.round(r.width), height: Math.round(r.height),
            visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0,
            color: cs.color, borderColor: cs.borderTopColor,
            inControls: !!b.closest('.controls'),
          };
        })()
        """, await_promise=False)
        print(f"  pop-out button: {json.dumps(btn)}", flush=True)
        checks.add("pop-out button present in the side panel", not btn.get("missing"))
        checks.add("pop-out button is visible", btn.get("visible"), json.dumps(btn))
        # Icon-only now, so the NAME is what must exist — an icon with no
        # accessible name is unusable with a screen reader.
        checks.add("pop-out button carries an accessible name",
                   len((btn.get("name") or "").strip()) >= 4,
                   f"name={btn.get('name')!r}")
        checks.add("pop-out button sits in the main controls row",
                   btn.get("inControls"), f"inControls={btn.get('inControls')}")
        # 28x28 is the project's floor for an icon target; the old 90px minimum
        # described a labelled button that no longer exists.
        checks.add("pop-out button is a usable target",
                   (btn.get("width") or 0) >= 28 and (btn.get("height") or 0) >= 28,
                   f"{btn.get('width')}x{btn.get('height')}")

        model = chrome.evaluate(panel_sid,
                                "SpeechRecognition.available({langs:['en-US'],processLocally:true})")
        if model != "available":
            chrome.evaluate(panel_sid, "SpeechRecognition.install({langs:['en-US'],processLocally:true})")

        # Transcribe a little in the side panel first, so there is text to carry over.
        print("\n=== TRANSCRIBE IN THE SIDE PANEL ===", flush=True)
        chrome.evaluate(panel_sid, "document.getElementById('recordBtn').click()", await_promise=False)
        deadline = time.time() + 45
        while time.time() < deadline:
            if chrome.evaluate(panel_sid, "document.getElementById('dot').dataset.state",
                               await_promise=False) == "listening":
                break
            time.sleep(0.5)
        chrome.evaluate(page_sid, "window.__play()")

        before = ""
        deadline = time.time() + 40
        while time.time() < deadline:
            before = transcript_text(chrome, panel_sid)
            if len(before.split()) >= 6:
                break
            time.sleep(0.3)
        words_before = word_count(chrome, panel_sid)
        print(f"  side panel has {words_before} words: {before!r}", flush=True)
        checks.add("side panel transcribed before pop-out", len(before.split()) >= 6,
                   f"{words_before} words")

        # --- POP OUT ---------------------------------------------------------
        print("\n=== POP OUT ===", flush=True)
        chrome.evaluate(panel_sid, "document.getElementById('popoutBtn').click()",
                        await_promise=False)

        window_target = None
        deadline = time.time() + 20
        while time.time() < deadline:
            window_target = find_window_target(chrome)
            if window_target:
                break
            time.sleep(0.5)
        checks.add("pop-out window opens", bool(window_target))
        if not window_target:
            raise SystemExit(1)

        win_sid = chrome.attach(window_target["targetId"])
        chrome.wait_for_js(win_sid, "!!document.getElementById('recordBtn')", timeout=30)
        time.sleep(2)

        # It must be a real popup window, not a tab. Note: tab URLs come back null
        # without the "tabs" permission, so the window is identified by the id the
        # extension recorded rather than by matching on tab URLs.
        wintype = chrome.evaluate(sw_sid, """
        (async () => {
          const stored = await chrome.storage.session.get('popoutWindowId');
          const id = stored.popoutWindowId;
          if (id === undefined) return { error: 'no window id recorded' };
          const w = await chrome.windows.get(id);
          return { id: w.id, type: w.type, focused: w.focused };
        })()
        """)
        print(f"  window record: {json.dumps(wintype)}", flush=True)
        checks.add("opens as a popup window (not a tab)",
                   wintype.get("type") == "popup", json.dumps(wintype))

        checks.add("pop-out button hidden inside the window",
                   chrome.evaluate(win_sid,
                                   "getComputedStyle(document.getElementById('popoutBtn')).display === 'none'",
                                   await_promise=False))

        # The side panel must close itself, leaving only the window. Verified that
        # chrome.sidePanel.close({windowId}) is the working shape on Chrome 151
        # (see probe_sidepanel_close.py).
        panel_closed = False
        deadline = time.time() + 10
        while time.time() < deadline:
            still_open = any(
                "sidepanel.html" in t.get("url", "") and "view=window" not in t.get("url", "")
                for t in chrome.targets()
            )
            if not still_open:
                panel_closed = True
                break
            time.sleep(0.4)
        checks.add("side panel closes when popping out", panel_closed,
                   "panel still open" if not panel_closed else "only the window remains")

        # Transcript carried across.
        carried = transcript_text(chrome, win_sid)
        carried_words = word_count(chrome, win_sid)
        print(f"  window shows {carried_words} words: {carried!r}", flush=True)
        # Compare on the first few words: the panel may have grown a word or two
        # between the reads, but the opening text must be identical.
        head_before = " ".join(before.split()[:6]).lower()
        checks.add("transcript carried into the window",
                   head_before and head_before in carried.lower(),
                   f"expected to start with {head_before!r}")
        checks.add("no transcript text lost", carried_words >= words_before - 1,
                   f"{words_before} -> {carried_words} words")

        # Recognition resumed automatically in the window.
        state = ""
        deadline = time.time() + 30
        while time.time() < deadline:
            state = chrome.evaluate(win_sid, "document.getElementById('dot').dataset.state",
                                    await_promise=False)
            if state == "listening":
                break
            time.sleep(0.5)
        status = chrome.evaluate(win_sid, "document.getElementById('status').textContent",
                                 await_promise=False)
        checks.add("window resumed transcribing automatically", state == "listening",
                   f"state={state} status={status!r}")

        # And it is actually producing NEW text, not just showing the old.
        grew = False
        deadline = time.time() + 30
        while time.time() < deadline:
            if word_count(chrome, win_sid) > carried_words + 3:
                grew = True
                break
            time.sleep(0.5)
        now_words = word_count(chrome, win_sid)
        print(f"  window words {carried_words} -> {now_words}", flush=True)
        checks.add("window is capturing live audio (new text arrives)", grew,
                   f"{carried_words} -> {now_words}")

        # The side panel released the tab. It normally closes outright now, so the
        # meaningful assertion is that the tab is free — checked below after the
        # window closes — rather than reading a status line from a dead document.
        if not panel_closed:
            panel_status = chrome.evaluate(panel_sid, "document.getElementById('status').textContent",
                                           await_promise=False)
            print(f"  side panel status: {panel_status!r}", flush=True)
            checks.add("side panel released the capture",
                       "window" in (panel_status or "").lower(), f"{panel_status!r}")

        # --- SECOND POP-OUT: focus, do not duplicate --------------------------
        print("\n=== SECOND POP-OUT ===", flush=True)
        before_count = len([t for t in chrome.targets() if "view=window" in t.get("url", "")])
        chrome.evaluate(sw_sid, """
          chrome.runtime.sendMessage({ type: 'OPEN_WINDOW' }).catch(() => {})
        """)
        time.sleep(3)
        after_count = len([t for t in chrome.targets() if "view=window" in t.get("url", "")])
        checks.add("second pop-out does not spawn a duplicate window",
                   after_count == before_count, f"{before_count} -> {after_count} windows")

        # --- CLOSE THE WINDOW: side panel recovers ---------------------------
        print("\n=== CLOSE THE WINDOW ===", flush=True)
        chrome.send("Target.closeTarget", targetId=window_target["targetId"])
        time.sleep(2.5)

        cleared = chrome.evaluate(sw_sid, "chrome.storage.session.get('popoutWindowId')")
        checks.add("window id forgotten after close",
                   not cleared or cleared.get("popoutWindowId") is None, json.dumps(cleared))

        # The side panel can take the tab back. With the panel now closed on pop-out,
        # this is asked from the service worker, which outlives both documents.
        chrome.send("Target.activateTarget", targetId=page_tid)
        time.sleep(0.5)
        recovered = chrome.evaluate(sw_sid, """
        (async () => {
          const stored = await chrome.storage.session.get('targetTabId');
          try {
            const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: stored.targetTabId });
            return { ok: true, streamId: String(id).slice(0, 10) + '…' };
          } catch (e) { return { ok: false, error: String(e) }; }
        })()
        """)
        print(f"  tab capturable after window closed: {json.dumps(recovered)}", flush=True)
        checks.add("tab is capturable again after the window closes",
                   recovered.get("ok"), json.dumps(recovered))

        # And the toolbar button reopens the panel cleanly afterwards.
        reopened = open_panel_via_toolbar(chrome)
        checks.add("toolbar click reopens the side panel afterwards", bool(reopened),
                   "panel did not reopen" if not reopened else "")
    finally:
        with open(os.path.join(HERE, "popout_result.json"), "w") as f:
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
