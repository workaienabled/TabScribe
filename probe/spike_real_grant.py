"""Spike: does a REAL persisted mic grant reach the side panel?

The previous spike granted via --use-fake-ui-for-media-stream, which auto-accepts
the prompt WITHOUT writing a content setting, so nothing survived the restart and
phase 2 was inconclusive.

This writes the content setting Chrome itself writes when a user clicks Allow
(profile Preferences → profile.content_settings.exceptions.media_stream_mic, keyed
by the extension origin) and then asks the REAL side panel, with no media flags at
all. That isolates the one question that decides the design:

    once the user has allowed the microphone for chrome-extension://<id>,
    can the SIDE PANEL open it without a prompt?

If yes: prompt once from an extension page in a tab (Google's own
offscreen-user-media sample does exactly this), then the panel works forever.
If no: the microphone cannot live in the side panel at all.

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
PROFILE = '/tmp/tabscribe-realgrant-profile'
EXT = '/tmp/tabscribe-realgrant-ext'

PROBE = """(async () => {
  let state = 'unknown';
  try {
    state = (await navigator.permissions.query({name: 'microphone'})).state;
  } catch (e) { state = 'query-failed'; }
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
  return {permissionState: state, getUserMedia: await Promise.race([attempt, timeout])};
})()"""


def unpacked_id(path):
    import hashlib
    digest = hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


def record(findings, key, value):
    findings[key] = value
    (OUT / 'real-grant-spike.json').write_text(json.dumps(findings, indent=2))
    print(f'{key}: {json.dumps(value)}', flush=True)


def write_mic_grant(profile, origin):
    """Write the content setting Chrome stores when the user clicks Allow."""
    path = os.path.join(profile, 'Default', 'Preferences')
    prefs = json.load(open(path))
    exceptions = (prefs.setdefault('profile', {})
                       .setdefault('content_settings', {})
                       .setdefault('exceptions', {}))
    mic = exceptions.setdefault('media_stream_mic', {})
    # Chrome keys these as "<origin>,*" and 1 == ALLOW.
    mic[f'{origin},*'] = {
        'last_modified': str(int(time.time() * 1000000)),
        'setting': 1,
    }
    json.dump(prefs, open(path, 'w'))
    return list(mic.keys())


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
    for path in (EXT, PROFILE):
        if os.path.isdir(path):
            shutil.rmtree(path)
    shutil.copytree(ROOT / 'extension', EXT)
    manifest = json.loads(Path(EXT, 'manifest.json').read_text())
    manifest['permissions'] = [p for p in manifest['permissions'] if p != 'audioCapture']
    manifest.pop('optional_permissions', None)
    Path(EXT, 'manifest.json').write_text(json.dumps(manifest, indent=2))
    ext_id = unpacked_id(EXT)
    origin = f'chrome-extension://{ext_id}'
    record(findings, 'origin', origin)

    # Warm the profile so Preferences exists, then pin and write the grant.
    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    time.sleep(3)
    chrome.kill()
    time.sleep(2)
    record(findings, 'pinned', pin_extension(PROFILE, ext_id))
    record(findings, 'grant_written', write_mic_grant(PROFILE, origin))
    time.sleep(1)

    # No media flags: only the stored grant can make this pass.
    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    try:
        chrome.send('Extensions.loadUnpacked', path=EXT)
        time.sleep(2)

        # An extension page in a normal tab, for comparison.
        tid, sid = chrome.new_tab(f'{origin}/sidepanel.html')
        chrome.wait_for_js(sid, "!!document.getElementById('startBtn')", timeout=30)
        record(findings, 'tab_with_stored_grant',
               chrome.evaluate(sid, PROBE, await_promise=True))
        chrome.send('Target.closeTarget', targetId=tid)

        # The real side panel, opened by a real toolbar click.
        panel = open_side_panel(chrome)
        record(findings, 'panel_opened', bool(panel))
        if panel:
            psid = chrome.attach(panel['targetId'])
            chrome.wait_for_js(psid, "!!document.getElementById('startBtn')", timeout=30)
            record(findings, 'side_panel_with_stored_grant',
                   chrome.evaluate(psid, PROBE, await_promise=True))
    finally:
        chrome.kill()

    print(json.dumps(findings, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
