// Beat, tempo and rhythm, in three layers, all of it plain arithmetic on note times (no model, no browser):
// - Beat: one clock (BeatClock) that the metronome, the sequencer, an incoming MIDI clock (MidiClock) or, in
//   free play, the player's own pulse keeps; every note gets its offset from the nearest beat or subdivision,
//   graded against the difficulty's windows.
// - Tempo: the player's tempo from the gaps between notes (estimateTempo), and TempoWatch, which says when
//   they are rushing or dragging against the clock for a few notes running, and when they are back.
// - Rhythm: a finished phrase on a sixteenth grid, as a string per bar ("x..x..x.x...x...") with its timing
//   statistics, swing, syncopation and, against a target pattern, what was missed or added (rhythmSummary);
//   a profile of what keeps happening across phrases; and the next exercise.
// The teacher (js/teacher-bridge.js) has System 1 (Laya) choose the words of a nudge and System 2 explain a
// phrase from these summaries; js/timing-widget.js draws them. Times are milliseconds on one clock
// (performance.now() in the page).

/* ---- Layer 1: the beat ---- */

// How strict the grading is: within `good` ms is green, within `ok` amber, beyond red; `grid` is how many
// parts a beat is split into for the nearest point (2: eighths, 4: sixteenths).
export const DIFFICULTY = {
 easy: { label: 'Easy', good: 50, ok: 100, grid: 2 },
 normal: { label: 'Normal', good: 30, ok: 60, grid: 2 },
 hard: { label: 'Hard', good: 15, ok: 35, grid: 4 },
};
export const grade = (offsetMs, level = DIFFICULTY.normal) => (Math.abs(offsetMs) <= level.good ? 'good' : Math.abs(offsetMs) <= level.ok ? 'ok' : 'off');

// One beat for everything: `origin` is when beat 0 sounds, and the beats follow every 60000 / bpm ms. `source`
// says who keeps it: 'metronome', 'sequencer', 'midi', 'free' (the player's own pulse) or 'none'.
export class BeatClock {
 constructor({ beatsPerBar = 4 } = {}) { this.bpm = 120; this.origin = null; this.source = 'none'; this.beatsPerBar = beatsPerBar; }
 get running() { return this.origin !== null; }
 // A reference the player is asked to follow: anything but their own pulse.
 get external() { return this.running && this.source !== 'free'; }
 get period() { return 60000 / this.bpm; }
 start(source, bpm, at) { this.source = source; this.bpm = bpm; this.origin = at; }
 stop(source = this.source) { if (source === this.source) { this.source = 'none'; this.origin = null; } }
 // A new tempo from `now` on, the beat carrying on where it was rather than jumping.
 setTempo(bpm, now) { if (this.running) { const beat = this.beatAt(now); this.bpm = bpm; this.origin = now - beat * this.period; } else this.bpm = bpm; }
 beatAt(t) { return (t - this.origin) / this.period; }
 timeOf(beat) { return this.origin + beat * this.period; }
 // The nearest point of a grid of `sub` parts a beat: { at (in beats), beat (whole beat number), offsetMs }.
 nearest(t, sub = 1) { const k = Math.round(this.beatAt(t) * sub); return { at: k / sub, beat: Math.floor(k / sub), offsetMs: t - this.timeOf(k / sub) }; }
}

