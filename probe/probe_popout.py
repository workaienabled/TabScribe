"""Can a pop-out window hold the tab capture?

Design question before building the feature. The activeTab grant that authorises
chrome.tabCapture comes from the user clicking the toolbar icon on a specific tab. A
pop-out is a separate window with its own document and its own focus, so three things
need checking before any feature code is written:

  1. Can an extension page in a popup window consume a tab-capture stream id at all?
  2. Does it still work once the side panel has released its own capture (handoff)?
  3. What happens if both the side panel and the window try to capture at once?

The existing sidepanel.js arms capture on load and reports the outcome in its status
line, so loading it in a popup window is a complete probe with no code changes.

Run:
    python3 -u probe_popout.py
"""
import functools
import hashlib
import http.server
import json
import os
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
PROFILE = "/tmp/tabscribe-popout-profile"
MODEL_CACHE = "/tmp/tabscribe-profile"
CLIP = "sample2.wav"


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


def panel_status(chrome, sid):
    return chrome.evaluate(sid, "document.getElementById('status').textContent",
                           await_promise=False)


def main():
    ext_id = unpacked_extension_id(EXT)
    findings = {}

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
        chrome.evaluate(page_sid, "window.__play()")
        time.sleep(1.5)

        # Toolbar click -> side panel, which arms capture.
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
        if not panel:
            print("FATAL: side panel never opened")
            return
        panel_sid = chrome.attach(panel["targetId"])
        chrome.wait_for_js(panel_sid, "!!document.getElementById('recordBtn')", timeout=30)
        time.sleep(2)
        findings["side_panel_status"] = panel_status(chrome, panel_sid)
        print(f"\n1. side panel armed: {findings['side_panel_status']!r}", flush=True)

        stored = chrome.evaluate(sw_sid, "chrome.storage.session.get(['targetTabId','targetTabTitle'])")
        findings["stored_target"] = stored
        print(f"   stored target: {json.dumps(stored)}", flush=True)

        # --- Q3 first: both trying to capture at once ---------------------------
        print("\n2. opening a popup window WHILE the side panel still holds capture",
              flush=True)
        chrome.evaluate(sw_sid, """
          chrome.windows.create({
            url: chrome.runtime.getURL('sidepanel.html?view=window'),
            type: 'popup', width: 460, height: 760, left: 1180, top: 60
          }).then(w => w.id)
        """)
        time.sleep(4)

        popup = None
        for t in chrome.targets():
            if "view=window" in t.get("url", ""):
                popup = t
        findings["popup_target_found"] = bool(popup)
        print(f"   popup document exists: {bool(popup)}", flush=True)
        if not popup:
            print("   FATAL: popup never created")
            return

        popup_sid = chrome.attach(popup["targetId"])
        chrome.wait_for_js(popup_sid, "!!document.getElementById('recordBtn')", timeout=30)
        time.sleep(3)
        findings["popup_status_while_panel_holds"] = panel_status(chrome, popup_sid)
        print(f"   popup status (panel still capturing): "
              f"{findings['popup_status_while_panel_holds']!r}", flush=True)

        # Did the popup actually get a live audio track?
        probe_js = """
        (() => {
          const s = document.getElementById('status').textContent;
          return { status: s };
        })()
        """
        findings["popup_probe_concurrent"] = chrome.evaluate(popup_sid, probe_js,
                                                             await_promise=False)

        # Ask the service worker directly whether a second stream id can be minted.
        second = chrome.evaluate(sw_sid, """
        (async () => {
          const stored = await chrome.storage.session.get('targetTabId');
          try {
            const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: stored.targetTabId });
            return { ok: true, streamId: String(id).slice(0, 10) + '…' };
          } catch (e) { return { ok: false, error: String(e) }; }
        })()
        """)
        findings["second_stream_id_while_panel_holds"] = second
        print(f"   second stream id mintable: {json.dumps(second)}", flush=True)

        # --- Q2: handoff. Release the side panel's capture, then re-arm popup ----
        print("\n3. releasing the side panel's capture, then re-arming the popup",
              flush=True)
        chrome.evaluate(panel_sid, """
          (async () => {
            if (window.__debugTeardown) { await window.__debugTeardown(); return 'torn down'; }
            return 'no hook';
          })()
        """)
        # No debug hook in production code: close the side panel document instead,
        # which fires pagehide and releases capture.
        chrome.send("Target.closeTarget", targetId=panel["targetId"])
        time.sleep(2.5)

        rearm = chrome.evaluate(popup_sid, """
        (async () => {
          const res = await chrome.runtime.sendMessage({ type: 'GET_STREAM_ID' });
          if (!res || !res.ok) return { ok: false, res };
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: res.streamId } }
            });
            const tracks = stream.getAudioTracks();
            const info = { ok: true, tracks: tracks.length,
                           readyState: tracks[0] && tracks[0].readyState,
                           label: tracks[0] && tracks[0].label };
            for (const t of stream.getTracks()) t.stop();
            return info;
          } catch (e) { return { ok: false, error: String(e) }; }
        })()
        """)
        findings["popup_capture_after_panel_released"] = rearm
        print(f"   popup capture after handoff: {json.dumps(rearm)}", flush=True)

        # --- Q1 corollary: does it survive the popup being focused? -------------
        popup_win = chrome.evaluate(sw_sid, """
          chrome.windows.getAll({windowTypes:['popup']}).then(ws => ws.map(w => w.id))
        """)
        if popup_win:
            chrome.evaluate(sw_sid, f"chrome.windows.update({popup_win[0]}, {{focused: true}})")
            time.sleep(1.5)
        focused = chrome.evaluate(popup_sid, """
        (async () => {
          const res = await chrome.runtime.sendMessage({ type: 'GET_STREAM_ID' });
          return res && res.ok ? { ok: true } : { ok: false, res };
        })()
        """)
        findings["stream_id_while_popup_focused"] = focused
        print(f"   stream id while popup focused: {json.dumps(focused)}", flush=True)

        # And what does the popup think the target tab is, now that a different
        # window is focused? This is the trap: tabs.query({currentWindow:true})
        # would return the popup's own tab.
        target_now = chrome.evaluate(popup_sid, """
          chrome.runtime.sendMessage({ type: 'GET_TARGET' })
        """)
        findings["target_seen_from_popup"] = target_now
        print(f"   GET_TARGET from popup: {json.dumps(target_now)}", flush=True)
    finally:
        with open(os.path.join(HERE, "popout_findings.json"), "w") as f:
            json.dump(findings, f, indent=2)
        chrome.kill()
        httpd.shutdown()

    print("\n" + "=" * 60)
    print(json.dumps(findings, indent=2))
    print("=" * 60)


if __name__ == "__main__":
    main()
