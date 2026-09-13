"""Pipe-transport CDP client for Chrome 137+.

Chrome 136+ refuses to expose extension targets over --remote-debugging-port, and
Chrome 137+ gates --load-extension behind --enable-unsafe-extension-debugging plus
the pipe transport.

Critical detail: CPython runs preexec_fn BEFORE _close_open_fds, so descriptors
dup2'd to 3/4 inside preexec_fn are closed again unless close_fds=False. Without
that, Chrome exits immediately with
"Remote debugging pipe file descriptors are not open."
"""
import json
import os
import shutil
import subprocess
import threading
import time


class PipeChrome:
    def __init__(self, profile, extensions=(), fresh=True, extra_args=()):
        self.profile = profile
        self.extensions = [os.path.abspath(e) for e in extensions]
        self.fresh = fresh
        self.extra_args = list(extra_args)
        self.proc = None
        self._id = 0
        self._buf = b""
        self._responses = {}
        self.events = []
        self._lock = threading.Lock()

    def launch(self, url="about:blank"):
        if self.fresh and os.path.isdir(self.profile):
            shutil.rmtree(self.profile)
        os.makedirs(self.profile, exist_ok=True)

        cmd_r, self.cmd_w = os.pipe()
        self.res_r, res_w = os.pipe()
        os.set_inheritable(cmd_r, True)
        os.set_inheritable(res_w, True)

        args = [
            "google-chrome",
            f"--user-data-dir={self.profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-debugging-pipe",
            "--autoplay-policy=no-user-gesture-required",
        ]
        if self.extensions:
            joined = ",".join(self.extensions)
            args += [
                "--enable-unsafe-extension-debugging",
                "--disable-features=DisableLoadExtensionCommandLineSwitch",
                f"--load-extension={joined}",
                f"--disable-extensions-except={joined}",
            ]
        args += self.extra_args + [url]
        self.args = args

        def child():
            if cmd_r != 3:
                os.dup2(cmd_r, 3)
            if res_w != 4:
                os.dup2(res_w, 4)
            os.set_inheritable(3, True)
            os.set_inheritable(4, True)

        self.proc = subprocess.Popen(
            args,
            preexec_fn=child,
            close_fds=False,  # see module docstring
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        os.close(cmd_r)
        os.close(res_w)

        threading.Thread(target=self._read_loop, daemon=True).start()
        # Confirm the transport is live before returning.
        self.send("Target.getTargets")
        return self

    def _read_loop(self):
        while True:
            try:
                chunk = os.read(self.res_r, 1 << 20)
            except OSError:
                return
            if not chunk:
                return
            self._buf += chunk
            while b"\0" in self._buf:
                raw, self._buf = self._buf.split(b"\0", 1)
                if not raw.strip():
                    continue
                try:
                    msg = json.loads(raw.decode("utf-8"))
                except Exception:  # noqa: BLE001
                    continue
                with self._lock:
                    if "id" in msg:
                        self._responses[msg["id"]] = msg
                    else:
                        self.events.append(msg)

    def send(self, method, session_id=None, timeout=60, **params):
        self._id += 1
        mid = self._id
        msg = {"id": mid, "method": method, "params": params}
        if session_id:
            msg["sessionId"] = session_id
        os.write(self.cmd_w, json.dumps(msg).encode("utf-8") + b"\0")

        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if mid in self._responses:
                    res = self._responses.pop(mid)
                    if "error" in res:
                        raise RuntimeError(f"{method} failed: {res['error']}")
                    return res.get("result", {})
            if self.proc.poll() is not None:
                err = self.proc.stderr.read().decode("utf-8", "replace")[:1500]
                raise RuntimeError(f"chrome exited rc={self.proc.returncode}: {err}")
            time.sleep(0.01)
        raise RuntimeError(f"timeout waiting for {method}")

    # --- target helpers -------------------------------------------------

    def targets(self):
        return self.send("Target.getTargets").get("targetInfos", [])

    def attach(self, target_id):
        return self.send("Target.attachToTarget", targetId=target_id, flatten=True)["sessionId"]

    def new_tab(self, url):
        tid = self.send("Target.createTarget", url=url)["targetId"]
        return tid, self.attach(tid)

    def wait_for_target(self, url_contains, types=("page",), timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for t in self.targets():
                if t.get("type") in types and url_contains in t.get("url", ""):
                    return t
            time.sleep(0.3)
        raise RuntimeError(f"no target matching {url_contains!r}")

    def evaluate(self, session_id, expression, await_promise=True):
        res = self.send(
            "Runtime.evaluate",
            session_id=session_id,
            expression=expression,
            awaitPromise=await_promise,
            returnByValue=True,
            userGesture=True,
        )
        if "exceptionDetails" in res:
            d = res["exceptionDetails"]
            raise RuntimeError(
                "JS exception: " + (d.get("exception", {}).get("description") or d.get("text", ""))
            )
        return res.get("result", {}).get("value")

    def wait_for_js(self, session_id, expression, timeout=30):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                if self.evaluate(session_id, expression, await_promise=False):
                    return True
            except Exception as e:  # noqa: BLE001
                last = e
            time.sleep(0.25)
        raise RuntimeError(f"timed out waiting for {expression!r} (last: {last})")

    def kill(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
