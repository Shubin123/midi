// Listening: what the microphone (or a clip) hears, turned into the levels, pitches, onsets and notes the rest
// of the app already understands. All of it is arithmetic on samples, with no browser and no model, so the same
// code runs in the AudioWorklet (js/listen-worklet.js), offline over a whole clip, and in Node
// (tests/listening.mjs):
// - Pitch: McLeod's normalised square difference function (MPM) on a 43 ms window every 5 ms, with its clarity
//   (how periodic the window is, 0 to 1). The square differences come from an autocorrelation by FFT, so a
//   window costs two FFTs rather than a million multiplications.
// - Onsets: spectral flux (how much louder each frequency got since the last window, on a log scale, so it
//   doesn't depend on how loud you are) and the rise in level, each picked out against its own recent median.
// - Notes: NoteTracker turns the frames into note-ons and note-offs as a MIDI keyboard sends them. A note
//   starts once its pitch holds still for 25 ms (stamped with when it began, so a scoop up to the note is one
//   note, on time), follows the median of the last frames (so vibrato doesn't spray extra notes), changes only
//   when the pitch stays more than 0.6 of a semitone away for 80 ms, and ends after 60 ms of silence or noise.
//   It can snap each note to a key and scale.

export const A4 = 440;
export const toSemis = hz => 69 + 12 * Math.log2(hz / A4); // fractional MIDI note number: 69 is A 440
export const toHz = semis => A4 * 2 ** ((semis - 69) / 12);
// A run of pitches holds still: within 0.35 of a semitone and not sliding (a scoop into a note, or vibrato at its
// steepest, moves faster than 4 semitones a second).
const steadyRun = span => {
 if (span.length < 3) return false;
 const n = span.length, mt = span.reduce((a, x) => a + x.t, 0) / n, ms = span.reduce((a, x) => a + x.semis, 0) / n;
 let num = 0, den = 0;
 for (const x of span) { num += (x.t - mt) * (x.semis - ms); den += (x.t - mt) ** 2; }
 const lo = Math.min(...span.map(x => x.semis)), hi = Math.max(...span.map(x => x.semis));
 return hi - lo <= 0.35 && Math.abs(den ? (num / den) * 1000 : 0) <= 4;
};
const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
export const dbOf = rms => (rms > 1e-9 ? 20 * Math.log10(rms) : -180);

/* ---- FFT ---- */

// An in-place radix-2 complex FFT of one size, its twiddles and bit reversal worked out once.
export class FFT {
 constructor(n) {
  this.n = n; this.rev = new Uint32Array(n); this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
  for (let i = 0, bits = Math.log2(n); i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = Math.sin((2 * Math.PI * i) / n); }
 }
 // inverse leaves out the 1/n.
 transform(re, im, inverse = false) {
  const { n, rev, cos, sin } = this, s = inverse ? 1 : -1;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
   const half = size >> 1, step = n / size;
   for (let start = 0; start < n; start += size) {
    for (let k = 0; k < half; k++) {
     const wr = cos[k * step], wi = s * sin[k * step], a = start + k, b = a + half;
     const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
     re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
   }
  }
 }
}

/* ---- Pitch ---- */

// The window and hop for a sample rate: about 43 ms (two periods of a low bass voice) every 5 ms, as powers of
// two; onsets are judged on a window half as long, for timing.
export function frameSizes(sampleRate) {
 const size = 2 ** Math.round(Math.log2(sampleRate * 0.0427));
 return { size, hop: size / 8, fluxSize: size / 2 };
}

