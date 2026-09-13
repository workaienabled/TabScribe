"""Behavior and layout checks in isolated Chrome, using explicit transcript fixtures.

These are UI tests, not recognition accuracy tests. Fixture text enters through
TabScribe's real pop-out handoff and renderer. e2e_full.py tests real recognition.
Run with DISPLAY pointing to a private Xvfb: python3 probe/ux_test.py shell
"""
import argparse
import base64
import json
from pathlib import Path
import sys
import tempfile
import time

from pipe_chrome import PipeChrome

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'chatgpt'
OUT.mkdir(parents=True, exist_ok=True)


class UI:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='tabscribe-ux-')
        self.chrome = PipeChrome(self.temp.name, extra_args=['--enable-unsafe-extension-debugging'])
        self.chrome.launch()
        self.ext_id = self.chrome.send('Extensions.loadUnpacked', path=str(ROOT / 'extension'))['id']
        self.tid, self.sid = self.chrome.new_tab(f'chrome-extension://{self.ext_id}/sidepanel.html')
        self.chrome.wait_for_js(self.sid, "document.getElementById('status').textContent.length > 0")
        self.checks = []

    def js(self, expr):
        return self.chrome.evaluate(self.sid, expr)

    def check(self, name, ok, detail=None):
        item = dict(name=name, ok=bool(ok), detail=detail)
        self.checks.append(item)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f' — {detail}' if detail is not None else ''), flush=True)

    def size(self, width, height=720):
        self.chrome.send('Emulation.setDeviceMetricsOverride', session_id=self.sid,
                         width=width, height=height, deviceScaleFactor=1, mobile=False)
        time.sleep(.1)

    def shot(self, name):
        data = self.chrome.send('Page.captureScreenshot', session_id=self.sid)['data']
        p = OUT / f'{name}.png'
        p.write_bytes(base64.b64decode(data))
        return p

    def fixture(self, count=40):
        segments = [dict(key=f'0:{i}', text=f'Segment {i + 1}. We discussed the roadmap and agreed to review the release on Friday.',
                         isFinal=True, startedAt=i * 5000) for i in range(count)]
        payload = dict(snapshot=dict(epoch=0, segments=segments), resume=False)
        self.js(f"chrome.storage.session.set({{handoffSnapshot: {json.dumps(payload)}}})")
        old = self.tid
        self.tid, self.sid = self.chrome.new_tab(f'chrome-extension://{self.ext_id}/sidepanel.html?view=window')
        self.chrome.wait_for_js(self.sid, f"document.querySelectorAll('.seg').length === {count}")
        self.chrome.send('Target.closeTarget', targetId=old)
        # Exercise side-panel layout with the same real restored transcript.
        self.js("document.body.classList.remove('view-window')")
        self.size(360)

    def finish(self, stage):
        self.chrome.kill()
        self.temp.cleanup()
        (OUT / f'ux-{stage}.json').write_text(json.dumps(self.checks, indent=2))
        passed = sum(c['ok'] for c in self.checks)
        print(f'RESULT: {passed}/{len(self.checks)} checks passed', flush=True)
        return 0 if passed == len(self.checks) else 1


