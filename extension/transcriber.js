/**
 * TabScribe recognition core.
 *
 * Shared by the side panel and the automated test harness so that both exercise
 * exactly the same code path.
 *
 * Two behaviours here exist because measurement showed they are required, not
 * because they seemed prudent:
 *
 * 1. TranscriptStore keeps a high-water mark for every result index, including
 *    segments that never reach isFinal. Chrome's on-device recognizer routinely
 *    still has the final sentence in an interim state when recognition stops, and
 *    stop() discards it. Building a transcript from final results alone silently
 *    loses the tail of every session.
 *
 * 2. Audio is routed through an AudioContext graph rather than handing the captured
 *    track straight to the recognizer. A MediaStreamAudioDestinationNode emits
 *    frames continuously even while the tab is silent, which gives the recognizer
 *    the trailing audio it needs to flush a pending segment. The same graph feeds
 *    the tab's audio back to the speakers, because chrome.tabCapture mutes the tab
 *    for as long as it is being captured.
 */

/** Validate a full snapshot before a restore can mutate live transcript state. */
function validateSnapshot(snapshot) {
  const invalid = () => { throw new TypeError('Invalid transcript snapshot.'); };
  if (!snapshot || !Array.isArray(snapshot.segments) ||
      !Number.isSafeInteger(snapshot.epoch) || snapshot.epoch < 0) invalid();
  let epoch = snapshot.epoch;
  const keys = new Set();
  const segments = snapshot.segments.map(s => {
    if (!s || typeof s.key !== 'string' || !s.key || keys.has(s.key) ||
        typeof s.text !== 'string' || typeof s.isFinal !== 'boolean' ||
        !Number.isFinite(s.startedAt) || s.startedAt < 0) invalid();
    keys.add(s.key);
    const recognitionKey = /^(\d+):\d+$/.exec(s.key);
    if (recognitionKey) epoch = Math.max(epoch, Number(recognitionKey[1]));
    return { key: s.key, text: s.text, isFinal: true, startedAt: s.startedAt };
  });
  if (!Number.isSafeInteger(epoch) || epoch >= Number.MAX_SAFE_INTEGER - 1) invalid();
  return { epoch, segments };
}

/** Ordered transcript segments, addressed by (epoch, result index). */
export class TranscriptStore {
  constructor() {
    this.segments = [];
    this.byKey = new Map();
    this.epoch = 0;
  }

  /**
   * Recognition restarts (auto-restart, or a new Start) reset result indices to 0.
   * Bumping the epoch keeps older segments addressable and ordered.
   */
  newEpoch() {
    this.epoch += 1;
  }

  update(index, text, isFinal, elapsedMs) {
    const key = `${this.epoch}:${index}`;
    let seg = this.byKey.get(key);
    if (!seg) {
      seg = { key, text: '', isFinal: false, startedAt: elapsedMs };
      this.byKey.set(key, seg);
      this.segments.push(seg);
    }
    // A final result is authoritative: never let a late interim overwrite it.
    if (seg.isFinal && !isFinal) return seg;
    seg.text = text;
    seg.isFinal = isFinal;
    return seg;
  }

  /** Drop segments that are empty or whitespace only. */
  liveSegments() {
    return this.segments.filter((s) => s.text && s.text.trim().length > 0);
  }

  isEmpty() {
    return this.liveSegments().length === 0;
  }

  clear() {
    this.segments = [];
    this.byKey.clear();
    this.epoch = 0;
  }

  /**
   * Plain snapshot of the transcript, for carrying it between documents (the side
   * panel and the pop-out window are separate documents and share no memory).
   */
  serialize() {
    return {
      epoch: this.epoch,
      segments: this.segments.map((s) => ({
        key: s.key,
        text: s.text,
        isFinal: s.isFinal,
        startedAt: s.startedAt,
      })),
    };
  }

