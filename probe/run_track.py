"""Step 1b: verify SpeechRecognition.start(mediaStreamTrack) works with processLocally.

Plays a known TTS clip in an isolated Chrome, feeds its captureStream() audio track
straight into on-device recognition, and scores the transcript against ground truth.
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
from wer import report  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8899

REFERENCE = (
    "The quarterly review is scheduled for Thursday at nine thirty in the morning. "
    "Our engineering team shipped fourteen features last month, and customer retention "
    "improved by six percent. Sarah will present the roadmap, and then we will discuss "
    "the budget for the next fiscal year. Please review the attached document before "
    "the meeting begins."
)


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def main():
    process_locally = "--cloud" not in sys.argv
    httpd = serve()
    chrome = IsolatedChrome(port=9334, profile="/tmp/tabscribe-profile", fresh=False)
    chrome.launch(f"http://127.0.0.1:{PORT}/track.html")
    try:
        target = chrome.wait_for_page("track.html")
        sess = Session(target["webSocketDebuggerUrl"])
        sess.wait_for_js("window.__ready === true", timeout=30)

        avail = sess.evaluate(
            "SpeechRecognition.available({langs:['en-US'],processLocally:true})"
        )
        print(f"en-US local availability: {avail}")

        started = sess.evaluate(
            f"window.__run({{processLocally: {str(process_locally).lower()}, flushMs: 4000}})"
        )
        print("run() ->", started)

        deadline = time.time() + 90
        snap = {}
        while time.time() < deadline:
            snap = sess.evaluate("window.__snapshot()", await_promise=False) or {}
            if snap.get("done") or snap.get("error"):
                break
            time.sleep(1)

        transcript = " ".join(f["text"].strip() for f in snap.get("finals", []))
        print("\n=== EVENT LOG ===")
        for e in snap.get("events", []):
            print(f"  {e['t']:>6}ms  {e['msg']}")
        print("\n=== TRANSCRIPT ===")
        print(transcript or "(empty)")
        print("\n=== TIMING ===")
        print(json.dumps({
            "mode": "on-device (processLocally=true)" if process_locally else "cloud",
            "first_result_ms": snap.get("firstResultMs"),
            "audio_ended_ms": snap.get("audioEndedMs"),
            "last_result_ms": snap.get("lastResultMs"),
            "final_segments": len(snap.get("finals", [])),
            "interim_updates": len(snap.get("interims", [])),
            "error": snap.get("error"),
        }, indent=2))
        if transcript:
            print("\n=== ACCURACY ===")
            print(json.dumps(report(REFERENCE, transcript), indent=2))
        sess.close()
    finally:
        chrome.kill()
        httpd.shutdown()


if __name__ == "__main__":
    main()
