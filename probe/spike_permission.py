"""Spike: what REALLY happens when the mic permission is requested?

No --use-fake-ui-for-media-stream here. That flag auto-accepts permission
prompts, which is precisely why the first mic test passed while the real
product path was reporting "permission was refused" without ever asking.

Questions:
  1. Does chrome.permissions.request() work outside a user gesture?
  2. Does it work inside one?
  3. What does getUserMedia do in a side-panel document with no grant?
  4. Is audioCapture even grantable as an optional permission here?

Throwaway. Run with DISPLAY on a private Xvfb.
"""
import json
import sys
import tempfile
import time
from pathlib import Path

from pipe_chrome import PipeChrome

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
OUT.mkdir(parents=True, exist_ok=True)


def record(findings, key, value):
    """Write findings as they arrive; a later hang must not lose earlier ones."""
    findings[key] = value
    (OUT / 'permission-spike.json').write_text(json.dumps(findings, indent=2))
    print(f'{key}: {json.dumps(value)}', flush=True)


def main():
    findings = {}
    with tempfile.TemporaryDirectory(prefix='tabscribe-perm-spike-') as tmp:
        # Deliberately NO media flags: this is the real user's situation.
        chrome = PipeChrome(str(Path(tmp) / 'profile'),
                            extra_args=['--enable-unsafe-extension-debugging'])
        chrome.launch()
        try:
            ext_id = chrome.send('Extensions.loadUnpacked', path=str(ROOT / 'extension'))['id']
            tid, sid = chrome.new_tab(f'chrome-extension://{ext_id}/sidepanel.html')
            chrome.wait_for_js(sid, "document.getElementById('status').textContent.length > 0")

            record(findings, 'manifest_declares_optional', chrome.evaluate(sid, """(() => {
              const m = chrome.runtime.getManifest();
              return {optional: m.optional_permissions || null, permissions: m.permissions};
            })()""", await_promise=False))

            record(findings, 'already_granted', chrome.evaluate(sid,
                "chrome.permissions.contains({permissions:['audioCapture']})", await_promise=True))

            # 1. Request with NO user gesture — this is what the shipped code does,
            #    because start() awaits several things before reaching the mic.
            record(findings, 'request_without_gesture', chrome.evaluate(sid, """(async () => {
              try {
                const granted = await chrome.permissions.request({permissions:['audioCapture']});
                return {ok: true, granted};
              } catch (e) {
                return {ok: false, error: String(e && e.message || e)};
              }
            })()""", await_promise=True))

            # 2. Are there any input devices at all on this machine?
            record(findings, 'devices', chrome.evaluate(sid, """(async () => {
              try {
                const d = await navigator.mediaDevices.enumerateDevices();
                return {count: d.filter(x => x.kind === 'audioinput').length,
                        kinds: d.map(x => x.kind)};
              } catch (e) { return {error: String(e)}; }
            })()""", await_promise=True))

            # 3. getUserMedia with no grant. Raced against a timer: with no grant
            #    Chrome raises a permission prompt, and on a headless display
            #    nothing will ever answer it, so the promise never settles.
            record(findings, 'getUserMedia_no_grant', chrome.evaluate(sid, """(async () => {
              const attempt = navigator.mediaDevices.getUserMedia({audio: true})
                .then((s) => {
                  const label = s.getAudioTracks()[0]?.label;
                  s.getTracks().forEach(t => t.stop());
                  return {ok: true, label};
                })
                .catch((e) => ({ok: false, name: String(e && e.name), message: String(e && e.message)}));
              const timeout = new Promise((r) => setTimeout(
                () => r({ok: false, hung: true, note: 'never settled — a prompt is waiting'}), 6000));
              return Promise.race([attempt, timeout]);
            })()""", await_promise=True))

            # 4. Request WITH a real user gesture, delivered as a native click.
            chrome.evaluate(sid, """(() => {
              window.__permResult = 'pending';
              const b = document.createElement('button');
              b.id = 'permProbe';
              b.textContent = 'grant';
              b.style.cssText = 'position:fixed;top:4px;left:4px;z-index:99999';
              b.addEventListener('click', () => {
                // Called synchronously in the gesture, exactly as the fix must.
                chrome.permissions.request({permissions:['audioCapture']})
                  .then(g => { window.__permResult = {granted: g}; })
                  .catch(e => { window.__permResult = {error: String(e && e.message || e)}; });
              });
              document.body.appendChild(b);
            })()""", await_promise=False)
            rect = chrome.evaluate(sid,
                "(() => { const r=document.getElementById('permProbe').getBoundingClientRect();"
                " return {x: r.x + r.width/2, y: r.y + r.height/2}; })()", await_promise=False)
            for kind in ('mousePressed', 'mouseReleased'):
                chrome.send('Input.dispatchMouseEvent', session_id=sid, type=kind,
                            button='left', clickCount=1, **rect)
            deadline = time.time() + 8
            result = 'pending'
            while time.time() < deadline:
                result = chrome.evaluate(sid, 'window.__permResult', await_promise=False)
                if result != 'pending':
                    break
                time.sleep(0.25)
            record(findings, 'request_with_gesture', result)
            record(findings, 'granted_after_gesture', chrome.evaluate(sid,
                "chrome.permissions.contains({permissions:['audioCapture']})", await_promise=True))
        finally:
            chrome.kill()

    (OUT / 'permission-spike.json').write_text(json.dumps(findings, indent=2))
    print(json.dumps(findings, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
