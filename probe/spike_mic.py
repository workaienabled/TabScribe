"""Spike: can a second SpeechRecognition run on the mic while tab capture runs?

Answers three questions with real Chrome, before any product code is written:

  1. Does a fake mic device satisfy getUserMedia({audio:true}) in this build?
  2. Can a SECOND SpeechRecognition instance run concurrently with the tab-audio
     one, or does starting it disturb/abort the first?
  3. Does each recognizer only hear its own stream, or do they cross-contaminate?

Throwaway. Nothing here ships. Run with DISPLAY on a private Xvfb.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from pipe_chrome import PipeChrome
from e2e_full import MODEL_CACHE, prepare_profile, graft_model_registration

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / 'uiux'
OUT.mkdir(parents=True, exist_ok=True)


def make_tone_wav(path, seconds=4):
    # A pure tone is not speech; it only proves the plumbing carries audio.
    subprocess.run(['python3', '-c', f'''
import math, struct, wave
w = wave.open({str(path)!r}, "w")
w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
frames = []
for i in range(16000 * {seconds}):
    frames.append(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / 16000))))
w.writeframes(b"".join(frames)); w.close()
'''], check=True)


def main():
    findings = {}
    with tempfile.TemporaryDirectory(prefix='tabscribe-mic-spike-') as tmp:
        wav = Path(tmp) / 'mic.wav'
        make_tone_wav(wav)
        profile = str(Path(tmp) / 'profile')
        # The on-device pack is ~310MB; reuse the warm cache the audio suites use,
        # otherwise the interesting question is skipped as 'downloadable'.
        findings['seeded'] = prepare_profile(profile, MODEL_CACHE)
        extra = [
            '--enable-unsafe-extension-debugging',
            # Chrome's own fake device: no real microphone is ever opened.
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            f'--use-file-for-fake-audio-capture={wav}%noloop',
        ]
        # Warm up once so Chrome writes Local State, then graft the registration
        # into it; Chrome rewrites that file on exit, so order matters.
        warm = PipeChrome(profile, fresh=False, extra_args=extra)
        warm.launch()
        warm.kill()
        time.sleep(1.0)
        findings['grafted'] = graft_model_registration(profile, MODEL_CACHE)
        chrome = PipeChrome(profile, fresh=False, extra_args=extra)
        chrome.launch()
        try:
            ext_id = chrome.send('Extensions.loadUnpacked', path=str(ROOT / 'extension'))['id']
            tid, sid = chrome.new_tab(f'chrome-extension://{ext_id}/sidepanel.html')
            chrome.wait_for_js(sid, "document.getElementById('status').textContent.length > 0")
            chrome.send('Browser.grantPermissions', permissions=['audioCapture'])

            # 1. Is a microphone reachable at all from the panel document?
            findings['getUserMedia'] = chrome.evaluate(sid, """(async () => {
              try {
                const s = await navigator.mediaDevices.getUserMedia({audio: true});
                const t = s.getAudioTracks()[0];
                const out = {ok: true, label: t.label, state: t.readyState};
                s.getTracks().forEach(x => x.stop());
                return out;
              } catch (e) { return {ok: false, error: String(e && e.name || e)}; }
            })()""", await_promise=True)

            # 2 + 3. Two recognizers, two independent streams, at the same time.
            findings['concurrent'] = chrome.evaluate(sid, """(async () => {
              const {buildAudioGraph} = await import('./transcriber.js');
              const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
              if (!SR) return {supported: false};
              const avail = await SR.available({langs: ['en-US'], processLocally: true});
              if (avail !== 'available') return {supported: true, availability: avail, skipped: true};

              const log = {a: [], b: [], errors: []};
              const ctx = new AudioContext();

              // Recognizer A: a synthetic silent stream standing in for tab audio.
              const destA = ctx.createMediaStreamDestination();
              const oscGain = ctx.createGain(); oscGain.gain.value = 0;
              const osc = ctx.createOscillator(); osc.connect(oscGain); oscGain.connect(destA); osc.start();

              // Recognizer B: the fake microphone.
              const mic = await navigator.mediaDevices.getUserMedia({audio: true});
              const graphB = buildAudioGraph(mic, {monitor: false});

              const recA = new SR();
              recA.lang = 'en-US'; recA.continuous = true; recA.interimResults = true;
              recA.processLocally = true;
              recA.onerror = (e) => log.errors.push('A:' + e.error);
              recA.onstart = () => log.a.push('start');
              recA.onend = () => log.a.push('end');

              const recB = new SR();
              recB.lang = 'en-US'; recB.continuous = true; recB.interimResults = true;
              recB.processLocally = true;
              recB.onerror = (e) => log.errors.push('B:' + e.error);
              recB.onstart = () => log.b.push('start');
              recB.onend = () => log.b.push('end');

              recA.start(destA.stream.getAudioTracks()[0]);
              await new Promise(r => setTimeout(r, 900));
              const aAliveBefore = log.a.includes('start') && !log.a.includes('end');

              let bThrew = null;
              try { recB.start(graphB.track); } catch (e) { bThrew = String(e && e.message || e); }
              await new Promise(r => setTimeout(r, 2500));

              const out = {
                supported: true, availability: avail,
                aStartedFirst: aAliveBefore,
                bThrew,
                aEvents: log.a, bEvents: log.b, errors: log.errors,
                bothRunning: log.a.includes('start') && log.b.includes('start')
                             && !log.a.includes('end') && !log.b.includes('end'),
                aSurvivedB: log.a.filter(x => x === 'end').length === 0,
              };
              try { recA.abort(); } catch (e) {}
              try { recB.abort(); } catch (e) {}
              mic.getTracks().forEach(t => t.stop());
              await graphB.cleanup();
              await ctx.close();
              return out;
            })()""", await_promise=True)
        finally:
            chrome.kill()

    (OUT / 'mic-spike.json').write_text(json.dumps(findings, indent=2))
    print(json.dumps(findings, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
