/**
 * Optional microphone side-channel for the saved transcript.
 *
 * The product records the meeting from the tab. That misses the one voice the tab
 * never carries: the user's own. This module transcribes the microphone into a
 * SEPARATE store that is merged in only when the transcript is downloaded.
 *
 * Three rules define it, and every one of them is a deliberate constraint:
 *
 *  1. It is strictly additive. Tab capture, recognition, the audio graph and the
 *     live view do not know this exists. Nothing here can throw into a caller:
 *     every entry point resolves, and a failure disables the feature rather than
 *     surfacing as a broken Start. Measured in probe/spike_mic.py on Chrome 151:
 *     a second SpeechRecognition runs concurrently with the tab-audio one without
 *     disturbing it (bothRunning: true, no errors).
 *
 *  2. It never reaches the live view. The user asked for the mic in the saved
 *     file only, and that is also the honest choice: two independent recognizers
 *     produce no reliable relative ordering, so interleaving them on screen would
 *     imply a turn-taking accuracy this cannot deliver.
 *
 *  3. It never touches the speakers. The mic stream feeds recognition only —
 *     monitoring it would echo the user's own voice back at them.
 *
 * Interleaving in the saved file uses each segment's own elapsed-time offset, so
 * the two sources are ordered against a shared clock rather than against each
 * other's arrival. Both sides are labelled, because unlabelled merged speakers
 * would be worse than no merge at all.
 */
import { TranscriptStore, buildAudioGraph, getSpeechRecognition, formatClock } from './transcriber.js';

export const MIC_LABEL = 'You';
export const TAB_LABEL = 'Meeting';

/**
 * Name what actually went wrong, so the UI never invents a refusal.
 *
 * The distinction matters: "dismissed" means the user closed the prompt without
 * choosing, which is not the same as "denied", and neither is the same as having
 * no microphone attached. Saying "you refused" when the user was never asked is
 * the specific lie this replaces.
 */
export function classify(error) {
  const name = String(error && error.name ? error.name : '');
  const message = String(error && error.message ? error.message : error || '');
  if (name === 'NotAllowedError') {
    // Chrome reuses this one error for several situations. Measured on Chrome
    // 151: a request with no live user gesture also arrives as "Permission
    // dismissed", so it is deliberately not distinguished here — the gesture is
    // guaranteed by the caller instead (see sidepanel.js start({gesture})).
    if (/dismiss/i.test(message)) return 'dismissed';
    return 'denied';
  }
  if (name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device';
  if (name === 'NotReadableError' || name === 'AbortError') return 'device-busy';
  return 'failed';
}

/** Release a stream without ever throwing. */
export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch (e) { /* best effort */ }
  }
}

/** What to tell the user for each failure, in their terms. */
export const MIC_MESSAGES = {
  denied: 'Chrome is blocking the microphone for this extension. Allow it from the '
        + 'address-bar camera icon, or in Settings → Privacy → Site settings → Microphone.',
  dismissed: 'The microphone request was dismissed, so your own speech is not being saved.',
  'no-device': 'No microphone was found, so only the meeting audio is being saved.',
  'device-busy': 'The microphone is in use by another app, so only the meeting audio is being saved.',
  unsupported: 'This browser cannot transcribe the microphone.',
  failed: 'The microphone could not be started, so only the meeting audio is being saved.',
};

export class MicTranscriber {
  constructor({ onStateChange = () => {} } = {}) {
    this.store = new TranscriptStore();
    this.onStateChange = onStateChange;
    this.stream = null;
    // A getUserMedia call that has not resolved yet. Tracked so that stopping
    // the microphone while a permission prompt is still open releases whatever
    // arrives afterwards, instead of leaving the recording indicator lit.
    this.pendingStream = null;
    this.discarded = false;
    this.graph = null;
    this.recognition = null;
    this.running = false;
    this.stopping = false;
    this.t0 = 0;
    this.lastError = null;
    this.options = { lang: 'en-US', processLocally: true };
  }

