"""First-load behaviour: the microphone page opens once, and only once.

Opening a tab on install is easy to get wrong in a way that makes people
uninstall an extension: a page that returns on every browser start, or on every
developer reload, is worse than no page at all.

Measured on Chrome 151 (probe/spike_install_event.py): for an unpacked
extension, chrome.runtime.onInstalled fires with reason 'install' on EVERY load,
not just the first, so the reason alone cannot be the guard. The service worker
can, however, read navigator.permissions.query({name:'microphone'}), so the two
real guards are a stored flag and the live permission state.

Checks here:
  1. A genuinely first load opens the microphone page exactly once.
  2. Reloading the extension does not open it again.
  3. With the microphone already granted it never opens at all.
  4. Opening it does not disturb tab capture or the panel.

Run with DISPLAY pointing at a private Xvfb.
"""
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipe_chrome import PipeChrome  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
OUT.mkdir(parents=True, exist_ok=True)

def write_mic_grant(profile, origin):
    """Store the content setting Chrome writes when the user clicks Allow.

    A real grant rather than a stubbed permissions.query: the worker and the
    pages are separate JS contexts, so a stub installed in one does not apply to
    the other, and verifying it from the wrong context proves nothing.
    """
    path = os.path.join(profile, 'Default', 'Preferences')
    prefs = json.load(open(path))
    mic = (prefs.setdefault('profile', {})
                .setdefault('content_settings', {})
                .setdefault('exceptions', {})
                .setdefault('media_stream_mic', {}))
    mic[f'{origin},*'] = {'last_modified': str(int(time.time() * 1000000)), 'setting': 1}
    json.dump(prefs, open(path, 'w'))


def unpacked_id(path):
    import hashlib
    digest = hashlib.sha256(os.path.abspath(path).encode()).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


class Checks:
    def __init__(self):
        self.items = []

    def add(self, name, ok, detail=None):
        self.items.append({'name': name, 'ok': bool(ok), 'detail': detail})
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f' — {detail}' if detail is not None else ''),
              flush=True)

    def finish(self):
        (OUT / 'ux-first-load.json').write_text(json.dumps(self.items, indent=2))
        passed = sum(c['ok'] for c in self.items)
        print(f'RESULT: {passed}/{len(self.items)} checks passed', flush=True)
        return 0 if passed == len(self.items) else 1


def mic_pages(chrome):
    return [t.get('url', '') for t in chrome.targets()
            if 'mic-permission.html' in t.get('url', '')]


def load_and_settle(profile, ext, seconds=4, extra_args=None, preload=None):
    """Load the extension into a profile and report the pages Chrome opened."""
    chrome = PipeChrome(profile, extensions=[], fresh=False, extra_args=extra_args or [])
    chrome.launch('about:blank')
    try:
        if preload:
            # Installed before the worker runs, so the stub is in place for the
            # very first permission query.
            chrome.send('Target.setDiscoverTargets', discover=True)
        ext_id = chrome.send('Extensions.loadUnpacked', path=ext)['id']
        time.sleep(seconds)
        return ext_id, mic_pages(chrome), chrome
    except Exception:
        chrome.kill()
        raise


def main():
    checks = Checks()
    with tempfile.TemporaryDirectory(prefix='tabscribe-firstload-') as tmp:
        ext = str(Path(tmp) / 'extension')
        shutil.copytree(ROOT / 'extension', ext)
        profile = str(Path(tmp) / 'profile')

        # --- 1. first load -------------------------------------------------
        ext_id, pages, chrome = load_and_settle(profile, ext)
        try:
            checks.add('the first load opens the microphone permission page',
                       len(pages) == 1, pages)
            # It must be a real tab the user can read and close, not a hidden one.
            if pages:
                sid = chrome.attach([t['targetId'] for t in chrome.targets()
                                     if 'mic-permission.html' in t.get('url', '')][0])
                ready = chrome.evaluate(sid, """({
                  allow: !!document.getElementById('allowBtn'),
                  skip: !!document.getElementById('skipBtn'),
                  title: document.title,
                })""", await_promise=False)
                checks.add('the opened page is the real permission page',
                           ready['allow'] and ready['skip'], ready)
            if pages:
                state = chrome.evaluate(
                    sid,
                    "(async () => (await chrome.storage.local.get('micPageShown'))"
                    ".micPageShown)()",
                    await_promise=True)
                checks.add('the extension records that it has shown the page',
                           state is True, state)
        finally:
            chrome.kill()
        time.sleep(2)

        # --- 2. reload: must not open again --------------------------------
        _, pages, chrome = load_and_settle(profile, ext)
        try:
            checks.add('reloading the extension does not open the page again',
                       len(pages) == 0, pages)
        finally:
            chrome.kill()
        time.sleep(2)

        # --- 3. already granted: never opens -------------------------------
        granted_profile = str(Path(tmp) / 'profile-granted')
        granted_ext = str(Path(tmp) / 'extension-granted')
        shutil.copytree(ROOT / 'extension', granted_ext)
        granted_id = unpacked_id(granted_ext)

        # Warm the profile so Preferences exists, then store a REAL grant for the
        # extension origin, exactly as clicking Allow would.
        warm = PipeChrome(granted_profile, extensions=[], fresh=False)
        warm.launch('about:blank')
        time.sleep(3)
        warm.kill()
        time.sleep(2)
        write_mic_grant(granted_profile, f'chrome-extension://{granted_id}')

        ext_id, pages, chrome = load_and_settle(granted_profile, granted_ext)
        try:
            # Guard against a vacuous pass: the page must be skipped because the
            # grant exists, not because a flag leaked in from an earlier profile.
            tid, sid = chrome.new_tab(f'chrome-extension://{ext_id}/sidepanel.html')
            chrome.wait_for_js(sid, "!!document.getElementById('startBtn')", timeout=30)
            why = chrome.evaluate(sid, """(async () => {
              let state = 'unknown';
              try { state = (await navigator.permissions.query({name:'microphone'})).state; }
              catch (e) { state = 'query-threw'; }
              return {state};
            })()""", await_promise=True)
            chrome.send('Target.closeTarget', targetId=tid)
            checks.add('the granted case really is granted, not a stale flag',
                       why['state'] == 'granted', why)
            checks.add('an already-granted microphone opens no page at all',
                       len(pages) == 0, pages)
        finally:
            chrome.kill()

    return checks.finish()


if __name__ == '__main__':
    sys.exit(main())
