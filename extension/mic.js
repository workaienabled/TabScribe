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

export class MicTranscriber {
  constructor({ onStateChange = () => {} } = {}) {
    this.store = new TranscriptStore();
    this.onStateChange = onStateChange;
    this.stream = null;
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
   * Begin transcribing the microphone.
   *
   * Resolves to {ok} or {ok:false, error, denied}. It never rejects: the caller
   * is in the middle of starting the real transcription and a microphone problem
   * must not become a tab-capture failure.
   */
  async start({ lang = 'en-US', processLocally = true } = {}) {
    if (this.running) return { ok: true };
    this.options = { lang, processLocally };
    this.lastError = null;
    this.stopping = false;

    try {
      const SR = getSpeechRecognition();
      if (!SR) return { ok: false, error: 'Speech recognition is unavailable.' };

      // Echo cancellation matters here: the tab's audio is playing through the
      // speakers, and without it the meeting's voices are picked up twice.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!this.stream.getAudioTracks().length) {
        throw new Error('The microphone produced no audio track.');
      }

      // monitor:false — recognition only. Playing the mic back would echo.
      this.graph = buildAudioGraph(this.stream, { monitor: false });
      this.t0 = Date.now();
      this.store.newEpoch();
      this._attach(SR, this.graph.track);
      return { ok: true };
    } catch (e) {
      const name = String(e && e.name ? e.name : '');
      const denied = name === 'NotAllowedError' || name === 'SecurityError';
      await this.stop({ flushMs: 0 });
      return {
        ok: false,
        denied,
        error: denied
          ? 'Microphone permission was refused.'
          : String(e && e.message ? e.message : e),
      };
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