  /**
   * Restore a snapshot. Segments are marked final: they came from a previous
   * recognition session that no longer exists, so nothing can legitimately revise
   * them, and leaving them interim would render them as unsettled forever.
   * The epoch is bumped past everything restored so a new session cannot collide
   * with a restored key.
   */
  restore(snapshot) {
    const validated = validateSnapshot(snapshot);
    const segments = validated.segments.filter(s => s.text.trim());
    const byKey = new Map(segments.map(s => [s.key, s]));
    this.segments = segments;
    this.byKey = byKey;
    this.epoch = validated.epoch + 1;
  }

  /** Recover cleared history without changing current recognition keys or epoch. */
  prepend(snapshot) {
    const validated = validateSnapshot(snapshot);
    const recovered = [];
    const byKey = new Map(this.byKey);
    for (const [index, source] of validated.segments.entries()) {
      if (!source.text.trim()) continue;
      let key = `recovered:${index}`;
      while (byKey.has(key)) key = `_${key}`;
      const segment = { ...source, key };
      recovered.push(segment);
      byKey.set(key, segment);
    }
    this.segments = [...recovered, ...this.segments];
    this.byKey = byKey;
  }

  /** Plain text, one line per segment when timestamps are on, otherwise flowed. */
  toText({ timestamps = false } = {}) {
    const segs = this.liveSegments();
    if (!timestamps) {
      return segs.map((s) => s.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
    }
    return segs
      .map((s) => `[${formatClock(s.startedAt)}] ${s.text.trim()}`)
      .join('\n');
  }

  wordCount() {
    return this.toText().split(/\s+/).filter(Boolean).length;
  }
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function getSpeechRecognition() {
  return self.SpeechRecognition || self.webkitSpeechRecognition || null;
}

/**
 * Build the audio graph described in the file header.
 * Returns the track to feed the recognizer plus a cleanup function.
 */
export function buildAudioGraph(stream, { monitor = true, preroll = true } = {}) {
  const ctx = new AudioContext();
  let dest;
  try {
    const source = ctx.createMediaStreamSource(stream);
    dest = ctx.createMediaStreamDestination();

    source.connect(dest);

    // Play the tab's audio back to the user. Without this the tab is silent for as
    // long as tabCapture holds the stream.
    let monitorGain = null;
    if (monitor) {
      monitorGain = ctx.createGain();
      monitorGain.gain.value = 1.0;
      source.connect(monitorGain);
      monitorGain.connect(ctx.destination);
    }

    // Keep the graph pulling even when the tab produces nothing, so the destination
    // node keeps emitting frames and the recognizer can flush pending segments.
    const keepAlive = ctx.createConstantSource();
    keepAlive.offset.value = 0;
    const keepAliveGain = ctx.createGain();
    keepAliveGain.gain.value = 0;
    keepAlive.connect(keepAliveGain);
    keepAliveGain.connect(dest);
    keepAlive.start();

    // The recognizer needs a moment of audio before it locks on, which otherwise eats
    // the first word of the first sentence. A brief burst of very quiet noise at
    // startup gives it something to settle on without being audible to the user (it is
    // routed only to the recognition destination, never to the speakers).
    if (preroll) {
      const frames = Math.floor(ctx.sampleRate * 0.3);
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i += 1) {
        data[i] = (Math.random() * 2 - 1) * 0.0008;
      }
      const prerollSource = ctx.createBufferSource();
      prerollSource.buffer = buffer;
      prerollSource.connect(dest);
      prerollSource.start();
    }

    const track = dest.stream.getAudioTracks()[0];

    const cleanup = async () => {
      for (const output of dest.stream.getTracks()) {
        try { output.stop(); } catch (e) { /* continue closing the graph */ }
      }
      try { keepAlive.stop(); } catch (e) { /* already stopped */ }
      try { source.disconnect(); } catch (e) { /* already disconnected */ }
      if (monitorGain) {
        try { monitorGain.disconnect(); } catch (e) { /* already disconnected */ }
      }
      try { await ctx.close(); } catch (e) { /* already closed */ }
    };

    return { track, ctx, cleanup, setMonitorVolume: (v) => { if (monitorGain) monitorGain.gain.value = v; } };
  } catch (error) {
    for (const output of dest?.stream.getTracks() || []) {
      try { output.stop(); } catch (e) { /* best effort */ }
    }
    try { Promise.resolve(ctx.close()).catch(() => {}); } catch (e) { /* preserve original error */ }
    throw error;
  }
}

/**
 * Drives SpeechRecognition over a MediaStreamTrack and accumulates a transcript.
 */
export class Transcriber {
  constructor({ onUpdate = () => {}, onStatus = () => {}, onError = () => {} } = {}) {
    this.store = new TranscriptStore();
    this.onUpdate = onUpdate;
    this.onStatus = onStatus;
    this.onError = onError;

    this.recognition = null;
    this.track = null;
    this.running = false;
    this.stopping = false;
    this.t0 = 0;
    this.restarts = 0;
    this.failedRestarts = 0;
    this.retryTimer = null;
    this.startTimer = null;
    this.lastError = null;
    this.lastErrorMessage = '';
    this.options = { lang: 'en-US', processLocally: true };
  }

