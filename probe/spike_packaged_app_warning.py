"""Spike: the 'audioCapture is only allowed for packaged apps' warning.

The user loaded the extension and Chrome warned:
  "'audioCapture' is only allowed for packaged apps, but this is a extension."

So the previous fix was wrong: audioCapture is a Chrome-App permission, not an
extension one. This spike establishes, against real Chrome:

  1. Does the warning actually appear with audioCapture in `permissions`?
     (Read from chrome://extensions, whose UI is layered shadow DOM.)
  2. Does it disappear when the permission is removed?
  3. Without the permission, can the side panel still obtain the microphone —
     and does a prompt appear, or is it silently denied?
  4. Does an extension page opened in a normal TAB behave differently from the
     side panel? Permission is per-origin, so a grant obtained anywhere in
     chrome-extension://<id> should serve the panel too.

Throwaway. Run with DISPLAY on a private Xvfb.
"""
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

from pipe_chrome import PipeChrome

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
OUT.mkdir(parents=True, exist_ok=True)

# chrome://extensions is nested shadow DOM; walk every root to find the warning.
WARNING_PROBE = """(() => {
  const seen = new Set();
  const out = [];
  const walk = (root, depth) => {
    if (!root || depth > 12 || seen.has(root)) return;
    seen.add(root);
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      const text = (el.textContent || '').trim();
      if (text && /only allowed for|packaged app|Unrecognized|warning/i.test(text)
          && text.length < 400 && el.children.length === 0) {
        out.push(text);
      }
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
  };
  walk(document, 0);
  return Array.from(new Set(out));
})()"""


def build(tmp, name, permissions, drop_optional=True):
    ext = Path(tmp) / name
    shutil.copytree(ROOT / 'extension', ext)
    manifest = json.loads((ext / 'manifest.json').read_text())
    manifest['permissions'] = permissions
    if drop_optional:
        manifest.pop('optional_permissions', None)
    (ext / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    return str(ext)


def inspect(chrome, label, findings):
    tid, sid = chrome.new_tab('chrome://extensions')
    time.sleep(2.5)
    try:
        warnings = chrome.evaluate(sid, WARNING_PROBE, await_promise=False)
    except Exception as e:  # noqa: BLE001
        warnings = [f'probe failed: {e}']
    findings[label] = warnings
    print(f'{label}: {json.dumps(warnings)}', flush=True)
    (OUT / 'packaged-app-warning.json').write_text(json.dumps(findings, indent=2))
    chrome.send('Target.closeTarget', targetId=tid)


def mic_probe(chrome, sid):
    """getUserMedia raced against a timer, so an unanswered prompt is reported."""
    return chrome.evaluate(sid, """(async () => {
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
      return Promise.race([attempt, timeout]);
    })()""", await_promise=True)


def main():
    findings = {}
    with tempfile.TemporaryDirectory(prefix='tabscribe-pkgwarn-') as tmp:
        base = ['tabCapture', 'sidePanel', 'storage', 'activeTab']

        # --- 1. with the offending permission --------------------------------
        with_perm = build(tmp, 'with-audiocapture', base + ['audioCapture'])
        chrome = PipeChrome(str(Path(tmp) / 'profile-a'),
                            extra_args=['--enable-unsafe-extension-debugging'])
        chrome.launch()
        try:
            chrome.send('Extensions.loadUnpacked', path=with_perm)
            time.sleep(2)
            inspect(chrome, 'warnings_with_audioCapture', findings)
        finally:
            chrome.kill()

        # --- 2. without it ---------------------------------------------------
        without = build(tmp, 'without-audiocapture', base)
        chrome = PipeChrome(str(Path(tmp) / 'profile-b'),
                            extra_args=['--enable-unsafe-extension-debugging'])
        chrome.launch()
        try:
            ext_id = chrome.send('Extensions.loadUnpacked', path=without)['id']
            time.sleep(2)
            inspect(chrome, 'warnings_without_audioCapture', findings)

            # --- 3. the extension page in a normal tab ----------------------
            tid, sid = chrome.new_tab(f'chrome-extension://{ext_id}/sidepanel.html')
            chrome.wait_for_js(sid, "document.getElementById('status').textContent.length > 0")
            findings['tab_getUserMedia_no_grant'] = mic_probe(chrome, sid)
            print('tab_getUserMedia_no_grant:',
                  json.dumps(findings['tab_getUserMedia_no_grant']), flush=True)

            # --- 4. after a grant for the extension origin -------------------
            chrome.send('Browser.grantPermissions',
                        origin=f'chrome-extension://{ext_id}',
                        permissions=['audioCapture'])
            findings['tab_getUserMedia_after_grant'] = mic_probe(chrome, sid)
            print('tab_getUserMedia_after_grant:',
                  json.dumps(findings['tab_getUserMedia_after_grant']), flush=True)
            findings['permissions_contains_after_grant'] = chrome.evaluate(
                sid, "chrome.permissions.contains({permissions:['audioCapture']})",
                await_promise=True)
        finally:
            chrome.kill()

    (OUT / 'packaged-app-warning.json').write_text(json.dumps(findings, indent=2))
    print(json.dumps(findings, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
