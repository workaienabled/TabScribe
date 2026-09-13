"""Measure whether the top control row fits on one line, at realistic panel widths.

The claim being tested is literal: every top control on a single row. Chrome's
side panel is narrow and user-resizable, so this checks a range of widths rather
than the one width a screenshot happens to use.

This matters more since the row grew from four controls to eight (record, copy,
download, clear screen, microphone, pop-out, preferences, delete). The four-button layout
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
# 280 is the narrowest a Chrome side panel goes, and it is where the eighth
# control first overflowed. The gate missed that because it started at 300.
WIDTHS = [280, 300, 320, 360, 400, 430, 480]


def unpacked_extension_id(path):
    d = hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in d)


MEASURE_JS = """
(() => {
  const ids = ['recordBtn', 'copyBtn', 'downloadBtn', 'clearScreenBtn',
               'micStatusBtn', 'popoutBtn', 'prefsBtn', 'clearBtn'];
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
           // A control that is not in the DOM must FAIL this gate, not be
           // quietly skipped: silently dropping it would let the row "fit"
           // precisely because a button went missing.
           missing: out.filter(o => o.missing).map(o => o.id),
           // One row is not enough on its own: the row can stay on one line and
           // still push the document wider than the panel, which is what an
           // eighth control did at 280px.
           overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
           small_targets: vis.filter(b => b.w < 28 || b.h < 28).map(b => b.id),
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
        # Any control absent from the DOM is a failure, not a pass with a
        # shorter row. Without this the gate would report "fits" for a layout
        # that fits only because a button disappeared.
        missing = sorted({mid for m in results.values() for mid in m.get("missing", [])})
        if missing:
            print(f"MISSING CONTROLS: {missing}", flush=True)
            return 1
        overflowed = sorted(w for w, m in results.items() if m.get("overflow"))
        if overflowed:
            print(f"HORIZONTAL OVERFLOW at: {overflowed}", flush=True)
            return 1
        small = sorted({sid for m in results.values() for sid in m.get("small_targets", [])})
        if small:
            print(f"TARGETS BELOW 28px: {small}", flush=True)
            return 1
        return 0 if worst == 1 else 1
    finally:
        chrome.kill()


if __name__ == "__main__":
    sys.exit(main())
