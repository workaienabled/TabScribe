"""Can the extension close its own side panel?

chrome.sidePanel has long had open() with no matching close(). Three candidate
mechanisms, all worth testing before the pop-out flow is built around one:

  1. chrome.sidePanel.close() — does it exist on this Chrome at all?
  2. window.close() from inside the side panel document.
  3. chrome.sidePanel.setOptions({ tabId, enabled: false }) — disabling the panel for
     a tab is the documented way to make it go away. The follow-up question matters
     just as much: can it be re-enabled afterwards without the panel popping back
     open, so the toolbar button still works next time?

Anything that leaves the side panel permanently disabled would be worse than not
closing it at all, so (3) is only viable if re-enabling is clean.

Run:
    python3 -u probe_sidepanel_close.py
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
PROFILE = "/tmp/ts-panelclose"
MODEL_CACHE = "/tmp/tabscribe-profile"


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


def pin_extension(profile, ext_id):
    p = os.path.join(profile, "Default", "Preferences")
    if not os.path.exists(p):
        return
    prefs = json.load(open(p))
    ext = prefs.setdefault("extensions", {})
    ext["pinned_extensions"] = sorted(set(ext.get("pinned_extensions", [])) | {ext_id})
    ext["ui"] = {"developer_mode": True}
    json.dump(prefs, open(p, "w"))


def panel_target(chrome):
    for t in chrome.targets():
        if "sidepanel.html" in t.get("url", "") and "view=window" not in t.get("url", ""):
            return t
    return None


def wait_panel_gone(chrome, timeout=6):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if panel_target(chrome) is None:
            return True
        time.sleep(0.3)
    return False


def open_panel(chrome, tries=4):
    for _ in range(tries):
        click_toolbar_icon(debug=False)
        deadline = time.time() + 8
        while time.time() < deadline:
            t = panel_target(chrome)
            if t:
                return t
            time.sleep(0.4)
    return None


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

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch("about:blank")
    try:
        chrome.send("Extensions.loadUnpacked", path=EXT)
        time.sleep(2)
        sw = [t for t in chrome.targets()
              if t.get("type") == "service_worker" and ext_id in t.get("url", "")][0]
        sw_sid = chrome.attach(sw["targetId"])

        page_tid, page_sid = chrome.new_tab(f"http://127.0.0.1:{PORT}/player.html?clip=sample2.wav")
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

        # --- 1. API surface --------------------------------------------------
        surface = chrome.evaluate(sw_sid, """
        (() => ({
          keys: Object.keys(chrome.sidePanel),
          hasClose: typeof chrome.sidePanel.close,
          hasOpen: typeof chrome.sidePanel.open,
          hasSetOptions: typeof chrome.sidePanel.setOptions,
          hasGetOptions: typeof chrome.sidePanel.getOptions,
        }))()
        """, await_promise=False)
        findings["api_surface"] = surface
        print("=== chrome.sidePanel SURFACE ===")
        print(json.dumps(surface, indent=2), flush=True)

        # --- 2. sidePanel.close() --------------------------------------------
        print("\n=== 1. chrome.sidePanel.close() ===", flush=True)
        panel = open_panel(chrome)
        print(f"  panel open: {bool(panel)}", flush=True)
        if panel and surface.get("hasClose") == "function":
            # close() takes a CloseOptions argument; find the accepted shape rather
            # than guessing. tabId and windowId are the plausible discriminators.
            tab_id = chrome.evaluate(sw_sid, """
              chrome.storage.session.get('targetTabId').then(s => s.targetTabId)
            """)
            window_id = chrome.evaluate(sw_sid, """
              chrome.windows.getCurrent().then(w => w.id).catch(() => null)
            """)
            print(f"  tabId={tab_id} windowId={window_id}", flush=True)

            attempts = {}
            for label, arg in (
                ("{}", "{}"),
                ("{tabId}", f"{{ tabId: {tab_id} }}"),
                ("{windowId}", f"{{ windowId: {window_id} }}"),
            ):
                if panel_target(chrome) is None:
                    open_panel(chrome)
                try:
                    res = chrome.evaluate(sw_sid, f"""
                      chrome.sidePanel.close({arg})
                        .then(()=>'resolved').catch(e=>'rejected: '+String(e))
                    """)
                except Exception as e:  # noqa: BLE001
                    res = f"threw: {str(e)[:120]}"
                gone = wait_panel_gone(chrome)
                attempts[label] = {"call": res, "panel_gone": gone}
                print(f"  close({label}) -> {res};  panel gone: {gone}", flush=True)

            findings["close_method"] = attempts
        else:
            findings["close_method"] = {"available": False}
            print("  close() not available on this Chrome", flush=True)

        # --- 3. window.close() from the panel document ------------------------
        print("\n=== 2. window.close() from inside the panel ===", flush=True)
        panel = panel_target(chrome) or open_panel(chrome)
        if panel:
            psid = chrome.attach(panel["targetId"])
            chrome.wait_for_js(psid, "!!document.getElementById('recordBtn')", timeout=20)
            try:
                chrome.evaluate(psid, "window.close(); 'called'", await_promise=False)
            except Exception as e:  # noqa: BLE001 - target may die mid-call
                print(f"  (evaluate threw as the target closed: {str(e)[:60]})", flush=True)
            gone = wait_panel_gone(chrome)
            findings["window_close"] = {"panel_gone": gone}
            print(f"  window.close() -> panel gone: {gone}", flush=True)
        else:
            findings["window_close"] = {"error": "panel would not open"}

        # --- 4. setOptions({enabled:false}) and re-enabling --------------------
        print("\n=== 3. setOptions({enabled:false}) ===", flush=True)
        panel = panel_target(chrome) or open_panel(chrome)
        if panel:
            tab_id = chrome.evaluate(sw_sid, """
              chrome.storage.session.get('targetTabId').then(s => s.targetTabId)
            """)
            print(f"  target tab id: {tab_id}", flush=True)
            res = chrome.evaluate(sw_sid, f"""
              chrome.sidePanel.setOptions({{ tabId: {tab_id}, enabled: false }})
                .then(()=>'resolved').catch(e=>'rejected: '+String(e))
            """)
            gone = wait_panel_gone(chrome)
            print(f"  disable -> {res};  panel gone: {gone}", flush=True)

            # Can it be re-enabled without the panel springing back open?
            res2 = chrome.evaluate(sw_sid, f"""
              chrome.sidePanel.setOptions({{ tabId: {tab_id}, path: 'sidepanel.html', enabled: true }})
                .then(()=>'resolved').catch(e=>'rejected: '+String(e))
            """)
            time.sleep(1.5)
            reopened = panel_target(chrome) is not None
            print(f"  re-enable -> {res2};  panel sprang back open: {reopened}", flush=True)

            # And does the toolbar button still work afterwards?
            back = open_panel(chrome, tries=3)
            print(f"  toolbar click opens it again: {bool(back)}", flush=True)

            findings["set_options_disable"] = {
                "disable": res, "panel_gone": gone,
                "reenable": res2, "sprang_back_open": reopened,
                "toolbar_works_after": bool(back),
            }
        else:
            findings["set_options_disable"] = {"error": "panel would not open"}
    finally:
        with open(os.path.join(HERE, "sidepanel_close_findings.json"), "w") as f:
            json.dump(findings, f, indent=2)
        chrome.kill()
        httpd.shutdown()

    print("\n" + "=" * 60)
    print(json.dumps(findings, indent=2))
    print("=" * 60)


if __name__ == "__main__":
    main()
