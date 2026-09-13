"""Select-to-copy and persisted preferences, end to end.

The silent-failure modes this pins down:

  - the checkbox exists but defaults OFF (the user asked for ON)
  - selecting text reports success without the clipboard actually changing
  - unchecking the box does not really disable auto-copy
  - preferences appear to save but do not survive a Chrome restart
  - the window size is recorded but not applied to the next pop-out

Clipboard reads are the only honest check here, so the clipboard is poisoned
with a sentinel first: an auto-copy that silently does nothing would otherwise
"pass" against whatever happened to be on the clipboard already.

Run:
    python3 -u prefs_test.py
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
from toolbar_click import click_toolbar_icon  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(os.path.join(HERE, "..", "extension"))
PORT = 8899
PROFILE = "/tmp/tabscribe-prefs-e2e"
MODEL_CACHE = "/tmp/tabscribe-profile"
CLIP = "sample2.wav"
SENTINEL = "SENTINEL-CLIPBOARD-NOT-TOUCHED"


def unpacked_extension_id(path):
    digest = hashlib.sha256(os.path.abspath(path).encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def prepare_profile(profile, model_cache):
    if os.path.isdir(profile):
        shutil.rmtree(profile)
    os.makedirs(profile, exist_ok=True)
    for name in ("SODA", "SODALanguagePacks"):
        src = os.path.join(model_cache, name)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(profile, name))


def graft_model_registration(profile, model_cache):
    src = os.path.join(model_cache, "Local State")
    dst = os.path.join(profile, "Local State")
    if not (os.path.exists(src) and os.path.exists(dst)):
        return False
    captions = json.load(open(src)).get("accessibility", {}).get("captions")
    if not captions:
        return False
    rewritten = {
        k: (v.replace(model_cache, profile) if isinstance(v, str) and model_cache in v else v)
        for k, v in captions.items()
    }
    state = json.load(open(dst))
    state.setdefault("accessibility", {})["captions"] = rewritten
    json.dump(state, open(dst, "w"))
    return True


def pin_extension(profile, ext_id):
    p = os.path.join(profile, "Default", "Preferences")
    if not os.path.exists(p):
        return
    prefs = json.load(open(p))
    ext = prefs.setdefault("extensions", {})
    ext["pinned_extensions"] = sorted(set(ext.get("pinned_extensions", [])) | {ext_id})
    ext["ui"] = {"developer_mode": True}
    json.dump(prefs, open(p, "w"))


class Checks:
    def __init__(self):
        self.items = []
        self.passed = True

    def add(self, name, ok, detail=""):
        ok = bool(ok)
        self.items.append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            self.passed = False
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""),
              flush=True)


def find_panel(chrome):
    for t in chrome.targets():
        if "sidepanel.html" in t.get("url", "") and "view=window" not in t.get("url", ""):
            return t
    return None


def open_panel(chrome, tries=4):
    for _ in range(tries):
        click_toolbar_icon(debug=False)
        deadline = time.time() + 8
        while time.time() < deadline:
            t = find_panel(chrome)
            if t:
                return t
            time.sleep(0.4)
    return None


def poison_clipboard(chrome, sid, target_id):
    """Put a sentinel on the clipboard so a no-op copy cannot masquerade as success.

    The Clipboard API refuses to write from an unfocused document, so the target
    owning `sid` is activated first.
    """
    chrome.send("Browser.grantPermissions",
                permissions=["clipboardReadWrite", "clipboardSanitizedWrite"])
    chrome.send("Target.activateTarget", targetId=target_id)
    time.sleep(0.3)
    return chrome.evaluate(sid, f"""
      navigator.clipboard.writeText({SENTINEL!r}).then(() => 'ok').catch(e => String(e))
    """)


def read_clipboard(chrome, sid):
    return chrome.evaluate(sid, "navigator.clipboard.readText().catch(e => 'ERR: ' + e)")


def select_words(chrome, sid, start_word, count):
    """Select a run of words inside the transcript via a real Selection range.

    Spans text nodes: the transcript is one node per segment, so an early
    version that only looked at nodes[0] ran out of words and reported a
    selection failure that looked like an auto-copy bug.
    """
    return chrome.evaluate(sid, f"""
    (() => {{
      // Walk only real transcript segments. The empty-state placeholder lives
      // inside #transcript too, and selecting it produced a range whose
      // toString() was "" (it is display:none once text arrives) — which looked
      // exactly like a broken auto-copy.
      const segs = document.querySelectorAll('#transcript .seg');
      if (!segs.length) return {{ ok: false, reason: 'no segments' }};

      const nodes = [];
      for (const seg of segs) {{
        const walker = document.createTreeWalker(seg, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {{
          const n = walker.currentNode;
          if (n.parentElement && n.parentElement.classList.contains('ts')) continue;
          if (n.data.trim()) nodes.push(n);
        }}
      }}
      if (!nodes.length) return {{ ok: false, reason: 'no text nodes' }};

      // Flatten every word across all nodes, keeping its node and offset.
      const words = [];
      for (const node of nodes) {{
        const re = /\\S+/g;
        let m;
        while ((m = re.exec(node.data)) !== null) {{
          words.push({{ node, start: m.index, end: m.index + m[0].length }});
        }}
      }}
      if (words.length < {start_word} + {count}) {{
        return {{ ok: false, reason: 'not enough words',
                 available: words.length, needed: {start_word} + {count} }};
      }}

      const first = words[{start_word}];
      const last = words[{start_word} + {count} - 1];
      const range = document.createRange();
      range.setStart(first.node, first.start);
      range.setEnd(last.node, last.end);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      // Auto-copy fires at the END of a selection gesture, not on selectionchange.
      document.dispatchEvent(new MouseEvent('mouseup', {{ bubbles: true }}));
      return {{ ok: true, text: sel.toString(), total_words: words.length }};
    }})()
    """, await_promise=False)


def main():
    ext_id = unpacked_extension_id(EXT)
    checks = Checks()

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=HERE)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    prepare_profile(PROFILE, MODEL_CACHE)
    warm = PipeChrome(PROFILE, extensions=[], fresh=False)
    warm.launch("about:blank")
    time.sleep(3)
    warm.kill()
    time.sleep(2)
    pin_extension(PROFILE, ext_id)
    graft_model_registration(PROFILE, MODEL_CACHE)

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch("about:blank")
    try:
        chrome.send("Extensions.loadUnpacked", path=EXT)
        time.sleep(2)
        sw = [t for t in chrome.targets()
              if t.get("type") == "service_worker" and ext_id in t.get("url", "")][0]
        sw_sid = chrome.attach(sw["targetId"])

        page_tid, page_sid = chrome.new_tab(f"http://127.0.0.1:{PORT}/player.html?clip={CLIP}")
        chrome.wait_for_js(page_sid, "window.__playerReady === true", timeout=30)
        for t in chrome.targets():
            if t.get("type") == "page" and t.get("url", "").startswith("about:blank"):
                chrome.send("Target.closeTarget", targetId=t["targetId"])
        time.sleep(0.5)
        chrome.send("Target.activateTarget", targetId=page_tid)
        win = chrome.send("Browser.getWindowForTarget", targetId=page_tid)
        chrome.send("Browser.setWindowBounds", windowId=win["windowId"],
                    bounds={"left": 40, "top": 40, "width": 1100, "height": 850,
                            "windowState": "normal"})
        time.sleep(1.5)

        panel = open_panel(chrome)
        checks.add("side panel open", bool(panel))
        if not panel:
            raise SystemExit(1)
        panel_sid = chrome.attach(panel["targetId"])
        chrome.wait_for_js(panel_sid, "!!document.getElementById('recordBtn')", timeout=30)

        # --- 0. preferences disclosure ---------------------------------------
        print("\n=== PREFERENCES BUTTON ===", flush=True)
        disclosure = chrome.evaluate(panel_sid, """
        (() => {
          const b = document.getElementById('prefsBtn');
          const p = document.getElementById('prefsPanel');
          if (!b || !p) return { missing: true };
          const r = b.getBoundingClientRect();
          return {
            btn_text: b.innerText.trim(),
            aria_label: b.getAttribute('aria-label'),
            title: b.getAttribute('title'),
            has_icon: !!b.querySelector('svg.gear'),
            width: Math.round(r.width),
            btn_visible: !!b.offsetParent,
            panel_hidden: p.hidden,
            expanded: b.getAttribute('aria-expanded'),
            lang_visible: !!document.getElementById('langSel').offsetParent,
            checks_visible: !!document.getElementById('selectToCopy').offsetParent,
          };
        })()
        """, await_promise=False)
        print(f"  collapsed: {json.dumps(disclosure)}", flush=True)
        checks.add("Preferences button exists", not disclosure.get("missing"))
        checks.add("Preferences button is a gear icon, not text",
                   disclosure.get("has_icon") and not disclosure.get("btn_text"),
                   f"icon={disclosure.get('has_icon')} text={disclosure.get('btn_text')!r}")
        # An icon-only control still needs an accessible name.
        checks.add("gear button has an accessible name",
                   (disclosure.get("aria_label") or "").lower().startswith("pref"),
                   repr(disclosure.get("aria_label")))
        checks.add("gear button has a tooltip",
                   bool(disclosure.get("title")), repr(disclosure.get("title")))
        checks.add("gear button is compact", (disclosure.get("width") or 999) <= 45,
                   f"{disclosure.get('width')}px")
        checks.add("options start hidden", disclosure.get("panel_hidden") is True,
                   json.dumps(disclosure))
        checks.add("language dropdown hidden when collapsed",
                   disclosure.get("lang_visible") is False)
        checks.add("checkboxes hidden when collapsed",
                   disclosure.get("checks_visible") is False)

        # The point of the icon: the whole top row on one line, at the narrow
        # widths a Chrome side panel actually gets used at.
        row = chrome.evaluate(panel_sid, """
        (() => {
          const ids = ['recordBtn', 'copyBtn', 'downloadBtn', 'clearScreenBtn', 'micStatusBtn', 'popoutBtn', 'prefsBtn'];
          const rects = ids.map(id => {
            const e = document.getElementById(id);
            const r = e.getBoundingClientRect();
            return { id, top: r.top, h: r.height };
          });
          // Same visual row = vertical overlap, not an identical top edge.
          const sorted = [...rects].sort((a, b) => a.top - b.top);
          const rows = [];
          for (const b of sorted) {
            const row = rows.find(r => b.top < r.bottom - 4 && b.top + b.h > r.top + 4);
            if (row) { row.bottom = Math.max(row.bottom, b.top + b.h); row.n += 1; }
            else rows.push({ top: b.top, bottom: b.top + b.h, n: 1 });
          }
          return { rows: rows.length, width: document.documentElement.clientWidth };
        })()
        """, await_promise=False)
        print(f"  button row: {json.dumps(row)}", flush=True)
        checks.add("all four top buttons fit on one row",
                   row.get("rows") == 1, json.dumps(row))

        chrome.evaluate(panel_sid, "document.getElementById('prefsBtn').click()",
                        await_promise=False)
        time.sleep(0.4)
        opened = chrome.evaluate(panel_sid, """
        (() => ({
          panel_hidden: document.getElementById('prefsPanel').hidden,
          expanded: document.getElementById('prefsBtn').getAttribute('aria-expanded'),
          lang_visible: !!document.getElementById('langSel').offsetParent,
          checks_visible: !!document.getElementById('selectToCopy').offsetParent,
          toast_toggle: !!document.getElementById('copyToast'),
        }))()
        """, await_promise=False)
        print(f"  expanded:  {json.dumps(opened)}", flush=True)
        checks.add("clicking Preferences reveals the options",
                   opened.get("panel_hidden") is False, json.dumps(opened))
        checks.add("language dropdown visible when expanded", opened.get("lang_visible"))
        checks.add("checkboxes visible when expanded", opened.get("checks_visible"))
        checks.add("aria-expanded tracks state", opened.get("expanded") == "true")
        checks.add("copy-toast toggle exists", opened.get("toast_toggle"))

        # --- 1. the checkbox exists and defaults ON --------------------------
        print("\n=== DEFAULT STATE ===", flush=True)
        box = chrome.evaluate(panel_sid, """
        (() => {
          const b = document.getElementById('selectToCopy');
          if (!b) return { missing: true };
          const label = b.closest('label');
          return { checked: b.checked, label: label ? label.innerText.trim() : '',
                   visible: !!b.offsetParent };
        })()
        """, await_promise=False)
        print(f"  {json.dumps(box)}", flush=True)
        checks.add("select-to-copy checkbox exists", not box.get("missing"))
        checks.add("defaults to ON", box.get("checked") is True, json.dumps(box))
        checks.add("checkbox is visible", box.get("visible"))
        checks.add("checkbox is labelled",
                   "select" in (box.get("label") or "").lower(), box.get("label"))

        # Transcribe a little so there is text to select.
        print("\n=== TRANSCRIBE ===", flush=True)
        chrome.evaluate(panel_sid, "document.getElementById('recordBtn').click()",
                        await_promise=False)
        deadline = time.time() + 45
        while time.time() < deadline:
            if chrome.evaluate(panel_sid, "document.getElementById('dot').dataset.state",
                               await_promise=False) == "listening":
                break
            time.sleep(0.5)
        chrome.evaluate(page_sid, "window.__play()")
        # Count words in real transcript SEGMENTS, not the pane's innerText: the
        # empty-state placeholder lives inside #transcript and would otherwise be
        # counted as transcript text, so the test could proceed with nothing
        # actually transcribed and then "fail" at the selection step.
        seg_words_js = """
        (() => {
          const segs = document.querySelectorAll('#transcript .seg');
          let words = 0;
          for (const s of segs) {
            const clone = s.cloneNode(true);
            clone.querySelectorAll('.ts').forEach(e => e.remove());
            words += clone.textContent.trim().split(/\\s+/).filter(Boolean).length;
          }
          return { segs: segs.length, words };
        })()
        """
        deadline = time.time() + 60
        seg = {"segs": 0, "words": 0}
        while time.time() < deadline:
            seg = chrome.evaluate(panel_sid, seg_words_js, await_promise=False)
            # Several disjoint selections are made later, the furthest reaching
            # word index 10, so there must be comfortably more than that.
            if seg.get("words", 0) >= 16:
                break
            time.sleep(0.3)
        chrome.evaluate(panel_sid, "document.getElementById('recordBtn').click()",
                        await_promise=False)
        time.sleep(2)
        seg = chrome.evaluate(panel_sid, seg_words_js, await_promise=False)
        print(f"  transcript: {json.dumps(seg)}", flush=True)
        checks.add("transcript has text to select", seg.get("words", 0) >= 16,
                   json.dumps(seg))

        # --- 2. selecting text auto-copies -----------------------------------
        print("\n=== SELECT TO COPY (enabled) ===", flush=True)
        print(f"  poison clipboard: {poison_clipboard(chrome, panel_sid, panel['targetId'])}", flush=True)
        before = read_clipboard(chrome, panel_sid)
        checks.add("clipboard poisoned with sentinel", before == SENTINEL, repr(before))

        selected = select_words(chrome, panel_sid, 1, 3)
        print(f"  selected: {json.dumps(selected)}", flush=True)
        time.sleep(1.2)
        after = read_clipboard(chrome, panel_sid)
        print(f"  clipboard now: {after!r}", flush=True)

        sel_text = (selected.get("text") or "").strip()
        checks.add("selection was made", selected.get("ok"), json.dumps(selected))
        checks.add("clipboard changed from the sentinel", after != SENTINEL, repr(after)[:60])
        checks.add("clipboard holds exactly the selected text",
                   after.strip() == sel_text and bool(sel_text),
                   f"selected={sel_text!r} clipboard={after.strip()!r}")

        status = chrome.evaluate(panel_sid, "document.getElementById('status').textContent",
                                 await_promise=False)
        checks.add("status is not hijacked by the copy",
                   "copied" not in (status or "").lower(), repr(status))

        # --- 2b. the toast, not a full-pane flash -----------------------------
        print("\n=== COPY TOAST ===", flush=True)
        # The flash was replaced because auto-copy fires on every selection while
        # reading; confirmation has to be small and local.
        flash_gone = chrome.evaluate(panel_sid, """
          (() => {
            const css = Array.from(document.styleSheets)
              .flatMap(s => { try { return Array.from(s.cssRules); } catch (e) { return []; } })
              .map(r => r.cssText).join(' ');
            return { flash_rule_present: css.includes('just-copied'),
                     transcript_classes: document.getElementById('transcript').className };
          })()
        """, await_promise=False)
        checks.add("full-pane flash removed",
                   not flash_gone.get("flash_rule_present")
                   and "just-copied" not in (flash_gone.get("transcript_classes") or ""),
                   json.dumps(flash_gone))

        # Re-select something new and watch the toast appear then dismiss.
        chrome.evaluate(panel_sid, "window.getSelection().removeAllRanges()",
                        await_promise=False)
        time.sleep(0.3)
        select_words(chrome, panel_sid, 7, 2)
        toast_seen = {}
        deadline = time.time() + 3
        while time.time() < deadline:
            t = chrome.evaluate(panel_sid, """
              (() => { const e = document.getElementById('toast');
                       return { hidden: e.hidden, shown: e.classList.contains('show'),
                                text: e.textContent.trim() }; })()
            """, await_promise=False)
            if t.get("shown"):
                toast_seen = t
                break
            time.sleep(0.1)
        print(f"  toast while showing: {json.dumps(toast_seen)}", flush=True)
        checks.add("toast appears on auto-copy", bool(toast_seen.get("shown")),
                   json.dumps(toast_seen))
        checks.add("toast reads 'Copied'", (toast_seen.get("text") or "") == "Copied",
                   repr(toast_seen.get("text")))

        dismissed = False
        deadline = time.time() + 4
        while time.time() < deadline:
            t = chrome.evaluate(panel_sid,
                                "document.getElementById('toast').classList.contains('show')",
                                await_promise=False)
            if not t:
                dismissed = True
                break
            time.sleep(0.15)
        checks.add("toast dismisses itself", dismissed)

        # Toggling the toast off must silence it WITHOUT disabling the copy.
        chrome.evaluate(panel_sid, """
          (() => { const b = document.getElementById('copyToast');
                   b.checked = false;
                   b.dispatchEvent(new Event('change', { bubbles: true }));
                   window.getSelection().removeAllRanges(); })()
        """, await_promise=False)
        time.sleep(0.4)
        print(f"  re-poison: {poison_clipboard(chrome, panel_sid, panel['targetId'])}", flush=True)
        sel_q = select_words(chrome, panel_sid, 9, 2)
        time.sleep(1.4)
        quiet = chrome.evaluate(panel_sid, """
          (() => { const e = document.getElementById('toast');
                   return { hidden: e.hidden, shown: e.classList.contains('show') }; })()
        """, await_promise=False)
        clip_q = read_clipboard(chrome, panel_sid)
        print(f"  toast off: {json.dumps(quiet)}; clipboard {clip_q!r}", flush=True)
        checks.add("toast toggle off suppresses the toast",
                   not quiet.get("shown"), json.dumps(quiet))
        checks.add("copying still works with the toast off",
                   clip_q.strip() == (sel_q.get("text") or "").strip() and clip_q != SENTINEL,
                   f"selected={sel_q.get('text')!r} clipboard={clip_q!r}")

        # Restore for the later disabled-selection check.
        chrome.evaluate(panel_sid, """
          (() => { const b = document.getElementById('copyToast');
                   b.checked = true;
                   b.dispatchEvent(new Event('change', { bubbles: true })); })()
        """, await_promise=False)
        time.sleep(0.3)

        # --- 3. unchecking really disables it --------------------------------
        print("\n=== SELECT TO COPY (disabled) ===", flush=True)
        chrome.evaluate(panel_sid, """
          (() => { const b = document.getElementById('selectToCopy');
                   b.checked = false;
                   b.dispatchEvent(new Event('change', { bubbles: true }));
                   window.getSelection().removeAllRanges(); })()
        """, await_promise=False)
        time.sleep(0.5)
        print(f"  re-poison: {poison_clipboard(chrome, panel_sid, panel['targetId'])}", flush=True)
        sel2 = select_words(chrome, panel_sid, 4, 3)
        time.sleep(1.2)
        after2 = read_clipboard(chrome, panel_sid)
        print(f"  selected {sel2.get('text')!r}; clipboard {after2!r}", flush=True)
        checks.add("unchecked: selection does NOT copy", after2 == SENTINEL,
                   f"clipboard={after2!r}")

        # --- 4. preferences persist across a Chrome restart -------------------
        print("\n=== PERSISTENCE ===", flush=True)
        chrome.evaluate(panel_sid, """
          (() => {
            const set = (id, v) => { const e = document.getElementById(id);
              e.checked = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
            set('selectToCopy', false);
            set('copyToast', false);
            set('tsToggle', true);
            set('autoscroll', false);
            const l = document.getElementById('langSel');
            l.value = 'fr-FR'; l.dispatchEvent(new Event('change', { bubbles: true }));
          })()
        """, await_promise=False)
        time.sleep(1.5)

        stored = chrome.evaluate(sw_sid, "chrome.storage.local.get('prefs')")
        print(f"  stored: {json.dumps(stored)}", flush=True)
        p = (stored or {}).get("prefs", {})
        checks.add("preferences written to storage", bool(p), json.dumps(stored)[:120])
        checks.add("selectToCopy=false persisted", p.get("selectToCopy") is False)
        checks.add("timestamps=true persisted", p.get("timestamps") is True)
        checks.add("language persisted", p.get("lang") == "fr-FR", str(p.get("lang")))
        checks.add("copyToast persisted", p.get("copyToast") is False, str(p.get("copyToast")))
        checks.add("prefsOpen persisted", p.get("prefsOpen") is True, str(p.get("prefsOpen")))

        # Restart Chrome entirely and reopen the panel.
        chrome.kill()
        time.sleep(3)
        chrome2 = PipeChrome(PROFILE, extensions=[], fresh=False)
        chrome2.launch("about:blank")
        chrome2.send("Extensions.loadUnpacked", path=EXT)
        time.sleep(3)
        tid2, sid2 = chrome2.new_tab(f"http://127.0.0.1:{PORT}/player.html?clip={CLIP}")
        chrome2.wait_for_js(sid2, "window.__playerReady === true", timeout=30)
        for t in chrome2.targets():
            if t.get("type") == "page" and t.get("url", "").startswith("about:blank"):
                chrome2.send("Target.closeTarget", targetId=t["targetId"])
        time.sleep(0.5)
        chrome2.send("Target.activateTarget", targetId=tid2)
        w2 = chrome2.send("Browser.getWindowForTarget", targetId=tid2)
        chrome2.send("Browser.setWindowBounds", windowId=w2["windowId"],
                     bounds={"left": 40, "top": 40, "width": 1100, "height": 850,
                             "windowState": "normal"})
        time.sleep(1.5)

        panel2 = open_panel(chrome2)
        checks.add("side panel reopens after restart", bool(panel2))
        if panel2:
            psid2 = chrome2.attach(panel2["targetId"])
            chrome2.wait_for_js(psid2, "!!document.getElementById('recordBtn')", timeout=30)
            time.sleep(1.5)
            restored = chrome2.evaluate(psid2, """
            (() => ({
              selectToCopy: document.getElementById('selectToCopy').checked,
              timestamps: document.getElementById('tsToggle').checked,
              autoscroll: document.getElementById('autoscroll').checked,
              lang: document.getElementById('langSel').value,
              copyToast: document.getElementById('copyToast').checked,
              prefsOpen: !document.getElementById('prefsPanel').hidden,
            }))()
            """, await_promise=False)
            print(f"  restored: {json.dumps(restored)}", flush=True)
            checks.add("selectToCopy restored as OFF",
                       restored.get("selectToCopy") is False, json.dumps(restored))
            checks.add("timestamps restored as ON", restored.get("timestamps") is True)
            checks.add("autoscroll restored as OFF", restored.get("autoscroll") is False)
            checks.add("language restored", restored.get("lang") == "fr-FR",
                       str(restored.get("lang")))
            checks.add("copyToast restored as OFF", restored.get("copyToast") is False,
                       str(restored.get("copyToast")))
            checks.add("preferences panel reopens expanded",
                       restored.get("prefsOpen") is True, str(restored.get("prefsOpen")))

            # --- 5. window size is stored and applied --------------------
            print("\n=== WINDOW SIZE ===", flush=True)
            chrome2.evaluate(psid2, """
              chrome.storage.local.get('prefs').then(g => {
                const p = g.prefs || {};
                p.windowWidth = 640; p.windowHeight = 900;
                return chrome.storage.local.set({ prefs: p });
              }).then(() => 'ok')
            """)
            time.sleep(1)
            chrome2.evaluate(psid2, "document.getElementById('popoutBtn').click()",
                             await_promise=False)
            popped = None
            deadline = time.time() + 20
            while time.time() < deadline:
                popped = next((t for t in chrome2.targets()
                               if "view=window" in t.get("url", "")), None)
                if popped:
                    break
                time.sleep(0.5)
            checks.add("pop-out window opened", bool(popped))
            if popped:
                time.sleep(2.5)
                wsid = chrome2.attach(popped["targetId"])
                dims = chrome2.evaluate(wsid,
                                        "({ w: window.outerWidth, h: window.outerHeight })",
                                        await_promise=False)
                print(f"  window dims: {json.dumps(dims)}", flush=True)
                # Window managers adjust by a few pixels for decorations.
                checks.add("stored window width applied",
                           abs(dims.get("w", 0) - 640) <= 40, json.dumps(dims))
                checks.add("stored window height applied",
                           abs(dims.get("h", 0) - 900) <= 60, json.dumps(dims))
        chrome = chrome2
    finally:
        with open(os.path.join(HERE, "prefs_result.json"), "w") as f:
            json.dump({"checks": checks.items, "passed": checks.passed}, f, indent=2)
        try:
            chrome.kill()
        except Exception:
            pass
        httpd.shutdown()

    n_pass = sum(1 for c in checks.items if c["ok"])
    print("\n" + "=" * 56, flush=True)
    print(f"RESULT: {n_pass}/{len(checks.items)} checks passed — "
          f"{'PASS' if checks.passed else 'FAIL'}", flush=True)
    print("=" * 56, flush=True)
    sys.exit(0 if checks.passed else 1)


if __name__ == "__main__":
    main()