// MPM pitch of one window: { hz, clarity }, or { hz: 0, clarity } when nothing in range repeats. The normalised
// square difference n(τ) = 2r(τ) / m(τ) is 1 where the window repeats exactly every τ samples; of its peaks after
// the first dip below zero, the first within 93% of the highest is the period (an octave below it is also a
// period, and later peaks would pick it). The peak is refined by a parabola through its neighbours.
export class Pitch {
 constructor(size, sampleRate, { minHz = 50, maxHz = 2500, k = 0.93 } = {}) {
  this.size = size; this.sampleRate = sampleRate; this.k = k;
  this.minLag = Math.max(2, Math.floor(sampleRate / maxHz)); this.maxLag = Math.min(size - 2, Math.ceil(sampleRate / minHz));
  this.fft = new FFT(size * 2); this.re = new Float64Array(size * 2); this.im = new Float64Array(size * 2); this.nsdf = new Float64Array(size); this.xs = new Float64Array(size);
 }
 detect(x) {
  const { size, re, im, nsdf, xs, minLag, maxLag } = this;
  let mean = 0;
  for (let i = 0; i < size; i++) mean += x[i];
  mean /= size;
  re.fill(0); im.fill(0);
  for (let i = 0; i < size; i++) re[i] = x[i] - mean;
  // m(τ) = Σ x[j]² + x[j+τ]² over the overlap, from the energy down; r(τ) by the power spectrum.
  let m = 0;
  for (let i = 0; i < size; i++) m += 2 * re[i] * re[i];
  const energy = m;
  xs.set(re.subarray(0, size));
  this.fft.transform(re, im);
  for (let i = 0; i < re.length; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  this.fft.transform(re, im, true);
  const scale = 1 / re.length;
  for (let t = 0; t <= maxLag + 1; t++) {
   nsdf[t] = m > 1e-12 ? (2 * re[t] * scale) / m : 0;
   m -= xs[t] * xs[t] + xs[size - 1 - t] * xs[size - 1 - t];
  }
  if (energy < 1e-10) return { hz: 0, clarity: 0 };
  // Key maxima: the highest point of each positive lobe after n(τ) first goes below zero.
  let t = 1;
  while (t < maxLag && nsdf[t] > 0) t++;
  const peaks = [];
  let best = -1, at = -1;
  for (; t <= maxLag; t++) {
   if (nsdf[t] > 0) { if (nsdf[t] > best) { best = nsdf[t]; at = t; } }
   else if (at >= 0) { peaks.push([at, best]); best = -1; at = -1; }
  }
  if (at >= 0) peaks.push([at, best]);
  const inRange = peaks.filter(([lag]) => lag >= minLag && lag < maxLag);
  if (!inRange.length) return { hz: 0, clarity: 0 };
  const highest = Math.max(...inRange.map(p => p[1]));
  const [lag, value] = inRange.find(p => p[1] >= this.k * highest);
  const a = nsdf[lag - 1], b = nsdf[lag], c = nsdf[lag + 1], d = a - 2 * b + c;
  const shift = d < 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d))) : 0;
  return { hz: this.sampleRate / (lag + shift), clarity: Math.min(1, d < 0 ? b - ((a - c) * shift) / 4 : value) };
 }
}

/* ---- Frames ---- */

