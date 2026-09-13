"""Definitive: does SpeechRecognition.install() report progress? (focused re-run)

The first attempt lost its JS context mid-download. This version serves a local page
(no navigation, no network dependency for the page itself), keeps all state in a
single evaluate call, and samples the SODA directory out-of-process as ground truth.

The question that decides the UI: is a real percentage available, or only a state?
"""
import functools
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
PORT = 8899
PROFILE = "/tmp/ts-dlprobe2"


def dir_size(path):
    total = 0
    for dp, _, fns in os.walk(path):
        for fn in fns:
            try:
                total += os.path.getsize(os.path.join(dp, fn))
            except OSError:
                pass
    return total


def main():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    if os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE)

    findings = {}
    chrome = PipeChrome(PROFILE, extensions=[], fresh=True)
    chrome.launch("about:blank")
    try:
        tid, sid = chrome.new_tab(f"http://127.0.0.1:{PORT}/probe.html")
        chrome.wait_for_js(sid, "typeof window.__probe === 'function'", timeout=30)

        before = chrome.evaluate(sid,
                                 "SpeechRecognition.available({langs:['en-US'],processLocally:true})")
        print(f"availability before: {before}", flush=True)
        findings["availability_before"] = before

        # Start install with a monitor attached, and record everything it does.
        chrome.evaluate(sid, """
        (() => {
          const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
          window.__dl = { started: Date.now(), monitorCalled: false, monitorType: null,
                          events: [], done: false, result: null, error: null, states: [] };
          const opts = {
            langs: ['en-US'],
            processLocally: true,
            monitor(m) {
              window.__dl.monitorCalled = true;
              window.__dl.monitorType = Object.prototype.toString.call(m);
              try {
                m.addEventListener('downloadprogress', (e) => {
                  window.__dl.events.push({ t: Date.now() - window.__dl.started,
                                            loaded: e.loaded, total: e.total });
                });
              } catch (err) { window.__dl.monitorType += ' (no addEventListener)'; }
            },
          };
          const p = SR.install(opts);
          window.__dl.promiseOwnKeys = Object.getOwnPropertyNames(p);
          p.then(r => { window.__dl.result = r; window.__dl.done = true; })
           .catch(e => { window.__dl.error = String(e); window.__dl.done = true; });
        })()
        """, await_promise=False)

        t0 = time.time()
        samples = []
        last_state = None
        while time.time() - t0 < 600:
            soda = dir_size(os.path.join(PROFILE, "SODA"))
            packs = dir_size(os.path.join(PROFILE, "SODALanguagePacks"))
            mb = round((soda + packs) / 1e6, 1)

            snap = chrome.evaluate(sid, """
            (async () => {
              const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
              const a = await SR.available({langs:['en-US'], processLocally:true});
              if (!window.__dl) return { lost: true, avail: a };
              if (window.__dl.states.at(-1)?.a !== a) {
                window.__dl.states.push({ t: Date.now() - window.__dl.started, a });
              }
              return { avail: a, done: window.__dl.done,
                       monitorCalled: window.__dl.monitorCalled,
                       events: window.__dl.events.length };
            })()
            """)
            if snap.get("lost"):
                print("  context lost", flush=True)
                break

            samples.append({"t": round(time.time() - t0, 1), "mb": mb,
                            "avail": snap["avail"], "events": snap["events"]})
            if snap["avail"] != last_state:
                print(f"  t+{samples[-1]['t']:>6}s  {mb:>6} MB  availability={snap['avail']}"
                      f"  monitorCalled={snap['monitorCalled']}  events={snap['events']}",
                      flush=True)
                last_state = snap["avail"]
            if snap.get("done"):
                break
            time.sleep(2)

        final = chrome.evaluate(sid, "window.__dl || {lost:true}", await_promise=False)
        findings["install_state"] = final
        findings["samples"] = samples

        print("\n=== VERDICT ===")
        print(f"  monitor callback invoked : {final.get('monitorCalled')}")
        print(f"  monitor object type      : {final.get('monitorType')}")
        print(f"  downloadprogress events  : {len(final.get('events') or [])}")
        print(f"  promise own keys         : {final.get('promiseOwnKeys')}")
        print(f"  install resolved to      : {final.get('result')}  error={final.get('error')}")
        print(f"  availability transitions : {json.dumps(final.get('states'))}")
        print(f"  total wall time          : {samples[-1]['t'] if samples else '?'}s")
        print(f"  final size on disk       : {samples[-1]['mb'] if samples else '?'} MB")

        print("\n=== DISK GROWTH (what a real progress bar would have shown) ===")
        step = max(1, len(samples) // 12)
        for s in samples[::step]:
            bar = "#" * int(s["mb"] / 12)
            print(f"  t+{s['t']:>6}s {s['mb']:>6} MB  {bar}")
    finally:
        with open(os.path.join(HERE, "download_findings.json"), "w") as f:
            json.dump(findings, f, indent=2)
        chrome.kill()
        httpd.shutdown()


if __name__ == "__main__":
    main()
