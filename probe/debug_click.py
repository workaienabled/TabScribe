"""Does the toolbar click work at all, and is the side panel visible to CDP?

Distinguishes three possibilities after a real X11 click on the action icon:
  1. onClicked never fires (click not landing on the action)
  2. onClicked fires but sidePanel.open() throws
  3. the panel opens but is not exposed as a CDP page target (detection bug)

Instruments the service worker to record onClicked and the open() outcome, then dumps
every target type Chrome reports.
"""
import functools
import hashlib
import http.server
import json
import os
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
PROFILE = "/tmp/tabscribe-profile"


def unpacked_extension_id(path):
    digest = hashlib.sha256(os.path.abspath(path).encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def pin(profile, ext_id):
    p = os.path.join(profile, "Default", "Preferences")
    prefs = json.load(open(p))
    ext = prefs.setdefault("extensions", {})
    ext["pinned_extensions"] = sorted(set(ext.get("pinned_extensions", [])) | {ext_id})
    ext["ui"] = {"developer_mode": True}
    json.dump(prefs, open(p, "w"))


def main():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    ext_id = unpacked_extension_id(EXT)
    pin(PROFILE, ext_id)
    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch("about:blank")
    try:
        chrome.send("Extensions.loadUnpacked", path=EXT)
        time.sleep(2)
        sw = [t for t in chrome.targets()
              if t.get("type") == "service_worker" and ext_id in t.get("url", "")][0]
        sw_sid = chrome.attach(sw["targetId"])
        chrome.send("Runtime.enable", session_id=sw_sid)

        # Record what happens on the next action click, without changing behaviour.
        chrome.evaluate(sw_sid, """
        (() => {
          self.__clicks = [];
          chrome.action.onClicked.addListener((tab) => {
            const rec = { at: Date.now(), tabId: tab && tab.id, url: tab && tab.url,
                          openResult: 'pending' };
            self.__clicks.push(rec);
            try {
              chrome.sidePanel.open({ tabId: tab.id })
                .then(() => { rec.openResult = 'resolved'; })
                .catch((e) => { rec.openResult = 'rejected: ' + String(e); });
            } catch (e) {
              rec.openResult = 'threw: ' + String(e);
            }
          });
          return self.__clicks.length;
        })()
        """, await_promise=False)

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
        time.sleep(1.5)

        print("=== CLICK ===")
        print(json.dumps(click_toolbar_icon(), indent=2))
        time.sleep(4)

        print("\n=== onClicked RECORD ===")
        print(json.dumps(chrome.evaluate(sw_sid, "self.__clicks", await_promise=False), indent=2))

        print("\n=== ALL TARGETS (every type) ===")
        for t in chrome.targets():
            print(f"  {t.get('type'):<18} {t.get('url','')[:95]}")

        print("\n=== window bounds now ===")
        print(json.dumps(chrome.send("Browser.getWindowForTarget", targetId=page_tid), indent=2))
    finally:
        chrome.kill()
        httpd.shutdown()


if __name__ == "__main__":
    main()
