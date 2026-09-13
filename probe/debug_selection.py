"""Why does a programmatic Selection come back empty in the panel?

select_words() builds a Range over real text nodes and addRange()s it, but
sel.toString() is "". Either the range is degenerate, or something in the page
clears the selection between addRange and the read.

Prints a step-by-step trace. Read-only apart from making selections.
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
PROFILE = "/tmp/tabscribe-seldebug"
MODEL_CACHE = "/tmp/tabscribe-profile"


def unpacked_extension_id(path):
    d = hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in d)


def main():
    ext_id = unpacked_extension_id(EXT)

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    if os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE)
    os.makedirs(PROFILE, exist_ok=True)
    for name in ("SODA", "SODALanguagePacks"):
        src = os.path.join(MODEL_CACHE, name)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(PROFILE, name))

    warm = PipeChrome(PROFILE, extensions=[], fresh=False)
    warm.launch("about:blank")
    time.sleep(3)
    warm.kill()
    time.sleep(2)

    p = os.path.join(PROFILE, "Default", "Preferences")
    prefs = json.load(open(p))
    ext = prefs.setdefault("extensions", {})
    ext["pinned_extensions"] = [ext_id]
    ext["ui"] = {"developer_mode": True}
    json.dump(prefs, open(p, "w"))

    src_ls = os.path.join(MODEL_CACHE, "Local State")
    dst_ls = os.path.join(PROFILE, "Local State")
    if os.path.exists(src_ls) and os.path.exists(dst_ls):
        cap = json.load(open(src_ls)).get("accessibility", {}).get("captions")
        if cap:
            cap = {k: (v.replace(MODEL_CACHE, PROFILE) if isinstance(v, str) else v)
                   for k, v in cap.items()}
            st = json.load(open(dst_ls))
            st.setdefault("accessibility", {})["captions"] = cap
            json.dump(st, open(dst_ls, "w"))

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch("about:blank")
    try:
        chrome.send("Extensions.loadUnpacked", path=EXT)
        time.sleep(2)

        tid, sid = chrome.new_tab(f"http://127.0.0.1:{PORT}/player.html?clip=sample2.wav")
        chrome.wait_for_js(sid, "window.__playerReady === true", timeout=30)
        for t in chrome.targets():
            if t.get("type") == "page" and t.get("url", "").startswith("about:blank"):
                chrome.send("Target.closeTarget", targetId=t["targetId"])
        time.sleep(0.5)
        chrome.send("Target.activateTarget", targetId=tid)
        w = chrome.send("Browser.getWindowForTarget", targetId=tid)
        chrome.send("Browser.setWindowBounds", windowId=w["windowId"],
                    bounds={"left": 40, "top": 40, "width": 1100, "height": 850,
                            "windowState": "normal"})
        time.sleep(1.5)

        panel = None
        for _ in range(4):
            click_toolbar_icon(debug=False)
            dl = time.time() + 8
            while time.time() < dl:
                panel = next((t for t in chrome.targets()
                              if "sidepanel.html" in t.get("url", "")
                              and "view=window" not in t.get("url", "")), None)
                if panel:
                    break
                time.sleep(0.4)
            if panel:
                break
        if not panel:
            print("panel would not open")
            return

        psid = chrome.attach(panel["targetId"])
        chrome.wait_for_js(psid, "!!document.getElementById('startBtn')", timeout=30)

        chrome.evaluate(psid, "document.getElementById('startBtn').click()", await_promise=False)
        dl = time.time() + 45
        while time.time() < dl:
            if chrome.evaluate(psid, "document.getElementById('dot').dataset.state",
                               await_promise=False) == "listening":
                break
            time.sleep(0.5)
        chrome.evaluate(sid, "window.__play()")
        dl = time.time() + 40
        while time.time() < dl:
            n = chrome.evaluate(psid,
                                "document.getElementById('transcript').innerText.trim().split(/\\s+/).filter(Boolean).length",
                                await_promise=False)
            if n >= 12:
                break
            time.sleep(0.3)
        chrome.evaluate(psid, "document.getElementById('stopBtn').click()", await_promise=False)
        time.sleep(2)

        print("\n=== STEP BY STEP ===", flush=True)
        trace = chrome.evaluate(psid, """
        (() => {
          const out = {};
          const root = document.getElementById('transcript');
          out.innerText_len = root.innerText.length;

          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          const nodes = [];
          while (walker.nextNode()) {
            const n = walker.currentNode;
            if (n.parentElement && n.parentElement.classList.contains('ts')) continue;
            if (n.data.trim()) nodes.push(n);
          }
          out.text_node_count = nodes.length;
          out.first_node_data = nodes.length ? nodes[0].data.slice(0, 60) : null;
          out.first_node_parent = nodes.length ? nodes[0].parentElement.className : null;

          if (!nodes.length) return out;

          const range = document.createRange();
          range.setStart(nodes[0], 0);
          range.setEnd(nodes[0], Math.min(20, nodes[0].data.length));
          out.range_toString = range.toString();
          out.range_collapsed = range.collapsed;

          const sel = window.getSelection();
          out.sel_type_before = sel.type;
          out.sel_rangeCount_before = sel.rangeCount;

          sel.removeAllRanges();
          sel.addRange(range);

          out.sel_rangeCount_after = sel.rangeCount;
          out.sel_type_after = sel.type;
          out.sel_toString_immediate = sel.toString();
          out.sel_isCollapsed = sel.isCollapsed;
          out.anchorNode = sel.anchorNode ? sel.anchorNode.nodeName : null;
          out.focusNode = sel.focusNode ? sel.focusNode.nodeName : null;
          out.doc_hasFocus = document.hasFocus();
          out.activeElement = document.activeElement
            ? document.activeElement.tagName + '#' + document.activeElement.id : null;

          // What the extension's own helper sees
          out.transcript_contains_anchor = sel.anchorNode
            ? root.contains(sel.anchorNode) : false;
          return out;
        })()
        """, await_promise=False)
        print(json.dumps(trace, indent=2), flush=True)

        # And after a tick — is something clearing it?
        time.sleep(1)
        after = chrome.evaluate(psid, """
        (() => {
          const sel = window.getSelection();
          return { rangeCount: sel.rangeCount, text: sel.toString(),
                   isCollapsed: sel.isCollapsed, hasFocus: document.hasFocus() };
        })()
        """, await_promise=False)
        print("\n=== ONE SECOND LATER ===")
        print(json.dumps(after, indent=2), flush=True)
    finally:
        chrome.kill()
        httpd.shutdown()


if __name__ == "__main__":
    main()
