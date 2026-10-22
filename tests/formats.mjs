import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FORMATS, encodeAudio, decodeAudioFile } from '../js/audio-files.js';
import { writeMidi, readMidi } from '../js/midi-file.js';

const dir = mkdtempSync(join(tmpdir(), 'formats-test-'));
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());
const rate = 48000, frames = 4801;
const signal = [0, 1].map(c => Float32Array.from({ length: frames }, (_, i) => 0.8 * Math.sin(2 * Math.PI * (440 + c * 110) * i / rate)));
signal[0][10] = 1; signal[1][11] = -1;
const noBrowser = { decodeAudioData: () => { throw new Error('browser decoder should not be needed'); } };
const maxError = (a, b) => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0);

// Every export format reads back at its own rate and depth, within its quantization step.
for (const [id, f] of Object.entries(FORMATS)) {
 const bytes = await bytesOf(encodeAudio(signal, rate, id));
 const back = await decodeAudioFile(bytes, noBrowser);
 assert.equal(back.sampleRate, rate, id);
 assert.equal(back.channels.length, 2, id);
 assert.equal(back.channels[0].length, frames, id);
 const step = f.float ? 1e-7 : 2 / 2 ** f.bits * (f.bits === 16 ? 3 : 1);
 back.channels.forEach((c, i) => assert.ok(maxError(c, signal[i]) <= step, `${id} channel ${i}: ${maxError(c, signal[i])}`));
 const mono = await decodeAudioFile(await bytesOf(encodeAudio([signal[0].subarray(0, 333)], 44100, id)), noBrowser);
 assert.equal(mono.channels[0].length, 333, `${id} odd-length mono`);
 assert.equal(mono.sampleRate, 44100, `${id} mono rate`);

 // Core Audio (Logic, GarageBand, Finder) must accept the file and report the same layout.
 if (process.platform === 'darwin') {
  const path = join(dir, `${id}.${f.ext}`);
  writeFileSync(path, bytes);
  const info = execFileSync('afinfo', [path], { encoding: 'utf8' });
  assert.match(info, new RegExp(`2 ch, +${rate} Hz`), `${id}: ${info}`);
  assert.match(info, f.float ? /32-bit little-endian float|Float32/ : new RegExp(`${f.bits}-bit (big|little)-endian signed integer|Int${f.bits}`), `${id}: ${info}`);
  assert.match(info, new RegExp(`${frames} sample frames|audio packets: ${frames}`), `${id}: ${info}`);
 }
}

// Files written by Core Audio, including layouts this app never writes (AIFC, AIFC float, 32-bit int, 8-bit), decode the same.
if (process.platform === 'darwin') {
 const source = join(dir, 'source.wav');
 writeFileSync(source, await bytesOf(encodeAudio(signal, rate, 'wav32f')));
 const cases = [['WAVE', 'LEI16', 'wav', 16], ['WAVE', 'LEI24', 'wav', 24], ['WAVE', 'LEI32', 'wav', 32], ['WAVE', 'UI8', 'wav', 8], ['WAVE', 'LEF64', 'wav', 0],
  ['AIFF', 'BEI16', 'aif', 16], ['AIFF', 'BEI24', 'aif', 24], ['AIFF', 'BEI8', 'aif', 8], ['AIFC', 'BEI16', 'aifc', 16], ['AIFC', 'BEF32', 'aifc', 0]];
 for (const [type, data, ext, bits] of cases) {
  const path = join(dir, `ca-${type}-${data}.${ext}`);
  execFileSync('afconvert', ['-f', type, '-d', data, source, path]);
  const back = await decodeAudioFile(new Uint8Array(readFileSync(path)), noBrowser);
  assert.equal(back.sampleRate, rate, path);
  assert.equal(back.channels[0].length, frames, path);
  const step = bits ? 2 / 2 ** bits : 1e-7;
  back.channels.forEach((c, i) => assert.ok(maxError(c, signal[i]) <= step, `${type} ${data} channel ${i}: ${maxError(c, signal[i])}`));
 }
}

// MIDI: a written file reads back note for note, and other tools' files with running status and tempo changes parse.
const notes = [{ midi: 60, velocity: 1, start: 0, end: 0.5 }, { midi: 64, velocity: 0.5, start: 0.5, end: 1 }, { midi: 60, velocity: 0.75, start: 0.5, end: 4.25 }];
const song = readMidi(await bytesOf(writeMidi({ name: 'Test', bpm: 90, tracks: [{ name: 'Synth', notes }] })));
assert.equal(song.name, 'Test');
assert.equal(song.bpm, 60e6 / Math.round(60e6 / 90));
assert.equal(song.barBeats, 4);
assert.deepEqual(song.notes.map(n => [n.midi, n.start, n.end, Math.round(n.velocity * 127)]), [[60, 0, 0.5, 127], [60, 0.5, 4.25, 95], [64, 0.5, 1, 64]]);
assert.ok(Math.abs(song.notes[1].endSec - 4.25 * 60 / 90) < 1e-3);

const tempoMap = readMidi(await bytesOf(writeMidi({ bpm: 120, tempos: [{ beat: 0, bpm: 120 }, { beat: 2, bpm: 60 }], tracks: [{ notes: [{ midi: 70, velocity: 0.5, start: 3, end: 4 }] }] })));
assert.ok(Math.abs(tempoMap.notes[0].startSec - 2) < 1e-6, 'two beats at 120 then one at 60');
assert.ok(Math.abs(tempoMap.notes[0].endSec - 3) < 1e-6);

// Hand-built format 0 file: running status, note-on velocity 0 as note-off, 3/4 time, a controller and a sysex.
const track = [0, 0xff, 0x58, 4, 3, 2, 24, 8, 0, 0xf0, 2, 1, 0xf7, 0, 0xb0, 7, 100, 0, 0x90, 62, 80, 96, 62, 0, 0, 65, 90, 0x83, 0x60, 65, 0, 0, 0xff, 0x2f, 0];
const smf = new Uint8Array([...'MThd'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 6, 0, 0, 0, 1, 0, 96], [...'MTrk'].map(c => c.charCodeAt(0)), [0, 0, 0, track.length], track));
const raw = readMidi(smf);
assert.equal(raw.barBeats, 3);
assert.deepEqual(raw.notes.map(n => [n.midi, n.start, n.end]), [[62, 0, 1], [65, 1, 6]]);
assert.throws(() => readMidi(new Uint8Array(20)), /Not a Standard MIDI File/);

console.log('Audio and MIDI formats: all checks passed.');
