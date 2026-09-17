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
  'device-busy': 'The microphone is busy or unavailable, so only the meeting audio is being saved.',
  unsupported: 'This browser cannot transcribe the microphone.',
  ended: 'The microphone disconnected or stopped. Your own speech is no longer being saved.',
  'language-not-supported': 'Chrome cannot transcribe the microphone in the selected language and recognition mode.',
  'service-not-allowed': 'Chrome blocked the microphone speech-recognition service.',
  network: 'Microphone speech recognition stopped after repeated network errors.',
  'audio-capture': 'Chrome could not capture microphone audio.',
  'restart-failed': 'Microphone speech recognition could not restart.',
  'start-timeout': 'Chrome did not start microphone speech recognition within 15 seconds.',
  'restart-limit': 'Microphone speech recognition repeatedly ended without starting or hearing speech.',
  'no-speech': 'Microphone speech recognition repeatedly ended without hearing speech.',
  failed: 'The microphone could not be started, so only the meeting audio is being saved.',
};

export class MicTranscriber {
  constructor({ onStateChange = () => {}, onUpdate = () => {} } = {}) {
    this.store = new TranscriptStore();
    this.onStateChange = onStateChange;
    this.onUpdate = onUpdate;
    this.stream = null;
    // A getUserMedia call that has not resolved yet. Tracked so that stopping
    // the microphone while a permission prompt is still open releases whatever
    // arrives afterwards, instead of leaving the recording indicator lit.
    this.pendingStream = null;
    this.discarded = false;
    this.requestId = 0;
    this.generation = 0;
    this.failedRestarts = 0;
    this.retryTimer = null;
    this.startTimer = null;
    this.sourceEnded = null;
    this.graph = null;
    this.recognition = null;
    this.running = false;
    this.stopping = false;
    this.t0 = 0;
    this.lastError = null;
    this.options = { lang: 'en-US', processLocally: true };
  }

