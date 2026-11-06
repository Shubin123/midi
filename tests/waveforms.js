// The waveform lab: renders oscillators through the synth's own voice builder (js/oscillators.js buildVoice)
// on an OfflineAudioContext, so the real Web Audio engine makes every sample, and checks what comes out:
// the harmonics of each waveform against its Fourier series, pitch to a hundredth of a cent, levels, start
// delays, noise colour, layering, the full bank, and that the default stack sounds exactly as the fixed
// oscillators did. Each check also leaves a fingerprint (harmonic amplitudes and RMS) that is compared with
// tests/waveforms.golden.json, so any change to any waveform shows up. Rendering is offline, so the whole
// lab takes well under a second. Run it with `node tests/waveforms.mjs`, or open tests/waveforms.html.
import { buildVoice, normalize, noiseBuffer, DEFAULT_STACK, WAVEFORMS, MAX_OSCILLATORS } from '../js/oscillators.js';

export const RATE = 48000, F0 = 375; // a period of exactly 128 samples, so each harmonic falls on a DFT bin
const SKIP = 4800; // analysis starts 0.1 s in, past any start delay
// The same "random" numbers on every run: a Lehmer generator.
export const seeded = (seed = 1) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const NO_SLOP = () => 0.5; // buildVoice detunes by (random·2 − 1)·slop

// One note of `oscillators`, `seconds` long.
export async function render(oscillators, { frequency = F0, seconds = 0.4, slop = 0, random = NO_SLOP } = {}) {
 const ctx = new OfflineAudioContext(1, Math.round(RATE * seconds), RATE);
 const out = new GainNode(ctx);
 out.connect(ctx.destination);
 buildVoice(ctx, oscillators.map(normalize), { frequency, when: 0, slop, random, noise: noiseBuffer(ctx, seeded(7)), out });
 return (await ctx.startRendering()).getChannelData(0);
}

/* ---- Measuring ---- */

