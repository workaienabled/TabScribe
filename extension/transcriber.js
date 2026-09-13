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
    if (!snapshot || !Array.isArray(snapshot.segments)) return;
    this.clear();
    for (const s of snapshot.segments) {
      if (!s || !s.text || !s.text.trim()) continue;
      const seg = {
        key: s.key,
        text: s.text,
        isFinal: true,
        startedAt: s.startedAt || 0,
      };
      this.byKey.set(seg.key, seg);
      this.segments.push(seg);
    }
    this.epoch = (Number(snapshot.epoch) || 0) + 1;
  }

  /** Recover cleared history without changing current recognition keys or epoch. */
  prepend(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.segments)) return;
    const recovered = [];
    for (const [index, source] of snapshot.segments.entries()) {
      if (!source?.text?.trim()) continue;
      let key = `recovered:${index}`;
      while (this.byKey.has(key)) key = `_${key}`;
      const segment = { ...source, key, isFinal: true };
      recovered.push(segment);
      this.byKey.set(key, segment);
    }
    this.segments = [...recovered, ...this.segments];
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
  const source = ctx.createMediaStreamSource(stream);
  const dest = ctx.createMediaStreamDestination();

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
    try { keepAlive.stop(); } catch (e) { /* already stopped */ }
    try { source.disconnect(); } catch (e) { /* already disconnected */ }
    if (monitorGain) {
      try { monitorGain.disconnect(); } catch (e) { /* already disconnected */ }
    }
    try { await ctx.close(); } catch (e) { /* already closed */ }
  };

  return { track, ctx, cleanup, setMonitorVolume: (v) => { if (monitorGain) monitorGain.gain.value = v; } };
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
    this.lastError = null;
    this.options = { lang: 'en-US', processLocally: true };
  }

  static async availability(lang = 'en-US', processLocally = true) {
    const SR = getSpeechRecognition();
    if (!SR || !SR.available) return 'unsupported';
    try {
      return await SR.available({ langs: [lang], processLocally });
    } catch (e) {
      return 'unsupported';
    }
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
                                             onProgress = () => {} } = {}) {
    let availability = await Transcriber.availability(lang, true);
    onProgress({ phase: 'checking', availability });

    if (availability === 'unsupported') {
      onProgress({ phase: 'unsupported', availability });
      return { ok: false, availability, installed: false, fellBackToCloud: false };
    }
    if (availability === 'available') {
      onProgress({ phase: 'ready', availability });
      return { ok: true, availability, installed: false, fellBackToCloud: false };
    }
    if (availability === 'downloadable' || availability === 'downloading') {
      onStatus(`Downloading on-device model for ${lang}…`);
      onProgress({ phase: 'downloading', availability, startedAt: Date.now() });

      // Poll Chrome's own availability during the install so the UI reflects the
      // browser's real state (including a download already started elsewhere)
      // rather than assuming what is happening.
      let polling = true;
      (async () => {
        while (polling) {
          await new Promise((r) => setTimeout(r, 1500));
          if (!polling) break;
          const a = await Transcriber.availability(lang, true);
          if (!polling) break;
          onProgress({ phase: a === 'available' ? 'ready' : 'downloading', availability: a });
        }
      })();

      let installed = false;
      let failure = null;
      try {
        installed = await Transcriber.install(lang);
      } catch (e) {
        failure = String(e && e.message ? e.message : e);
      } finally {
        polling = false;
      }

      availability = await Transcriber.availability(lang, true);
      const ok = availability === 'available';
      onProgress({ phase: ok ? 'ready' : 'failed', availability, installed, error: failure });
      return { ok, availability, installed, fellBackToCloud: false, error: failure };
    }
    // 'unavailable' for on-device.
    onProgress({ phase: 'unavailable', availability });
    if (allowCloudFallback) {
      const remote = await Transcriber.availability(lang, false);
      return { ok: remote === 'available', availability, installed: false, fellBackToCloud: true };
    }
    return { ok: false, availability, installed: false, fellBackToCloud: false };
  }

  start(track, { lang = 'en-US', processLocally = true, isRestart = false } = {}) {
    const SR = getSpeechRecognition();
    if (!SR) throw new Error('SpeechRecognition is not available in this browser.');

    this.track = track;
    this.options = { lang, processLocally };
    if (!isRestart) {
      this.t0 = Date.now();
      this.restarts = 0;
      this.stopping = false;
    } else {
      this.store.newEpoch();
    }

    const rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.processLocally = processLocally;
    this.recognition = rec;

    rec.onresult = (event) => {
      const elapsed = Date.now() - this.t0;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        this.store.update(i, result[0].transcript, result.isFinal, elapsed);
      }
      this.onUpdate(this.store);
    };

    rec.onerror = (event) => {
      this.lastError = event.error;
      // 'no-speech' and 'aborted' are routine during a long capture and are handled
      // by the restart path in onend; anything else is surfaced to the user.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        this.onError(event.error, event.message || '');
      }
    };

    rec.onend = () => {
      if (this.stopping || !this.running) {
        this.running = false;
        this.onStatus('stopped');
        this.onUpdate(this.store);
        return;
      }
      // Fatal conditions must not be retried in a tight loop.
      if (this.lastError === 'not-allowed' || this.lastError === 'service-not-allowed' ||
          this.lastError === 'language-not-supported') {
        this.running = false;
        this.onStatus('stopped');
        return;
      }
      if (!this.track || this.track.readyState !== 'live') {
        this.running = false;
        this.onStatus('stopped');
        return;
      }
      this.restarts += 1;
      this.onStatus('restarting');
      try {
        this.start(this.track, { ...this.options, isRestart: true });
      } catch (e) {
        this.running = false;
        this.onError('restart-failed', String(e));
      }
    };

    rec.onstart = () => {
      this.running = true;
      this.onStatus('listening');
    };

    rec.start(track);
  }

  /**
   * Stop recognition, allowing a grace period for the recognizer to finalize the
   * segment still in flight. The transcript is safe either way because the store
   * retains unfinalized text, but waiting produces a cleaner final sentence.
   */
  async stop({ flushMs = 1500 } = {}) {
    this.stopping = true;
    if (flushMs > 0) {
      await new Promise((r) => setTimeout(r, flushMs));
    }
    try {
      this.recognition?.stop();
    } catch (e) { /* already stopped */ }
    this.running = false;
    this.onUpdate(this.store);
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

    const rec = this.recognition;
    const wasRunning = this.running;
    const track = this.track;

    if (rec) {
      // Detach handlers first: the abort below fires onend, which would otherwise
      // trigger the auto-restart path and race the fresh session started here.
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.onstart = null;
      try {
        rec.abort();
      } catch (e) {
        try { rec.stop(); } catch (e2) { /* already stopped */ }
      }
    }
    this.recognition = null;
    this.running = false;

    if (wasRunning && track && track.readyState === 'live' && !this.stopping) {
      // Continue transcribing from a clean slate. isRestart is deliberately NOT set:
      // epochs exist to keep old segments addressable, and there are no old segments
      // left to protect after a clear.
      this.t0 = Date.now();
      try {
        this.start(track, { ...this.options });
      } catch (e) {
        this.onError('restart-failed', String(e));
      }
    }

    this.onUpdate(this.store);
  }

  getText(opts) {
    return this.store.toText(opts);
  }
}
