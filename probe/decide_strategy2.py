"""Which panel-opening strategy actually grants activeTab for tabCapture?

Strategy A: openPanelOnActionClick = false, chrome.action.onClicked fires and the
            listener calls chrome.sidePanel.open().
Strategy B: openPanelOnActionClick = true, Chrome opens the panel itself and
            onClicked does NOT fire.

Both are exercised on a FRESH profile with a real X11 click, and each is scored on
two independent questions: did the panel open, and does tabCapture work afterwards.
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


def unpacked_extension_id(path):
    digest = hashlib.sha256(os.path.abspath(path).encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def pin(profile, ext_id):
    p = os.path.join(profile, "Default", "Preferences")
    if not os.path.exists(p):
        return
    prefs = json.load(open(p))
    ext = prefs.setdefault("extensions", {})
    ext["pinned_extensions"] = sorted(set(ext.get("pinned_extensions", [])) | {ext_id})
    ext["ui"] = {"developer_mode": True}
    json.dump(prefs, open(p, "w"))


def run_strategy(open_on_click, profile):
    ext_id = unpacked_extension_id(EXT)
    if os.path.isdir(profile):
        shutil.rmtree(profile)

    warm = PipeChrome(profile, extensions=[], fresh=True)
    warm.launch("about:blank")
    time.sleep(3)
    warm.kill()
    time.sleep(2)
    pin(profile, ext_id)

    chrome = PipeChrome(profile, extensions=[], fresh=False)
    chrome.launch("about:blank")
    out = {"strategy": "B (openPanelOnActionClick=true)" if open_on_click
           else "A (onClicked -> sidePanel.open)"}
    try:
        chrome.send("Extensions.loadUnpacked", path=EXT)
        time.sleep(3)
        sw = [t for t in chrome.targets()
              if t.get("type") == "service_worker" and ext_id in t.get("url", "")][0]
        sw_sid = chrome.attach(sw["targetId"])

        chrome.evaluate(sw_sid, f"""
          chrome.sidePanel.setPanelBehavior({{openPanelOnActionClick: {str(open_on_click).lower()}}})
            .then(() => 'ok')
        """)
        out["behavior"] = chrome.evaluate(sw_sid, "chrome.sidePanel.getPanelBehavior()")

        page_tid, page_sid = chrome.new_tab(f"http://127.0.0.1:{PORT}/player.html")
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

        click = click_toolbar_icon(debug=False)
        out["click"] = click
        time.sleep(3)

        panel = None
        for t in chrome.targets():
            if "sidepanel.html" in t.get("url", ""):
                panel = t
        out["panel_opened"] = bool(panel)

        # Does the invocation authorise tabCapture on that tab?
        probe = chrome.evaluate(sw_sid, """
        (async () => {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const target = tabs[0];
          if (!target) return { ok: false, error: 'no active tab' };
          try {
            const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: target.id });
            return { ok: true, streamId: String(id).slice(0, 12) + '…' };
          } catch (e) { return { ok: false, error: String(e) }; }
        })()
        """)
        out["tabcapture"] = probe
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)
    finally:
        chrome.kill()
    return out


def main():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        for open_on_click, profile in ((False, "/tmp/ts-strat-a"), (True, "/tmp/ts-strat-b")):
            res = run_strategy(open_on_click, profile)
            print("\n" + "=" * 60)
            print(json.dumps(res, indent=2))
            time.sleep(2)
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