// An incoming MIDI clock: 24 ticks a beat, Start (the next tick is beat 0), Stop and Continue. USB MIDI ticks
// wander by a millisecond or two, so the tempo and the beat come from a straight line fitted through the last
// four beats of ticks, not from any one tick. A clock that was already running when we started listening
// counts its first tick as beat 0. Returns from tick() the { bpm, origin } to follow, or null until it has
// seen half a beat.
export const PPQN = 24;
export class MidiClock {
 constructor() { this.reset(); }
 reset() { this.ticks = []; this.count = 0; this.running = false; this.last = 0; }
 start(t) { this.reset(); this.running = true; this.last = t; }
 stop() { this.running = false; this.ticks = []; }
 continue(t) { this.running = true; this.ticks = []; this.last = t; }
 tick(t) {
  if (!this.running) { this.running = true; this.count = 0; } // a clock already going when we started listening
  if (this.ticks.length && t - this.last > 1000) this.ticks = []; // a pause: fit afresh
  this.ticks.push([this.count, t]); this.count++; this.last = t;
  if (this.ticks.length > PPQN * 4) this.ticks.shift();
  if (this.ticks.length < PPQN / 2) return null;
  // Least squares: t = a + b·k.
  const n = this.ticks.length, mk = this.ticks.reduce((s, [k]) => s + k, 0) / n, mt = this.ticks.reduce((s, [, x]) => s + x, 0) / n;
  let num = 0, den = 0;
  for (const [k, x] of this.ticks) { num += (k - mk) * (x - mt); den += (k - mk) ** 2; }
  const b = num / den, a = mt - b * mk;
  return { bpm: 60000 / (b * PPQN), origin: a, beat: Math.floor((this.count - 1) / PPQN), onBeat: (this.count - 1) % PPQN === 0 };
 }
}

/* ---- Layer 2: the tempo ---- */

// Notes struck within `chordMs` of each other are one event, a chord.
export function eventTimes(times, chordMs = 40) {
 const out = [];
 for (const t of [...times].sort((a, b) => a - b)) if (!out.length || t - out.at(-1) > chordMs) out.push(t);
 return out;
}
// The note values a gap between two events can be, in beats: from a sixteenth to a whole note, triplets too.
const VALUES = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.5, 2, 3, 4];
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
// The player's tempo from the last `n` gaps between events. Each gap is read as the nearest note value of the
// reference beat (a gap of 290 ms at 100 BPM is an eighth) and says what tempo it implies; the median of those
// is the tempo, so a mix of quarters and eighths, or one stray note, doesn't throw it. Gaps that fit no note
// value (a rest) are left out. With no reference (free play), the median gap, folded into 60–180 BPM, is the
// beat. Returns { bpm, n } or null with fewer than three gaps to go on.
export function estimateTempo(times, refBpm = null, n = 8) {
 const ev = eventTimes(times).slice(-(n + 1)), gaps = ev.slice(1).map((t, i) => t - ev[i]);
 if (gaps.length < 3) return null;
 let beat = refBpm ? 60000 / refBpm : median(gaps);
 if (!refBpm) { while (60000 / beat < 60) beat /= 2; while (60000 / beat > 180) beat *= 2; }
 const implied = [];
 for (const g of gaps) {
  const r = g / beat, v = VALUES.reduce((best, x) => (Math.abs(Math.log(r / x)) < Math.abs(Math.log(r / best)) ? x : best));
  if (Math.abs(Math.log(r / v)) < 0.2) implied.push(60000 / (g / v));
 }
 return implied.length >= 3 ? { bpm: median(implied), n: implied.length } : null;
}

