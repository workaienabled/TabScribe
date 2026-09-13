"""Minimal Chrome DevTools Protocol helper for an isolated, agent-owned Chrome.

Deliberately does NOT touch the user's signed-in Chrome profile: every launch uses a
throwaway --user-data-dir and its own debugging port, so the user is never prompted
to approve a debugger attach on their own browser.
"""
import json
import os
import shutil
import signal
import subprocess
import time
import urllib.request

import websocket  # websocket-client

CHROME = "/usr/bin/google-chrome"


class IsolatedChrome:
    def __init__(self, port=9333, profile="/tmp/tabscribe-profile", extra_args=(), fresh=False):
        self.port = port
        self.profile = profile
        self.extra_args = list(extra_args)
        self.fresh = fresh
        self.proc = None

    def launch(self, url="about:blank"):
        if self.fresh and os.path.isdir(self.profile):
            shutil.rmtree(self.profile)
        os.makedirs(self.profile, exist_ok=True)
        args = [
            CHROME,
            f"--remote-debugging-port={self.port}",
            f"--user-data-dir={self.profile}",
            "--remote-allow-origins=*",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=DialMediaRouteProvider",
            "--autoplay-policy=no-user-gesture-required",
        ] + self.extra_args + [url]
        self.proc = subprocess.Popen(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        self._wait_for_port()
        return self

    def _wait_for_port(self, timeout=30):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                return self.version()
            except Exception as e:  # noqa: BLE001 - retry until the port is listening
                last = e
                time.sleep(0.25)
        raise RuntimeError(f"chrome debug port never opened: {last}")

    def _http(self, path):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=5) as r:
            return json.load(r)

    def version(self):
        return self._http("/json/version")

    def targets(self):
        return self._http("/json/list")

    def page_target(self, url_contains=None):
        for t in self.targets():
            if t.get("type") != "page":
                continue
            if url_contains and url_contains not in t.get("url", ""):
                continue
            return t
        return None

    def wait_for_page(self, url_contains, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            t = self.page_target(url_contains)
            if t:
                return t
            time.sleep(0.25)
        raise RuntimeError(f"no page target matching {url_contains!r}")

    def kill(self):
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except Exception:  # noqa: BLE001 - best effort teardown
                self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)


class Session:
    """One websocket attached to one target, with Runtime.evaluate."""

    def __init__(self, ws_url, timeout=120):
        self.ws = websocket.create_connection(ws_url, timeout=timeout)
        self._id = 0

    def send(self, method, **params):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method} failed: {msg['error']}")
                return msg.get("result", {})

    def evaluate(self, expression, await_promise=True, timeout_hint=None):
        res = self.send(
            "Runtime.evaluate",
            expression=expression,
            awaitPromise=await_promise,
            returnByValue=True,
            userGesture=True,
        )
        if "exceptionDetails" in res:
            details = res["exceptionDetails"]
            desc = details.get("exception", {}).get("description") or details.get("text")
            raise RuntimeError(f"JS exception: {desc}")
        return res.get("result", {}).get("value")

    def wait_for_js(self, expression, timeout=30, interval=0.25):
        """Poll until `expression` evaluates truthy; raises on timeout."""
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                if self.evaluate(expression, await_promise=False):
                    return True
            except Exception as e:  # noqa: BLE001 - page may still be loading
                last = e
            time.sleep(interval)
        raise RuntimeError(f"timed out waiting for {expression!r} (last: {last})")

    def close(self):
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001 - best effort teardown
            pass
