import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptStore } from '../extension/transcriber.js';
import { mergeTranscripts, MIC_LABEL, TAB_LABEL } from '../extension/mic.js';

function store(entries) {
  const s = new TranscriptStore();
  entries.forEach(([index, text, at], i) => s.update(index ?? i, text, true, at));
  return s;
}

test('with no microphone text the saved transcript is byte-identical', () => {
  const tab = store([[0, 'The release ships on Friday.', 1000]]);
  const empty = new TranscriptStore();
  assert.equal(mergeTranscripts(tab, empty), tab.toText());
  assert.equal(mergeTranscripts(tab, empty, { timestamps: true }), tab.toText({ timestamps: true }));
  assert.equal(mergeTranscripts(tab, null), tab.toText());
});

test('microphone turns are interleaved by elapsed time and labelled', () => {
  const tab = store([[0, 'Any questions before we finish?', 5000],
                     [1, 'Good, that settles it.', 15000]]);
  const mic = store([[0, 'Yes, who owns the migration?', 9000]]);
  assert.equal(mergeTranscripts(tab, mic),
    `${TAB_LABEL}: Any questions before we finish?\n`
    + `${MIC_LABEL}: Yes, who owns the migration?\n`
    + `${TAB_LABEL}: Good, that settles it.`);
});

test('timestamps apply to merged rows', () => {
  const tab = store([[0, 'Opening remarks.', 0]]);
  const mic = store([[0, 'Understood.', 62000]]);
  assert.equal(mergeTranscripts(tab, mic, { timestamps: true }),
    `[00:00] ${TAB_LABEL}: Opening remarks.\n[01:02] ${MIC_LABEL}: Understood.`);
});

test('a same-instant tie keeps the meeting turn first', () => {
  const tab = store([[0, 'Tab speaks.', 4000]]);
  const mic = store([[0, 'Mic speaks.', 4000]]);
  assert.equal(mergeTranscripts(tab, mic),
    `${TAB_LABEL}: Tab speaks.\n${MIC_LABEL}: Mic speaks.`);
});

test('whitespace-only microphone results never create a labelled empty turn', () => {
  const tab = store([[0, 'Real content.', 1000]]);
  const mic = new TranscriptStore();
  mic.update(0, '   ', true, 2000);
  assert.equal(mergeTranscripts(tab, mic), tab.toText());
});

test('microphone text survives when the meeting transcript is empty', () => {
  const tab = new TranscriptStore();
  const mic = store([[0, 'Only I spoke.', 500]]);
  assert.equal(mergeTranscripts(tab, mic), `${MIC_LABEL}: Only I spoke.`);
});

test('unfinalised microphone speech is still saved', () => {
  // The closing sentence is routinely still interim when recognition stops.
  const tab = store([[0, 'Meeting over.', 100]]);
  const mic = new TranscriptStore();
  mic.update(0, 'One last thought', false, 200);
  assert.match(mergeTranscripts(tab, mic), /One last thought/);
});
