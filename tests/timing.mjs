// node tests/timing.mjs: beat, tempo and rhythm (js/timing.js), on note times made up to be exactly as early,
// late, swung or rushed as each check needs.
import assert from 'node:assert/strict';
import { BeatClock, MidiClock, PPQN, DIFFICULTY, grade, estimateTempo, eventTimes, pulseFromOnsets, TempoWatch, NUDGES, nudgeText, rhythmSummary, diffPattern, describeRhythm, newProfile, learn, issues, exerciseOptions, nextExercise, exercise, patternSteps, readPattern, rhythmMessage } from '../js/timing.js';

let failed = 0;
const check = (name, fn) => { try { fn(); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message.split('\n')[0]}`); } };
// A deterministic wobble, ±`ms`, so runs are repeatable.
const wobble = (i, ms) => Math.sin(i * 12.9898) * 43758.5453 % 1 * ms;
const clockAt = (bpm, origin = 1000, source = 'metronome') => { const c = new BeatClock(); c.start(source, bpm, origin); return c; };

/* ---- Free play heard through the microphone: the pulse from onsets alone ---- */
check('onset autocorrelation: the tempo within 0.5 BPM and the beat within 5 ms, from 60 to 180 BPM, through missed and stray onsets and some eighths', () => {
 for (const bpm of [60, 72, 96, 120, 150, 180]) for (const eighths of [false, true]) {
  const beat = 60000 / bpm, ts = [];
  for (let i = 0; i < 16; i++) { if (i === 5 || i === 11) continue; ts.push(1000 + i * beat + wobble(i, 8)); if (eighths && i % 4 === 2) ts.push(1000 + (i + 0.5) * beat + wobble(i + 50, 6)); }
  ts.push(1000 + 7.3 * beat); // heard, but not played
  const r = pulseFromOnsets(ts);
  assert.ok(r, `${bpm} BPM${eighths ? ' with eighths' : ''}: no pulse`);
  assert.ok(Math.abs(r.bpm - bpm) < 0.5, `${bpm} BPM${eighths ? ' with eighths' : ''}: read as ${r.bpm.toFixed(2)}`);
  const phase = (((r.origin - 1000) % beat) + beat) % beat;
  assert.ok(Math.min(phase, beat - phase) < 5, `${bpm} BPM: the beat is ${Math.min(phase, beat - phase).toFixed(1)} ms out`);
 }
});
check('onset autocorrelation: too few onsets, or none on a pulse, is no pulse', () => {
 assert.equal(pulseFromOnsets([0, 500, 1000, 1500]), null);
 let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
 for (let k = 0; k < 20; k++) { const ts = Array.from({ length: 12 }, () => rnd() * 6000).sort((a, b) => a - b); assert.equal(pulseFromOnsets(ts), null, `random onsets ${ts.map(Math.round).join(' ')} have a pulse`); }
});

/* ---- Layer 1: the beat ---- */
check('offsets from the nearest beat and subdivision are exact at 60, 120 and 180 BPM', () => {
 for (const bpm of [60, 120, 180]) {
  const c = clockAt(bpm), beat = 60000 / bpm;
  assert.equal(Math.round(c.nearest(1000 + 3 * beat + 17).offsetMs), 17, `${bpm} BPM, late`);
  assert.equal(Math.round(c.nearest(1000 + 5 * beat - 23).offsetMs), -23, `${bpm} BPM, early`);
  const half = c.nearest(1000 + 2.5 * beat + 9, 2);
  assert.deepEqual([half.at, half.beat, Math.round(half.offsetMs)], [2.5, 2, 9], `${bpm} BPM, the "and"`);
 }
});
check('a tempo change carries the beat on where it was', () => {
 const c = clockAt(120), now = 1000 + 2.25 * 500;
 c.setTempo(90, now);
 assert.ok(Math.abs(c.beatAt(now) - 2.25) < 1e-9);
 assert.ok(Math.abs(c.timeOf(3) - (now + 0.75 * 60000 / 90)) < 1e-9);
});
check('grades follow the difficulty', () => {
 assert.deepEqual([12, -45, 80, -140].map(o => grade(o, DIFFICULTY.normal)), ['good', 'ok', 'off', 'off']);
 assert.deepEqual([12, -45, 80, -140].map(o => grade(o, DIFFICULTY.easy)), ['good', 'good', 'ok', 'off']);
 assert.deepEqual([12, -20, 30, -40].map(o => grade(o, DIFFICULTY.hard)), ['good', 'ok', 'ok', 'off']);
});
check('a MIDI clock with ±2 ms jitter gives the tempo within 0.2 BPM and offsets within 3 ms', () => {
 for (const bpm of [60, 100, 140, 180]) {
  const m = new MidiClock(), tick = 60000 / bpm / PPQN, start = 5000;
  m.start(start - 3);
  let r = null;
  for (let k = 0; k < PPQN * 8; k++) r = m.tick(start + k * tick + wobble(k, 2)) || r;
  assert.ok(Math.abs(r.bpm - bpm) < 0.2, `${bpm} BPM read as ${r.bpm.toFixed(2)}`);
  const c = clockAt(r.bpm, r.origin, 'midi');
  for (const [beat, off] of [[6, 25], [7.5, -12], [8, 0]]) {
   const got = c.nearest(start + beat * 60000 / bpm + off, 2).offsetMs;
   assert.ok(Math.abs(got - off) < 3, `${bpm} BPM, beat ${beat}: ${got.toFixed(1)} ms, not ${off}`);
  }
 }
});
check('a MIDI clock: Start makes the next tick beat 0, a beat every 24 ticks', () => {
 const m = new MidiClock(), seen = [];
 m.start(0);
 for (let k = 0; k < 72; k++) { const r = m.tick(10 + k * 20); if (r?.onBeat) seen.push(r.beat); }
 assert.deepEqual(seen, [1, 2], 'beats 1 and 2 seen (beat 0 comes before there is a fit)');
 const r = m.tick(10 + 72 * 20);
 assert.equal(Math.round(r.origin), 10);
});

/* ---- Layer 2: the tempo ---- */
check('the tempo from a mix of quarters and eighths, and a chord, at the reference', () => {
 const b = 600; // 100 BPM
 const times = [0, b, b * 1.5, b * 2, b * 3, b * 3 + 15, b * 3.5, b * 4, b * 5].map(t => t * 0.95); // 5% fast
 const est = estimateTempo(times, 100);
 assert.ok(Math.abs(est.bpm - 105.3) < 0.5, `read ${est.bpm.toFixed(1)} BPM`);
 assert.equal(eventTimes([0, 10, 30, 100]).length, 2, 'notes within 40 ms are one event');
});
check('free play: the tempo from the player alone, folded into 60–180 BPM', () => {
 assert.ok(Math.abs(estimateTempo([0, 250, 500, 750, 1000, 1250]).bpm - 120) < 0.5, 'eighths at 120 read as 120');
 assert.ok(Math.abs(estimateTempo([0, 1500, 3000, 4500]).bpm - 80) < 0.5, 'half notes at 40 read as 80');
 assert.equal(estimateTempo([0, 500]), null, 'too few notes');
});
check('rushing is said after four notes running, once, and "back" when it returns', () => {
 const c = clockAt(100, 0), w = new TempoWatch();
 const flags = [];
 let t = 0;
 for (let i = 0; i < 6; i++) { flags.push(w.note(t, c)); t += 600; } // on tempo
 for (let i = 0; i < 10; i++) { flags.push(w.note(t, c)); t += 560; } // 107 BPM
 for (let i = 0; i < 12; i++) { flags.push(w.note(t, c)); t += 600; } // back
 const said = flags.filter(Boolean);
 assert.deepEqual(said.map(f => f.kind), ['rushing', 'back']);
 assert.deepEqual([said[0].target, said[0].actual], [100, 107]);
});
check('dragging, and a chord counts once', () => {
 const c = clockAt(120, 0), w = new TempoWatch();
 const said = [];
 let t = 0;
 for (let i = 0; i < 14; i++) { said.push(w.note(t, c), w.note(t + 12, c)); t += 545; } // 110 BPM, two notes a time
 assert.deepEqual(said.filter(Boolean).map(f => f.kind), ['dragging']);
});
check('free play: an accelerando on purpose is never called rushing', () => {
 const c = new BeatClock(), w = new TempoWatch();
 let t = 0, gap = 700;
 for (let i = 0; i < 30; i++) { assert.equal(w.note(t, c), null); c.start('free', 60000 / gap, t); t += gap; gap *= 0.97; }
});
check('nudges: words with the numbers in', () => {
 assert.equal(nudgeText(NUDGES.rushing[0], { actual: 107, target: 100 }), 'Easy, you\'re speeding up: 107 against 100.');
 assert.ok(Object.values(NUDGES).every(list => list.length >= 2), 'Laya has a choice for each');
});

/* ---- Layer 3: the rhythm ---- */
const at = (c, beats, offs = []) => beats.map((b, i) => ({ time: c.timeOf(b) + (offs[i] || 0) }));
check('a phrase on the sixteenth grid, bar by bar, with its offsets', () => {
 const c = clockAt(100, 0);
 const r = rhythmSummary(at(c, [4, 4.75, 5.5, 6, 6.5, 7, 8, 9.5], [10, -5, 20, 8, 0, 12, 30, -10]), c);
 assert.deepEqual(r.bars, ['x..x..x.x.x.x...', 'x.....x.........']);
 assert.equal(r.count, 8);
 assert.equal(r.meanOffset, 8);
 assert.equal(r.onGrid, 8);
 assert.equal(r.beats[0].n, 2, 'two notes on beat one');
 assert.equal(Math.round(r.beats[0].mean), 20);
});
check('swing: straight eighths are 1, triplet swing is about 2, swung off-beats are written on the "and", and a dotted rhythm isn\'t swing', () => {
 assert.equal(rhythmSummary(at(clockAt(100, 0), [0, 0.75, 1, 1.5, 2, 2.5]), clockAt(100, 0)).swing, 1, 'one dotted pair among straight eighths');
 const c = clockAt(120, 0);
 const straight = rhythmSummary(at(c, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]), c);
 assert.equal(straight.swing, 1);
 const swung = rhythmSummary(at(c, [0, 2 / 3, 1, 5 / 3, 2, 8 / 3, 3, 11 / 3]), c);
 assert.ok(Math.abs(swung.swing - 2) < 0.05, `swing ${swung.swing}`);
 assert.deepEqual(swung.bars, ['x.x.x.x.x.x.x.x.']);
 assert.match(describeRhythm(swung).text, /swung \(2 : 1\)/);
});
check('syncopation: notes off the beat that carry across it', () => {
 const c = clockAt(100, 0);
 assert.equal(rhythmSummary(at(c, [0, 0.75, 1.5, 2.5, 3]), c).syncopation, 2); // 0.75 and 1.5 skip the next beat; 2.5 leads into beat 3
 assert.equal(rhythmSummary(at(c, [0, 0.5, 1, 1.5, 2]), c).syncopation, 0);
});
check('against a target: matched, missed and extra hits, lined up on the first', () => {
 assert.deepEqual(diffPattern(['x...x...x.x.x...'], ['x...x...x.x.x...']), { matched: 5, missed: 0, extra: 0, of: 5 });
 assert.deepEqual(diffPattern(['..x...x.....x.x.'], ['x...x...x.x.x...']), { matched: 4, missed: 1, extra: 0, of: 5 });
 assert.deepEqual(diffPattern(['x.x.x...x...x.x.'], ['x...x...x.x.x...']), { matched: 4, missed: 1, extra: 2, of: 5 });
 const c = clockAt(100, 0);
 const r = rhythmSummary(at(c, [8, 9, 10, 10.5, 11]), c, { expected: ['x...x...x.x.x...'] });
 assert.deepEqual(r.diff, { matched: 5, missed: 0, extra: 0, of: 5 });
});
check('in words: the worst problem first, and one thing to do', () => {
 const c = clockAt(100, 0);
 const late3 = describeRhythm(rhythmSummary(at(c, [0, 1, 2, 3, 4, 5, 6, 7], [0, 5, 70, 0, 0, 5, 75, 0]), c));
 assert.match(late3.text, /beat 3 late by 7\d ms/);
 assert.match(late3.fix, /Beat 3 lands late/);
 const steady = describeRhythm(rhythmSummary(at(c, [0, 1, 2, 3]), c));
 assert.match(steady.text, /all within 30 ms/);
 assert.match(steady.fix, /Steady/);
});

/* ---- What keeps happening, and what to try next ---- */
check('late on beat 3 phrase after phrase becomes something the teacher knows', () => {
 const c = clockAt(100, 0);
 let p = newProfile();
 for (let i = 0; i < 5; i++) p = learn(p, rhythmSummary(at(c, [0, 1, 2, 3], [0, 0, 45, 0]), c));
 p = learn(learn(learn(p, null, 'rushing'), null, 'rushing'), null, 'rushing');
 assert.deepEqual(issues(p).map(i => i.key), ['beat3', 'rushing']);
 assert.match(issues(p)[0].text, /consistently late on beat 3 \(45 ms, 5 phrases\)/);
 assert.equal(issues(learn(newProfile(), rhythmSummary(at(c, [0, 1, 2, 3], [0, 0, 45, 0]), c))).length, 0, 'once is not a habit');
});
check('the next exercise: slower or simpler when shaky, lean on the beat that keeps slipping, harder when steady', () => {
 const c = clockAt(100, 0);
 const shaky = rhythmSummary(at(c, [0, 1, 2, 3, 4, 5], [0, 90, -80, 70, -90, 60]), c);
 assert.equal(nextExercise(shaky, null).id, 'same_slower');
 assert.equal(nextExercise(shaky, null).bpm, 85);
 const steady = rhythmSummary(at(c, [0, 1, 2, 3, 4, 5, 6, 7]), c);
 assert.equal(nextExercise(steady, null).id, 'offbeats');
 let p = newProfile();
 for (let i = 0; i < 4; i++) p = learn(p, rhythmSummary(at(c, [0, 1, 2, 3], [0, 0, 50, 0]), c));
 const ex = nextExercise(steady, p);
 assert.deepEqual([ex.id, ex.accent, ex.pattern], ['lean_beat', 3, 'x...x...x...x...']);
 assert.match(ex.label, /beat 3/);
 assert.equal(exerciseOptions(steady, p).ids.length, 3, 'three for Laya to choose from');
});
check('patterns: played as sixteenth steps with the downbeat low, and read from what a model wrote', () => {
 assert.deepEqual(patternSteps('x...x...').slice(0, 5), [[48, 60], [], [], [], [60]]);
 assert.deepEqual(patternSteps('x...x...x...x...', 3)[8], [48, 60], 'the accented beat is low too');
 assert.equal(readPattern('x...x...|x.x.x...'), 'x...x...x.x.x...');
 assert.equal(readPattern('X..X..X.X...X... x...'), null, 'not whole bars');
 assert.equal(readPattern('hello'), null);
});
check('the [RHYTHM] message: the grid, the numbers, the target, the history and System 1\'s step, no raw MIDI', () => {
 const c = clockAt(90, 0);
 const r = rhythmSummary(at(c, [0, 1, 2, 2.5, 3], [5, -3, 40, 0, 8]), c, { expected: ['x...x...x.x.x...'] });
 let p = newProfile();
 for (let i = 0; i < 4; i++) p = learn(p, r);
 const msg = rhythmMessage(r, { described: 'Beat 3 lands late.', profile: p, lesson: 'Tempo and rhythm', target: { pattern: 'x...x...x.x.x...', bpm: 90 } });
 assert.match(msg, /^\[RHYTHM\] 5 notes, 1 bar at 90 BPM \(metronome\), on a sixteenth grid: x\.\.\.x\.\.\.x\.x\.x\.\.\./);
 assert.match(msg, /target x\.\.\.x\.\.\.x\.x\.x\.\.\. at 90 BPM: 5 of 5 hits/);
 assert.match(msg, /history: consistently late on beat 3/);
 assert.match(msg, /Coach: Beat 3 lands late\./);
 assert.doesNotMatch(msg, /midi|\b6\d\b,/i);
});
check('an exercise by id says what it is', () => {
 const c = clockAt(100, 0), r = rhythmSummary(at(c, [0, 1, 2, 3]), c);
 assert.equal(exercise('tresillo', r).label, 'a syncopated 3-3-2 rhythm, at 100 BPM');
});

console.log(failed ? `\n${failed} failed` : 'timing: all checks passed');
process.exit(failed ? 1 : 0);