// Takes samples in chunks of any length (128 at a time in the worklet, a whole clip offline) and returns a frame
// for every hop: { end (the sample after the window, on the stream's own count), rms, db, peak, hz, clarity,
// flux, centroid (the spectrum's centre of mass in Hz: how bright it sounds) }.
export class Analyzer {
 constructor(sampleRate, opts = {}) {
  Object.assign(this, frameSizes(sampleRate), { sampleRate });
  this.pitch = new Pitch(this.size, sampleRate, opts);
  this.ring = new Float32Array(this.size); this.filled = 0; this.sinceHop = 0; this.count = null;
  this.window = new Float32Array(this.size);
  const f = this.fluxSize;
  this.hann = Float64Array.from({ length: f }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / f));
  this.fluxFft = new FFT(f); this.fre = new Float64Array(f); this.fim = new Float64Array(f); this.lastLog = new Float64Array(f / 2);
  this.bins = Math.min(f / 2, Math.ceil((8000 / sampleRate) * f)); // flux up to 8 kHz: above that it's mostly noise
 }
 // start: the stream's frame number of samples[0] (the worklet's currentFrame); counted on from there.
 push(samples, start = null) {
  if (start !== null) this.count = start; else this.count ??= 0;
  const out = [], n = this.size;
  for (let i = 0; i < samples.length; i++) {
   this.ring[this.filled % n] = samples[i]; this.filled++; this.count++;
   if (++this.sinceHop >= this.hop && this.filled >= n) { this.sinceHop = 0; out.push(this._frame()); }
  }
  return out;
 }
 _frame() {
  const n = this.size, w = this.window, at = this.filled % n;
  for (let i = 0; i < n; i++) w[i] = this.ring[(at + i) % n];
  let sum = 0, peak = 0;
  for (let i = 0; i < n; i++) { sum += w[i] * w[i]; peak = Math.max(peak, Math.abs(w[i])); }
  const rms = Math.sqrt(sum / n), db = dbOf(rms);
  // The level over the last hop's length, taken four times through the newest hop, so an onset can be placed
  // to a millisecond or so without the ripple of each cycle of a low note.
  const env = [], part = this.hop / 4;
  for (let j = 1; j <= 4; j++) { let e = 0; for (let i = n - 2 * this.hop + j * part; i < n - this.hop + j * part; i++) e += w[i] * w[i]; env.push(dbOf(Math.sqrt(e / this.hop))); }
  const { hz, clarity } = db > -90 ? this.pitch.detect(w) : { hz: 0, clarity: 0 };
  // Flux and brightness over the newest half of the window.
  const f = this.fluxSize, { fre, fim, hann, lastLog, bins } = this;
  for (let i = 0; i < f; i++) { fre[i] = w[n - f + i] * hann[i]; fim[i] = 0; }
  this.fluxFft.transform(fre, fim);
  let flux = 0, mass = 0, moment = 0;
  for (let k = 1; k < f / 2; k++) {
   const mag = Math.hypot(fre[k], fim[k]), log = Math.log1p(100 * mag);
   if (k < bins) { const d = log - lastLog[k]; if (d > 0) flux += d; }
   lastLog[k] = log; mass += mag; moment += mag * k;
  }
  return { end: this.count, rms, db, peak, hz, clarity, flux: flux / bins, centroid: mass > 1e-9 ? (moment / mass) * (this.sampleRate / f) : 0, env };
 }
}

// Every frame of a whole clip (mono samples).
export function analyze(samples, sampleRate, opts = {}) { return new Analyzer(sampleRate, opts).push(samples); }

// A frame's times in ms, given how to turn a stream frame number into ms: when the window ends, the middle of
// the pitch window, and the middle of the onset window (where a sudden sound shows most).
export function timed(frame, sizes, toMs) {
 const part = sizes.hop / 4;
 return { ...frame, t: toMs(frame.end), tPitch: toMs(frame.end - sizes.size / 2), tOnset: toMs(frame.end - sizes.fluxSize / 2), envAt: (frame.env || []).map((_, j) => toMs(frame.end - sizes.hop + (j + 1) * part - part * 2)) };
}

/* ---- Onsets ---- */

// Picks onsets from timed frames: a peak in the flux well above its median over the last 300 ms, or a jump in
// level of 9 dB within 30 ms, while above the gate, and never two within `minGapMs`. A peak is only known one
// frame later, so push() answers for the frame before: the onset's time in ms, or null. The time is then
// placed on the fine level envelope: where the level first comes within 12 dB of where it gets to (the flux
// window alone would put a soft attack up to 20 ms early).
export class OnsetDetector {
 constructor({ gateDb = -50, minGapMs = 60, delta = 0.12, ratio = 2.2, jumpDb = 9 } = {}) {
  Object.assign(this, { gateDb, minGapMs, delta, ratio, jumpDb });
  this.reset();
 }
 reset() { this.frames = []; this.env = []; this.last = -Infinity; }
 _place(t) {
  const win = this.env.filter(e => e.t >= t - 20), before = this.env.filter(e => e.t >= t - 45 && e.t < t - 12);
  if (!win.length) return t;
  const top = Math.max(...win.map(e => e.db)), floor = before.length ? Math.min(...before.map(e => e.db)) : -180;
  if (top - floor < 12) return t; // no rise to place it on (a change of note while the level holds)
  const at = win.find(e => e.db >= Math.max(floor + 6, top - 12));
  return at ? at.t : t;
 }
 push(f) {
  const fr = this.frames;
  fr.push(f);
  (f.env || []).forEach((db, j) => this.env.push({ t: f.envAt[j], db }));
  while (this.env.length && f.t - this.env[0].t > 120) this.env.shift();
  while (fr.length > 2 && f.t - fr[0].t > 300) fr.shift();
  if (fr.length < 3) return null;
  const prev = fr[fr.length - 3], cur = fr[fr.length - 2], next = f;
  const base = median(fr.slice(0, -2).map(x => x.flux));
  const fluxPeak = cur.flux >= prev.flux && cur.flux > next.flux && cur.flux > base * this.ratio + this.delta;
  const before = fr.filter(x => x.t < cur.t && cur.t - x.t <= 30);
  const jump = before.length && cur.db - Math.min(...before.map(x => x.db)) >= this.jumpDb;
  // Not while the level is falling: a note dying away smears its spectrum, which reads as flux.
  if ((fluxPeak || jump) && Math.max(cur.db, next.db) >= this.gateDb && next.db >= prev.db - 1) {
   const t = this._place(cur.tOnset);
   if (t - this.last >= this.minGapMs) { this.last = t; return t; }
  }
  return null;
 }
}

