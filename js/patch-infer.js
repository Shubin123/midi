// A patch for the built-in synth that sounds like a recorded note (the Sound match widget, js/sound-match.js):
// - analyzeNote reads the note: its pitch (MPM), its level over time (attack, decay, sustain and release, read
//   the way the synth's envelope draws them), its harmonics in the steady part, how much of it is noise, and
//   how bright it is.
// - guessPatch makes a first patch from that: the waveform whose series of harmonics fits the lowest ones
//   (a sine has one, a triangle odd ones falling fast, a square odd ones falling slowly, a sawtooth all of
//   them), a lowpass where the harmonics fall away faster than that waveform's, with resonance for a bump at
//   it, noise for what isn't harmonic, and the envelope as measured.
// - inferPatch refines it by listening to its own guesses: each candidate is rendered offline exactly as the
//   synth plays a note (renderPatch: the oscillator bank's own buildVoice, the envelope as synth.js schedules
//   it, the filter) and compared with the recording by a multi-resolution spectral distance (STFTs of 512,
//   1024 and 2048 samples: spectral convergence plus log-magnitude difference, on loudness-matched sound). The
//   waveform is chosen first, and a second oscillator (an octave up or down); then the envelope, filter, the two
//   oscillators' levels and detune, and noise move by coordinate descent, each step halving when nothing
//   improves; then the waveforms are tried again, and the dials once more. It is a search, so the
//   match is reported (0-100%), with the first guess's for comparison.
import { FFT, Pitch, dbOf } from './listen-dsp.js';
import { buildVoice, noiseBuffer } from './oscillators.js';

export const SHAPES = ['sine', 'triangle', 'square', 'sawtooth'];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const seeded = (seed = 9) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

/* ---- Rendering a patch's note ---- */

// patch: { oscillators: [...] (as the bank keeps them), adsr: { enabled, attack, decay, sustain, release },
// filter: { enabled, type, cutoff, resonance } }. A note at `hz`, held `hold` s and let go, as synth.js plays one
// (velocity 0.7, no slop, the same noise every time). Returns mono samples.
export async function renderPatch(patch, { hz, hold, sampleRate, velocity = 0.7, seconds = null }) {
 const a = patch.adsr, rel = a.enabled ? a.release : 0.001, length = seconds ?? hold + Math.min(rel * 1.2, 4) + 0.05;
 const ctx = new OfflineAudioContext(1, Math.max(128, Math.ceil(length * sampleRate)), sampleRate);
 const amp = new GainNode(ctx, { gain: 0 }), g = amp.gain;
 // The envelope up to the release, then from where it had got to down to silence (an exponential ramp to 0.0001).
 let at;
 if (a.enabled) {
  const atk = a.attack, dcy = a.decay, sus = a.sustain * velocity;
  g.setValueAtTime(0, 0);
  if (hold <= atk) { at = (velocity * hold) / atk; g.linearRampToValueAtTime(at, hold); }
  else { g.linearRampToValueAtTime(velocity, atk); if (hold <= atk + dcy) { at = velocity + ((sus - velocity) * (hold - atk)) / dcy; g.linearRampToValueAtTime(at, hold); } else { g.linearRampToValueAtTime(sus, atk + dcy); g.setValueAtTime(sus, hold); at = sus; } }
 } else { g.setValueAtTime(0, 0); g.linearRampToValueAtTime(velocity, 0.001); g.setValueAtTime(velocity, hold); at = velocity; }
 g.exponentialRampToValueAtTime(0.0001, hold + rel);
 let out = amp;
 if (patch.filter.enabled) { const f = new BiquadFilterNode(ctx, { type: patch.filter.type, frequency: patch.filter.cutoff, Q: patch.filter.resonance }); amp.connect(f); out = f; }
 out.connect(ctx.destination);
 buildVoice(ctx, patch.oscillators, { frequency: hz, when: 0, slop: 0, noise: noiseBuffer(ctx, seeded()), out: amp }).forEach(l => l.source.stop(length));
 return (await ctx.startRendering()).getChannelData(0);
}

/* ---- Reading the note ---- */

