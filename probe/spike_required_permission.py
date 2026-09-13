"""Spike: does audioCapture as a REQUIRED manifest permission actually work?

The optional-permission route is dead: chrome.permissions.request() rejects with
"Only permissions specified in the manifest may be requested" because
audioCapture is not requestable at runtime, and a side panel cannot show a
getUserMedia prompt either — it just hangs or is denied.

An extension that declares audioCapture in `permissions` is granted it at
INSTALL time, so getUserMedia should succeed with no prompt at all. This checks
that against a temporary copy of the extension, without touching the real one.

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


def main():
    findings = {}
    with tempfile.TemporaryDirectory(prefix='tabscribe-required-perm-') as tmp:
        # Copy the extension and promote audioCapture to a required permission.
        ext = Path(tmp) / 'extension'
        shutil.copytree(ROOT / 'extension', ext)
        manifest = json.loads((ext / 'manifest.json').read_text())
        manifest['permissions'] = sorted(set(manifest['permissions']) | {'audioCapture'})
        manifest.pop('optional_permissions', None)
        (ext / 'manifest.json').write_text(json.dumps(manifest, indent=2))
        findings['manifest_under_test'] = manifest['permissions']

        chrome = PipeChrome(str(Path(tmp) / 'profile'),
                            extra_args=['--enable-unsafe-extension-debugging'])
        chrome.launch()
        try:
            ext_id = chrome.send('Extensions.loadUnpacked', path=str(ext))['id']
            tid, sid = chrome.new_tab(f'chrome-extension://{ext_id}/sidepanel.html')
            chrome.wait_for_js(sid, "document.getElementById('status').textContent.length > 0")

            findings['granted_at_install'] = chrome.evaluate(sid,
                "chrome.permissions.contains({permissions:['audioCapture']})", await_promise=True)

            # The real question: does getUserMedia resolve with no prompt?
            findings['getUserMedia'] = chrome.evaluate(sid, """(async () => {
              const attempt = navigator.mediaDevices.getUserMedia({audio: true})
                .then((s) => {
                  const t = s.getAudioTracks()[0];
                  const out = {ok: true, label: t && t.label, state: t && t.readyState};
                  s.getTracks().forEach(x => x.stop());
                  return out;
                })
                .catch((e) => ({ok: false, name: String(e && e.name), message: String(e && e.message)}));
              const timeout = new Promise((r) => setTimeout(
                () => r({ok: false, hung: true, note: 'never settled — a prompt is waiting'}), 8000));
              return Promise.race([attempt, timeout]);
            })()""", await_promise=True)

            # And does the real MicTranscriber start against it?
            findings['mic_transcriber_start'] = chrome.evaluate(sid, """(async () => {
              const {MicTranscriber} = await import('./mic.js');
              const m = new MicTranscriber();
              const started = await Promise.race([
                m.start({lang: 'en-US', processLocally: true}),
                new Promise((r) => setTimeout(() => r({ok: false, hung: true}), 9000)),
              ]);
              await m.stop({flushMs: 0});
              return started;
            })()""", await_promise=True)
        finally:
            chrome.kill()

    (OUT / 'required-permission-spike.json').write_text(json.dumps(findings, indent=2))
    print(json.dumps(findings, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