// The beat from onsets alone, for free play heard through the microphone (js/listening.js), where an onset can be
// missed or one heard that wasn't played: the onsets of the last `spanMs` as a train of short bumps, its
// autocorrelation (each lag scored with its double, so the beat wins over its half, and leaning towards
// `prefer` BPM, as people hear a pulse), then a line fitted through the onsets that fall near the beats it
// implies, for the exact tempo and where its beats are. Returns { bpm, origin (a beat's time), fit (how many
// onsets are on its beats) } or null with fewer than six onsets or no clear pulse.
export function pulseFromOnsets(times, { minBpm = 50, maxBpm = 220, prefer = 110, spanMs = 8000, resMs = 5 } = {}) {
 const last = Math.max(...times), ts = times.filter(t => last - t <= spanMs).sort((a, b) => a - b);
 if (ts.length < 6) return null;
 const first = ts[0], n = Math.ceil((last - first) / resMs) + 8, x = new Float64Array(n);
 for (const t of ts) { const c = (t - first) / resMs + 4; for (let k = Math.max(0, Math.floor(c - 4)); k <= Math.min(n - 1, Math.ceil(c + 4)); k++) x[k] += Math.exp(-0.5 * ((k - c) / 2) ** 2); }
 const ac = lag => { let s = 0; for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag]; return s / (n - lag); };
 const lo = Math.floor(60000 / maxBpm / resMs), hi = Math.ceil(60000 / minBpm / resMs);
 const score = [];
 for (let lag = lo; lag <= hi && lag < n - 1; lag++) { const bpm = 60000 / (lag * resMs); score.push([lag, (ac(lag) + 0.5 * (2 * lag < n ? ac(2 * lag) : 0)) * Math.exp(-0.5 * Math.log2(bpm / prefer) ** 2)]); }
 if (!score.length) return null;
 const [lag, peak] = score.reduce((a, b) => (b[1] > a[1] ? b : a));
 // Onsets with no pulse have a flat autocorrelation; a pulse stands five times above its average (random onsets
 // reached that 2 times in 500, claps ±25 ms off their beat fell short of it once in 48).
 if (peak < 5 * (score.reduce((a, b) => a + b[1], 0) / score.length)) return null;
 // A period's beats: the phase most onsets sit on, then a line through the onsets near a beat (within 40 ms, or an
 // eighth of a fast one) for the tempo and the beat to the millisecond.
 const near = (per, org) => ts.map(t => [Math.round((t - org) / per), t]).filter(([k, t]) => Math.abs(t - (org + k * per)) < Math.min(per / 8, 40));
 const beats = period => {
  let best = 0, phase = 0;
  for (let p = 0; p < period; p += resMs / 2) {
   let s = 0;
   for (const t of ts) { const d = (((t - first - p) % period) + period) % period, e = Math.min(d, period - d); s += Math.exp(-0.5 * (e / 15) ** 2); }
   if (s > best) { best = s; phase = p; }
  }
  let org = first + phase, on = near(period, org);
  for (let round = 0; round < 2 && on.length >= 4; round++) {
   const m = on.length, mk = on.reduce((a, [k]) => a + k, 0) / m, mt = on.reduce((a, [, t]) => a + t, 0) / m;
   let num = 0, den = 0;
   for (const [k, t] of on) { num += (k - mk) * (t - mt); den += (k - mk) ** 2; }
   if (den > 0) { period = num / den; org = mt - period * mk; }
   on = near(period, org);
  }
  const rms = on.length ? Math.sqrt(on.reduce((a, [k, t]) => a + (t - (org + k * period)) ** 2, 0) / on.length) : Infinity;
  return { period, org, fit: on.length / ts.length, on: on.length, rms };
 };
 // The autocorrelation can land an octave out: of the period, its half and its double, the slowest that most of
 // the onsets fall on is the beat.
 const tries = [lag * 2, lag, lag / 2].map(l => l * resMs).filter(per => per >= 60000 / maxBpm && per <= 60000 / minBpm).map(beats).filter(b => b.on >= 4 && b.rms <= 25); // people clap within 10-20 ms of their beat
 if (!tries.length) return null;
 const top = Math.max(...tries.map(b => b.fit)), pick = tries.find(b => b.fit >= top * 0.7);
 if (pick.fit < 0.6 || pick.on < 6) return null;
 const bpm = 60000 / pick.period;
 return bpm >= minBpm && bpm <= maxBpm ? { bpm, origin: pick.org + Math.ceil((last - pick.org) / pick.period) * pick.period - pick.period, fit: pick.fit } : null;
}

