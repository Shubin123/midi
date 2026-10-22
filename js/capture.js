// Plugin capture: measures any effect from a test signal rendered through it and fits a general model.
// Model: input -> static level-dependent curve -> stereo impulse response (a Hammerstein system).
// The impulse response comes from regularized FFT deconvolution of an exponential sweep; the curve from stepped sine levels.
import { encodeAudio } from './audio-files.js';
export const LAYOUT = { preroll: 0.5, sweep: 10, tail: 4, step: 0.25, levels: [-42, -39, -36, -33, -30, -27, -24, -21, -18, -15, -12, -9, -6, -3, 0], probeHz: 100, post: 1, sweepDb: -6, f1: 20 };
const dbToGain = db => 10 ** (db / 20);
const gainToDb = g => 20 * Math.log10(Math.max(g, 1e-12));

export function layout(sampleRate) {
 const s = x => Math.round(x * sampleRate);
 const sweepStart = s(LAYOUT.preroll), sweepLength = s(LAYOUT.sweep);
 const stepsStart = sweepStart + sweepLength + s(LAYOUT.tail), stepLength = s(LAYOUT.step);
 return { sweepStart, sweepLength, stepsStart, stepLength, length: stepsStart + stepLength * LAYOUT.levels.length + s(LAYOUT.post) };
}

function sweep(sampleRate) {
 const T = LAYOUT.sweep, f2 = sampleRate * 0.45, L = T / Math.log(f2 / LAYOUT.f1), n = Math.round(T * sampleRate), amp = dbToGain(LAYOUT.sweepDb);
 const x = new Float32Array(n), fade = Math.round(0.01 * sampleRate);
 for (let i = 0; i < n; i++) {
  const t = i / sampleRate, edge = Math.min(1, i / fade, (n - 1 - i) / fade);
  x[i] = amp * edge * Math.sin(2 * Math.PI * LAYOUT.f1 * L * (Math.exp(t / L) - 1));
 }
 return x;
}

