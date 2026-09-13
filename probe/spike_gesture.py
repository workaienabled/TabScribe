"""Spike: does preserving the user gesture make the mic prompt actually appear?

Established by earlier spikes:
  * audioCapture cannot be optional — permissions.request() rejects with
    "Only permissions specified in the manifest may be requested".
  * getUserMedia in the side panel with no live user gesture is denied with
    NotAllowedError and NO prompt. That is the bug the user hit.

Hypothesis: calling getUserMedia synchronously inside the click handler (before
any await) preserves the gesture, so Chrome shows a real prompt.

This drives the REAL side panel opened by a REAL toolbar click, and clicks a
button with a native X11-style CDP mouse event, so the gesture is genuine.

Throwaway. Run with DISPLAY on a private Xvfb.
"""
import base64
import json
import os
import shutil
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
PROFILE = '/tmp/tabscribe-gesture-panel'
EXT = '/tmp/tabscribe-gesture-ext'


def record(findings, key, value):
    findings[key] = value
    (OUT / 'gesture-spike.json').write_text(json.dumps(findings, indent=2))
    print(f'{key}: {json.dumps(value)}', flush=True)


def unpacked_id(path):
    import hashlib
    digest = hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


def click(chrome, sid, element):
    rect = chrome.evaluate(sid, f"""(() => {{
      const r = document.getElementById('{element}').getBoundingClientRect();
      return {{x: r.x + r.width / 2, y: r.y + r.height / 2}};
    }})()""", await_promise=False)
    for kind in ('mousePressed', 'mouseReleased'):
        chrome.send('Input.dispatchMouseEvent', session_id=sid, type=kind,
                    button='left', clickCount=1, **rect)


def main():
    findings = {}
    if os.path.isdir(EXT):
        shutil.rmtree(EXT)
    shutil.copytree(ROOT / 'extension', EXT)
    manifest = json.loads(Path(EXT, 'manifest.json').read_text())
    manifest['permissions'] = sorted(set(manifest['permissions']) | {'audioCapture'})
    manifest.pop('optional_permissions', None)
    Path(EXT, 'manifest.json').write_text(json.dumps(manifest, indent=2))

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
        chrome.send('Extensions.loadUnpacked', path=EXT)
        time.sleep(2)
        tid, sid = chrome.new_tab(
            'data:text/html,<title>TabScribe test audio</title><h1>fixture</h1>')
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
        if not panel:
            raise SystemExit('side panel never opened')
        psid = chrome.attach(panel['targetId'])
        chrome.wait_for_js(psid, "!!document.getElementById('startBtn')", timeout=30)

        # Auto-accept the prompt so the spike can complete unattended. This ONLY
        # affects whether a prompt is answered, not whether one is raised, which
        # is the thing under test.
        # 'audioCapture' is not a valid PermissionDescriptor name; the web-facing
        # name is 'microphone'. grantPermissions takes the browser-level name.
        chrome.send('Browser.grantPermissions',
                    origin=f'chrome-extension://{unpacked_id(EXT)}',
                    permissions=['audioCapture'])

        # Case A: gesture-less, exactly what the shipped code does today.
        record(findings, 'A_no_gesture', chrome.evaluate(psid, """(async () => {
          await new Promise(r => setTimeout(r, 50));   // the awaits in start()
          try {
            const s = await navigator.mediaDevices.getUserMedia({audio: true});
            const label = s.getAudioTracks()[0]?.label;
            s.getTracks().forEach(t => t.stop());
            return {ok: true, label};
          } catch (e) { return {ok: false, name: String(e && e.name), message: String(e && e.message)}; }
        })()""", await_promise=True))

        # Case B: called synchronously inside a real click, before any await.
        chrome.evaluate(psid, """(() => {
          window.__B = 'pending';
          const b = document.createElement('button');
          b.id = 'gestureProbe';
          b.style.cssText = 'position:fixed;top:4px;left:4px;z-index:99999';
          b.textContent = 'go';
          b.addEventListener('click', () => {
            // Synchronous: the gesture is still live here.
            const p = navigator.mediaDevices.getUserMedia({audio: true});
            p.then((s) => {
              const label = s.getAudioTracks()[0]?.label;
              s.getTracks().forEach(t => t.stop());
              window.__B = {ok: true, label};
            }).catch((e) => {
              window.__B = {ok: false, name: String(e && e.name), message: String(e && e.message)};
            });
          });
          document.body.appendChild(b);
        })()""", await_promise=False)
        click(chrome, psid, 'gestureProbe')
        deadline = time.time() + 12
        result = 'pending'
        while time.time() < deadline:
            result = chrome.evaluate(psid, 'window.__B', await_promise=False)
            if result != 'pending':
                break
            time.sleep(0.3)
        record(findings, 'B_with_gesture', result)

        shot = chrome.send('Page.captureScreenshot', session_id=psid)['data']
        (OUT / 'gesture-panel.png').write_bytes(base64.b64decode(shot))
    finally:
        chrome.kill()

    print(json.dumps(findings, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