  /**
   * A session exists and has not been asked to stop: live, still starting, or
   * waiting for its scheduled restart. Chrome ends a continuous session every
   * few minutes and the restart is delayed, so `running` and `recognition` are
   * both false for that gap while the user still sees Record pressed. And after
   * stop() begins, `running` stays true through the flush although the meeting
   * is over. Callers deciding whether recognition is in progress read this.
   */
  get active() {
    return !this.stopping && !!(this.running || this.recognition || this.retryTimer);
  }

  static async availability(lang = 'en-US', processLocally = true) {
    const SR = getSpeechRecognition();
    if (!SR || !SR.available) return 'unsupported';
    return SR.available({ langs: [lang], processLocally });
  }

  static async install(lang = 'en-US') {
    const SR = getSpeechRecognition();
    if (!SR || !SR.install) return false;
    return SR.install({ langs: [lang], processLocally: true });
  }

  /**
   * Ensure the on-device language pack is present.
   * Returns { ok, availability, installed, fellBackToCloud }.
   *
   * onProgress receives real state only. Chrome's install() reports NO download
   * progress — verified on Chrome 151: the Prompt-API style `monitor` callback is
   * never invoked, no `downloadprogress` events fire, and the returned promise
   * carries no progress affordances (matching the spec, where install(options)
   * simply resolves to a boolean). The one genuine signal is available(), which
   * reports 'downloading' while a pack is being fetched, so that is polled here.
   * Anything resembling a percentage would be fabricated, so none is produced.
   */
  static async ensureModel(lang = 'en-US', { allowCloudFallback = false, onStatus = () => {},
    onProgress = () => {}, signal, timeoutMs = 600000 } = {}) {
    signal?.throwIfAborted();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid model timeout.');
    let timeout;
    let pollTimer;
    let abort;
    const cancelled = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new DOMException('Speech model setup timed out.', 'TimeoutError')), timeoutMs);
      abort = () => reject(signal.reason || new DOMException('Cancelled.', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
    });
    const wait = async (promise) => {
      const result = await Promise.race([promise, cancelled]);
      signal?.throwIfAborted();
      return result;
    };
    try {
      let availability = await wait(Transcriber.availability(lang, true));
      onProgress({ phase: 'checking', availability });
      if (availability === 'unsupported' || availability === 'available') {
        const ok = availability === 'available';
        onProgress({ phase: ok ? 'ready' : 'unsupported', availability });
        return { ok, availability, installed: false, fellBackToCloud: false };
      }
      if (availability === 'downloadable' || availability === 'downloading') {
        onStatus(`Downloading on-device model for ${lang}…`);
        onProgress({ phase: 'downloading', availability, startedAt: Date.now() });
        signal?.throwIfAborted();
        // Chrome cannot cancel its download. We can cancel this caller's wait,
        // timers and callbacks, and observe any late rejection without publishing it.
        const installation = Transcriber.install(lang).then(
          installed => ({ installed, error: null }),
          error => ({ installed: false, error: String(error?.message || error) }),
        );
        let outcome;
        while (!outcome) {
          outcome = await wait(Promise.race([
            installation,
            new Promise(resolve => { pollTimer = setTimeout(() => resolve(null), 1500); }),
          ]));
          clearTimeout(pollTimer);
          if (!outcome) {
            availability = await wait(Transcriber.availability(lang, true));
            onProgress({ phase: availability === 'available' ? 'ready' : 'downloading', availability });
          }
        }
        availability = await wait(Transcriber.availability(lang, true));
        const ok = availability === 'available';
        onProgress({ phase: ok ? 'ready' : 'failed', availability, ...outcome });
        return { ok, availability, ...outcome, fellBackToCloud: false };
      }
      onProgress({ phase: 'unavailable', availability });
      if (allowCloudFallback) {
        const remote = await wait(Transcriber.availability(lang, false));
        return { ok: remote === 'available', availability, installed: false, fellBackToCloud: true };
      }
      return { ok: false, availability, installed: false, fellBackToCloud: false };
    } finally {
      clearTimeout(timeout);
      clearTimeout(pollTimer);
      signal?.removeEventListener('abort', abort);
    }
  }

  start(track, { lang = 'en-US', processLocally = true, isRestart = false } = {}) {
    const SR = getSpeechRecognition();
    if (!SR) throw new Error('SpeechRecognition is not available in this browser.');

    this._detach(this.recognition, true);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.running = false;
    this.lastError = null;
    this.lastErrorMessage = '';
    this.track = track;
    this.options = { lang, processLocally };
    // Every recognizer instance starts result indices at zero. A manual Start
    // after Stop must get fresh keys too, or it overwrites the previous session.
    this.store.newEpoch();
    if (!isRestart) {
      this.t0 = Date.now();
      this.restarts = 0;
      this.failedRestarts = 0;
      this.stopping = false;
    }

    const rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.processLocally = processLocally;
    this.recognition = rec;
    const attemptAt = Date.now();
    let started = false;
    let heardSpeech = false;

    rec.onresult = (event) => {
      if (this.recognition !== rec) return;
      const elapsed = Date.now() - this.t0;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result[0].transcript.trim()) heardSpeech = true;
        this.store.update(i, result[0].transcript, result.isFinal, elapsed);
      }
      this._notify('onUpdate', this.store);
    };

    rec.onerror = (event) => {
      if (this.recognition !== rec || this.stopping) return;
      this.lastError = event.error;
      this.lastErrorMessage = event.message || '';
      // 'no-speech' and 'aborted' are routine during a long capture and are handled
      // by the restart path in onend; anything else is surfaced to the user.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        this._notify('onError', event.error, event.message || '');
      }
    };

    rec.onend = () => {
      if (this.recognition !== rec) return;
      this._detach(rec);
      this.running = false;
      if (this.stopping) {
        this.running = false;
        this._notify('onStatus', 'stopped', { fatal: false, error: null });
        this._notify('onUpdate', this.store);
        return;
      }
      // A startup failure may end without ever firing onstart. Preserve the
      // browser's reason; the code alone does not establish its underlying cause.
      if (this.lastError === 'not-allowed' || this.lastError === 'service-not-allowed' ||
          this.lastError === 'language-not-supported') {
        this.running = false;
        this._notify('onStatus', 'stopped', { fatal: true, error: this.lastError, message: this.lastErrorMessage });
        return;
      }
      if (!this.track || this.track.readyState !== 'live') {
        this.running = false;
        // Not a recognition failure: the tab simply stopped producing audio.
        this._notify('onStatus', 'stopped', { fatal: false, error: null, trackEnded: true });
        return;
      }
      // Real speech and ordinary long silence are not failed attempts. Only
      // repeated empty/failed sessions exhaust this consecutive-failure budget.
      const healthy = heardSpeech || (started && Date.now() - attemptAt >= 10000 &&
        (!this.lastError || this.lastError === 'no-speech'));
      this.failedRestarts = healthy ? 0 : this.failedRestarts + 1;
      if (this.failedRestarts >= 4) {
        this._notify('onStatus', 'stopped', { fatal: true, error: this.lastError || 'restart-limit',
          message: this.lastErrorMessage || 'Recognition repeatedly ended without producing speech.' });
        return;
      }
      this.restarts += 1;
      this._notify('onStatus', 'restarting');
      const retryTimer = setTimeout(() => {
        if (this.retryTimer !== retryTimer) return;
        this.retryTimer = null;
        if (this.stopping) return;
        try {
          this.start(this.track, { ...this.options, isRestart: true });
        } catch (e) {
          this.running = false;
          this._notify('onError', 'restart-failed', String(e));
          this._notify('onStatus', 'stopped', { fatal: true, error: 'restart-failed', message: String(e?.message || e) });
        }
      }, healthy ? 100 : 250 * 2 ** (this.failedRestarts - 1));
      this.retryTimer = retryTimer;
    };

    rec.onstart = () => {
      if (this.recognition !== rec || this.stopping) return;
      clearTimeout(this.startTimer);
      this.startTimer = null;
      started = true;
      this.running = true;
      this._notify('onStatus', 'listening');
    };

    this.startTimer = setTimeout(() => {
      if (this.recognition !== rec || this.stopping) return;
      this._detach(rec, true);
      this.running = false;
      this.lastError = 'start-timeout';
      this.lastErrorMessage = 'Chrome did not start speech recognition within 15 seconds.';
      this._notify('onError', this.lastError, this.lastErrorMessage);
      this._notify('onStatus', 'stopped', { fatal: true, error: this.lastError, message: this.lastErrorMessage });
    }, 15000);
    try {
      rec.start(track);
    } catch (error) {
      this._detach(rec, true);
      this.running = false;
      throw error;
    }
  }

  _notify(observer, ...args) {
    // Observers are outside recognition ownership. Their exceptions (including
    // rejected promises) must not interrupt cleanup or retries. Never log text.
    const failed = () => console.warn('TabScribe recognition observer failed:', observer);
    try { Promise.resolve(this[observer](...args)).catch(failed); }
    catch (e) { failed(); }
  }

  _detach(rec, abort = false) {
    if (!rec) return;
    rec.onresult = rec.onerror = rec.onend = rec.onstart = null;
    if (this.recognition === rec) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
      this.recognition = null;
    }
    if (abort) {
      try { rec.abort(); } catch (e) { /* already ended */ }
    }
  }

  /**
   * Stop recognition, allowing a grace period for the recognizer to finalize the
   * segment still in flight. The transcript is safe either way because the store
   * retains unfinalized text, but waiting produces a cleaner final sentence.
   */
  async stop({ flushMs = 1500 } = {}) {
    this.stopping = true;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const rec = this.recognition;
    if (flushMs > 0) {
      await new Promise((r) => setTimeout(r, flushMs));
    }
    if (this.recognition !== rec) return;
    try {
      rec?.stop();
    } catch (e) { this._detach(rec, true); }
    this.running = false;
    this._notify('onUpdate', this.store);
  }

  /**
   * Discard the transcript, including whatever is still being spoken.
   *
   * Clearing the store alone is not enough. The live SpeechRecognition session owns
   * its own results array, and its in-flight utterance keeps the same result index,
   * so the very next event re-adds the block the user just dismissed. To actually
   * drop it, the recognition session has to be abandoned: abort() (unlike stop())
   * discards buffered audio without emitting a final result, and a fresh session is
   * started so transcription continues seamlessly.
   */
  reset() {
    this.store.clear();
    const wasActive = this.active;
    const track = this.track;
    this._detach(this.recognition, true);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.running = false;
    if (wasActive && track?.readyState === 'live' && !this.stopping) {
      // A reset starts new recognition keys but keeps the capture's clock so
      // microphone turns and recovered history remain on the same timeline.
      try {
        this.start(track, { ...this.options, isRestart: true });
      } catch (e) {
        this._notify('onError', 'restart-failed', String(e));
        this._notify('onStatus', 'stopped', { fatal: true, error: 'restart-failed', message: String(e?.message || e) });
      }
    }
    this._notify('onUpdate', this.store);
  }

  getText(opts) {
    return this.store.toText(opts);
  }
}