// Watches the tempo against the clock, note by note. Rushing or dragging is said once it has lasted `notes`
// events running beyond `threshold` (a fraction of the tempo), and "back" once the tempo returns to within it.
// In free play there is nothing to rush against: the clock follows the player, so a tempo changed on purpose
// (rubato, an accelerando) is never held against them.
export class TempoWatch {
 constructor({ threshold = 0.04, notes = 4 } = {}) { this.threshold = threshold; this.notes = notes; this.reset(); }
 reset() { this.times = []; this.run = 0; this.side = 0; this.flagged = 0; this.history = []; this.actual = null; }
 // `time` of an event's first note; `clock` the BeatClock. Returns { kind: 'rushing' | 'dragging' | 'back',
 // target, actual, trend } when something is worth saying, else null.
 note(time, clock) {
  if (this.times.length && time - this.times.at(-1) < 40) return null; // part of a chord
  this.times.push(time);
  if (this.times.length > 12) this.times.shift();
  if (!clock.external) { this.run = 0; this.side = 0; this.flagged = 0; this.actual = null; return null; }
  const est = estimateTempo(this.times, clock.bpm);
  if (!est) return null;
  const target = clock.bpm, actual = est.bpm, drift = actual / target - 1;
  this.actual = actual;
  this.history.push(actual); if (this.history.length > 6) this.history.shift();
  const trend = this.history.length < 4 ? 'steady' : this.history.at(-1) - this.history[0] > target * 0.02 ? 'rising' : this.history[0] - this.history.at(-1) > target * 0.02 ? 'falling' : 'steady';
  const side = drift > this.threshold ? 1 : drift < -this.threshold ? -1 : 0;
  this.run = side && side === this.side ? this.run + 1 : side ? 1 : 0;
  this.side = side;
  const out = { target: Math.round(target), actual: Math.round(actual), trend };
  if (side && this.run >= this.notes && this.flagged !== side) { this.flagged = side; return { kind: side > 0 ? 'rushing' : 'dragging', ...out }; }
  if (!side && this.flagged && Math.abs(drift) < this.threshold / 2) { this.flagged = 0; return { kind: 'back', ...out }; }
  return null;
 }
}

// What System 1 may say mid-phrase, by what tripped: Laya picks one of these from the summary (and the canned
// first one is said when Laya isn't loaded). At most one a bar, and never closer than NUDGE_GAP_MS.
export const NUDGES = {
 rushing: ['Easy, you\'re speeding up: {actual} against {target}.', 'Let each beat land with the click; you\'re ahead of it.', 'Hold back a little: count the rests all the way through.'],
 dragging: ['Push on a little: {actual} against {target}.', 'Lean into each beat; you\'re behind the click.', 'Keep it moving: listen ahead to the next click.'],
 back: ['That\'s it, right on {target}.', 'Locked in again.', 'Back with the click.'],
};
export const NUDGE_GAP_MS = 4000;
export const nudgeText = (template, flag) => template.replace('{actual}', flag.actual).replace('{target}', flag.target);

/* ---- Layer 3: the rhythm ---- */

const STEPS = 16; // sixteenths in a bar of four

