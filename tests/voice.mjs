import assert from 'node:assert/strict';
import { sayable, stretch, speedFrom, Voice, ENGINES, SPEED } from '../js/voice.js';

// Replies are read aloud in talk mode; music notation is turned into words a speech voice says properly.
assert.equal(sayable('The ii–V–I in C is Dm7 → G7 → Cmaj7.'), 'The two, five, one in C is D minor seven, then G seven, then C major seven.');
assert.equal(sayable('Bb major uses Bb and Eb; F# minor; Bm7b5; C°7.'), 'B flat major uses B flat and E flat; F sharp minor; B minor seven flat five; C diminished seven.');
assert.equal(sayable('I-IV-V is the basis of blues.'), 'one, four, five is the basis of blues.');
assert.equal(sayable('D Dorian is A minor with a raised sixth.'), 'D Dorian is A minor with a raised sixth.', 'plain words untouched');
assert.equal(sayable('Add the blue note Eb to the A blues scale.'), 'Add the blue note E flat to the A blues scale.');
assert.equal(sayable('Strum **Am** then Gsus4.'), 'Strum A minor then G suspended 4.');

/* ---- How fast the teacher talks ---- */

// A voice-like test sound: 180 Hz with harmonics, its loudness rising and falling like syllables.
const RATE = 24000, voiced = Float32Array.from({ length: RATE }, (_, i) => { const t = i / RATE; return (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)) * (0.5 * Math.sin(2 * Math.PI * 180 * t) + 0.25 * Math.sin(2 * Math.PI * 360 * t + 1) + 0.12 * Math.sin(2 * Math.PI * 540 * t + 2)); });
// Its pitch, from the autocorrelation's peak between 80 and 400 Hz, over a stretch in the middle.
function pitch(x, rate) {
 const from = Math.floor(x.length / 2) - 2400, len = 2400;
 let best = 0, lag = 0;
 for (let l = Math.floor(rate / 400); l <= Math.ceil(rate / 80); l++) { let c = 0; for (let i = 0; i < len; i++) c += x[from + i] * x[from + i + l]; if (c > best) { best = c; lag = l; } }
 // Refine between samples with a parabola through the peak.
 const at = l => { let c = 0; for (let i = 0; i < len; i++) c += x[from + i] * x[from + i + l]; return c; };
 const [a, b, c] = [at(lag - 1), at(lag), at(lag + 1)];
 return rate / (lag + (a - c) / (2 * (a - 2 * b + c)));
}
const rms = x => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
assert.equal(stretch(voiced, RATE, 1), voiced, 'at its own speed the sound is left alone');
for (const speed of [0.5, 0.75, 1.25, 1.5, 2]) {
 const out = stretch(voiced, RATE, speed);
 assert.ok(Math.abs(out.length - RATE / speed) <= 1, `at ${speed}× it lasts ${out.length / RATE} s, not ${1 / speed} s`);
 const f = pitch(out, RATE);
 assert.ok(Math.abs(f / 180 - 1) < 0.01, `at ${speed}× the pitch moved to ${f.toFixed(1)} Hz`);
 assert.ok(Math.abs(rms(out) / rms(voiced) - 1) < 0.12, `at ${speed}× the loudness changed by ${((rms(out) / rms(voiced) - 1) * 100).toFixed(0)}%`);
 // No clicks: no sample jumps much further than the sound itself ever does.
 const jump = x => x.slice(1).reduce((m, v, i) => Math.max(m, Math.abs(v - x[i])), 0);
 assert.ok(jump(out) < jump(voiced) * 1.5, `at ${speed}× it clicks (a jump of ${jump(out).toFixed(3)})`);
}
assert.ok(Math.abs(pitch(voiced, RATE) - 180) < 0.5, 'the pitch measure itself is right');

// Asking out loud.
assert.equal(speedFrom('talk faster'), 1.25);
assert.equal(speedFrom('can you speak a little slower', 1.25), 1.15);
assert.equal(speedFrom('speak much slower'), 0.5);
assert.equal(speedFrom('voice speed 1.5'), 1.5);
assert.equal(speedFrom('read at 3x'), SPEED.max, 'held to 2×');
assert.equal(speedFrom('talk at normal speed', 1.6), 1);
assert.equal(speedFrom('slow down your voice', 1), 0.75);
for (const other of ['play it faster', 'make the tempo slower', 'set the speed to 90', 'speed up', 'what did you say about the filter?']) assert.equal(speedFrom(other), null, `"${other}" is not about the voice`);

// The browser's voice reads at the speed set; a neural voice's sentences are stretched to it.
{
 const spoken = [];
 globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
 globalThis.speechSynthesis = { getVoices: () => [], cancel() {}, speak: u => { spoken.push(u); setTimeout(() => u.onend?.(), 0); } };
 const v = new Voice({ lang: 'en-US' });
 v.setSpeed(1.4); await v.speak('Hello there.');
 assert.equal(spoken.at(-1).rate, 1.4, 'the browser voice reads at 1.4×');
 v.setSpeed(9); assert.equal(v.speed, SPEED.max, 'held to the slider\'s range');

 const played = [];
 globalThis.AudioContext = class {
  get currentTime() { return (this.t = (this.t || 0) + 5); } // time runs on: each look is five seconds later
  resume() {} get destination() { return {}; }
  createBuffer(ch, length, sampleRate) { return { length, duration: length / sampleRate, copyToChannel(d) { this.data = d; } }; }
  createBufferSource() { const src = { connect() {}, start() { played.push(src.buffer.length); }, stop() {} }; return src; }
 };
 ENGINES.fake = `data:text/javascript,${encodeURIComponent('export const ENGINE = { defaultVoice: "x" }; export async function load() {} export async function synthesize(text) { return { samples: new Float32Array(24000), sampleRate: 24000 }; }')}`;
 const n = new Voice();
 n.setVoice({ engine: 'fake', voice: 'x' }); n.setSpeed(1.5);
 await n.speak('One sentence. Another one.');
 assert.deepEqual(played, [16000, 16000], `each one-second sentence played ${played.map(p => p / 24000)} s at 1.5×`);
 n.setSpeed(1); played.length = 0;
 await n.speak('One sentence.');
 assert.deepEqual(played, [24000], 'and as made at 1×');
}

console.log('voice: all checks passed');
