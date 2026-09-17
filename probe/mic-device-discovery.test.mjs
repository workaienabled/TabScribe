import test from 'node:test';
import assert from 'node:assert/strict';
import { MicTranscriber } from '../extension/mic.js';

for (const [label, enumerateDevices, expected] of [
  ['empty device list', async () => [], false],
  ['only audio output', async () => [{ kind: 'audiooutput' }], false],
  ['audio input', async () => [{ kind: 'audioinput' }], true],
  ['enumeration rejection', async () => { throw new Error('device enumeration failed'); }, null],
  ['enumeration throw', () => { throw new Error('device enumeration failed'); }, null],
  ['unavailable API', undefined, null],
]) {
  test(`microphone discovery distinguishes ${label} from no device`, async t => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { enumerateDevices } } });
    t.after(() => previous ? Object.defineProperty(globalThis, 'navigator', previous) : delete globalThis.navigator);
    assert.equal(await MicTranscriber.hasMicrophone(), expected);
  });
}