// The level every 5 ms (RMS), in linear units.
function envelope(x, sampleRate, hopMs = 5) {
 const hop = Math.round((sampleRate * hopMs) / 1000), out = [];
 for (let i = 0; i + hop <= x.length; i += hop) { let e = 0; for (let j = i; j < i + hop; j++) e += x[j] * x[j]; out.push(Math.sqrt(e / hop)); }
 return { env: out, hopMs };
}
// Harmonic amplitudes (relative to the strongest) and how much of the spectrum lies between them, over a window.
function harmonics(x, sampleRate, hz, count = 24) {
 const n = 2 ** Math.min(15, Math.ceil(Math.log2(Math.min(x.length, sampleRate * 0.5)))), fft = new FFT(n), re = new Float64Array(n), im = new Float64Array(n);
 for (let i = 0; i < n && i < x.length; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
 fft.transform(re, im);
 const mag = k => Math.hypot(re[k], im[k]), bin = (hz * n) / sampleRate, amps = [];
 let onHarmonics = 0, total = 0;
 for (let k = 1; k < n / 2 && (k * sampleRate) / n < 8000; k++) total += mag(k) ** 2;
 for (let h = 1; h <= count && h * hz < sampleRate / 2 - 100; h++) {
  const c = Math.round(h * bin);
  let best = 0;
  for (let k = Math.max(1, c - 3); k <= c + 3; k++) best = Math.max(best, mag(k));
  amps.push(best);
  for (let k = Math.max(1, Math.round(c - bin / 4)); k <= Math.round(c + bin / 4); k++) if ((k * sampleRate) / n < 8000) onHarmonics += mag(k) ** 2;
 }
 const top = Math.max(...amps, 1e-12);
 return { amps: amps.map(a => a / top), noise: clamp(1 - onHarmonics / (total || 1), 0, 1) };
}

// Reads a recorded note (mono). Returns { hz, midi, onset, hold, ends, adsr, harmonics, noise, brightness, peak }
// (times in seconds from the start of the samples; `ends` when it has faded away), or throws if there is no note.
export function analyzeNote(x, sampleRate) {
 const { env, hopMs } = envelope(x, sampleRate), dt = hopMs / 1000;
 const peak = Math.max(...env);
 if (!(peak > 1e-4)) throw new Error('The recording is silent.');
 let on = env.findIndex(v => v > peak * 0.05);
 let top = on; for (let i = on; i < env.length && i < on + 2 / dt; i++) if (env[i] > env[top]) top = i;
 // The release, read backwards from where the note is 40 dB down: the synth's release falls in a straight line
 // in dB, so it began where the level stops falling at (most of) that rate.
 const D = env.map(dbOf), top40 = D[top] - 40;
 let i40 = env.length - 1; while (i40 > top && D[i40] < top40) i40--;
 const fit = (i0, i1) => { const m = i1 - i0 + 1, mt = (i0 + i1) / 2; let my = 0; for (let i = i0; i <= i1; i++) my += D[i]; my /= m; let num = 0, den = 0; for (let i = i0; i <= i1; i++) { num += (i - mt) * (D[i] - my); den += (i - mt) ** 2; } return den ? num / den : 0; };
 const rate = fit(Math.max(top, i40 - 12), i40); // dB a frame, below zero
 let end = i40;
 while (end - 4 > top && rate < -0.05 && fit(end - 4, end) < rate * 0.6) end--;
 // The sustain level: the median between the decay and the release.
 const mid = env.slice(top, end + 1), sus = mid.length > 4 ? median(mid.slice(Math.floor(mid.length * 0.5))) : env[top];
 // Decay: from the peak until 90% of the way to the sustain level.
 let d = top; while (d < end && env[d] > sus + (env[top] - sus) * 0.1) d++;
 // The release falls from the gain the sustain is at (the velocity, 0.7, times the level relative to the peak)
 // to 0.0001: that many dB, at the slope measured.
 const slope = -rate / dt, release = slope > 1 ? clamp((dbOf(sus) - dbOf(peak) + dbOf(0.7) + 80) / slope, 0.005, 5) : 0.05;
 let last = env.length - 1; while (last > end && env[last] < peak * 1e-3) last--;
 const attack = clamp((top - on) * dt, 0.001, 2), decay = clamp((d - top) * dt, 0.001, 2), sustain = clamp(sus / env[top], 0, 1);
 // Pitch and harmonics over the steady part (or what there is of it).
 const s0 = Math.round((top + Math.max(2, (end - top) * 0.2)) * dt * sampleRate), s1 = Math.max(s0 + 4096, Math.round(end * dt * sampleRate));
 const steady = x.subarray(Math.min(s0, x.length - 4096), Math.min(x.length, s1));
 const pitch = new Pitch(2048, sampleRate, { minHz: 30, maxHz: 3000 }), reads = [];
 for (let i = 0; i + 2048 <= steady.length; i += 1024) { const p = pitch.detect(steady.subarray(i, i + 2048)); if (p.clarity > 0.6) reads.push(p.hz); }
 if (!reads.length) throw new Error('No pitch was found: record one clear note.');
 const hz = median(reads), h = harmonics(steady, sampleRate, hz);
 const centroid = h.amps.reduce((a, v, i) => a + v * (i + 1), 0) / h.amps.reduce((a, v) => a + v, 0);
 return { hz, midi: 69 + 12 * Math.log2(hz / 440), onset: on * dt, hold: Math.max(0.05, (end - on) * dt), ends: (last - on) * dt + 0.05, adsr: { enabled: true, attack, decay, sustain, release }, harmonics: h.amps, noise: h.noise, brightness: centroid, peak };
}

/* ---- A first guess ---- */

// Each waveform's harmonic series (amplitudes relative to the first).
export const series = (shape, h) => (shape === 'sine' ? (h === 1 ? 1 : 0) : shape === 'triangle' ? (h % 2 ? 1 / (h * h) : 0) : shape === 'square' ? (h % 2 ? 1 / h : 0) : 1 / h);
const OSC = { waveform: 'sawtooth', octave: 0, detune: 0, level: 0.7, delay: 0, pulseWidth: 0.5, on: true };
export function guessPatch(a) {
 const amps = a.harmonics, h = i => amps[i - 1] ?? 0;
 const even = (h(2) + h(4)) / (h(1) || 1e-9), odd3 = h(3) / (h(1) || 1e-9);
 const shape = even < 0.12 && odd3 < 0.06 ? 'sine' : even < 0.12 ? (odd3 < 0.2 ? 'triangle' : 'square') : 'sawtooth';
 // Where the harmonics fall below the waveform's own series by 3 dB (relative to the lowest ones): the cutoff;
 // a rise above it just before: resonance.
 const ratio = amps.map((v, i) => { const s = series(shape, i + 1); return s > 0.004 ? v / s : null; });
 const ref = median(ratio.slice(0, 3).filter(r => r !== null)) || 1;
 let cut = null, bump = 1, bumpAt = -1;
 ratio.forEach((r, i) => { if (r === null || cut !== null) return; const rel = r / ref; if (rel > bump) { bump = rel; bumpAt = i; } if (rel < 0.7) cut = (i + 0.5) * a.hz; });
 if (cut === null && bump > 1.5) cut = (bumpAt + 1) * a.hz; // a resonant peak, with too little above it to see the fall
 const filter = cut ? { enabled: true, type: 'lowpass', cutoff: clamp(cut, 60, 18000), resonance: clamp(bump, 0.7, 12) } : { enabled: false, type: 'lowpass', cutoff: 18000, resonance: 0.7 };
 const oscillators = [{ ...OSC, waveform: shape, level: 0.7 }];
 // Noise is always there for the search to turn up, sounding only if the note has much between its harmonics.
 oscillators.push({ ...OSC, waveform: 'white', level: a.noise > 0.25 ? clamp(a.noise * 0.5, 0.02, 0.6) : 0, on: a.noise > 0.25 });
 return { oscillators, adsr: { ...a.adsr }, filter };
}

/* ---- How alike two sounds are ---- */

const ffts = new Map();
function stft(x, n) {
 const hop = n / 4, fft = ffts.get(n) || ffts.set(n, new FFT(n)).get(n), re = new Float64Array(n), im = new Float64Array(n), frames = [];
 const win = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
 for (let s = 0; s + n <= x.length; s += hop) {
  for (let i = 0; i < n; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
  fft.transform(re, im);
  const mag = new Float32Array(n / 2); for (let k = 0; k < n / 2; k++) mag[k] = Math.hypot(re[k], im[k]); frames.push(mag);
 }
 return frames;
}
const rmsOf = x => { let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i]; return Math.sqrt(e / (x.length || 1)) || 1e-9; };
// Multi-resolution STFT distance between two sounds of the same length (the shorter one decides), each scaled to
// the same loudness first: for each of three sizes, spectral convergence (how far the magnitudes are apart,
// relative to the target's) plus the mean difference of log magnitudes. 0 is identical.
export function spectralDistance(target, candidate, sizes = [512, 1024, 2048]) {
 const n = Math.min(target.length, candidate.length), ta = target.subarray(0, n), ca = candidate.subarray(0, n), gt = 1 / rmsOf(ta), gc = 1 / rmsOf(ca);
 const t = Float32Array.from(ta, v => v * gt), c = Float32Array.from(ca, v => v * gc);
 let total = 0;
 for (const size of sizes) {
  const A = stft(t, size), B = stft(c, size);
  let diff = 0, ref = 0, logs = 0, count = 0;
  for (let f = 0; f < A.length; f++) for (let k = 0; k < A[f].length; k++) {
   const a = A[f][k], b = B[f][k];
   diff += (a - b) ** 2; ref += a * a; logs += Math.abs(Math.log(a + 1e-3) - Math.log(b + 1e-3)); count++;
  }
  total += Math.sqrt(diff / (ref || 1)) + logs / (count || 1);
 }
 return total / sizes.length;
}
// A distance as a match, 0-100%: 0.35 (a close render) is about 90%, a different waveform and envelope 30-50%.
export const matchOf = d => Math.round(100 * Math.exp(-d / 3.3));

/* ---- The search ---- */

// Continuous settings, each on a scale where one step means about the same change of sound.
const DIALS = [
 { name: 'attack', get: p => Math.log(p.adsr.attack), set: (p, v) => { p.adsr.attack = clamp(Math.exp(v), 0.001, 2); }, step: 0.7 },
 { name: 'decay', get: p => Math.log(p.adsr.decay), set: (p, v) => { p.adsr.decay = clamp(Math.exp(v), 0.001, 2); }, step: 0.7 },
 { name: 'sustain', get: p => p.adsr.sustain, set: (p, v) => { p.adsr.sustain = clamp(v, 0, 1); }, step: 0.15 },
 { name: 'release', get: p => Math.log(p.adsr.release), set: (p, v) => { p.adsr.release = clamp(Math.exp(v), 0.001, 5); }, step: 0.7 },
 { name: 'cutoff', get: p => Math.log(p.filter.cutoff), set: (p, v) => { p.filter.cutoff = clamp(Math.exp(v), 40, 18000); p.filter.enabled = true; }, step: 0.5 },
 { name: 'resonance', get: p => Math.log(p.filter.resonance), set: (p, v) => { p.filter.resonance = clamp(Math.exp(v), 0.3, 20); }, step: 0.5 },
 { name: 'first', get: p => p.oscillators[0].level, set: (p, v) => { p.oscillators[0].level = clamp(v, 0.05, 1); }, step: 0.15, needs: p => p.oscillators[1]?.on && p.oscillators[1].waveform !== 'white' },
 { name: 'second', get: p => p.oscillators[1]?.level ?? 0, set: (p, v) => { p.oscillators[1].level = clamp(v, 0, 1); p.oscillators[1].on = v > 0.01; }, step: 0.2, needs: p => p.oscillators[1] && p.oscillators[1].waveform !== 'white' },
 { name: 'detune', get: p => p.oscillators[1]?.detune ?? 0, set: (p, v) => { p.oscillators[1].detune = clamp(v, -100, 100); }, step: 10, needs: p => p.oscillators[1]?.on && p.oscillators[1].waveform !== 'white' },
 { name: 'noise', get: p => p.oscillators.find(o => o.waveform === 'white')?.level ?? 0, set: (p, v) => { const o = p.oscillators.find(x => x.waveform === 'white'); o.level = clamp(v, 0, 1); o.on = v > 0.005; }, step: 0.1, needs: p => p.oscillators.some(o => o.waveform === 'white') },
];
const copy = p => JSON.parse(JSON.stringify(p));

// Finds a patch for a recorded note. Returns { patch, guess, distance, guessDistance, match, guessMatch, analysis,
// tried }. onProgress(fraction) as it goes; `budget` renders at most.
export async function inferPatch(samples, sampleRate, { onProgress = () => {}, budget = 200 } = {}) {
 const a = analyzeNote(samples, sampleRate);
 // The whole note, to where it fades below −60 dB of its peak (at most 3 s), so the search hears its tail.
 const from = Math.max(0, Math.round(a.onset * sampleRate)), length = Math.round(Math.min(3, Math.max(a.ends, a.hold + 0.1)) * sampleRate);
 const target = samples.subarray(from, Math.min(samples.length, from + length));
 let tried = 0;
 const score = async p => { tried++; onProgress(Math.min(0.99, tried / budget)); return spectralDistance(target, await renderPatch(p, { hz: a.hz, hold: a.hold, sampleRate, seconds: target.length / sampleRate })); };
 const guess = guessPatch(a), guessDistance = await score(guess);
 let best = copy(guess), bestD = guessDistance;
 const consider = async p => { const d = await score(p); if (d < bestD) { best = p; bestD = d; return true; } return false; };
 const shapes = async () => { for (const shape of SHAPES) if (shape !== best.oscillators[0].waveform) { const p = copy(best); p.oscillators[0].waveform = shape; await consider(p); } };
 let steps;
 // Every dial, by coordinate descent, until `until` renders have been made or nothing moves.
 const descend = async until => {
  for (let pass = 0; pass < 8 && tried < until; pass++) {
   let moved = false;
   for (const dial of DIALS) {
    if (tried >= until) break;
    if (dial.needs && !dial.needs(best)) continue;
    for (const dir of [1, -1]) {
     const p = copy(best); dial.set(p, dial.get(best) + dir * steps[dial.name]);
     if (await consider(p)) { moved = true; break; }
    }
   }
   if (!moved) for (const k in steps) steps[k] /= 2;
  }
 };
 // One search from a starting patch, using renders up to `until`.
 const search = async (start, until) => {
  best = copy(start); bestD = await score(best);
  steps = Object.fromEntries(DIALS.map(d => [d.name, d.step]));
  await shapes(); // the waveform first
  // A second oscillator of any waveform, an octave up or down. (A note with one an octave down is heard at the
  // lower pitch, so the louder may well be the one an octave up.)
  const plain = copy(best);
  for (const octave of [-1, 1]) for (const shape of SHAPES) {
   const p = copy(plain); p.oscillators.splice(1, 0, { ...OSC, waveform: shape, octave, level: octave > 0 ? 0.5 : 0.25 }); await consider(p);
  }
  // With two oscillators, their balance on a grid first: it is most of what a layered sound is.
  if (best.oscillators[1] && best.oscillators[1].waveform !== 'white') for (const level of [0.1, 0.25, 0.4, 0.55, 0.85, 1]) { const p = copy(best); p.oscillators[0].level = level; await consider(p); }
  // The dials, then the waveforms again with the envelope and filter nearer, then the dials again.
  await descend(tried + (until - tried) * 0.55);
  await shapes();
  if (best.oscillators[1] && best.oscillators[1].waveform !== 'white') for (const shape of SHAPES) if (shape !== best.oscillators[1].waveform) { const p = copy(best); p.oscillators[1].waveform = shape; await consider(p); }
  for (const k in steps) steps[k] = DIALS.find(d => d.name === k).step / 2;
  await descend(until);
  return { patch: best, d: bestD };
 };
 // Twice: from the guess, and from the guess with the filter open (a guessed resonance can be a trap), half the
 // renders each; the closer wins.
 const open = copy(guess); open.filter = { enabled: true, type: 'lowpass', cutoff: 12000, resonance: 0.7 };
 const first = await search(guess, budget / 2), second = await search(open, budget);
 ({ patch: best, d: bestD } = first.d <= second.d ? first : second);
 best.oscillators = best.oscillators.filter(o => o.on !== false && o.level > 0.005);
 onProgress(1);
 return { patch: best, guess, distance: bestD, guessDistance, match: matchOf(bestD), guessMatch: matchOf(guessDistance), analysis: a, tried };
}

// The patch in words.
export function describePatch(p) {
 const names = { sine: 'sine', triangle: 'triangle', square: 'square', sawtooth: 'sawtooth', pulse: 'pulse', white: 'noise', pink: 'pink noise' };
 const oscs = p.oscillators.map((o, i) => `${i ? `${names[o.waveform]}${o.waveform === 'white' ? '' : o.octave ? ` ${o.octave > 0 ? 'an octave up' : 'an octave down'}` : ''}${o.detune ? ` (${Math.round(o.detune)}¢)` : ''} at ${Math.round(o.level * 100)}%` : names[o.waveform]}`).join(' + ');
 const ms = s => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`), e = p.adsr;
 return `${oscs[0].toUpperCase()}${oscs.slice(1)}; ${p.filter.enabled ? `${p.filter.type} at ${p.filter.cutoff >= 1000 ? `${(p.filter.cutoff / 1000).toFixed(1)} kHz` : `${Math.round(p.filter.cutoff)} Hz`}, Q ${p.filter.resonance.toFixed(1)}` : 'no filter'}; attack ${ms(e.attack)}, decay ${ms(e.decay)}, sustain ${Math.round(e.sustain * 100)}%, release ${ms(e.release)}.`;
}