/* ---- Notes ---- */

// Scales by interval from the tonic, and the nearest note of one: snap(semis, key, intervals) → MIDI note.
export function snapToScale(semis, key, intervals) {
 const pcs = new Set(intervals.map(i => (i + key) % 12));
 const base = Math.round(semis);
 let best = base, dist = Infinity;
 for (let m = base - 2; m <= base + 2; m++) if (pcs.has(((m % 12) + 12) % 12) && Math.abs(m - semis) < dist) { dist = Math.abs(m - semis); best = m; }
 return best;
}

// Turns timed frames into notes. push(frame) returns the events it ends with, each { type: 'on' | 'off', midi,
// velocity, time }; `pitch` is always the latest reading for a tuner: { semis, midi, cents, clarity, voiced }.
// Options: `snap(semis) → midi` (a key and scale, else the nearest semitone), `ignore(midi)` (true for notes the
// app is sounding itself, which are then followed but not sent), the gate and the clarity a voice needs.
export class NoteTracker {
 constructor({ minClarity = 0.8, gateDb = -50, minHz = 50, maxHz = 2500, stableMs = 25, releaseMs = 60, gapMs = 20, changeMs = 80, hysteresis = 0.6, retriggerDb = 6, snap = null, ignore = null } = {}) {
  Object.assign(this, { minClarity, gateDb, minHz, maxHz, stableMs, releaseMs, gapMs, changeMs, hysteresis, retriggerDb, snap, ignore });
  this.onsets = new OnsetDetector({ gateDb });
  this.reset();
 }
 reset() {
  this.state = 'idle'; this.note = null; this.pending = null; this.recent = []; this.history = []; this.quietSince = null; this.changeSince = null; this.lastOnset = -Infinity; this.again = null;
  this.pitch = { semis: null, midi: null, cents: 0, clarity: 0, voiced: false };
  this.onsets.reset();
 }
 _pick(semis) { return this.snap ? this.snap(semis) : Math.round(semis); }
 // A voice from dB: the gate is quiet, 45 dB above it is full.
 _velocity(db) { return Math.max(0.1, Math.min(1, 0.2 + ((db - this.gateDb) / 45) * 0.8)); }
 push(f) {
  const events = [], onset = this.onsets.push(f);
  this.onset = onset; // for whoever also wants the onsets (a clap tapping the tempo)
  if (onset !== null) this.lastOnset = onset;
  const voiced = f.clarity >= this.minClarity && f.db >= this.gateDb && f.hz >= this.minHz && f.hz <= this.maxHz;
  const semis = voiced ? toSemis(f.hz) : null;
  this.history.push({ t: f.tPitch, semis, db: f.db });
  while (this.history.length && f.tPitch - this.history[0].t > 250) this.history.shift();
  this.recent.push(semis); if (this.recent.length > 5) this.recent.shift();
  const known = this.recent.filter(s => s !== null), smooth = known.length ? median(known) : null;
  const on = (midi, time, db) => {
   this.note = { midi, start: time, muted: !!this.ignore?.(midi), velocity: this._velocity(db) };
   if (!this.note.muted) events.push({ type: 'on', midi, velocity: this.note.velocity, time });
   this.state = 'on'; this.pending = null; this.changeSince = null; this.quietSince = null;
  };
  const off = time => { if (this.note && !this.note.muted) events.push({ type: 'off', midi: this.note.midi, velocity: 0, time: Math.max(time, this.note.start + 1) }); this.note = null; this.again = null; };
  if (this.state === 'idle' && voiced) {
   // It started at the onset heard with it; or, with none (yet: an onset is known a frame late), where the
   // level rose (the pitch window's middle is up to 20 ms early).
   const start = this.lastOnset >= f.tPitch - 80 && this.lastOnset <= f.t ? this.lastOnset : this.onsets._place(f.tPitch);
   this.pending = { start, list: [], miss: 0, peak: f.db, since: f.tPitch }; this.state = 'pending';
  }
  if (this.state === 'pending') {
   const p = this.pending;
   if (onset !== null && f.tPitch - p.since <= 40 && onset > p.start - 40) p.start = onset;
   if (!voiced) { if (++p.miss >= 3) { this.state = 'idle'; this.pending = null; } }
   else {
    p.miss = 0; p.list.push({ t: f.tPitch, semis }); p.peak = Math.max(p.peak, f.db);
    const span = p.list.filter(x => f.tPitch - x.t <= this.stableMs), mid = median(span.map(x => x.semis));
    const steady = f.tPitch - p.list[0].t >= this.stableMs && steadyRun(span);
    // A pitch that never settles (a long slide) still becomes a note after 150 ms, and changes as it moves.
    if (steady || f.tPitch - p.start > 150) on(this._pick(steady ? mid : smooth), p.start, p.peak);
   }
  } else if (this.state === 'on') {
   const n = this.note;
   const fresh = start => { this.pending = { start, list: [{ t: f.tPitch, semis }], miss: 0, peak: f.db, since: f.tPitch }; this.state = 'pending'; this.changeSince = null; };
   if (!voiced) {
    this.quietSince ??= f.tPitch;
    if (f.tPitch - this.quietSince >= this.releaseMs) { off(this.quietSince); this.state = 'idle'; }
   } else if (this.quietSince !== null && f.tPitch - this.quietSince >= this.gapMs) {
    // Back after a short gap (a breath, a consonant): that was the end of the note, and this is a new one.
    off(this.quietSince); fresh(this.lastOnset >= this.quietSince - 20 ? this.lastOnset : f.tPitch);
   } else {
    this.quietSince = null;
    // Sung again on the same note ("da da da"): an onset well into the note, out of a dip in level below what
    // the note had been, and the level coming back up within 40 ms (a note dying away has a dip too, but stays
    // down).
    if (onset !== null && onset - n.start > 90) {
     const typical = median(this.history.filter(h => h.t < onset - 60 && h.t >= n.start).map(h => h.db)), dip = Math.min(...this.history.filter(h => h.t >= onset - 60 && h.t <= onset + 15).map(h => h.db));
     if (Number.isFinite(typical) && typical - dip >= this.retriggerDb) this.again = { onset, dip };
    }
    if (this.again && f.tPitch - this.again.onset > 40 + this.stableMs) this.again = null;
    if (this.again && f.db - this.again.dip >= this.retriggerDb) { const at = this.again.onset; this.again = null; off(at); fresh(at); }
    else {
     // Moving to another note: once the pitch has been more than `hysteresis` away for `changeMs` and holds
     // still (a slide passing through a note doesn't stop on it), or after 200 ms of sliding.
     const want = this._pick(smooth);
     if (want !== n.midi && Math.abs(smooth - n.midi) > this.hysteresis) {
      this.changeSince ??= f.tPitch;
      const span = this.history.filter(h => f.tPitch - h.t <= this.stableMs && h.semis !== null), mid = median(span.map(h => h.semis));
      const steady = steadyRun(span) && this._pick(mid) !== n.midi;
      const since = f.tPitch - this.changeSince;
      if ((steady && since >= this.changeMs / 2) || since >= 200) {
       const to = steady ? this._pick(mid) : want;
       // It moved where the pitch came nearer the new note than the old one and stayed there (halfway between
       // the last frame on the old side and the first on the new, or after a gap), or at an onset close by.
       const h = this.history, nearer = x => x.semis !== null && Math.abs(x.semis - to) < Math.abs(x.semis - n.midi);
       let k = h.length - 1;
       while (k >= 0 && nearer(h[k])) k--;
       let j = k;
       while (j >= 0 && h[j].semis === null && h[k].t - h[j].t < 40) j--; // unclear frames between: the move is in them
       let moved = k < 0 || k === h.length - 1 ? this.changeSince : (h[Math.max(0, j)].t + h[k + 1].t) / 2;
       if (Math.abs(this.lastOnset - moved) <= 25) moved = this.lastOnset;
       const db = Math.max(...this.history.filter(h => h.t >= moved).map(h => h.db));
       off(moved); on(to, moved, db);
      }
     } else this.changeSince = null;
    }
   }
  }
  const shown = this.note?.midi ?? (semis !== null ? this._pick(semis) : null);
  this.pitch = { semis, midi: shown, cents: semis !== null && shown !== null ? (semis - shown) * 100 : 0, clarity: f.clarity, voiced, hz: voiced ? f.hz : 0, db: f.db };
  return events;
 }
 // Ends a note still held (the input stopped): its off at `time`.
 flush(time) { const events = []; if (this.note && !this.note.muted) events.push({ type: 'off', midi: this.note.midi, velocity: 0, time }); this.note = null; this.state = 'idle'; this.pending = null; return events; }
}