  /**
   * Never prompts or throws. true/false means enumeration succeeded; null means
   * it failed or is unavailable, not evidence that no microphone exists.
   */
  static async hasMicrophone() {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices?.();
      return Array.isArray(devices) ? devices.some((d) => d.kind === 'audioinput') : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Has the user already allowed the microphone for this extension's origin?
   *
   * Returns 'granted' | 'denied' | 'prompt' | 'unknown'. Never prompts, never
   * throws. This is what lets the panel avoid calling getUserMedia at all in a
   * surface that cannot show a prompt: a request in state 'prompt' would be
   * auto-rejected as "Permission dismissed" and look like a refusal the user
   * never made.
   */
  static async permissionState() {
    try {
      const status = await navigator.permissions.query({ name: 'microphone' });
      return status.state;
    } catch (e) {
      return 'unknown';
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
    const requestId = ++this.requestId;
    stopStream(this.pendingStream);
    this.pendingStream = null;
    return MicTranscriber.requestStream().then((res) => {
      if (requestId !== this.requestId || this.discarded) {
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
    if (!this.stopping && (this.running || this.recognition || this.retryTimer)) {
      if (stream !== this.stream) stopStream(stream);
      return { ok: true };
    }
    this.generation += 1;
    this.failedRestarts = 0;
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
      if (!stream.getAudioTracks().some(track => track.readyState === 'live')) {
        await this._terminal('ended');
        return { ok: false, reason: 'ended', error: MIC_MESSAGES.ended };
      }

      // monitor:false — recognition only. Playing the mic back would echo.
      this.graph = buildAudioGraph(this.stream, { monitor: false });
      const generation = this.generation;
      this.sourceEnded = () => {
        if (this.generation === generation && !this.stopping) this._terminal('ended');
      };
      for (const track of stream.getAudioTracks()) track.addEventListener?.('ended', this.sourceEnded);
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

  _updated() {
    try { Promise.resolve(this.onUpdate(this.store)).catch(() => {}); } catch (e) { /* persistence observers are isolated */ }
  }

  _notify(state) {
    try { Promise.resolve(this.onStateChange(state)).catch(() => {}); } catch (e) { /* an observer cannot break capture cleanup */ }
  }

  _terminal(code, message = '') {
    this.lastError = code;
    const reason = code === 'not-allowed' ? 'denied' : code;
    return this.stop({ flushMs: 0, reason, error: message || MIC_MESSAGES[reason] || MIC_MESSAGES.failed });
  }

  _attach(SR, track) {
    const rec = new SR();
    rec.lang = this.options.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.processLocally = this.options.processLocally;
    this.recognition = rec;
    this.lastError = null;
    const generation = this.generation;
    const current = () => this.generation === generation && this.recognition === rec;
    const attemptAt = Date.now();
    let started = false;
    let heardSpeech = false;

    rec.onresult = (event) => {
      if (!current()) return;
      const elapsed = Date.now() - this.t0;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result[0].transcript.trim()) heardSpeech = true;
        this.store.update(i, result[0].transcript, result.isFinal, elapsed);
      }
      this._updated();
    };
    rec.onerror = (event) => {
      if (!current() || this.stopping) return;
      this.lastError = event.error;
      if (['not-allowed', 'service-not-allowed', 'language-not-supported'].includes(event.error)) {
        this._terminal(event.error, event.message);
      }
    };
    rec.onend = () => {
      if (!current() || this.stopping) return;
      clearTimeout(this.startTimer);
      this.startTimer = null;
      rec.onresult = rec.onerror = rec.onend = rec.onstart = null;
      this.recognition = null;
      this.running = false;
      if (!track || track.readyState !== 'live') {
        this._terminal('ended');
        return;
      }
      const healthy = heardSpeech || (started && Date.now() - attemptAt >= 10000 &&
        (!this.lastError || this.lastError === 'no-speech'));
      this.failedRestarts = healthy ? 0 : this.failedRestarts + 1;
      if (this.failedRestarts >= 4) {
        this._terminal(this.lastError || 'restart-limit');
        return;
      }
      const retryTimer = setTimeout(() => {
        if (this.retryTimer !== retryTimer) return;
        this.retryTimer = null;
        if (this.stopping || this.generation !== generation) return;
        try {
          this.store.newEpoch();
          this._attach(SR, track);
        } catch (e) {
          this._terminal('restart-failed', String(e?.message || e));
        }
      }, healthy ? 100 : 250 * 2 ** (this.failedRestarts - 1));
      this.retryTimer = retryTimer;
    };
    rec.onstart = () => {
      if (!current() || this.stopping) return;
      clearTimeout(this.startTimer);
      this.startTimer = null;
      started = true;
      this.running = true;
      this._notify({ running: true });
    };
    this.startTimer = setTimeout(() => {
      if (current() && !this.stopping) this._terminal('start-timeout');
    }, 15000);
    rec.start(track);
  }

  /** Stop only this session's resources, never resources opened during teardown. */
  async stop({ flushMs = 800, reason, error } = {}) {
    this.discarded = true;
    this.requestId += 1;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    stopStream(this.pendingStream);
    this.pendingStream = null;
    this.stopping = true;
    const generation = this.generation;
    const rec = this.recognition;
    const graph = this.graph;
    const stream = this.stream;
    const sourceEnded = this.sourceEnded;
    if (this.running && flushMs > 0) await new Promise(resolve => setTimeout(resolve, flushMs));
    if (rec) {
      rec.onend = rec.onresult = rec.onerror = rec.onstart = null;
      try { rec.stop(); } catch (e) {
        try { rec.abort(); } catch (e2) { /* already gone */ }
      }
    }
    for (const track of stream?.getAudioTracks() || []) {
      track.removeEventListener?.('ended', sourceEnded);
    }
    // Release the physical device before awaiting AudioContext.close(). That
    // promise belongs to this graph and may settle after another Start.
    stopStream(stream);
    if (this.generation === generation) {
      this.recognition = null;
      this.graph = null;
      this.stream = null;
      this.sourceEnded = null;
      this.running = false;
      this._notify({ running: false, ...(reason ? { reason, error } : {}) });
    }
    let cleanupTimeout;
    try {
      await Promise.race([
        graph?.cleanup(),
        new Promise(resolve => { cleanupTimeout = setTimeout(resolve, 1000); }),
      ]);
    } catch (e) { /* physical tracks are already stopped; cleanup is best effort */ }
    finally { clearTimeout(cleanupTimeout); }
  }

  hasText() {
    return !this.store.isEmpty();
  }

  /** Drop captured microphone text without disturbing the meeting transcript. */
  clear() {
    this.store.clear();
    const rec = this.recognition;
    const active = !this.stopping && (this.running || rec || this.retryTimer);
    clearTimeout(this.startTimer);
    this.startTimer = null;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (rec) {
      rec.onend = rec.onresult = rec.onerror = rec.onstart = null;
      try { rec.abort(); } catch (e) { /* already ended */ }
    }
    this.recognition = null;
    this.running = false;
    if (active && this.graph?.track.readyState === 'live') {
      try {
        this.store.newEpoch();
        this._attach(getSpeechRecognition(), this.graph.track);
      } catch (e) {
        this._terminal('restart-failed', String(e?.message || e));
      }
    }
    this._updated();
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
