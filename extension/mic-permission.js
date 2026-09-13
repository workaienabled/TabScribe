/**
 * Microphone permission page.
 *
 * This page exists because of a hard Chrome rule, measured rather than assumed
 * (probe/spike_grant_flow.py, probe/spike_real_grant.py on Chrome 151):
 *
 *   - `audioCapture` is a Chrome-App permission. Declaring it in an extension
 *     manifest produces "'audioCapture' is only allowed for packaged apps, but
 *     this is a extension." and grants nothing.
 *   - A side panel cannot raise the microphone prompt. getUserMedia there is
 *     rejected with NotAllowedError "Permission dismissed" and NO prompt is ever
 *     shown, which is how the panel came to announce a refusal the user was
 *     never asked for.
 *   - A normal extension page in a TAB can raise the prompt. Once the user
 *     allows it, the grant is stored against the extension's origin and the
 *     SIDE PANEL can then open the microphone with no prompt at all
 *     (measured: permissionState 'granted', a real stream).
 *
 * Google's own offscreen-user-media sample uses the same shape: prompt from a
 * tab, then capture from a surface that cannot prompt.
 *
 * The request runs synchronously inside the button's click handler, because the
 * prompt requires a live user activation.
 */
const el = {
  allow: document.getElementById('allowBtn'),
  skip: document.getElementById('skipBtn'),
  status: document.getElementById('grantStatus'),
};

function setStatus(text, isError) {
  el.status.textContent = text;
  el.status.classList.toggle('error', !!isError);
}

/** Tell the panel how this ended, so it can stop asking. */
async function report(outcome) {
  try {
    await chrome.storage.local.set({ micGrant: { outcome, at: Date.now() } });
  } catch (e) { /* the panel re-checks the real permission state anyway */ }
}

el.allow.addEventListener('click', () => {
  el.allow.disabled = true;
  setStatus('Waiting for Chrome…');
  // Synchronous inside the gesture: anything awaited first loses the activation
  // and Chrome refuses to show the prompt.
  let pending;
  try {
    pending = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    el.allow.disabled = false;
    setStatus(`Could not ask for the microphone: ${e && e.message ? e.message : e}`, true);
    return;
  }

  pending.then(async (stream) => {
    // The grant is what matters, not this stream. Release it immediately so the
    // recording indicator does not stay lit on a page about to close.
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch (e) { /* best effort */ }
    }
    await report('granted');
    setStatus('Microphone allowed. You can close this tab — TabScribe will use it '
      + 'automatically from now on.');
    el.allow.textContent = 'Allowed';
    // Closing immediately looks like a glitch; leave it readable for a moment.
    setTimeout(() => { window.close(); }, 1800);
  }, async (e) => {
    const name = String(e && e.name ? e.name : '');
    el.allow.disabled = false;
    if (name === 'NotAllowedError') {
      await report('denied');
      setStatus('Microphone not allowed. The meeting transcript is unaffected — only '
        + 'your own speech will be missing from saved files. You can allow it later '
        + 'from the address-bar icon.', true);
      return;
    }
    if (name === 'NotFoundError') {
      await report('no-device');
      setStatus('No microphone was found. Only the meeting audio will be saved.', true);
      return;
    }
    await report('failed');
    setStatus(`The microphone could not be started: ${e && e.message ? e.message : e}`, true);
  });
});

el.skip.addEventListener('click', async () => {
  await report('skipped');
  window.close();
});