// Notes from a whole clip: [{ midi, velocity, start, end }] in ms from its first sample.
export function transcribe(samples, sampleRate, opts = {}) {
 const sizes = frameSizes(sampleRate), tracker = new NoteTracker(opts), notes = [], open = new Map();
 const toMs = frame => (frame / sampleRate) * 1000;
 const take = events => events.forEach(e => {
  if (e.type === 'on') open.set(e.midi, { midi: e.midi, velocity: e.velocity, start: e.time });
  else { const n = open.get(e.midi); if (n) { n.end = e.time; notes.push(n); open.delete(e.midi); } }
 });
 for (const f of analyze(samples, sampleRate, opts)) take(tracker.push(timed(f, sizes, toMs)));
 take(tracker.flush(toMs(samples.length)));
 return notes.sort((a, b) => a.start - b.start);
}

/* ---- Scoring (for the tests and the calibration) ---- */

// Note F-measure as transcription is usually scored: a detected note matches a reference note of the same pitch
// whose onset is within `tolerance` ms, each used once. Returns { precision, recall, f1, matched, onsetErrors }.
export function noteF1(reference, detected, tolerance = 50) {
 const used = new Set(), errors = [];
 for (const r of reference) {
  let best = -1, err = Infinity;
  detected.forEach((d, i) => { if (!used.has(i) && d.midi === r.midi && Math.abs(d.start - r.start) <= tolerance && Math.abs(d.start - r.start) < err) { err = Math.abs(d.start - r.start); best = i; } });
  if (best >= 0) { used.add(best); errors.push(detected[best].start - r.start); }
 }
 const precision = detected.length ? used.size / detected.length : 0, recall = reference.length ? used.size / reference.length : 0;
 return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, matched: used.size, onsetErrors: errors };
}

// The round trip from a click leaving the speakers to it being heard back: each click paired with the first onset
// heard 0-400 ms after it, and the median of those gaps (ms), with how far they spread. Null if fewer than half
// the clicks were heard.
export function roundTrip(clicks, onsets, maxMs = 400) {
 const gaps = clicks.map(c => onsets.find(o => o - c >= 0 && o - c <= maxMs)).map((o, i) => (o === undefined ? null : o - clicks[i])).filter(g => g !== null);
 if (gaps.length < Math.ceil(clicks.length / 2)) return null;
 const mid = median(gaps);
 return { ms: mid, spread: median(gaps.map(g => Math.abs(g - mid))), heard: gaps.length };
}