  /**
   * Is a microphone usable at all? Never prompts and never throws; a browser
   * without enumerateDevices, or one that reports nothing, simply answers false.
   */
  static async hasMicrophone() {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices?.();
      return Array.isArray(devices) && devices.some((d) => d.kind === 'audioinput');
    } catch (e) {
      return false;
    }
  }

  /**
   * Open the microphone. MUST be called synchronously from a user gesture.
   *
   * Measured on Chrome 151 (probe/spike_permission.py): in a side panel with no
   * live user gesture, getUserMedia is rejected with NotAllowedError and NO
   * prompt is ever shown. Awaiting anything before this call silently converts
   * "ask the user" into "refuse the user", which is exactly the bug this fixes.
   * So the caller grabs the stream first, then does its async work.
   *
   * Resolves to {ok, stream} or {ok:false, reason, error}. Never rejects.
   */
  static requestStream() {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        return Promise.resolve({ ok: false, reason: 'unsupported',
                                 error: 'This browser exposes no microphone API.' });
      }
      // Echo cancellation matters here: the tab's audio is playing through the
      // speakers, and without it the meeting's voices are picked up twice.
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }).then(
        (stream) => ({ ok: true, stream }),
        (e) => ({ ok: false, reason: classify(e), error: String(e && e.message ? e.message : e) }),
      );
    } catch (e) {
      return Promise.resolve({ ok: false, reason: classify(e),
                               error: String(e && e.message ? e.message : e) });
    }
  }

  /**
   * Open the microphone and keep ownership of the in-flight request.
   *
   * Instance method so that stop() can release a stream that arrives after the
   * user has already changed their mind: the prompt is answered by a human and
   * can stay open for as long as they like.
   */
  open() {
    this.discarded = false;
    return MicTranscriber.requestStream().then((res) => {
      if (res.ok && this.discarded) {
        stopStream(res.stream);
        return { ok: false, reason: 'cancelled', error: 'Cancelled before it started.' };
      }
      if (res.ok) this.pendingStream = res.stream;
      return res;
    });
  }

  /**
   * Begin transcribing an already-open microphone stream.
   *
   * Resolves to {ok} or {ok:false, reason, error}. It never rejects: the caller
   * is in the middle of starting the real transcription and a microphone problem
   * must not become a tab-capture failure.
   */
  async start(stream, { lang = 'en-US', processLocally = true, t0 = 0 } = {}) {
    if (this.discarded) {
      // Turned off while the prompt was open; do not open a live microphone now.
      stopStream(stream);
      this.pendingStream = null;
      return { ok: false, reason: 'cancelled', error: 'Cancelled before it started.' };
    }
    this.pendingStream = null;
    // this.running only becomes true inside rec.onstart, which fires in a later
    // task, so it cannot guard against a second start() in the same tick. The
    // recognizer is assigned synchronously by _attach(), so test that instead —
    // otherwise two calls each build a graph and leak a live microphone.
    if (this.running || this.recognition) {
      stopStream(stream);
      return { ok: true };
    }
    this.options = { lang, processLocally };
    this.lastError = null;
    this.stopping = false;

    try {
      const SR = getSpeechRecognition();
      if (!SR) {
        stopStream(stream);
        return { ok: false, reason: 'unsupported', error: 'Speech recognition is unavailable.' };
      }
      this.stream = stream;
      if (!stream || !stream.getAudioTracks().length) {
        throw new Error('The microphone produced no audio track.');
      }

      // monitor:false — recognition only. Playing the mic back would echo.
      this.graph = buildAudioGraph(this.stream, { monitor: false });
      // Share the meeting's clock origin. Without it a microphone attached late
      // (mid-session re-tick) times its first line from ITS start, which sorts
      // the user's turns to the top of the merged file instead of where they
      // were actually spoken.
      this.t0 = t0 || Date.now();
      this.store.newEpoch();
      this._attach(SR, this.graph.track);
      return { ok: true };
    } catch (e) {
      await this.stop({ flushMs: 0 });
      return { ok: false, reason: classify(e),
               error: String(e && e.message ? e.message : e) };
    }
  }

  _attach(SR, track) {
    const rec = new SR();
    rec.lang = this.options.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.processLocally = this.options.processLocally;
    this.recognition = rec;

    rec.onresult = (event) => {
      const elapsed = Date.now() - this.t0;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        // Interim results are kept for the same reason the tab store keeps them:
        // the closing sentence is often still interim when recognition ends.
        this.store.update(i, result[0].transcript, result.isFinal, elapsed);
      }
    };

    rec.onerror = (event) => {
      this.lastError = event.error;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // Permission was revoked mid-session. Give up quietly; the meeting
        // transcript continues untouched.
        this.running = false;
        this.onStateChange({ running: false, error: 'Microphone access was withdrawn.' });
      }
    };

    rec.onend = () => {
      if (this.stopping || !this.running) {
        this.running = false;
        this.onStateChange({ running: false });
        return;
      }
      if (this.lastError === 'not-allowed' || this.lastError === 'service-not-allowed' ||
          this.lastError === 'language-not-supported') {
        this.running = false;
        this.onStateChange({ running: false });
        return;
      }
      if (!track || track.readyState !== 'live') {
        this.running = false;
        this.onStateChange({ running: false });
        return;
      }
      // Same restart discipline as the tab recognizer; a new recognizer instance
      // restarts result indices at zero, so the epoch must advance with it.
      try {
        this.store.newEpoch();
        this._attach(SR, track);
      } catch (e) {
        this.running = false;
        this.onStateChange({ running: false, error: String(e && e.message ? e.message : e) });
      }
    };

    rec.onstart = () => {
      this.running = true;
      this.onStateChange({ running: true });
    };

    rec.start(track);
  }

  /** Stop recognition and release the microphone. Never throws. */
  async stop({ flushMs = 800 } = {}) {
    // Any request still in flight must not come back and open a live microphone.
    this.discarded = true;
    // Release before any await: otherwise a stop() that is still awaiting the
    // graph teardown can come back and stop a stream a LATER open() acquired,
    // leaving a dead microphone the UI believes is working.
    if (this.pendingStream) {
      stopStream(this.pendingStream);
      this.pendingStream = null;
    }
    this.stopping = true;
    if (this.running && flushMs > 0) {
      await new Promise((r) => setTimeout(r, flushMs));
    }
    const rec = this.recognition;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onstart = null;
      try { rec.stop(); } catch (e) {
        try { rec.abort(); } catch (e2) { /* already gone */ }
      }
    }
    this.recognition = null;
    this.running = false;

    try { await this.graph?.cleanup(); } catch (e) { /* best effort */ }
    this.graph = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        try { t.stop(); } catch (e) { /* best effort */ }
      }
    }
    this.stream = null;
    this.onStateChange({ running: false });
  }

  hasText() {
    return !this.store.isEmpty();
  }

  /** Drop captured microphone text without disturbing the meeting transcript. */
  clear() {
    this.store.clear();
  }
}

