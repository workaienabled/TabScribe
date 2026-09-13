"""Spike: the correct microphone-permission flow for an extension.

Established:
  * audioCapture is a Chrome-App permission. In an extension it produces
    "'audioCapture' is only allowed for packaged apps, but this is a extension."
  * A side panel cannot show a microphone prompt (measured: NotAllowedError
    "Permission dismissed" with no prompt). Google's own offscreen-user-media
    sample says the same thing and prompts from a page opened in a TAB first.

So the question this answers, against real Chrome, with NO audioCapture in the
manifest:

  1. What does navigator.permissions.query({name:'microphone'}) report in the
     side panel before any grant?
  2. If the grant is obtained once from an extension page in a TAB, does it
     persist in the profile and serve the REAL side panel afterwards?

Step 1 runs with --use-fake-ui-for-media-stream purely to stand in for the user
clicking Allow on the prompt in that tab. Chrome is then restarted WITHOUT the
flag, so the final side-panel check sees only the persisted grant — the flag
cannot be what makes it pass.

Throwaway. Run with DISPLAY on a private Xvfb.
"""
import json
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipe_chrome import PipeChrome  # noqa: E402
from toolbar_click import click_toolbar_icon  # noqa: E402
from e2e_full import pin_extension  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
OUT.mkdir(parents=True, exist_ok=True)
PROFILE = '/tmp/tabscribe-grantflow-profile'
EXT = '/tmp/tabscribe-grantflow-ext'

PROBE = """(async () => {
  let state = 'unknown';
  try {
    const s = await navigator.permissions.query({name: 'microphone'});
    state = s.state;
  } catch (e) { state = 'query-failed: ' + e; }
  const attempt = navigator.mediaDevices.getUserMedia({audio: true})
    .then((s) => {
      const t = s.getAudioTracks()[0];
      const out = {ok: true, label: t && t.label};
      s.getTracks().forEach(x => x.stop());
      return out;
    })
    .catch((e) => ({ok: false, name: String(e && e.name), message: String(e && e.message)}));
  const timeout = new Promise((r) => setTimeout(
    () => r({ok: false, hung: true, note: 'never settled — a prompt is waiting'}), 7000));
  const gum = await Promise.race([attempt, timeout]);
  return {permissionState: state, getUserMedia: gum};
})()"""


def unpacked_id(path):
    import hashlib
    digest = hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


def record(findings, key, value):
    findings[key] = value
    (OUT / 'grant-flow-spike.json').write_text(json.dumps(findings, indent=2))
    print(f'{key}: {json.dumps(value)}', flush=True)


def open_side_panel(chrome):
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
    return panel


def main():
    findings = {}
    if os.path.isdir(EXT):
        shutil.rmtree(EXT)
    if os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE)
    shutil.copytree(ROOT / 'extension', EXT)

    # No audioCapture: that is the permission that triggers the warning.
    manifest = json.loads(Path(EXT, 'manifest.json').read_text())
    manifest['permissions'] = [p for p in manifest['permissions'] if p != 'audioCapture']
    manifest.pop('optional_permissions', None)
    Path(EXT, 'manifest.json').write_text(json.dumps(manifest, indent=2))
    record(findings, 'permissions', manifest['permissions'])
    ext_id = unpacked_id(EXT)

    # --- phase 0: side panel with no grant at all ---------------------------
    # The toolbar icon must be pinned BEFORE the run that clicks it, and Chrome
    # rewrites Preferences on exit, so the pin needs its own launch/quit cycle.
    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    time.sleep(3)
    chrome.kill()
    time.sleep(2)
    record(findings, 'pinned', pin_extension(PROFILE, ext_id))
    time.sleep(1)

    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    try:
        chrome.send('Extensions.loadUnpacked', path=EXT)
        time.sleep(2)
        panel = open_side_panel(chrome)
        record(findings, 'panel_opened_phase0', bool(panel))
        if panel:
            psid = chrome.attach(panel['targetId'])
            chrome.wait_for_js(psid, "!!document.getElementById('startBtn')", timeout=30)
            record(findings, 'phase0_side_panel_no_grant',
                   chrome.evaluate(psid, PROBE, await_promise=True))
    finally:
        chrome.kill()
    time.sleep(2)

    # --- phase 1: grant once from an extension page in a TAB ----------------
    # The fake UI stands in for the user pressing Allow on the real prompt.
    chrome = PipeChrome(PROFILE, extensions=[], fresh=False,
                        extra_args=['--use-fake-ui-for-media-stream'])
    chrome.launch('about:blank')
    try:
        chrome.send('Extensions.loadUnpacked', path=EXT)
        time.sleep(2)
        tid, sid = chrome.new_tab(f'chrome-extension://{ext_id}/sidepanel.html')
        chrome.wait_for_js(sid, "!!document.getElementById('startBtn')", timeout=30)
        record(findings, 'phase1_tab_grant', chrome.evaluate(sid, PROBE, await_promise=True))
    finally:
        chrome.kill()
    time.sleep(3)

    # --- phase 2: does the grant persist and serve the REAL side panel? -----
    # No media flags at all here: only the stored grant can make this pass.
    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    try:
        chrome.send('Extensions.loadUnpacked', path=EXT)
        time.sleep(2)
        panel = open_side_panel(chrome)
        record(findings, 'panel_opened_phase2', bool(panel))
        if panel:
            psid = chrome.attach(panel['targetId'])
            chrome.wait_for_js(psid, "!!document.getElementById('startBtn')", timeout=30)
            record(findings, 'phase2_side_panel_after_grant',
                   chrome.evaluate(psid, PROBE, await_promise=True))
    finally:
        chrome.kill()

    print(json.dumps(findings, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
