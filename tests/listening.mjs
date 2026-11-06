// node tests/listening.mjs: listening (js/listen-dsp.js) on sounds made up with known notes
// (tests/support/signals.js): the pitch of voices, whistles and plain waveforms to a few cents, with noise and
// with no fundamental at all; a sung melody with vibrato, scoops, breaths and re-sung notes transcribed note
// for note, each on time; no extra notes from wide vibrato; snapping to a scale; the latency arithmetic.
import assert from 'node:assert/strict';
import { analyze, Analyzer, transcribe, noteF1, toSemis, snapToScale, roundTrip, NoteTracker, timed, frameSizes } from '../js/listen-dsp.js';
import { tone, sing, melody } from './support/signals.js';

let failed = 0;
const check = (name, fn) => { try { fn(); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message.split('\n')[0]}`); } };
const SR = 48000;
const cents = (hz, want) => (toSemis(hz) - toSemis(want)) * 100;
const show = notes => notes.map(n => `${n.midi}@${Math.round(n.start)}`).join(' ');

/* ---- Pitch ---- */
check('pitch within 5 cents from 65 Hz to 2 kHz: sine, sawtooth, square, a sung "ah" and a whistle, at 44.1 and 48 kHz', () => {
 for (const sampleRate of [44100, 48000]) for (const kind of ['sine', 'saw', 'square', 'voice', 'whistle']) for (const hz of [65.4, 98, 146.8, 220, 330, 440, 659.3, 987.8, 1318.5, 2093]) {
  if (kind === 'voice' && hz > 1000) continue; // nobody sings that high
  const frames = analyze(tone(hz, 0.4, { kind, sampleRate }), sampleRate).slice(4);
  const worst = Math.max(...frames.map(f => Math.abs(cents(f.hz, hz))));
  assert.ok(frames.every(f => f.clarity > 0.9), `${kind} ${hz} Hz at ${sampleRate}: clarity ${Math.min(...frames.map(f => f.clarity)).toFixed(2)}`);
  assert.ok(worst < (kind === 'square' ? 5 : 2), `${kind} ${hz} Hz at ${sampleRate}: ${worst.toFixed(2)} cents off`); // the square isn't band-limited: it aliases
 }
});
check('pitch within 20 cents with noise 20 dB down, and a voice with no fundamental reads as its fundamental', () => {
 for (const hz of [110, 220, 440]) {
  const noisy = analyze(tone(hz, 0.4, { kind: 'voice', noise: 0.02 }), SR).slice(4).filter(f => f.clarity > 0.8);
  assert.ok(noisy.length > 50 && noisy.every(f => Math.abs(cents(f.hz, hz)) < 20), `${hz} Hz with noise: ${noisy.length} frames, worst ${Math.max(...noisy.map(f => Math.abs(cents(f.hz, hz)))).toFixed(1)} cents`);
  const hollow = analyze(tone(hz, 0.4, { kind: 'hollow' }), SR).slice(4);
  assert.ok(hollow.every(f => Math.abs(cents(f.hz, hz)) < 5), `${hz} Hz with no fundamental read as ${hollow[10].hz.toFixed(1)} Hz`);
 }
});
check('silence and noise have no pitch', () => {
 const quiet = analyze(new Float32Array(SR / 2), SR), hiss = analyze(tone(440, 0.5, { amp: 0, noise: 0.3 }), SR);
 assert.ok(quiet.every(f => f.clarity === 0), 'silence has a pitch');
 assert.ok(hiss.filter(f => f.clarity > 0.8).length < hiss.length * 0.05, `noise read as pitched in ${hiss.filter(f => f.clarity > 0.8).length} of ${hiss.length} frames`);
});
check('the worklet\'s 128-sample blocks give the same frames as a whole clip', () => {
 const x = tone(330, 0.3), whole = analyze(x, SR), a = new Analyzer(SR), parts = [];
 for (let i = 0; i < x.length; i += 128) parts.push(...a.push(x.subarray(i, i + 128), i));
 assert.equal(parts.length, whole.length);
 assert.ok(parts.every((f, i) => f.end === whole[i].end && Math.abs(f.hz - whole[i].hz) < 1e-6), 'the frames differ');
});

/* ---- Notes ---- */
check('a sung melody (vibrato, scoops, breaths, the same note again, legato): every note, each within 20 ms', () => {
 const ref = melody();
 for (const opts of [{}, { vibrato: 60 }, { noise: 0.02 }, { sampleRate: 44100 }, { kind: 'saw', vibrato: 0 }, { kind: 'hollow' }]) {
  const sampleRate = opts.sampleRate || SR, got = transcribe(sing(ref, opts), sampleRate), s = noteF1(ref, got);
  assert.equal(s.f1, 1, `${JSON.stringify(opts)}: F1 ${s.f1.toFixed(2)}, heard ${show(got)}`);
  const worst = Math.max(...s.onsetErrors.map(Math.abs));
  assert.ok(worst < 20, `${JSON.stringify(opts)}: an onset ${worst.toFixed(1)} ms out`);
 }
});
check('a whistled melody two octaves up', () => {
 const ref = melody().map(n => ({ ...n, midi: n.midi + 24 })), got = transcribe(sing(ref, { kind: 'whistle', vibrato: 10 }), SR), s = noteF1(ref, got);
 assert.equal(s.f1, 1, `F1 ${s.f1.toFixed(2)}: ${show(got)}`);
 assert.ok(Math.max(...s.onsetErrors.map(Math.abs)) < 20, `onsets ${s.onsetErrors.map(Math.round).join(' ')}`);
});
check('wide vibrato (±90 cents), a scoop up a whole tone, and a long held note are one note each', () => {
 for (const [opts, notes] of [[{ vibrato: 90 }, [{ midi: 64, start: 200, end: 2200 }]], [{ vibrato: 30 }, [{ midi: 62, start: 200, end: 900, scoop: 2 }]], [{ vibrato: 50 }, [{ midi: 57, start: 100, end: 4100 }]]]) {
  const got = transcribe(sing(notes, opts), SR);
  assert.equal(got.length, 1, `${JSON.stringify(notes[0])}: ${show(got)}`);
  assert.equal(got[0].midi, notes[0].midi);
 }
});
check('a note sung again out of a consonant (a dip, no silence) is two notes; a legato step is two notes', () => {
 const got = transcribe(sing([{ midi: 64, start: 200, end: 1400, dip: 400 }]), SR);
 assert.deepEqual(got.map(n => n.midi), [64, 64], show(got));
 assert.ok(Math.abs(got[1].start - 640) < 15, `the second starts at ${got[1].start.toFixed(0)}`);
 const legato = transcribe(sing([{ midi: 60, start: 200, end: 600 }, { midi: 62, start: 600, end: 1000 }]), SR);
 assert.deepEqual(legato.map(n => n.midi), [60, 62], show(legato));
 assert.ok(Math.abs(legato[1].start - 600) < 20 && Math.abs(legato[0].end - 600) < 20, `the step is at ${legato[1].start.toFixed(0)}`);
});
check('louder singing gives a higher velocity', () => {
 const got = transcribe(sing([{ midi: 60, start: 200, end: 500, amp: 0.15 }, { midi: 60, start: 600, end: 900, amp: 1 }]), SR);
 assert.equal(got.length, 2);
 assert.ok(got[1].velocity > got[0].velocity + 0.2, `velocities ${got.map(n => n.velocity.toFixed(2)).join(', ')}`);
});
check('snapping: notes sung 40 cents off, and between scale notes, land on C major pentatonic', () => {
 const pent = [0, 2, 4, 7, 9];
 assert.deepEqual([60.4, 61.4, 62.6, 65.2, 65.6, 70.4].map(s => snapToScale(s, 0, pent)), [60, 62, 62, 64, 67, 69]);
 assert.deepEqual([61.2, 65.8, 67.8].map(s => snapToScale(s, 2, [0, 2, 3, 5, 7, 8, 10])), [62, 65, 67]); // D minor
 const notes = [{ midi: 61, start: 200, end: 600 }, { midi: 66, start: 700, end: 1100 }];
 const got = transcribe(sing(notes.map(n => ({ ...n, bend: 0.4 }))), SR, { snap: s => snapToScale(s, 0, pent) });
 assert.deepEqual(got.map(n => n.midi), [62, 67], show(got));
});
check('notes the app is sounding itself are followed but not sent', () => {
 const x = sing([{ midi: 60, start: 200, end: 600 }, { midi: 64, start: 700, end: 1100 }, { midi: 72, start: 1200, end: 1500 }]);
 const got = transcribe(x, SR, { ignore: m => m % 12 === 0 });
 assert.deepEqual(got.map(n => n.midi), [64], show(got));
});
check('the gate: quiet singing below it is not heard', () => {
 const x = sing([{ midi: 60, start: 200, end: 600, amp: 0.02 }], { noise: 0.0002 });
 assert.equal(transcribe(x, SR, { gateDb: -40 }).length, 0);
 assert.equal(transcribe(x, SR, { gateDb: -70 }).length, 1);
});
check('every note-on is answered by a note-off, and none overlap', () => {
 const t = new NoteTracker(), sizes = frameSizes(SR), held = new Set();
 for (const f of analyze(sing(melody(), { vibrato: 70, noise: 0.01 }), SR)) for (const e of t.push(timed(f, sizes, x => (x / SR) * 1000))) {
  if (e.type === 'on') { assert.equal(held.size, 0, `note ${e.midi} on while ${[...held]} held`); held.add(e.midi); }
  else assert.ok(held.delete(e.midi), `an off for ${e.midi}, which wasn't on`);
 }
 t.flush(1e9).forEach(e => held.delete(e.midi));
 assert.equal(held.size, 0);
});

/* ---- Latency ---- */
check('calibration: each click paired with the first onset after it; the median gap; too few heard is null', () => {
 const clicks = [1000, 1400, 1800, 2200, 2600, 3000, 3400, 3800];
 const heard = [1043, 1441, 1500, 1844, 2242, 2643, 3045, 3441, 3842];
 const r = roundTrip(clicks, heard, 360);
 assert.equal(r.ms, 42.5); assert.equal(r.heard, 8); assert.ok(r.spread <= 1.5);
 assert.equal(roundTrip(clicks, [1043, 1441], 360), null);
});

console.log(failed ? `\n${failed} failed` : 'listening: all checks passed');
process.exit(failed ? 1 : 0);
