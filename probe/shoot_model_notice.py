"""Render the download notice and screenshot it, for visual review.

DOM assertions prove the strings are present; they do not prove the panel looks
right. This drives each state directly and captures a PNG of each.
"""
import base64
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

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(os.path.join(HERE, "..", "extension"))
OUT = os.path.join(HERE, "shots")
PORT = 8899
PROFILE = "/tmp/tabscribe-shots"


def unpacked_extension_id(path):
    digest = hashlib.sha256(os.path.abspath(path).encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def main():
    os.makedirs(OUT, exist_ok=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    if os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE)

    ext_id = unpacked_extension_id(EXT)
    chrome = PipeChrome(PROFILE, extensions=[], fresh=True)
    chrome.launch("about:blank")
    try:
        chrome.send("Extensions.loadUnpacked", path=EXT)
        time.sleep(2)

        # Two views, because the pop-out button only exists in the side panel: the
        # window hides it via body.view-window. Screenshotting only the window view
        # would show an absent button and look like a bug.
        panel_tid, panel_sid = chrome.new_tab(f"chrome-extension://{ext_id}/sidepanel.html")
        chrome.wait_for_js(panel_sid, "!!document.getElementById('modelPanel')", timeout=30)
        chrome.send("Emulation.setDeviceMetricsOverride", session_id=panel_sid,
                    width=430, height=560, deviceScaleFactor=2, mobile=False)

        tid, sid = chrome.new_tab(f"chrome-extension://{ext_id}/sidepanel.html?view=window")
        chrome.wait_for_js(sid, "!!document.getElementById('modelPanel')", timeout=30)
        chrome.send("Emulation.setDeviceMetricsOverride", session_id=sid,
                    width=430, height=560, deviceScaleFactor=2, mobile=False)
        time.sleep(1)

        states = [
            ("0-controls", """
              (() => {
                document.getElementById('modelPanel').hidden = true;
                document.getElementById('status').textContent =
                  'Ready. Press Record to transcribe this tab.';
                document.getElementById('target').textContent = 'Quarterly review call';
                document.getElementById('prefsPanel').hidden = true;
                document.getElementById('prefsBtn').setAttribute('aria-expanded', 'false');
                return true;
              })()
            """),
            ("0b-prefs-open", """
              (() => {
                document.getElementById('modelPanel').hidden = true;
                document.getElementById('prefsPanel').hidden = false;
                document.getElementById('prefsBtn').setAttribute('aria-expanded', 'true');
                document.getElementById('status').textContent =
                  'Ready. Press Record to transcribe this tab.';
                return true;
              })()
            """),
            ("0c-toast", """
              (() => {
                document.getElementById('modelPanel').hidden = true;
                document.getElementById('prefsPanel').hidden = true;
                document.getElementById('prefsBtn').setAttribute('aria-expanded', 'false');
                document.getElementById('emptyHint').style.display = 'none';
                const t = document.getElementById('transcript');
                t.innerHTML = '<div class="seg">Welcome back to the podcast. Today we are ' +
                  'discussing distributed systems and the challenges of maintaining ' +
                  'consistency across regions.</div>';
                const toast = document.getElementById('toast');
                toast.hidden = false; toast.classList.add('show');
                document.getElementById('status').textContent = '';
                document.getElementById('wordCount').textContent = '21 words';
                return true;
              })()
            """),
            ("1-before-start", """
              (() => {
                const p = document.getElementById('modelPanel');
                p.hidden = false; p.className = 'model-panel idle';
                document.getElementById('modelTitle').textContent =
                  'First run needs a one-time download';
                document.getElementById('modelBody').innerHTML =
                  "Transcribing English (US) on-device needs Chrome's speech model — " +
                  "roughly 300&nbsp;MB, downloaded once. Press <strong>Start</strong> and " +
                  "it will download automatically; on a slow connection expect several minutes.";
                document.getElementById('modelState').textContent = 'Not downloaded yet';
                document.getElementById('modelElapsed').textContent = '';
                document.getElementById('modelHint').hidden = true;
                document.getElementById('modelActions').hidden = false;
                document.getElementById('retryModelBtn').hidden = true;
                document.getElementById('status').textContent =
                  'Ready. Press Record to transcribe this tab.';
                return true;
              })()
            """),
            ("2-downloading", """
              (() => {
                const p = document.getElementById('modelPanel');
                p.hidden = false; p.className = 'model-panel';
                document.getElementById('modelTitle').textContent =
                  'First run: one-time model download';
                document.getElementById('modelBody').innerHTML =
                  "TabScribe transcribes on your own machine using Chrome's English (US) " +
                  "speech model — roughly 300&nbsp;MB. It downloads once, then works " +
                  "instantly and offline. You can leave this open and keep using the tab.";
                document.getElementById('modelState').textContent = 'Downloading…';
                document.getElementById('modelElapsed').textContent = '2m 14s elapsed';
                document.getElementById('modelHint').hidden = false;
                document.getElementById('modelActions').hidden = false;
                document.getElementById('retryModelBtn').hidden = true;
                document.getElementById('status').textContent =
                  'Downloading on-device model for en-US…';
                return true;
              })()
            """),
            ("3-failed", """
              (() => {
                const p = document.getElementById('modelPanel');
                p.hidden = false; p.className = 'model-panel failed';
                document.getElementById('modelTitle').textContent = 'Model download failed';
                document.getElementById('modelBody').textContent =
                  'Chrome could not finish downloading the model. This is usually a network ' +
                  'problem — the download resumes from scratch, so a stable connection helps.';
                document.getElementById('modelState').textContent = 'Failed';
                document.getElementById('modelElapsed').textContent = '4m 02s elapsed';
                document.getElementById('modelHint').hidden = true;
                document.getElementById('modelActions').hidden = false;
                document.getElementById('retryModelBtn').hidden = false;
                return true;
              })()
            """),
            ("4-ready", """
              (() => {
                const p = document.getElementById('modelPanel');
                p.hidden = false; p.className = 'model-panel done';
                document.getElementById('modelTitle').textContent = 'Model ready';
                document.getElementById('modelBody').textContent =
                  'The on-device English (US) model is installed. Future sessions start instantly.';
                document.getElementById('modelState').textContent = 'Done';
                document.getElementById('modelElapsed').textContent = '2m 31s elapsed';
                document.getElementById('modelHint').hidden = true;
                document.getElementById('modelActions').hidden = true;
                return true;
              })()
            """),
        ]

        for name, js in states:
            # The controls shot must come from the side-panel view, where the
            # pop-out button actually exists.
            target_sid = panel_sid if name.startswith("0") else sid
            chrome.evaluate(target_sid, js, await_promise=False)
            time.sleep(0.6)
            shot = chrome.send("Page.captureScreenshot", session_id=target_sid, format="png")
            path = os.path.join(OUT, f"model-{name}.png")
            with open(path, "wb") as f:
                f.write(base64.b64decode(shot["data"]))
            print(f"  wrote {path}", flush=True)
    finally:
        chrome.kill()
        httpd.shutdown()


if __name__ == "__main__":
    main()
