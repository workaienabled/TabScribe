"""Spike: what does Chrome report when the extension is first loaded?

Opening the microphone page on first load has to fire EXACTLY once. Getting that
wrong is worse than not doing it: a tab that reopens on every browser start, or
on every dev reload, is the kind of thing people uninstall an extension over.

Questions, against real Chrome:

  1. What `reason` does chrome.runtime.onInstalled report for a first
     Extensions.loadUnpacked — 'install', or something else?
  2. What does it report when the same unpacked extension is reloaded?
  3. Does it fire again when Chrome restarts with the extension already there?
  4. Can the service worker read the microphone permission state at all? If it
     can, the page can be skipped when the grant already exists.

The listener writes to chrome.storage.local, because a service worker can go
dormant and its console is not observable afterwards.

Throwaway. Run with DISPLAY on a private Xvfb.
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
PROFILE = '/tmp/tabscribe-install-profile'
EXT = '/tmp/tabscribe-install-ext'

# Appended to the real background worker so the real registration order applies.
RECORDER = """

// --- spike instrumentation -------------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  const prev = (await chrome.storage.local.get('spikeEvents')).spikeEvents || [];
  prev.push({ event: 'onInstalled', reason: details.reason,
              previousVersion: details.previousVersion || null, at: Date.now() });
  await chrome.storage.local.set({ spikeEvents: prev });
});

chrome.runtime.onStartup.addListener(async () => {
  const prev = (await chrome.storage.local.get('spikeEvents')).spikeEvents || [];
  prev.push({ event: 'onStartup', at: Date.now() });
  await chrome.storage.local.set({ spikeEvents: prev });
});

// Can the worker see the microphone permission at all?
(async () => {
  let state = 'no-permissions-api';
  try {
    state = (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch (e) {
    state = 'query-threw: ' + (e && e.message ? e.message : e);
  }
  await chrome.storage.local.set({ spikeWorkerMicState: state });
})();
"""


def read_events(chrome, ext_id):
    """Read what the worker recorded, from an extension page."""
    tid, sid = chrome.new_tab(f'chrome-extension://{ext_id}/sidepanel.html')
    chrome.wait_for_js(sid, "!!document.getElementById('startBtn')", timeout=30)
    data = chrome.evaluate(sid, """(async () => {
      const got = await chrome.storage.local.get(['spikeEvents', 'spikeWorkerMicState']);
      return {events: got.spikeEvents || [], workerMicState: got.spikeWorkerMicState || null};
    })()""", await_promise=True)
    chrome.send('Target.closeTarget', targetId=tid)
    return data


def tabs_open(chrome):
    return [t.get('url', '') for t in chrome.targets() if t.get('type') == 'page']


def main():
    findings = {}
    for path in (EXT, PROFILE):
        if os.path.isdir(path):
            shutil.rmtree(path)
    shutil.copytree(ROOT / 'extension', EXT)
    worker = Path(EXT, 'background.js')
    worker.write_text(worker.read_text() + RECORDER)

    # --- 1. first load ------------------------------------------------------
    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    try:
        ext_id = chrome.send('Extensions.loadUnpacked', path=EXT)['id']
        time.sleep(3)
        findings['after_first_load'] = read_events(chrome, ext_id)
        findings['tabs_after_first_load'] = tabs_open(chrome)
    finally:
        chrome.kill()
    time.sleep(2)

    # --- 2. same profile, Chrome restarted ----------------------------------
    chrome = PipeChrome(PROFILE, extensions=[], fresh=False)
    chrome.launch('about:blank')
    try:
        # Unpacked extensions are not auto-restored by CDP launches, so load it
        # again: this is the "already installed, browser restarted" case.
        chrome.send('Extensions.loadUnpacked', path=EXT)
        time.sleep(3)
        findings['after_restart'] = read_events(chrome, ext_id)
    finally:
        chrome.kill()

    (OUT / 'install-event-spike.json').write_text(json.dumps(findings, indent=2))
    print(json.dumps(findings, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
