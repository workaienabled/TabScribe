"""Measure whether the top control row fits on one line, at realistic panel widths.

The claim being tested is literal: every top control on a single row. Chrome's
side panel is narrow and user-resizable, so this checks a range of widths rather
than the one width a screenshot happens to use.

This matters more since the row grew from four controls to seven (record, copy,
download, clear screen, microphone, pop-out, preferences). The four-button layout
already needed icon-only controls to fit 300px, so seven is a real constraint and
this gate is the thing that proves it rather than a screenshot at one width.

Rows are detected by offsetTop: buttons sharing a row share a top edge. Prints one
line per width with the number of distinct rows.

Run:
    python3 -u measure_button_row.py
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

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(os.path.join(HERE, "..", "extension"))
PROFILE = "/tmp/ts-btnrow"
WIDTHS = [300, 320, 360, 400, 430, 480]


def unpacked_extension_id(path):
    d = hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in d)


MEASURE_JS = """
(() => {
  const ids = ['recordBtn', 'copyBtn', 'downloadBtn', 'clearScreenBtn',
               'micStatusBtn', 'popoutBtn', 'prefsBtn'];
  const out = [];
  for (const id of ids) {
    const e = document.getElementById(id);
    if (!e) { out.push({ id, missing: true }); continue; }
    const r = e.getBoundingClientRect();
    out.push({ id, top: Math.round(r.top), left: Math.round(r.left),
               w: Math.round(r.width), h: Math.round(r.height),
               text: e.innerText.trim().replace(/\\s+/g, ' ') });
  }
  const vis = out.filter(o => !o.missing);
  // Group by row using vertical OVERLAP, not an exact top edge: buttons of
  // slightly different heights sit on the same visual row but differ by a pixel
  // or two, and an exact-match test reports that as a wrap.
  const sorted = [...vis].sort((a, b) => a.top - b.top);
  const rows = [];
  for (const b of sorted) {
    const row = rows.find(r => b.top < r.bottom - 4 && b.top + b.h > r.top + 4);
    if (row) {
      row.top = Math.min(row.top, b.top);
      row.bottom = Math.max(row.bottom, b.top + b.h);
      row.items.push(b.id);
    } else {
      rows.push({ top: b.top, bottom: b.top + b.h, items: [b.id] });
    }
  }
  const container = document.querySelector('.controls');
  return { buttons: out, rows: rows.length,
           row_items: rows.map(r => r.items),
           tops: vis.map(b => b.top),
           row_height: container ? Math.round(container.getBoundingClientRect().height) : null,
           doc_width: document.documentElement.clientWidth };
})()
"""


def main():
    ext_id = unpacked_extension_id(EXT)

    if os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE)
    chrome = PipeChrome(PROFILE, extensions=[], fresh=True)
    chrome.launch("about:blank")
    try:
        chrome.send("Extensions.loadUnpacked", path=EXT)
        time.sleep(2)

        tid, sid = chrome.new_tab(f"chrome-extension://{ext_id}/sidepanel.html")
        chrome.wait_for_js(sid, "!!document.getElementById('prefsBtn')", timeout=30)

        print(f"{'width':>6}  {'rows':>4}  {'row h':>6}  buttons", flush=True)
        results = {}
        for w in WIDTHS:
            chrome.send("Emulation.setDeviceMetricsOverride", session_id=sid,
                        width=w, height=620, deviceScaleFactor=1, mobile=False)
            time.sleep(0.5)
            m = chrome.evaluate(sid, MEASURE_JS, await_promise=False)
            results[w] = m
            desc = " | ".join(
                f"{b['id'].replace('Btn','')}:{b['w']}px@y{b['top']}"
                for b in m["buttons"] if not b.get("missing"))
            flag = "" if m["rows"] == 1 else f"  <-- WRAPS: {m['row_items']}"
            print(f"{w:>6}  {m['rows']:>4}  {str(m['row_height']):>6}  {desc}{flag}",
                  flush=True)

        with open(os.path.join(HERE, "button_row_measurements.json"), "w") as f:
            json.dump(results, f, indent=2)

        worst = max(m["rows"] for m in results.values())
        print(f"\nmax rows across {WIDTHS}: {worst}", flush=True)
        return 0 if worst == 1 else 1
    finally:
        chrome.kill()


if __name__ == "__main__":
    sys.exit(main())
