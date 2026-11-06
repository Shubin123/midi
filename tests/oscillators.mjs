// The oscillator bank's settings, without a browser. How the oscillators sound is checked by rendering them:
// node tests/waveforms.mjs.
import assert from 'node:assert/strict';
import { normalize, DEFAULTS, DEFAULT_STACK, WAVEFORMS, RANGES, MAX_OSCILLATORS, isNoise } from '../js/oscillators.js';

const plain = ({ id, ...o }) => o;

// The default stack is the sound the fixed oscillators made: Oscillator 1 and 2 sawtooths at 0.7, the Sub a
// square two octaves down at 0.5, noise off.
assert.deepEqual(DEFAULT_STACK.map(plain), [
 { waveform: 'sawtooth', octave: 0, detune: 0, level: 0.7, delay: 0, pulseWidth: 0.5, on: true },
 { waveform: 'sawtooth', octave: 0, detune: 0, level: 0.7, delay: 0, pulseWidth: 0.5, on: true },
 { waveform: 'square', octave: -2, detune: 0, level: 0.5, delay: 0, pulseWidth: 0.5, on: true },
]);
assert.deepEqual(Object.keys(WAVEFORMS), ['sine', 'square', 'sawtooth', 'triangle', 'pulse', 'white', 'pink'], 'every waveform the old widgets had, noise included');
assert.ok(isNoise('white') && isNoise('pink') && !isNoise('pulse'));
assert.ok(MAX_OSCILLATORS >= 4);

// Settings are filled in and kept in range, whatever a saved bank or a control hands over.
assert.deepEqual(plain(normalize({})), DEFAULTS, 'nothing given: the defaults');
assert.deepEqual(plain(normalize({ waveform: 'kazoo', octave: 7, detune: -500, level: 3, delay: -1, pulseWidth: 0, on: false })),
 { waveform: 'sawtooth', octave: RANGES.octave[1], detune: RANGES.detune[0], level: 1, delay: 0, pulseWidth: RANGES.pulseWidth[0], on: false }, 'out of range: clamped');
assert.deepEqual(plain(normalize({ octave: '-1', detune: '12.5', level: '0.25', delay: '3', pulseWidth: '0.2' })),
 { ...DEFAULTS, octave: -1, detune: 12.5, level: 0.25, delay: 3, pulseWidth: 0.2 }, 'control values arrive as strings');
assert.equal(normalize({ octave: 1.6 }).octave, 2, 'octaves are whole');
assert.equal(normalize({ level: 'loud' }).level, DEFAULTS.level, 'not a number: the default');
assert.equal(normalize({ level: 0 }).level, 0, 'zero is kept, not replaced by the default');
const a = normalize({}), b = normalize({});
assert.notEqual(a.id, b.id, 'each oscillator has its own id');
assert.equal(normalize({ id: 'x', level: 0.1 }).id, 'x', 'and keeps it');

console.log('oscillators: all checks passed');