/**
 * Merge tab and microphone transcripts for the saved file.
 *
 * Ordering is by each segment's elapsed offset from its own session start. Both
 * recognizers are started within the same Start, so those clocks share an origin
 * closely enough to order turns; they are not sample-accurate, and nothing here
 * pretends otherwise.
 *
 * With no microphone text this returns the tab transcript unchanged, byte for
 * byte, so the ordinary path cannot be altered by this feature being present.
 */
export function mergeTranscripts(tabStore, micStore, { timestamps = false } = {}) {
  const plain = tabStore.toText({ timestamps });
  if (!micStore || micStore.isEmpty()) return plain;

  const rows = [
    ...tabStore.liveSegments().map((s) => ({ at: s.startedAt || 0, who: TAB_LABEL, text: s.text.trim() })),
    ...micStore.liveSegments().map((s) => ({ at: s.startedAt || 0, who: MIC_LABEL, text: s.text.trim() })),
  ].filter((r) => r.text);
  if (!rows.length) return plain;

  // A stable sort keeps same-instant segments in source order (tab first, since
  // it is listed first above) rather than shuffling them unpredictably.
  rows.sort((a, b) => a.at - b.at);

  const lines = [];
  for (const row of rows) {
    const stamp = timestamps ? `[${formatClock(row.at)}] ` : '';
    lines.push(`${stamp}${row.who}: ${row.text}`);
  }
  return lines.join('\n');
}
