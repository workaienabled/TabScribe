"""Manifest hygiene and the microphone grant flow, in real isolated Chrome.

This suite exists because the extension shipped with `audioCapture` in its
manifest, which Chrome rejects with:

    "'audioCapture' is only allowed for packaged apps, but this is a extension."

Two distinct things are checked:

  1. The manifest declares nothing Chrome will reject, and the extension loads
     with no install warnings — read from Chrome's own runtime, not by grepping
     the manifest, so a future packaged-app-only permission is caught too.
  2. The panel never calls getUserMedia in a surface that cannot prompt. Measured
     on Chrome 151 (probe/spike_real_grant.py): with the grant stored for the
     extension origin the side panel opens the microphone silently, but without
     it the request is auto-rejected as "Permission dismissed" and no prompt is
     shown. So the grant is obtained from a page in a TAB instead.

Run with DISPLAY pointing at a private Xvfb.
"""
import json
import sys
import time
from pathlib import Path

from ux_test import UI

ROOT = Path(__file__).resolve().parents[1]

# Permissions Chrome only honours for packaged apps / Chrome Apps. Declaring any
# of these in an extension manifest produces an install warning and grants
# nothing. Not exhaustive; these are the audio/video ones this project could
# plausibly reach for.
PACKAGED_APP_ONLY = {
    'audioCapture', 'videoCapture', 'audio', 'serial', 'usb', 'hid',
    'fileSystem', 'mediaGalleries', 'syncFileSystem', 'socket',
}


def manifest_hygiene(ui):
    manifest = ui.js("chrome.runtime.getManifest()")
    declared = set(manifest.get('permissions') or [])
    optional = set(manifest.get('optional_permissions') or [])
    offending = sorted((declared | optional) & PACKAGED_APP_ONLY)
    ui.check('the manifest declares no packaged-app-only permission',
             not offending,
             {'offending': offending, 'permissions': sorted(declared)})

    # Chrome's own verdict, not ours: install warnings are what the user saw.
    warnings = ui.js("""(async () => {
      try {
        const self_ = await new Promise((r) => chrome.management.getSelf(r));
        return {available: true, warnings: self_.installWarnings || null};
      } catch (e) {
        return {available: false, error: String(e && e.message || e)};
      }
    })()""")
    if warnings.get('available') and warnings.get('warnings') is not None:
        ui.check('Chrome reports no install warnings', not warnings['warnings'], warnings)
    else:
        # chrome.management is not held by this extension; fall back to the
        # runtime's own error channel, which is still Chrome's opinion.
        loaded = ui.js("({id: chrome.runtime.id, err: chrome.runtime.lastError || null})")
        ui.check('the extension loaded with a runtime id and no error',
                 bool(loaded['id']) and not loaded['err'], loaded)

    # The microphone is not requestable at runtime either, which is why the
    # grant has to come from a page that can prompt.
    requestable = ui.js("""(async () => {
      try { return {ok: true, granted: await chrome.permissions.request({permissions:['audioCapture']})}; }
      catch (e) { return {ok: false, error: String(e && e.message || e)}; }
    })()""")
    ui.check('audioCapture cannot be requested at runtime either',
             requestable['ok'] is False, requestable)


def grant_flow(ui):
    # The permission page must exist and be reachable as an extension page.
    page = ui.js("""(async () => {
      const url = chrome.runtime.getURL('mic-permission.html');
      const res = await fetch(url);
      const text = await res.text();
      return {url, ok: res.ok, hasAllow: /id="allowBtn"/.test(text),
              hasSkip: /id="skipBtn"/.test(text)};
    })()""")
    ui.check('the microphone permission page ships and is reachable',
             page['ok'] and page['hasAllow'] and page['hasSkip'], page)

    # The panel must read the real state rather than assume it.
    state = ui.js("""(async () => {
      const {MicTranscriber} = await import('./mic.js');
      return {state: await MicTranscriber.permissionState()};
    })()""")
    ui.check('the panel can read the microphone permission state without prompting',
             state['state'] in ('granted', 'denied', 'prompt', 'unknown'), state)

    # With no grant, the panel offers the page and does NOT claim a refusal.
    ui.js("""(() => {
      document.getElementById('prefsBtn').click();
      const box = document.getElementById('includeMic');
      box.checked = true; box.dispatchEvent(new Event('change'));
    })()""")
    time.sleep(.6)
    ungranted = ui.js("""({
      state: null,
      grantVisible: !document.getElementById('micGrantBtn').hidden,
      hint: document.getElementById('micHint').textContent,
      status: document.getElementById('status').textContent,
    })""")
    ui.check('without a grant the panel offers the Allow microphone button',
             ungranted['grantVisible'], ungranted)
    ui.check('without a grant the panel claims no refusal',
             'refus' not in ungranted['hint'].lower()
             and 'dismiss' not in ungranted['hint'].lower(), ungranted['hint'])
    ui.check('microphone wording never reaches the recognition status line',
             'microphone' not in ungranted['status'].lower(), ungranted['status'])

    # Pressing Start with no grant must not call getUserMedia at all.
    asked = ui.js("""(async () => {
      let calls = 0;
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (constraints) => {
        const isTab = !!(constraints && constraints.audio && constraints.audio.mandatory
                         && constraints.audio.mandatory.chromeMediaSource === 'tab');
        if (!isTab) calls += 1;
        return real(constraints);
      };
      document.getElementById('startBtn').click();
      await new Promise((r) => setTimeout(r, 700));
      navigator.mediaDevices.getUserMedia = real;
      return {calls, hint: document.getElementById('micHint').textContent};
    })()""")
    ui.check('Start never requests the microphone while the grant is missing',
             asked['calls'] == 0, asked)
    ui.check('and still claims no refusal afterwards',
             'refus' not in asked['hint'].lower()
             and 'dismiss' not in asked['hint'].lower(), asked['hint'])


if __name__ == '__main__':
    ui = UI()
    try:
        manifest_hygiene(ui)
        grant_flow(ui)
    except Exception:
        ui.cleanup()
        raise
    sys.exit(ui.finish('mic-grant'))
