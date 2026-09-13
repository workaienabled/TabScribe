"""Step 1 go/no-go: is Chrome's on-device speech recognition (SODA) usable here?

Launches an isolated Chrome, serves probe.html over http://127.0.0.1 (a secure
context), and reports API surface + language-pack availability, attempting an
install() if the pack is merely downloadable.
"""
import functools
import http.server
import json
import os
import socketserver
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import IsolatedChrome, Session  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8899


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    do_install = "--install" in sys.argv
    httpd = serve()
    chrome = IsolatedChrome(port=9333, profile="/tmp/tabscribe-profile", fresh=False)
    chrome.launch(f"http://127.0.0.1:{PORT}/probe.html")
    try:
        target = chrome.wait_for_page("probe.html")
        sess = Session(target["webSocketDebuggerUrl"])
        sess.wait_for_js("typeof window.__probe === 'function'", timeout=30)
        probe = sess.evaluate("window.__probe()")
        print("=== PROBE ===")
        print(json.dumps(probe, indent=2))

        avail = (probe or {}).get("availability", {}).get("en-US local")
        if do_install and avail in ("downloadable", "downloading"):
            print("\n=== INSTALL (this downloads the SODA language pack) ===")
            print(json.dumps(sess.evaluate("window.__install()"), indent=2))
        sess.close()
    finally:
        chrome.kill()
        httpd.shutdown()


if __name__ == "__main__":
    main()