// A phrase's notes ({ time, ... } with time in ms) on the clock's sixteenth grid, bar by bar from the bar the
// first note falls in: { bars: ['x..x..x.x...x...', ...], events: [{ time, bar, step, offsetMs }], ... } with
// the statistics the teacher reads:
// - meanOffset and spread (ms) from the nearest sixteenth (negative is early), and onGrid: how many within `good`
// - beats: for each beat of the bar, the mean offset of the events that land on it (where lateness repeats)
// - swing: the long-to-short ratio of eighth pairs (1 straight, 2 a triplet swing), or null with fewer than two
//   pairs; swung off-beats are written on the "and", where they are meant
// - syncopation: events off the beat with nothing on the next beat, so they carry across it
// - against `expected` (bar strings), from where the first note lines up: missed, extra and matched hits
export function rhythmSummary(notes, clock, { expected = null, level = DIFFICULTY.normal } = {}) {
 const times = eventTimes(notes.map(n => n.time));
 if (!clock.running || times.length < 2) return null;
 const sixteenth = clock.period / 4;
 // Swing first, from the times themselves: an event near a beat, then one 0.55–0.8 of the way to the next.
 const frac = t => { const b = clock.beatAt(t); return b - Math.floor(b + 0.15); };
 const ratios = [];
 for (let i = 0; i + 1 < times.length; i++) {
  const a = clock.beatAt(times[i]), b = clock.beatAt(times[i + 1]);
  if (Math.abs(a - Math.round(a)) < 0.12 && b - Math.round(a) > 0.4 && b - Math.round(a) < 0.8) ratios.push((b - Math.round(a)) / (1 - (b - Math.round(a))));
 }
 // Swing only when most pairs agree: a dotted eighth and sixteenth (3 : 1) among straight eighths isn't swing.
 const long = ratios.filter(x => x > 1.3), side = long.length >= ratios.length * 2 / 3 ? long : ratios.length - long.length >= ratios.length * 2 / 3 ? ratios.filter(x => x <= 1.3) : null;
 const swing = ratios.length >= 2 && side ? Math.round(median(side) * 100) / 100 : null, swung = swing !== null && swing > 1.4;
 const first = Math.floor(Math.round(clock.beatAt(times[0]) * 4) / STEPS);
 const events = times.map(time => {
  let pos = Math.round(clock.beatAt(time) * 4);
  const f = frac(time);
  if (swung && f > 0.55 && f < 0.8) pos = Math.floor(clock.beatAt(time) + 0.15) * 4 + 2; // a swung "and"
  return { time, pos, bar: Math.floor(pos / STEPS) - first, step: ((pos % STEPS) + STEPS) % STEPS, offsetMs: time - clock.timeOf(pos / 4) };
 });
 const barCount = Math.min(8, events.at(-1).bar + 1);
 const bars = Array.from({ length: barCount }, () => Array(STEPS).fill('.'));
 events.forEach(e => { if (e.bar < barCount) bars[e.bar][e.step] = 'x'; });
 const offs = events.map(e => e.offsetMs), mean = offs.reduce((s, x) => s + x, 0) / offs.length;
 const spread = Math.sqrt(offs.reduce((s, x) => s + (x - mean) ** 2, 0) / offs.length);
 const beats = Array.from({ length: 4 }, (_, b) => { const on = events.filter(e => e.step === b * 4).map(e => e.offsetMs); return on.length ? { n: on.length, mean: on.reduce((s, x) => s + x, 0) / on.length } : null; });
 const has = new Set(events.map(e => e.pos));
 const syncopation = events.filter(e => e.step % 4 && !has.has(Math.ceil(e.pos / 4) * 4) && events.at(-1).pos > e.pos).length;
 const out = {
  bpm: Math.round(clock.bpm), source: clock.source, bars: bars.map(b => b.join('')), events,
  meanOffset: Math.round(mean), spread: Math.round(spread), onGrid: offs.filter(x => Math.abs(x) <= level.good).length, count: events.length,
  beats, swing, syncopation, sixteenthMs: sixteenth,
 };
 if (expected?.length) out.diff = diffPattern(out.bars, expected);
 return out;
}

// Played bars against the expected ones, lined up on their first hits: a hit within a sixteenth of an
// expected one matches it.
export function diffPattern(played, expected) {
 const hits = bars => bars.join('').split('').flatMap((c, i) => (c === 'x' ? [i] : []));
 const p = hits(played), e = hits(expected);
 if (!p.length || !e.length) return { matched: 0, missed: e.length, extra: p.length, of: e.length };
 const shift = e[0] - p[0], length = expected.join('').length, used = new Set();
 let matched = 0;
 for (const h of p.map(x => x + shift).filter(x => x < length)) {
  const m = e.find(x => !used.has(x) && Math.abs(x - h) <= 1);
  if (m !== undefined) { used.add(m); matched++; }
 }
 const inRange = p.map(x => x + shift).filter(x => x < length).length;
 return { matched, missed: e.length - matched, extra: inRange - matched, of: e.length };
}

