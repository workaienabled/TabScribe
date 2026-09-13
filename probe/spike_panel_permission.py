"""Spike: can the REAL side panel obtain the microphone, and does a prompt appear?

The previous spikes ran in an ordinary tab. This one opens the actual side panel
through the real toolbar click, with audioCapture as a REQUIRED permission, and
watches for a permission bubble on screen. That is the only configuration that
answers the user's actual question.

Questions:
  1. With audioCapture required, does getUserMedia resolve in the side panel?
  2. Is a permission prompt shown (screenshot + window list)?
  3. Does the tab transcription keep working regardless?

Throwaway. Run with DISPLAY on a private Xvfb.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipe_chrome import PipeChrome  # noqa: E402
from toolbar_click import click_toolbar_icon  # noqa: E402
from e2e_full import MODEL_CACHE, prepare_profile, graft_model_registration, pin_extension  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
OUT.mkdir(parents=True, exist_ok=True)
PROFILE = '/tmp/tabscribe-perm-panel'
EXT = '/tmp/tabscribe-perm-ext'


def record(findings, key, value):
    findings[key] = value
    (OUT / 'panel-permission-spike.json').write_text(json.dumps(findings, indent=2))
    print(f'{key}: {json.dumps(value)}', flush=True)


def unpacked_id(path):
    import hashlib
    digest = hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


def main():
    findings = {}
    if os.path.isdir(EXT):
        shutil.rmtree(EXT)
    shutil.copytree(ROOT / 'extension', EXT)
    manifest = json.loads(Path(EXT, 'manifest.json').read_text())
    manifest['permissions'] = sorted(set(manifest['permissions']) | {'audioCapture'})
    manifest.pop('optional_permissions', None)
    Path(EXT, 'manifest.json').write_text(json.dumps(manifest, indent=2))
    findings['permissions'] = manifest['permissions']

    ext_id = unpacked_id(EXT)
    prepare_profile(PROFILE, MODEL_CACHE)
    warm = PipeChrome(PROFILE, extensions=[], fresh=False)
    warm.launch('about:blank')
    time.sleep(3)
    warm.kill()
    time.sleep(2)
    pin_extension(PROFILE, ext_id)
    graft_model_registration(PROFILE, MODEL_CACHE)

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    try:
        chrome.launch('about:blank')
        loaded = chrome.send('Extensions.loadUnpacked', path=EXT)['id']
        findings['extension_id_matches'] = (loaded == ext_id)
        time.sleep(2)

        # click_toolbar_icon() finds the browser window by the fixture page's
        # title, so the tab must carry it.
        tid, sid = chrome.new_tab('data:text/html,<title>TabScribe test audio</title><h1>fixture</h1>')
        chrome.send('Target.activateTarget', targetId=tid)
        time.sleep(2)

        panel = None
        for _ in range(4):
            click_toolbar_icon()
            deadline = time.time() + 8
            while time.time() < deadline and not panel:
                for t in chrome.targets():
                    if 'sidepanel.html' in t.get('url', ''):
                        panel = t
                        break
                time.sleep(0.5)
            if panel:
                break
            time.sleep(1.5)
        findings['panel_opened'] = bool(panel)
        if not panel:
            raise SystemExit('side panel never opened')

        psid = chrome.attach(panel['targetId'])
        chrome.wait_for_js(psid, "!!document.getElementById('startBtn')", timeout=30)

        record(findings, 'granted_at_install', chrome.evaluate(
            psid, "chrome.permissions.contains({permissions:['audioCapture']})", await_promise=True))

        # Ask from inside the real side panel, racing a timer so a waiting prompt
        # is reported rather than hanging the spike.
        record(findings, 'getUserMedia_in_panel', chrome.evaluate(psid, """(async () => {
          const attempt = navigator.mediaDevices.getUserMedia({audio: true})
            .then((s) => {
              const t = s.getAudioTracks()[0];
              const out = {ok: true, label: t && t.label};
              s.getTracks().forEach(x => x.stop());
              return out;
            })
            .catch((e) => ({ok: false, name: String(e && e.name), message: String(e && e.message)}));
          const timeout = new Promise((r) => setTimeout(
            () => r({ok: false, hung: true, note: 'never settled — a prompt is waiting'}), 8000));
          return Promise.race([attempt, timeout]);
        })()""", await_promise=True))

        # What is actually on screen right now? Captured over CDP: ImageMagick's
        # `import` is not installed on this machine.
        try:
            shot = chrome.send('Page.captureScreenshot', session_id=psid)['data']
            import base64
            (OUT / 'permission-panel.png').write_bytes(base64.b64decode(shot))
            record(findings, 'screenshot', str(OUT / 'permission-panel.png'))
        except Exception as e:  # noqa: BLE001
            record(findings, 'screenshot', f'failed: {e}')

        windows = subprocess.run(['xdotool', 'search', '--name', '.'],
                                 capture_output=True, text=True, timeout=20).stdout.split()
        names = []
        for wid in windows[:40]:
            n = subprocess.run(['xdotool', 'getwindowname', wid],
                               capture_output=True, text=True, timeout=10).stdout.strip()
            if n:
                names.append(n)
        record(findings, 'window_names', names)
    finally:
        chrome.kill()

    (OUT / 'panel-permission-spike.json').write_text(json.dumps(findings, indent=2))
    print(json.dumps(findings, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