// Amplitudes of harmonics 1..n of f0, over a whole number of periods (f0 must divide the sample rate).
export function harmonics(x, f0 = F0, n = 8) {
 const period = RATE / f0, N = Math.floor((x.length - SKIP) / period) * period;
 return Array.from({ length: n }, (_, k) => {
  const w = (2 * Math.PI * (k + 1)) / period;
  let re = 0, im = 0;
  for (let i = 0; i < N; i++) { re += x[SKIP + i] * Math.cos(w * i); im += x[SKIP + i] * Math.sin(w * i); }
  return (2 * Math.hypot(re, im)) / N;
 });
}
export const rms = (x, from = SKIP) => { let s = 0; for (let i = from; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / (x.length - from)); };
export const peak = x => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
// The share of the time the wave is above zero.
export const dutyHigh = (x, from = SKIP) => { let n = 0; for (let i = from; i < x.length; i++) n += x[i] > 0; return n / (x.length - from); };
// Pitch from rising zero crossings, each placed between its two samples.
export function frequency(x, rate = RATE, from = SKIP) {
 let first = null, last = null, cycles = 0;
 for (let i = from + 1; i < x.length; i++) {
  if (x[i - 1] < 0 && x[i] >= 0) { const t = i - 1 - x[i - 1] / (x[i] - x[i - 1]); if (first === null) first = t; else cycles++; last = t; }
 }
 return cycles ? (rate * cycles) / (last - first) : 0;
}
export const cents = (f, ref) => 1200 * Math.log2(f / ref);
export const firstSound = (x, threshold = 1e-4) => x.findIndex(v => Math.abs(v) > threshold);
// The share of the energy above `hz`, from a Hann-windowed FFT of 8192 samples.
export function highShare(x, hz, from = SKIP) {
 const N = 8192, re = new Float64Array(N), im = new Float64Array(N);
 for (let i = 0; i < N; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
 for (let i = 1, j = 0; i < N; i++) { let b = N >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
 for (let len = 2; len <= N; len <<= 1) {
  const a = (-2 * Math.PI) / len;
  for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) {
   const c = Math.cos(a * k), s = Math.sin(a * k), p = i + k, q = p + len / 2;
   const tr = re[q] * c - im[q] * s, ti = re[q] * s + im[q] * c;
   re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
  }
 }
 let all = 0, high = 0;
 for (let k = 1; k < N / 2; k++) { const e = re[k] ** 2 + im[k] ** 2; all += e; if ((k * RATE) / N >= hz) high += e; }
 return high / all;
}
export const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const sumOf = parts => parts.reduce((acc, x) => acc.map((v, i) => v + x[i]));
const fingerprint = x => ({ h: harmonics(x).map(v => +v.toFixed(4)), rms: +rms(x).toFixed(4) });

/* ---- The fixed oscillators, as they were built before the bank ---- */

// A copy of the voice code the bank replaced (Oscillator 1, Oscillator 2, Sub, Noise), kept as the reference
// the default stack must match sample for sample. Its pulse was a sawtooth through this step.
function pulseCurve(width) {
 const c = new Float32Array(256), t = width * 2 - 1;
 for (let i = 0; i < 256; i++) c[i] = (i / 255) * 2 - 1 < t ? -1 : 1;
 return c;
}
function legacyVoice(ctx, p, note, now, noise, out) {
 const nodes = [];
 const o1 = ctx.createOscillator(); o1.type = p.osc1.waveform === 'pulse' ? 'sawtooth' : p.osc1.waveform;
 o1.frequency.setValueAtTime(note * Math.pow(2, p.osc1.detune / 1200), now);
 const g1 = ctx.createGain(); g1.gain.value = p.osc1.level;
 if (p.osc1.waveform === 'pulse') { const s = ctx.createWaveShaper(); s.curve = pulseCurve(p.osc1.pulseWidth); o1.connect(s).connect(g1); } else o1.connect(g1);
 g1.connect(out); o1.start(now); nodes.push(o1);
 if (p.osc2.enabled && p.osc2.level > 0) {
  const o2 = ctx.createOscillator(); o2.type = p.osc2.waveform === 'pulse' ? 'sawtooth' : p.osc2.waveform;
  o2.frequency.setValueAtTime(note * Math.pow(2, p.osc2.octaveOffset) * Math.pow(2, p.osc2.fineTune / 1200), now);
  const g2 = ctx.createGain(); g2.gain.value = p.osc2.level;
  if (p.osc2.waveform === 'pulse') { const s = ctx.createWaveShaper(); s.curve = pulseCurve(p.osc2.pulseWidth); o2.connect(s).connect(g2); } else o2.connect(g2);
  g2.connect(out); o2.start(now + p.osc2.delay / 1000); nodes.push(o2);
 }
 if (p.sub.enabled && p.sub.level > 0) {
  const s = ctx.createOscillator(); s.type = p.sub.waveform; s.frequency.setValueAtTime(note * Math.pow(2, p.sub.octave), now);
  const g = ctx.createGain(); g.gain.value = p.sub.level; s.connect(g).connect(out); s.start(now);
 }
 if (p.noise.enabled && p.noise.level > 0) {
  const n = ctx.createBufferSource(); n.buffer = noise; n.loop = true;
  const g = ctx.createGain(); g.gain.value = p.noise.level;
  if (p.noise.type === 'pink') { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(1500, now); f.Q.setValueAtTime(0.707, now); n.connect(f).connect(g); } else n.connect(g);
  g.connect(out); n.start(now);
 }
}
async function renderLegacy(p, seconds = 0.4) {
 const ctx = new OfflineAudioContext(1, Math.round(RATE * seconds), RATE);
 const out = new GainNode(ctx); out.connect(ctx.destination);
 legacyVoice(ctx, p, F0, 0, noiseBuffer(ctx, seeded(7)), out);
 return (await ctx.startRendering()).getChannelData(0);
}

/* ---- The checks ---- */

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = v => (Array.isArray(v) ? `[${v.map(fmt).join(', ')}]` : typeof v === 'number' ? +v.toFixed(5) : v);
// Harmonic n of each waveform, relative to the first: the Fourier series of the ideal shape.
const SERIES = {
 sine: n => (n === 1 ? 1 : 0),
 square: n => (n % 2 ? 1 / n : 0),
 sawtooth: n => 1 / n,
 triangle: n => (n % 2 ? 1 / n ** 2 : 0),
 pulse: (n, w) => Math.abs(Math.sin(Math.PI * n * w)) / (n * Math.sin(Math.PI * w)),
};

export const CHECKS = [];
const check = (name, fn) => CHECKS.push({ name, fn });

for (const waveform of ['sine', 'square', 'sawtooth', 'triangle']) {
 check(`${waveform}: harmonics follow its Fourier series`, async expect => {
  const x = await render([{ waveform, level: 0.7 }]), h = harmonics(x), ideal = h.map((_, i) => SERIES[waveform](i + 1));
  h.forEach((v, i) => expect(near(v / h[0], ideal[i], 0.02), `harmonic ${i + 1} is ${fmt(v / h[0])} of the first, not ${fmt(ideal[i])}`));
  expect(near(frequency(x), F0, 0.01), `pitch ${fmt(frequency(x))} Hz, not ${F0}`);
  return x;
 });
}
check('sine: level 0.7 is a sine of amplitude 0.7', async expect => {
 const x = await render([{ waveform: 'sine', level: 0.7 }]);
 expect(near(harmonics(x)[0], 0.7, 0.002), `amplitude ${fmt(harmonics(x)[0])}`);
 expect(near(peak(x), 0.7, 0.002), `peak ${fmt(peak(x))}`);
 return x;
});
// The analysed stretch cut to whole periods of f0, so averages don't depend on where a cycle is cut.
const periods = (x, f0 = F0) => { const p = RATE / f0; return x.subarray(SKIP, SKIP + Math.floor((x.length - SKIP) / p) * p); };
const mean = x => x.reduce((s, v) => s + v, 0) / x.length;
for (const width of [0.5, 0.25, 0.1, 0.75, 0.02, 0.98]) {
 // Very narrow pulses ring across zero (a band-limited pulse 2.5 samples wide), so the time spent high is only
 // measured from 0.1 to 0.9; the harmonics and the missing DC hold at every width.
 const timed = width >= 0.1 && width <= 0.9;
 check(`pulse, width ${width}: ${timed ? `high ${width} of each cycle, ` : ''}no DC, harmonics of that pulse`, async expect => {
  const x = await render([{ waveform: 'pulse', pulseWidth: width, level: 0.7 }]), h = harmonics(x), w = periods(x);
  if (timed) expect(near(dutyHigh(w, 0), width, 0.015), `high ${fmt(dutyHigh(w, 0))} of the time`);
  expect(Math.abs(mean(w)) < 0.001, `a DC offset of ${fmt(mean(w))}`);
  h.forEach((v, i) => expect(near(v / h[0], SERIES.pulse(i + 1, width), 0.01), `harmonic ${i + 1} is ${fmt(v / h[0])} of the first, not ${fmt(SERIES.pulse(i + 1, width))}`));
  return x;
 });
}
check('pulse, width 0.5: the same square as the old pulse made', async expect => {
 const p = { osc1: { waveform: 'pulse', detune: 0, level: 0.7, pulseWidth: 0.5 }, osc2: { enabled: false }, sub: { enabled: false }, noise: { enabled: false } };
 const [now, before] = await Promise.all([render([{ waveform: 'pulse', level: 0.7 }]), renderLegacy(p)]);
 const a = harmonics(now), b = harmonics(before);
 a.forEach((v, i) => expect(near(v, b[i], 0.03), `harmonic ${i + 1}: ${fmt(v)}, was ${fmt(b[i])}`));
});
check('white noise: flat, at the level of uniform noise', async expect => {
 const x = await render([{ waveform: 'white', level: 0.7 }]);
 expect(near(rms(x), 0.7 / Math.sqrt(3), 0.02), `RMS ${fmt(rms(x))}, not ${fmt(0.7 / Math.sqrt(3))}`);
 expect(near(highShare(x, 6000), 0.75, 0.05), `${fmt(highShare(x, 6000))} of its energy above 6 kHz, not about 0.75`);
 return x;
});
check('pink noise: rolled off above 1.5 kHz', async expect => {
 const x = await render([{ waveform: 'pink', level: 0.7 }]);
 expect(highShare(x, 6000) < 0.05, `${fmt(highShare(x, 6000))} of its energy above 6 kHz`);
 expect(rms(x) > 0.05 && rms(x) < 0.7 / Math.sqrt(3), `RMS ${fmt(rms(x))}`);
 return x;
});
check('level scales the wave', async expect => {
 const [a, b] = await Promise.all([render([{ waveform: 'sawtooth', level: 0.7 }]), render([{ waveform: 'sawtooth', level: 0.35 }])]);
 expect(near(rms(b) / rms(a), 0.5, 0.001), `half the level gives ${fmt(rms(b) / rms(a))} of the RMS`);
 expect(peak(await render([{ waveform: 'sawtooth', level: 0 }])) === 0, 'level 0 is silent');
});
check('octave: each step doubles or halves the pitch', async expect => {
 for (const octave of [-2, -1, 1, 2]) {
  const f = frequency(await render([{ waveform: 'sine', octave }]));
  expect(near(cents(f, F0 * 2 ** octave), 0, 0.01), `octave ${octave}: ${fmt(f)} Hz, not ${F0 * 2 ** octave}`);
 }
});
check('detune: cents up and down', async expect => {
 for (const detune of [100, 7, -37, -100]) {
  const f = frequency(await render([{ waveform: 'sine', detune }]));
  expect(near(cents(f, F0), detune, 0.01), `detune ${detune}: ${fmt(cents(f, F0))} cents`);
 }
});
check('slop: up to slop × 100 cents of drift, per oscillator', async expect => {
 const up = frequency(await render([{ waveform: 'sine' }], { slop: 0.05, random: () => 1 }));
 const down = frequency(await render([{ waveform: 'sine' }], { slop: 0.05, random: () => 0 }));
 expect(near(cents(up, F0), 5, 0.01) && near(cents(down, F0), -5, 0.01), `+${fmt(cents(up, F0))} and ${fmt(cents(down, F0))} cents, not ±5`);
});
check('start delay: silent until it starts', async expect => {
 const at = firstSound(await render([{ waveform: 'sine', delay: 20 }]));
 expect(Math.abs(at - 0.02 * RATE) <= 2, `starts at sample ${at}, not ${0.02 * RATE}`);
 expect(firstSound(await render([{ waveform: 'sine' }])) <= 2, 'no delay starts at once');
});
check('off: an oscillator switched off is silent', async expect => {
 expect(peak(await render([{ waveform: 'sawtooth', on: false }])) === 0, 'it still sounds');
});
check('layers: a stack is exactly the sum of its oscillators', async expect => {
 const stack = [{ waveform: 'sawtooth' }, { waveform: 'square', octave: -1, level: 0.4 }, { waveform: 'triangle', octave: 1, detune: 7, level: 0.3 }, { waveform: 'pulse', pulseWidth: 0.3, delay: 5, level: 0.2 }];
 const whole = await render(stack), parts = await Promise.all(stack.map(o => render([o])));
 expect(maxDiff(whole, sumOf(parts)) < 1e-5, `differs from the sum by ${fmt(maxDiff(whole, sumOf(parts)))}`);
 return whole;
});
check(`a full bank: ${MAX_OSCILLATORS} oscillators, every waveform, all sounding`, async expect => {
 const bank = [...Object.keys(WAVEFORMS), 'sine'].slice(0, MAX_OSCILLATORS).map((waveform, i) => ({ waveform, octave: (i % 5) - 2, detune: i * 3, level: 0.1 + i * 0.05, delay: i, pulseWidth: 0.2 }));
 const ctx = new OfflineAudioContext(1, RATE / 10, RATE);
 const layers = buildVoice(ctx, bank.map(normalize), { frequency: F0, noise: noiseBuffer(ctx), out: ctx.destination });
 expect(layers.length === MAX_OSCILLATORS, `${layers.length} layers built`);
 const whole = await render(bank), parts = await Promise.all(bank.map(o => render([o])));
 parts.forEach((p, i) => expect(rms(p) > 0.01, `oscillator ${i + 1} (${bank[i].waveform}) is silent`));
 expect(maxDiff(whole, sumOf(parts)) < 1e-5, `differs from the sum of its oscillators by ${fmt(maxDiff(whole, sumOf(parts)))}`);
 return whole;
});
check('the default stack sounds exactly as Oscillator 1, Oscillator 2 and the Sub did', async expect => {
 const legacy = { osc1: { waveform: 'sawtooth', detune: 0, level: 0.7, pulseWidth: 0.5 }, osc2: { enabled: true, waveform: 'sawtooth', octaveOffset: 0, fineTune: 0, delay: 0, level: 0.7, pulseWidth: 0.5 }, sub: { enabled: true, waveform: 'square', octave: -2, level: 0.5 }, noise: { enabled: false, type: 'white', level: 0 } };
 const [now, before] = await Promise.all([render(DEFAULT_STACK), renderLegacy(legacy)]);
 expect(maxDiff(now, before) < 1e-6, `differs by ${fmt(maxDiff(now, before))}`);
 return now;
});
check('every other legacy setting sounds the same in the bank (to below −80 dB)', async expect => {
 const legacy = { osc1: { waveform: 'square', detune: 7, level: 0.6, pulseWidth: 0.5 }, osc2: { enabled: true, waveform: 'triangle', octaveOffset: 1, fineTune: -12, delay: 10, level: 0.4, pulseWidth: 0.5 }, sub: { enabled: true, waveform: 'sine', octave: -1, level: 0.3 }, noise: { enabled: true, type: 'pink', level: 0.2 } };
 const bank = [{ waveform: 'square', detune: 7, level: 0.6 }, { waveform: 'triangle', octave: 1, detune: -12, delay: 10, level: 0.4 }, { waveform: 'sine', octave: -1, level: 0.3 }, { waveform: 'pink', level: 0.2 }];
 const [now, before] = await Promise.all([render(bank), renderLegacy(legacy)]);
 // Not to the last bit: the old code and the bank round detuned frequencies differently (about −100 dB).
 expect(maxDiff(now, before) < 1e-4, `differs by ${fmt(maxDiff(now, before))}`);
 return now;
});

// Runs every check. `golden` maps check names to fingerprints from an earlier run; a check whose wave has
// moved from its fingerprint (any harmonic or the RMS by more than 0.005) fails, unless `update` is set.
// Returns { passed, failed, checks: [{ name, ok, problems, fingerprint, ms }], ms }.
export async function runLab({ golden = null, update = false } = {}) {
 const t0 = performance.now(), checks = [];
 for (const { name, fn } of CHECKS) {
  const t = performance.now(), problems = [];
  let print = null;
  try {
   const x = await fn((ok, why) => { if (!ok) problems.push(why); });
   if (x) {
    print = fingerprint(x);
    const was = golden?.[name];
    if (was && !update) {
     const moved = [...was.h.map((v, i) => [`harmonic ${i + 1}`, v, print.h[i]]), ['RMS', was.rms, print.rms]].filter(([, a, b]) => !near(a, b, 0.005));
     moved.forEach(([what, a, b]) => problems.push(`${what} moved from ${a} to ${b} (tests/waveforms.golden.json)`));
    } else if (golden && !was && !update) problems.push('no fingerprint in tests/waveforms.golden.json yet: run node tests/waveforms.mjs --update');
   }
  } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems, fingerprint: print, ms: Math.round(performance.now() - t) });
 }
 return { passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, checks, ms: Math.round(performance.now() - t0) };
}