// The phrase in words: what happened, and one thing to do about it (the worst problem first).
export function describeRhythm(r, level = DIFFICULTY.normal) {
 const parts = [`${r.count} notes over ${r.bars.length} bar${r.bars.length > 1 ? 's' : ''} at ${r.bpm} BPM`];
 parts.push(r.onGrid === r.count ? `all within ${level.good} ms of the grid` : `${r.onGrid} of ${r.count} within ${level.good} ms of the grid`);
 if (Math.abs(r.meanOffset) > level.good / 2) parts.push(`on average ${Math.abs(r.meanOffset)} ms ${r.meanOffset < 0 ? 'early' : 'late'}`);
 const worst = r.beats.map((b, i) => b && b.n >= 1 && Math.abs(b.mean) > level.good ? { beat: i + 1, mean: b.mean } : null).filter(Boolean).sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean))[0];
 if (worst) parts.push(`beat ${worst.beat} ${worst.mean > 0 ? 'late' : 'early'} by ${Math.round(Math.abs(worst.mean))} ms`);
 if (r.swing !== null) parts.push(r.swing > 1.4 ? `swung (${r.swing} : 1)` : 'straight eighths');
 if (r.syncopation) parts.push(`${r.syncopation} syncopation${r.syncopation > 1 ? 's' : ''}`);
 if (r.diff) parts.push(`${r.diff.matched} of ${r.diff.of} hits of the pattern${r.diff.extra ? `, ${r.diff.extra} extra` : ''}`);
 const fix = r.diff && r.diff.missed > 1 ? 'Play the pattern once more, slowly, saying the counts out loud: one-e-and-a.'
  : r.spread > level.ok ? 'Keep it even: count one-and-two-and out loud, and play on the numbers first.'
  : worst ? `Beat ${worst.beat} lands ${worst.mean > 0 ? 'late' : 'early'}: feel it coming and ${worst.mean > 0 ? 'lean into it' : 'wait for it'}.`
  : Math.abs(r.meanOffset) > level.good / 2 ? (r.meanOffset < 0 ? 'You\'re ahead of the click: let it come to you.' : 'You\'re behind the click: listen ahead to it.')
  : 'Steady: keep that feel and try something harder.';
 return { text: `${parts.join('; ')}.`, fix };
}

/* ---- What keeps happening ---- */

// A small profile of the student's timing over many phrases, kept in the browser: each beat's offset (a
// running mean, the latest phrases counting most), how often they rush or drag, and how many phrases.
export const newProfile = () => ({ phrases: 0, beats: [0, 0, 0, 0].map(() => ({ n: 0, mean: 0 })), rushing: 0, dragging: 0 });
export function learn(profile, r, flag = null) {
 const p = structuredClone(profile || newProfile());
 if (r) {
  p.phrases++;
  r.beats.forEach((b, i) => { if (!b) return; const s = p.beats[i]; s.n++; s.mean += (b.mean - s.mean) / Math.min(s.n, 8); });
 }
 if (flag === 'rushing') p.rushing++;
 if (flag === 'dragging') p.dragging++;
 return p;
}
// What keeps happening, in words: a beat off the same way in at least four phrases, or rushing or dragging
// three times. Each is { key, text, beat? }.
export function issues(profile, level = DIFFICULTY.normal) {
 if (!profile) return [];
 const out = [];
 profile.beats.forEach((b, i) => { if (b.n >= 4 && Math.abs(b.mean) > level.good) out.push({ key: `beat${i + 1}`, beat: i + 1, late: b.mean > 0, text: `consistently ${b.mean > 0 ? 'late' : 'early'} on beat ${i + 1} (${Math.round(Math.abs(b.mean))} ms, ${b.n} phrases)` }); });
 if (profile.rushing >= 3 && profile.rushing >= profile.dragging) out.push({ key: 'rushing', text: `tends to rush (${profile.rushing} times)` });
 else if (profile.dragging >= 3) out.push({ key: 'dragging', text: `tends to drag (${profile.dragging} times)` });
 return out;
}

/* ---- The next exercise ---- */

