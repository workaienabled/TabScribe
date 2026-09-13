"""Read console output and errors from the running extension's service worker.

Attaches to the already-running fixture Chrome is not possible over the exclusive
pipe, so this script drives its own browser: load the extension, dispatch the action
click programmatically via Extensions/Runtime, and capture what the worker logs.
"""
import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipe_chrome import PipeChrome  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(os.path.join(HERE, "..", "extension"))


def unpacked_extension_id(path):
    digest = hashlib.sha256(os.path.abspath(path).encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def main():
    chrome = PipeChrome("/tmp/tabscribe-swlog", extensions=[], fresh=True)
    chrome.launch("about:blank")
    try:
        ext_id = chrome.send("Extensions.loadUnpacked", path=EXT)["id"]
        print("ext id:", ext_id)
        time.sleep(2)

        sw = [t for t in chrome.targets()
              if t.get("type") == "service_worker" and ext_id in t.get("url", "")]
        if not sw:
            print("NO SERVICE WORKER TARGET")
            return
        sid = chrome.attach(sw[0]["targetId"])
        chrome.send("Runtime.enable", session_id=sid)
        chrome.send("Log.enable", session_id=sid)

        # Verify the APIs the worker relies on are actually present.
        api = chrome.evaluate(sid, """
        ({
          hasSidePanel: typeof chrome.sidePanel,
          hasOpen: typeof (chrome.sidePanel && chrome.sidePanel.open),
          hasSetOptions: typeof (chrome.sidePanel && chrome.sidePanel.setOptions),
          hasSetPanelBehavior: typeof (chrome.sidePanel && chrome.sidePanel.setPanelBehavior),
          hasTabCapture: typeof chrome.tabCapture,
          hasGetMediaStreamId: typeof (chrome.tabCapture && chrome.tabCapture.getMediaStreamId),
          actionListeners: chrome.action.onClicked.hasListeners(),
          manifestVersion: chrome.runtime.getManifest().manifest_version,
          permissions: chrome.runtime.getManifest().permissions,
        })
        """, await_promise=False)
        print("\n=== API SURFACE IN WORKER ===")
        print(json.dumps(api, indent=2))

        # Does setPanelBehavior(openPanelOnActionClick:true) make the click work
        # without needing a gesture-preserving open() call?
        res = chrome.evaluate(sid, """
        (async () => {
          try {
            await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
            return { ok: true };
          } catch (e) { return { ok: false, error: String(e) }; }
        })()
        """)
        print("\nsetPanelBehavior(true) ->", json.dumps(res))

        print("\n=== CONSOLE EVENTS ===")
        for ev in chrome.events:
            m = ev.get("method", "")
            if m in ("Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"):
                print(" ", m, json.dumps(ev.get("params", {}))[:400])
    finally:
        chrome.kill()


if __name__ == "__main__":
    main()
