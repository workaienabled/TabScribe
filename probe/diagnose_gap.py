"""Diagnose the mid-stream deletions seen in run_track.py.

Prints every interim update in the window where words went missing, so we can tell
whether the recognizer never heard them (audio problem) or heard them and then
discarded them when finalizing (segmentation problem).
"""
import functools
import http.server
import json
import os
import socketserver
import sys
import threading
import time

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
    httpd = serve()
    chrome = IsolatedChrome(port=9335, profile="/tmp/tabscribe-profile", fresh=False)
    chrome.launch(f"http://127.0.0.1:{PORT}/track.html")
    try:
        target = chrome.wait_for_page("track.html")
        sess = Session(target["webSocketDebuggerUrl"])
        sess.wait_for_js("window.__ready === true", timeout=30)
        sess.evaluate("window.__run({processLocally: true, flushMs: 6000})")

        deadline = time.time() + 90
        snap = {}
        while time.time() < deadline:
            snap = sess.evaluate("window.__snapshot()", await_promise=False) or {}
            if snap.get("done") or snap.get("error"):
                break
            time.sleep(1)

        print("=== ALL INTERIM UPDATES (idx, time, text) ===")
        for it in snap.get("interims", []):
            print(f"  [{it.get('idx')}] {it['t']:>6}ms  {it['text']}")

        print("\n=== FINALS ===")
        for f in snap.get("finals", []):
            print(f"  [{f.get('idx')}] {f['t']:>6}ms  conf={f.get('confidence')}  {f['text']}")

        print("\n=== RESULT-EVENT INDEX TRACE ===")
        for ev in snap.get("resultEvents", []):
            print(f"  {ev['t']:>6}ms resultIndex={ev['resultIndex']} length={ev['length']}")

        print("\n=== DID 'sarah' / 'roadmap' / 'attached' EVER APPEAR? ===")
        blob = " ".join(
            [i["text"] for i in snap.get("interims", [])]
            + [f["text"] for f in snap.get("finals", [])]
        ).lower()
        for word in ["sarah", "roadmap", "present", "attached", "document", "meeting", "begins", "please"]:
            print(f"  {word:<10} {'YES' if word in blob else 'NO'}")

        print("\n=== EVENTS ===")
        print(json.dumps(snap.get("events", []), indent=2))
        sess.close()
    finally:
        chrome.kill()
        httpd.shutdown()


if __name__ == "__main__":
    main()
