"""Behavior and layout checks in isolated Chrome, using explicit transcript fixtures.

These are UI tests, not recognition accuracy tests. Fixture text enters through
TabScribe's real pop-out handoff and renderer. e2e_full.py tests real recognition.
Run with DISPLAY pointing to a private Xvfb: python3 probe/ux_test.py shell
"""
import argparse
import base64
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time

from pipe_chrome import PipeChrome

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
OUT.mkdir(parents=True, exist_ok=True)


class UI:
    def __init__(self):
        # Not TemporaryDirectory: Chrome keeps writing into the profile for a
        # moment after kill(), and its automatic cleanup raced that, failing an
        # otherwise green run with "Directory not empty: 'Default'".
        self.profile = tempfile.mkdtemp(prefix='tabscribe-ux-')
        self.chrome = PipeChrome(self.profile, extra_args=['--enable-unsafe-extension-debugging'])
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

    def fixture(self, count=40, view='panel'):
        segments = [dict(key=f'0:{i}', text=f'Segment {i + 1}. We discussed the roadmap and agreed to review the release on Friday.',
                         isFinal=True, startedAt=i * 5000) for i in range(count)]
        payload = dict(snapshot=dict(epoch=0, segments=segments), resume=False)
        self.js(f"chrome.storage.session.set({{handoffSnapshot: {json.dumps(payload)}}})")
        old = self.tid
        self.tid, self.sid = self.chrome.new_tab(f'chrome-extension://{self.ext_id}/sidepanel.html?view=window')
        self.chrome.wait_for_js(self.sid, f"document.querySelectorAll('.seg').length === {count}")
        self.chrome.send('Target.closeTarget', targetId=old)
        if view == 'window':
            # Leave it as a genuine window-mode document, for tests about the
            # window itself rather than about panel layout.
            self.size(460, 780)
            return
        # Panel mode has to be a REAL panel document, not a window one with the
        # class stripped: IS_WINDOW is read from the URL, and it now decides what
        # the view-switch control does, not merely how the page is styled.
        #
        # A panel document restores from the autosave, not the hand-off snapshot
        # (only a window claims that), so stage the autosave instead.
        autosave = dict(snapshot=dict(epoch=0, segments=segments), savedText='')
        self.js(f"chrome.storage.session.set({{liveTranscript: {json.dumps(autosave)}}})")
        old = self.tid
        self.tid, self.sid = self.chrome.new_tab(f'chrome-extension://{self.ext_id}/sidepanel.html')
        self.chrome.wait_for_js(self.sid, "!!document.getElementById('recordBtn')", timeout=25)
        self.chrome.send('Target.closeTarget', targetId=old)
        self.chrome.wait_for_js(
            self.sid, f"document.querySelectorAll('.seg').length === {count}", timeout=25)
        self.size(360)

    def arm_capture(self):
        """Reload the panel with tab capture stubbed in, so Record runs fully.

        Installed before the document runs, because the panel arms on load.
        Without this the record path returns at the capture check and every
        assertion after it passes without exercising the code under test.
        """
        self.chrome.send('Page.enable', session_id=self.sid)
        self.chrome.send('Page.addScriptToEvaluateOnNewDocument', session_id=self.sid, source="""
          (() => {
            const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = (constraints) => {
              const isTab = !!(constraints && constraints.audio && constraints.audio.mandatory
                               && constraints.audio.mandatory.chromeMediaSource === 'tab');
              if (!isTab) return realGum(constraints);
              const ctx = new AudioContext();
              const dest = ctx.createMediaStreamDestination();
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              gain.gain.value = 0;
              osc.connect(gain); gain.connect(dest); osc.start();
              return Promise.resolve(dest.stream);
            };
            const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
            chrome.runtime.sendMessage = (msg, ...rest) => {
              if (msg && msg.type === 'GET_STREAM_ID') {
                return Promise.resolve({ok: true, streamId: 'test', tabId: 1, title: 'Test tab'});
              }
              return realSend(msg, ...rest);
            };
          })();
        """)
        self.chrome.send('Page.reload', session_id=self.sid)
        # The button enables before arming completes; wait for the status the
        # panel sets once it actually holds the tab.
        self.chrome.wait_for_js(
            self.sid,
            "!document.getElementById('recordBtn').disabled && "
            "/Press Record|Ready/.test(document.getElementById('status').textContent)",
            timeout=20)

    def delete_transcript(self, answer='confirmDeleteBtn'):
        """Press Delete, and answer the confirmation if one appears.

        Delete asks before destroying a transcript that is not on disk, so a
        test that only wants the transcript GONE has to answer the question.
        Suites about the question itself drive the controls directly instead.
        """
        self.js("document.getElementById('clearBtn').click()")
        time.sleep(0.15)
        self.js(f"""(() => {{
          const bar = document.getElementById('confirmBar');
          if (bar && !bar.hidden) document.getElementById('{answer}').click();
        }})()""")
        time.sleep(0.2)

    def download_and_read(self, directory, trigger='downloadBtn'):
        """Press a control that downloads, and return what reached disk.

        A fresh subdirectory per call, so an overwritten same-name file cannot be
        mistaken for a new download and a stale file cannot satisfy a later read.

        `trigger` names the control: Download itself, or any other control whose
        job includes writing the file (the delete confirmation's save-first
        action, for one) — the point is to read the REAL bytes either way.

        Downloading CLEARS the transcript, so a caller that keeps working with
        the text afterwards has to call undo_clear() and say so.
        """
        destination = Path(directory) / f'dl-{len(self.checks)}-{int(time.time() * 1000)}'
        destination.mkdir(parents=True)
        self.chrome.send('Browser.setDownloadBehavior', behavior='allow',
                         downloadPath=str(destination))
        self.js(f"document.getElementById('{trigger}').click()")
        for _ in range(40):
            files = [p for p in destination.iterdir() if p.suffix == '.txt']
            if files and files[0].stat().st_size > 0:
                return files[0].read_text()
            time.sleep(0.25)
        return ''

    def undo_clear(self):
        """Take back the delete a Download (or Delete) just performed.

        Download saves and clears in one press, so suites that carry on using
        the transcript restore it here rather than assuming it survived.
        """
        self.js("""(() => {
          const bar = document.getElementById('undoBar');
          if (bar && !bar.hidden) document.getElementById('undoClearBtn').click();
        })()""")
        time.sleep(0.3)

    def capture_store(self):
        # Test-only observation of the real store during a real render. No hooks
        # or fixtures are exposed by production code.
        self.js("""(async () => {
          const {TranscriptStore} = await import('./transcriber.js');
          const original = TranscriptStore.prototype.liveSegments;
          TranscriptStore.prototype.liveSegments = function() {
            window.fixtureStore = this;
            return original.call(this);
          };
          document.getElementById('tsToggle').dispatchEvent(new Event('change'));
          TranscriptStore.prototype.liveSegments = original;
        })()""")

    def cleanup(self):
        """Tear the browser down, then remove its profile without racing it."""
        self.chrome.kill()
        # kill() waits for exit, but the kernel may still be flushing its writes.
        for _ in range(20):
            shutil.rmtree(self.profile, ignore_errors=True)
            if not Path(self.profile).exists():
                return
            time.sleep(0.25)

    def finish(self, stage):
        self.cleanup()
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
      brand: !!document.querySelector('.brand-mark'),
      modeHidden: document.getElementById('cloudWarning')?.hidden,
      prefsPos: getComputedStyle(document.getElementById('prefsPanel')).position,
      chrome: (() => { const t=document.getElementById('transcript').getBoundingClientRect(); return t.height/innerHeight; })(),
      focusable: document.querySelector('#transcript').tabIndex,
      controls: ['copyBtn','downloadBtn','clearBtn'].map(id => document.getElementById(id).disabled),
    }))()""")
    ui.check('recognition status is announced accessibly', info['liveStatus'] == 'status', info)
    ui.check('transcript uses compact 13px type by default', info['readable'] == 13, info)
    ui.check('transcript dominates a typical side panel', info['chrome'] >= 0.62, info)
    ui.check('no decorative brand mark', not info['brand'])
    ui.check('on-device mode shows no cloud warning', info.get('modeHidden') is True, info)
    ui.check('preferences sit in the document flow', info['prefsPos'] != 'absolute', info)
    ui.check('transcript can receive keyboard focus', info['focusable'] == 0)
    ui.check('empty transcript actions are disabled', all(info['controls']))
    for w in [280, 300, 320, 340, 360, 430, 640]:
        ui.size(w, 620)
        fit = ui.js("""(() => {
          const rs = ['recordBtn','copyBtn','downloadBtn','clearScreenBtn','micStatusBtn','popoutBtn','prefsBtn'].map(id => document.getElementById(id).getBoundingClientRect());
          return {oneRow: Math.max(...rs.map(r=>r.top)) < Math.min(...rs.map(r=>r.bottom)),
            targets: rs.every(r=>r.height>=24 && r.width>=28),
            overflow: document.documentElement.scrollWidth > innerWidth};
        })()""")
        ui.check(f'top row fits at {w}px with usable targets', fit['oneRow'] and fit['targets'] and not fit['overflow'], fit)
    ui.size(300, 460)
    ui.js("document.getElementById('prefsBtn').click()")
    info = ui.js("""(() => {
      const p = document.getElementById('prefsPanel'), r = p.getBoundingClientRect();
      return {inside: r.top >= 0 && r.bottom <= innerHeight, scroll: ['auto','scroll'].includes(getComputedStyle(p).overflowY)};
    })()""")
    ui.check('settings stay reachable in short windows', info['inside'] and info['scroll'], info)
    ui.js("document.getElementById('prefsBtn').click()")
    ui.check('gear closes preferences', ui.js("document.getElementById('prefsPanel').hidden"))
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
    ui.check('system theme and 13px are defaults', defaults == {'theme':'system', 'size':'13'}, defaults)
    ui.js("""(() => {
      const t = document.getElementById('themeSel'); t.value = 'dark'; t.dispatchEvent(new Event('change'));
      const s = document.getElementById('fontSizeSel'); s.value = '17'; s.dispatchEvent(new Event('change'));
    })()""")
    ui.check('reading size applies immediately', ui.js("getComputedStyle(document.getElementById('transcript')).fontSize === '17px'"))
    dark = ui.js("getComputedStyle(document.body).backgroundColor")
    ui.js("document.getElementById('themeSel').value='light'; document.getElementById('themeSel').dispatchEvent(new Event('change'))")
    light = ui.js("getComputedStyle(document.body).backgroundColor")
    ui.check('light and dark themes actually differ', light != dark, {'light':light, 'dark':dark})
    time.sleep(.3)
    ui.chrome.kill()
    ui.chrome = PipeChrome(ui.profile, fresh=False, extra_args=['--enable-unsafe-extension-debugging'])
    ui.chrome.launch()
    ui.chrome.send('Extensions.loadUnpacked', path=str(ROOT / 'extension'))
    ui.tid, ui.sid = ui.chrome.new_tab(f'chrome-extension://{ui.ext_id}/sidepanel.html')
    ui.chrome.wait_for_js(ui.sid, "document.getElementById('fontSizeSel').value === '17'")
    ui.check('theme and text size survive Chrome restart', ui.js("document.getElementById('themeSel').value === 'light' && getComputedStyle(document.getElementById('transcript')).fontSize === '17px'"))
    ui.js("chrome.storage.local.set({prefs:{theme:'invalid', fontSize:9000, lang:'xx-XX', windowWidth:-5}})")
    ui.chrome.send('Page.reload', session_id=ui.sid)
    ui.chrome.wait_for_js(ui.sid, "document.getElementById('status').textContent.length > 0")
    ui.check('invalid stored choices fall back safely', ui.js("document.getElementById('themeSel').value === 'system' && getComputedStyle(document.getElementById('transcript')).fontSize === '13px'"))
    # Assert the validator itself, not only the rendered control: a select simply
    # ignores an unknown value, so the control alone would look correct even with
    # validation deleted entirely.
    rejected = ui.js("""(async () => {
      const prefs = await import('./prefs.js');
      const got = await prefs.load();
      return {lang: got.lang, theme: got.theme, size: got.fontSize, width: got.windowWidth};
    })()""", )
    ui.check('the validator rejects every invalid stored value, not just the visible ones',
             rejected == {'lang': 'en-US', 'theme': 'system', 'size': 13, 'width': 460}, rejected)


def navigation(ui):
    ui.fixture()
    ui.capture_store()
    ui.js("document.getElementById('transcript').scrollTop = 0")
    time.sleep(.2)
    ui.js("fixtureStore.update(80, 'New words arriving while you read older text.', true, 210000); document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    ui.check('new transcript text does not pull reader to bottom', ui.js("document.getElementById('transcript').scrollTop < 5"))
    available = ui.js("!!document.getElementById('jumpLatestBtn') && !document.getElementById('jumpLatestBtn').hidden")
    ui.check('jump-to-latest appears while reading history', available)
    if not available:
        return
    ui.js("document.getElementById('jumpLatestBtn').click()")
    ui.check('jump returns to latest text', ui.js("(() => { const t=document.getElementById('transcript'); return t.scrollHeight-t.scrollTop-t.clientHeight<5; })()"))
    ui.js("fixtureStore.update(81, 'More incoming words at the bottom.', true, 211000); document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    ui.check('following resumes after jump', ui.js("(() => { const t=document.getElementById('transcript'); return t.scrollHeight-t.scrollTop-t.clientHeight<5; })()"))
    ui.js("document.getElementById('autoscroll').checked=false; document.getElementById('autoscroll').dispatchEvent(new Event('change')); document.getElementById('transcript').scrollTop=0")
    time.sleep(.2)
    ui.js("fixtureStore.update(82, 'Auto-scroll is now turned off.', true, 212000); document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    ui.check('auto-scroll off remains respected', ui.js("document.getElementById('transcript').scrollTop < 5"))
    ui.js("document.getElementById('jumpLatestBtn').click()")
    ui.check('jump does not silently enable auto-scroll', ui.js("!document.getElementById('autoscroll').checked"))


def undo(ui):
    ui.fixture(3)
    ui.capture_store()
    ui.js("window.oldText=fixtureStore.toText()")
    ui.delete_transcript()
    ui.check('Clear still removes all transcript immediately', ui.js("document.querySelectorAll('.seg').length === 0 && fixtureStore.isEmpty()"))
    exists = ui.js("!!document.getElementById('undoClearBtn') && !document.getElementById('undoBar').hidden")
    ui.check('Clear offers a visible Undo', exists)
    if not exists:
        return
    ui.js("fixtureStore.update(0, 'New words since clearing.', false, 20000); document.getElementById('tsToggle').dispatchEvent(new Event('change')); document.getElementById('undoClearBtn').click()")
    ui.check('Undo recovers old text and preserves new text', ui.js("fixtureStore.toText() === oldText + ' New words since clearing.'"))
    ui.js("fixtureStore.update(0, 'New words finalized after undo.', true, 20000); document.getElementById('tsToggle').dispatchEvent(new Event('change'))")
    ui.check('live result keys still update correctly after Undo', ui.js("fixtureStore.toText() === oldText + ' New words finalized after undo.' && document.querySelectorAll('.seg').length === 4"))
    ui.check('Undo is single-use', ui.js("document.getElementById('undoBar').hidden"))
    ui.js("document.getElementById('copyToast').checked=false; document.getElementById('copyToast').dispatchEvent(new Event('change'))")
    ui.delete_transcript()
    ui.check('copy-toast preference cannot hide recovery action', ui.js("!document.getElementById('undoBar').hidden"))
    ui.js("document.getElementById('undoDismiss').click()")
    ui.check('dismiss leaves transcript cleared', ui.js("document.getElementById('undoBar').hidden && fixtureStore.isEmpty()"))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['shell', 'reading', 'navigation', 'undo'])
    args = parser.parse_args()
    ui = UI()
    try:
        globals()[args.stage](ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish(args.stage))
