// Made-up sounds with known notes, for the listening tests in Node (tests/listening.mjs) and in the page
// (tests/listening-app.js): a voice (a buzz of harmonics shaped by the formants of "ah"), a whistle, plain
// waveforms, and a sung melody with vibrato, scoops up into notes, breaths and re-sung notes, all to the
// millisecond. Noise is from a seeded generator, so every run hears the same thing.

export const random = (seed = 1) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const hzOf = semis => 440 * 2 ** ((semis - 69) / 12);
// Harmonic weights of a sung "ah": formants near 700, 1220 and 2600 Hz over a source falling 6 dB an octave.
const formant = fh => 1 / (1 + ((fh - 700) / 150) ** 2) + 0.6 / (1 + ((fh - 1220) / 200) ** 2) + 0.3 / (1 + ((fh - 2600) / 300) ** 2) + 0.05;

// One sample of a waveform at phase `ph` (cycles) and frequency `f`.
function wave(kind, ph, f, sampleRate) {
 const p = ph % 1;
 if (kind === 'sine' || kind === 'whistle') return Math.sin(2 * Math.PI * p);
 if (kind === 'square') return p < 0.5 ? 0.8 : -0.8;
 let s = 0;
 const top = Math.min(sampleRate / 2, kind === 'voice' ? 6000 : 12000);
 for (let h = kind === 'hollow' ? 2 : 1; h * f < top; h++) {
  const w = kind === 'voice' || kind === 'hollow' ? formant(h * f) / h : 1 / h; // hollow: a voice with no fundamental
  s += w * Math.sin(2 * Math.PI * h * p);
 }
 return s * (kind === 'saw' ? 0.6 : 1);
}

// A steady tone of `secs` seconds.
export function tone(hz, secs, { kind = 'voice', sampleRate = 48000, amp = 0.3, noise = 0, seed = 7 } = {}) {
 const n = Math.round(secs * sampleRate), out = new Float32Array(n), r = random(seed);
 let ph = 0;
 for (let i = 0; i < n; i++) { ph += hz / sampleRate; out[i] = amp * wave(kind, ph, hz, sampleRate) * (kind === 'voice' ? 0.6 : 1) + noise * (r() * 2 - 1) + (kind === 'whistle' ? 0.01 * (r() * 2 - 1) : 0); }
 return out;
}

// A melody: notes { midi, start, end } in ms, each optionally with `amp`, `scoop` (semitones below, gliding up
// over 70 ms) and `dip` (a ms time inside the note where the level drops 15 dB for 40 ms: a consonant). Vibrato
// (cents) grows in over the first 200 ms of each note, as singers do. Returns mono samples.
export function sing(notes, { sampleRate = 48000, vibrato = 40, vibratoHz = 5.5, noise = 0.002, kind = 'voice', seed = 3, tail = 300 } = {}) {
 const total = Math.max(...notes.map(n => n.end)) + tail, N = Math.round((total / 1000) * sampleRate), out = new Float32Array(N), r = random(seed);
 let ph = 0, semis = notes[0].midi;
 const sorted = [...notes].sort((a, b) => a.start - b.start);
 let k = 0;
 for (let i = 0; i < N; i++) {
  const t = (i / sampleRate) * 1000;
  while (k < sorted.length - 1 && t >= sorted[k].end && t >= sorted[k + 1].start) k++;
  const n = sorted[k];
  let amp = 0;
  if (t >= n.start && t < n.end) {
   const into = t - n.start, left = n.end - t;
   amp = Math.min(1, into / 15) * Math.min(1, left / 20) * (n.amp ?? 1);
   if (n.dip !== undefined && t >= n.start + n.dip && t < n.start + n.dip + 40) amp *= 0.18;
   semis = n.midi - (n.scoop ?? 0) * Math.max(0, 1 - into / 70) + (n.bend ?? 0) + (vibrato / 100) * Math.sin((2 * Math.PI * vibratoHz * into) / 1000) * Math.min(1, into / 200);
  }
  const f = hzOf(semis);
  ph += f / sampleRate;
  out[i] = (amp ? 0.25 * amp * wave(kind, ph, f, sampleRate) * (kind === 'voice' ? 0.6 : 1) : 0) + noise * (r() * 2 - 1);
 }
 return out;
}

// "Twinkle, twinkle" (C D E F G, with a scoop or two, a breath, the same note sung again, and a legato step), in
// ms from the start: the reference every melody test scores against.
export function melody(start = 200) {
 const plan = [[60, 300, 80], [60, 300, 80], [67, 300, 70, { scoop: 0.8 }], [67, 300, 70], [69, 280, 60], [69, 280, 60], [67, 560, 140], [65, 300, 0], [64, 300, 0, { scoop: 0.6 }], [62, 300, 80], [62, 300, 80], [60, 600, 0]];
 const notes = [];
 let t = start;
 for (const [midi, len, gap, more = {}] of plan) { notes.push({ midi, start: t, end: t + len, ...more }); t += len + gap; }
 return notes;
}

// Claps at `times` (ms): a burst of noise that is loudest at once and gone in 60 ms, each `amp` loud (an array
// for each its own). A metronome's click is the same with a 25 ms decay.
export function claps(times, { sampleRate = 48000, amp = 0.5, decayMs = 60, noise = 0.001, seed = 11, tail = 300 } = {}) {
 const N = Math.round(((Math.max(...times) + tail) / 1000) * sampleRate), out = new Float32Array(N), r = random(seed);
 times.forEach((t, k) => {
  const a = Array.isArray(amp) ? amp[k] : amp, at = Math.round((t / 1000) * sampleRate), len = Math.round((decayMs / 1000) * sampleRate);
  for (let i = 0; i < len && at + i < N; i++) out[at + i] += a * (r() * 2 - 1) * Math.exp((-5 * i) / len);
 });
 for (let i = 0; i < N; i++) out[i] += noise * (r() * 2 - 1);
 return out;
}
