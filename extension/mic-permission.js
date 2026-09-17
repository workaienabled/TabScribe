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
import { MicTranscriber, MIC_MESSAGES, stopStream } from './mic.js';

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
  let timeout;
  try {
    return await Promise.race([
      chrome.storage.local.set({ micGrant: { outcome, at: Date.now() } }).then(() => true),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), 2000); }),
    ]);
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

let cancelled = false;
window.addEventListener('pagehide', () => { cancelled = true; });

el.allow.addEventListener('click', () => {
  cancelled = false;
  el.allow.disabled = true;
  setStatus('Waiting for Chrome…');
  // requestStream invokes getUserMedia synchronously and classifies both thrown
  // and asynchronous failures consistently with the panel's microphone path.
  MicTranscriber.requestStream().then(async (result) => {
    stopStream(result.stream);
    if (cancelled) return;
    // The permission result is already known. Storage only notifies the panel;
    // it must neither conceal a grant nor turn one into a permission failure.
    const outcome = result.ok ? 'Microphone allowed.'
      : `${MIC_MESSAGES[result.reason] || MIC_MESSAGES.failed} The meeting transcript is unaffected.`;
    el.allow.disabled = result.ok;
    if (result.ok) el.allow.textContent = 'Allowed';
    setStatus(outcome, !result.ok);
    const reported = await report(result.ok ? 'granted' : result.reason);
    if (cancelled) return;
    if (!reported) {
      setStatus(`${outcome} The panel could not be notified. Return to TabScribe and turn the microphone off and on in Preferences to retry.`, true);
      return;
    }
    if (!result.ok) return;
    setStatus('Microphone allowed. You can close this tab — TabScribe will use it '
      + 'automatically from now on.');
    setTimeout(() => { if (!cancelled) window.close(); }, 1800);
  });
});

el.skip.addEventListener('click', async () => {
  cancelled = true;
  setStatus('Microphone skipped. Notifying TabScribe…');
  if (!await report('skipped')) {
    setStatus('Microphone skipped. The panel could not be notified. Return to TabScribe and turn off the microphone in Preferences.', true);
    return;
  }
  window.close();
});