// In-place iterative radix-2 FFT on Float64Arrays.
function fft(re, im, inverse = false) {
 const n = re.length;
 for (let i = 1, j = 0; i < n; i++) {
  let bit = n >> 1;
  for (; j & bit; bit >>= 1) j ^= bit;
  j ^= bit;
  if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
 }
 for (let len = 2; len <= n; len <<= 1) {
  const angle = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(angle), wi = Math.sin(angle), half = len >> 1;
  for (let i = 0; i < n; i += len) {
   let cr = 1, ci = 0;
   for (let k = 0; k < half; k++) {
    const a = i + k, b = a + half, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
    re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    const next = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = next;
   }
  }
 }
 if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// h = y / x in the frequency domain, regularized where the sweep has little energy.
function deconvolve(x, ys, size) {
 const xr = new Float64Array(size), xi = new Float64Array(size);
 xr.set(x); fft(xr, xi);
 let peak = 0; for (let k = 0; k < size; k++) peak = Math.max(peak, xr[k] ** 2 + xi[k] ** 2);
 const eps = peak * 1e-6;
 return ys.map(y => {
  const yr = new Float64Array(size), yi = new Float64Array(size);
  yr.set(y.subarray(0, Math.min(y.length, size))); fft(yr, yi);
  for (let k = 0; k < size; k++) {
   const d = xr[k] ** 2 + xi[k] ** 2 + eps, r = (yr[k] * xr[k] + yi[k] * xi[k]) / d, i = (yi[k] * xr[k] - yr[k] * xi[k]) / d;
   yr[k] = r; yi[k] = i;
  }
  fft(yr, yi, true);
  return yr;
 });
}

export function testSignal(sampleRate) {
 const L = layout(sampleRate), out = new Float32Array(L.length);
 out.set(sweep(sampleRate), L.sweepStart);
 const fade = Math.round(0.005 * sampleRate);
 LAYOUT.levels.forEach((db, k) => {
  const start = L.stepsStart + k * L.stepLength, amp = dbToGain(db);
  for (let i = 0; i < L.stepLength; i++) out[start + i] = amp * Math.min(1, i / fade, (L.stepLength - 1 - i) / fade) * Math.sin(2 * Math.PI * LAYOUT.probeHz * i / sampleRate);
 });
 return out;
}

export const encodeWav = (channels, sampleRate) => encodeAudio(channels, sampleRate, 'wav32f');

// Runs a Web Audio graph offline: render(ctx, source) wires source to ctx.destination.
async function offline(channels, sampleRate, length, wire) {
 const ctx = new OfflineAudioContext(2, length, sampleRate);
 const buffer = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
 channels.forEach((c, i) => buffer.copyToChannel(c, i));
 const src = ctx.createBufferSource(); src.buffer = buffer;
 wire(ctx, src); src.start();
 const out = await ctx.startRendering();
 return [out.getChannelData(0), out.getChannelData(1)];
}


// Builds the curve a WaveShaperNode needs from measured (input amplitude, gain) points.
export function shaperCurve(points, size = 4096) {
 const pts = [[0, points[0]?.[1] ?? 1], ...points].sort((a, b) => a[0] - b[0]);
 const gainAt = a => {
  let i = 1; while (i < pts.length - 1 && pts[i][0] < a) i++;
  const [a0, g0] = pts[i - 1], [a1, g1] = pts[i];
  return a1 === a0 ? g1 : g0 + (g1 - g0) * Math.min(1, Math.max(0, (a - a0) / (a1 - a0)));
 };
 const curve = new Float32Array(size);
 let last = 0;
 for (let i = size / 2; i < size; i++) { const x = (i - size / 2 + 0.5) / (size / 2); last = Math.max(last, x * gainAt(x)); curve[i] = last; curve[size - 1 - i] = -last; }
 return curve;
}

export const isLinear = points => points.every(([, g]) => Math.abs(20 * Math.log10(Math.max(g, 1e-12))) < 0.1);

const goertzel = (data, start, length, freq, sampleRate) => {
 const w = 2 * Math.PI * freq / sampleRate, c = 2 * Math.cos(w);
 let s1 = 0, s2 = 0;
 for (let i = start; i < start + length; i++) { const s0 = (data[i] || 0) + c * s1 - s2; s2 = s1; s1 = s0; }
 return 2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / length;
};

export async function analyze(recorded, sampleRate) {
 const L = layout(sampleRate);
 if (recorded[0].length < L.stepsStart) throw new Error(`The processed file is too short (${(recorded[0].length / sampleRate).toFixed(1)} s). Export the whole test signal, ${(L.length / sampleRate).toFixed(1)} s.`);
 const rec = recorded.length > 1 ? recorded.slice(0, 2) : [recorded[0], recorded[0]];
 const peak = Math.max(...rec.map(c => c.reduce((m, x) => Math.max(m, Math.abs(x)), 0)));
 if (peak < 1e-5) throw new Error('The processed file is silent. Check the plugin is on the track and not bypassed.');
 const region = L.stepsStart;
 const dry = new Float32Array(region); dry.set(sweep(sampleRate), L.sweepStart);
 let size = 1; while (size < region) size <<= 1;
 const h = deconvolve(dry, rec.map(c => c.subarray(0, region)), size);
 // Unwrap the circular result so index p0 is zero lag and the 0.4 s before it holds any pre-ringing.
 const p0 = Math.round(0.4 * sampleRate), span = p0 + Math.round(LAYOUT.tail * sampleRate);
 const deconv = h.map(c => Float32Array.from({ length: span }, (_, i) => c[(i - p0 + size) % size]));

 // Find where the response starts (plugin latency) and where its tail falls below -80 dB.
 const lo = 0, hi = span;
 let max = 0; for (const c of deconv) for (let i = lo; i < hi; i++) max = Math.max(max, Math.abs(c[i]));
 let onset = lo; while (onset < hi && deconv.every(c => Math.abs(c[onset]) < max * 0.01)) onset++;
 let end = hi - 1; while (end > onset && deconv.every(c => Math.abs(c[end]) < max * 1e-4)) end--;
 const start = Math.max(lo, onset - 48), length = Math.max(256, end - start + 256);
 const ir = deconv.map(c => c.slice(start, start + length));
 // shift: how far the model runs behind the plugin's own output (negative when plugin latency is removed).
 let main = 0; for (let i = 0; i < span; i++) if (deconv.some(c => Math.abs(c[i]) > Math.abs(c[main]))) main = i;
 const shift = p0 - start, pluginLatency = Math.max(0, main - p0);

 // Level-dependent gain from the stepped sines, relative to the linear response at the probe frequency.
 const w = 2 * Math.PI * LAYOUT.probeHz / sampleRate;
 let re = 0, im = 0; for (let n = 0; n < length; n++) { const h = (ir[0][n] + ir[1][n]) / 2; re += h * Math.cos(w * n); im -= h * Math.sin(w * n); }
 const linear = Math.hypot(re, im) || 1e-9;
 const mono = Float32Array.from(rec[0], (v, i) => (v + rec[1][i]) / 2);
 const measured = LAYOUT.levels.map((db, k) => {
  const a = dbToGain(db), from = L.stepsStart + k * L.stepLength + pluginLatency + Math.round(L.stepLength * 0.3);
  return [a, goertzel(mono, from, Math.round(L.stepLength * 0.5), LAYOUT.probeHz, sampleRate) / (a * linear)];
 });
 const sweepAmp = dbToGain(LAYOUT.sweepDb);
 const ref6 = measured.reduce((best, p) => Math.abs(p[0] - sweepAmp) < Math.abs(best[0] - sweepAmp) ? p : best)[1] || 1;
 let points = measured.map(([a, g]) => [a, Math.min(16, Math.max(0.01, g / ref6))]);

 // Verify: run the model on the test signal and compare with what the plugin produced. The level curve is kept
 // only if it beats the impulse response alone; time-varying plugins make the stepped-level measurement unreliable.
 const input = testSignal(sampleRate);
 const errorOf = async pts => {
  const model = await offline([input], sampleRate, input.length, (ctx, src) => {
   // No oversampling: Chrome's oversampled WaveShaper adds 128-192 samples of latency.
   const shaper = new WaveShaperNode(ctx, { curve: shaperCurve(pts), oversample: 'none' });
   const conv = new ConvolverNode(ctx, { disableNormalization: true });
   const b = ctx.createBuffer(2, length, sampleRate); ir.forEach((c, i) => b.copyToChannel(c, i)); conv.buffer = b;
   (isLinear(pts) ? src : src.connect(shaper)).connect(conv).connect(ctx.destination);
  });
  let err = 0, sig = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < input.length; i++) {
   const r = rec[c][i - shift] ?? 0;
   err += (r - model[c][i]) ** 2; sig += r * r;
  }
  return err / (sig || 1);
 };
 const flat = points.map(([a]) => [a, 1]);
 let esr = await errorOf(flat);
 if (!isLinear(points)) { const curved = await errorOf(points); if (curved < esr) esr = curved; else points = flat; }
 const spread = Math.max(...points.map(p => Math.abs(gainToDb(p[1]))));
 return {
  sampleRate, ir, points, latency: onset - start, shift, esr,
  report: { irSeconds: length / sampleRate, latencyMs: pluginLatency / sampleRate * 1000, levelSpreadDb: spread, accuracy: Math.max(0, 1 - esr),
   stereo: ir[0].some((v, i) => Math.abs(v - ir[1][i]) > 1e-4 * max) }
 };
}

export function verdict(esr) {
 if (esr < 0.01) return ['Excellent', 'The model matches the plugin closely.'];
 if (esr < 0.05) return ['Good', 'Small differences remain, usually from level-dependent tone changes.'];
 if (esr < 0.2) return ['Fair', 'The plugin changes over time or with level in ways one curve and one impulse response cannot hold.'];
 return ['Rough', 'This plugin is strongly time-varying (modulation, dynamics with attack and release, or randomness). The capture keeps its average tone and level behavior only.'];
}