def shell(ui):
    ui.size(360)
    ui.shot('shell-before-or-after')
    info = ui.js("""(() => ({
      liveStatus: document.querySelector('#status').getAttribute('role'),
      readable: parseFloat(getComputedStyle(document.querySelector('#transcript')).fontSize),
      groups: document.querySelectorAll('#prefsPanel fieldset').length,
      mode: document.querySelector('#modeSummary')?.textContent,
      focusable: document.querySelector('#transcript').tabIndex,
      controls: ['copyBtn','downloadBtn','clearBtn'].map(id => document.getElementById(id).disabled),
    }))()""")
    ui.check('recognition status is announced accessibly', info['liveStatus'] == 'status', info)
    ui.check('transcript uses at least 16px type by default', info['readable'] >= 16)
    ui.check('preferences are grouped by purpose', info['groups'] >= 3)
    ui.check('recognition mode visible with settings closed', bool(info.get('mode')))
    ui.check('transcript can receive keyboard focus', info['focusable'] == 0)
    ui.check('empty transcript actions are disabled', all(info['controls']))
    for w in [280, 300, 320, 340, 360, 430, 640]:
        ui.size(w, 620)
        fit = ui.js("""(() => {
          const rs = ['startBtn','stopBtn','popoutBtn','prefsBtn'].map(id => document.getElementById(id).getBoundingClientRect());
          return {oneRow: Math.max(...rs.map(r=>r.top)) < Math.min(...rs.map(r=>r.bottom)),
            targets: rs.every(r=>r.height>=32 && r.width>=28),
            overflow: document.documentElement.scrollWidth > innerWidth};
        })()""")
        ui.check(f'top row fits at {w}px with usable targets', fit['oneRow'] and fit['targets'] and not fit['overflow'], fit)
    ui.size(300, 460)
    ui.js("document.getElementById('prefsBtn').click()")
    info = ui.js("""(() => {
      const p = document.getElementById('prefsPanel'), r = p.getBoundingClientRect();
      return {inside: r.top >= 0 && r.bottom <= innerHeight, scroll: ['auto','scroll'].includes(getComputedStyle(p).overflowY),
        close: !!document.querySelector('#prefsCloseBtn')};
    })()""")
    ui.check('settings stay reachable in short windows', info['inside'] and info['scroll'] and info['close'], info)
    if info['close']:
        ui.js("document.getElementById('prefsCloseBtn').click()")
        ui.check('closing preferences restores focus to gear', ui.js("document.getElementById('prefsPanel').hidden && document.activeElement.id === 'prefsBtn'"))
    ui.fixture(4)
    ui.js("document.querySelector('#transcript .seg').classList.add('interim')")
    ui.check('interim text is readable without italics', ui.js("getComputedStyle(document.querySelector('.seg.interim')).fontStyle === 'normal'"))
    ui.shot('shell-transcript')


def reading(ui):
    exists = ui.js("!!document.getElementById('themeSel') && !!document.getElementById('fontSizeSel')")
    ui.check('reading controls exist', exists)
    if not exists:
        return
    defaults = ui.js("({theme: document.getElementById('themeSel').value, size: document.getElementById('fontSizeSel').value})")
    ui.check('system theme and 16px are defaults', defaults == {'theme':'system', 'size':'16'}, defaults)
    ui.js("""(() => {
      const t = document.getElementById('themeSel'); t.value = 'dark'; t.dispatchEvent(new Event('change'));
      const s = document.getElementById('fontSizeSel'); s.value = '20'; s.dispatchEvent(new Event('change'));
    })()""")
    ui.check('reading size applies immediately', ui.js("getComputedStyle(document.getElementById('transcript')).fontSize === '20px'"))
    dark = ui.js("getComputedStyle(document.body).backgroundColor")
    ui.js("document.getElementById('themeSel').value='light'; document.getElementById('themeSel').dispatchEvent(new Event('change'))")
    light = ui.js("getComputedStyle(document.body).backgroundColor")
    ui.check('light and dark themes actually differ', light != dark, {'light':light, 'dark':dark})
    time.sleep(.3)
    ui.chrome.kill()
    ui.chrome = PipeChrome(ui.temp.name, fresh=False, extra_args=['--enable-unsafe-extension-debugging'])
    ui.chrome.launch()
    ui.chrome.send('Extensions.loadUnpacked', path=str(ROOT / 'extension'))
    ui.tid, ui.sid = ui.chrome.new_tab(f'chrome-extension://{ui.ext_id}/sidepanel.html')
    ui.chrome.wait_for_js(ui.sid, "document.getElementById('fontSizeSel').value === '20'")
    ui.check('theme and text size survive Chrome restart', ui.js("document.getElementById('themeSel').value === 'light' && getComputedStyle(document.getElementById('transcript')).fontSize === '20px'"))
    ui.js("chrome.storage.local.set({prefs:{theme:'invalid', fontSize:9000}})")
    ui.chrome.send('Page.reload', session_id=ui.sid)
    ui.chrome.wait_for_js(ui.sid, "document.getElementById('status').textContent.length > 0")
    ui.check('invalid stored choices fall back safely', ui.js("document.getElementById('themeSel').value === 'system' && getComputedStyle(document.getElementById('transcript')).fontSize === '16px'"))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['shell', 'reading'])
    args = parser.parse_args()
    ui = UI()
    try:
        globals()[args.stage](ui)
    except Exception:
        ui.chrome.kill()
        raise
    sys.exit(ui.finish(args.stage))