// What System 1 can set next, each a one-bar pattern and a tempo built from the last phrase: Laya picks one
// (or the rule in nextExercise() does, without it). An exercise plays as an example and becomes the target
// that the next phrases are marked against.
export const EXERCISES = {
 same_slower: { says: 'the same rhythm, slower', make: (r, p) => ({ pattern: r.bars[0], bpm: Math.max(50, r.bpm - 15) }) },
 quarters: { says: 'a simpler rhythm: four even quarter notes', make: r => ({ pattern: 'x...x...x...x...', bpm: r.bpm }) },
 eighths: { says: 'even eighth notes', make: r => ({ pattern: 'x.x.x.x.x.x.x.x.', bpm: r.bpm }) },
 lean_beat: { says: 'quarter notes, leaning on the beat that slips', make: (r, p) => ({ pattern: 'x...x...x...x...', bpm: Math.max(50, r.bpm - 10), accent: p?.beat || 1 }) },
 offbeats: { says: 'off-beat eighths, between the clicks', make: r => ({ pattern: '..x...x...x...x.', bpm: r.bpm }) },
 tresillo: { says: 'a syncopated 3-3-2 rhythm', make: r => ({ pattern: 'x..x..x...x.x...', bpm: r.bpm }) },
 same_faster: { says: 'the same rhythm, faster', make: r => ({ pattern: r.bars[0], bpm: Math.min(200, r.bpm + 10) }) },
};
export function exercise(id, r, profileIssue = null) {
 const e = EXERCISES[id].make(r, profileIssue);
 return { id, ...e, label: `${EXERCISES[id].says}${e.accent ? ` (beat ${e.accent})` : ''}, at ${e.bpm} BPM` };
}
// The rule System 1 follows without Laya, and the options it offers Laya: struggling, slow down or simplify;
// a beat that keeps slipping, lean on it; steady, add syncopation or speed up.
export function exerciseOptions(r, profile, level = DIFFICULTY.normal) {
 const recurring = issues(profile, level).find(i => i.beat);
 const shaky = r.spread > level.ok || (r.diff && r.diff.missed > 1), steady = r.onGrid / r.count >= 0.8 && (!r.diff || !r.diff.missed);
 const ids = shaky ? ['same_slower', 'quarters', 'eighths'] : recurring ? ['lean_beat', 'same_slower', 'quarters'] : steady ? (r.syncopation ? ['same_faster', 'tresillo', 'offbeats'] : ['offbeats', 'tresillo', 'same_faster']) : ['same_slower', 'eighths', 'offbeats'];
 return { ids, recurring };
}
export function nextExercise(r, profile, level = DIFFICULTY.normal) {
 const { ids, recurring } = exerciseOptions(r, profile, level);
 return exercise(ids[0], r, recurring);
}

// A pattern as an example to play: one step per sixteenth (so four steps a beat), a low C on the downbeat
// and the accented beat, the C above on the rest.
export function patternSteps(pattern, accent = 1) {
 return pattern.split('').map((c, i) => (c !== 'x' ? [] : i === 0 || i === (accent - 1) * 4 ? [48, 60] : [60]));
}
// A pattern a model wrote ("x...x...x.x.x..."): one or two bars of x and ., or null.
export function readPattern(text) {
 const s = String(text ?? '').replace(/[|\s]/g, '').toLowerCase().replace(/[^x.]/g, '');
 return s.length >= STEPS && s.length <= STEPS * 2 && s.length % STEPS === 0 && s.includes('x') ? s : null;
}

// The [RHYTHM] message System 2 reads: the phrase in a few lines, no raw MIDI.
export function rhythmMessage(r, { described, profile = null, lesson = '', target = null, level = DIFFICULTY.normal } = {}) {
 const lines = [`[RHYTHM] ${r.count} notes, ${r.bars.length} bar${r.bars.length > 1 ? 's' : ''} at ${r.bpm} BPM (${r.source === 'free' ? 'the player\'s own pulse' : r.source === 'midi' ? 'MIDI clock' : r.source}), on a sixteenth grid: ${r.bars.join(' | ')}`,
  `timing: mean ${r.meanOffset >= 0 ? '+' : ''}${r.meanOffset} ms, spread ${r.spread} ms, ${r.onGrid} of ${r.count} within ${level.good} ms; swing ${r.swing ?? 'n/a'}; syncopations ${r.syncopation}`];
 if (target) lines.push(`target ${target.pattern} at ${target.bpm} BPM: ${r.diff ? `${r.diff.matched} of ${r.diff.of} hits, ${r.diff.missed} missed, ${r.diff.extra} extra` : 'not compared'}`);
 if (lesson) lines.push(`lesson: ${lesson}`);
 const recurring = issues(profile, level).map(i => i.text);
 if (recurring.length) lines.push(`history: ${recurring.join('; ')}`);
 if (described) lines.push(`Coach: ${described}`);
 return lines.join('\n');
}
