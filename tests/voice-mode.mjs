// node tests/voice-mode.mjs: voice mode (js/voice-mode.js) on made-up sounds (tests/support/signals.js): talk is
// told from singing, the notes of talk are held back in hands-free mode while sung ones go through on time,
// spoken requests become the app's actions, and a sing-back is scored note by note.
import assert from 'node:assert/strict';
import { analyze, NoteTracker, timed, frameSizes, transcribe } from '../js/listen-dsp.js';
import { SpeechOrMusic, HandsFreeGate, readIntent, makePhrase, scoreSingBack, STYLE_RHYTHMS } from '../js/voice-mode.js';
import { sing, speak, melody, random } from './support/signals.js';

let failed = 0;
const check = (name, fn) => { try { fn(); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message.split('\n')[0]}`); } };
const SR = 48000, sizes = frameSizes(SR), toMs = x => (x / SR) * 1000;
// Runs a sound through the tracker, the classifier and the gate, as the Listening widget does in voice mode.
function handsFree(samples) {
 const tracker = new NoteTracker(), sm = new SpeechOrMusic(), gate = new HandsFreeGate(), labels = { music: 0, speech: 0, quiet: 0 }, sent = [], raw = [];
 for (const f of analyze(samples, SR)) {
  const t = timed(f, sizes, toMs), events = tracker.push(t), label = sm.push(t);
  labels[label]++; raw.push(...events.filter(e => e.type === 'on'));
  sent.push(...gate.push(events, label, t.t));
 }
 return { labels, sent, raw, sm };
}

check('talk is heard as talk: a dozen spoken syllables at three voices\' pitches, mostly speech and never held as music', () => {
 for (const hz of [110, 140, 210]) for (const seed of [1, 2, 3]) {
  const { labels } = handsFree(speak(14, { hz, seed }));
  assert.ok(labels.speech > labels.music * 4 && labels.music < 30, `at ${hz} Hz (seed ${seed}): ${JSON.stringify(labels)}`);
 }
});
check('singing is heard as music: the melody, with vibrato, mostly music', () => {
 const { labels } = handsFree(sing(melody(), { vibrato: 40 }));
 assert.ok(labels.music > labels.speech * 3, JSON.stringify(labels));
});
check('hands-free: talk sends (almost) no notes, though the tracker heard some; singing sends every note, at the time it was sung', () => {
 for (const seed of [1, 2, 3]) {
  const { sent, raw } = handsFree(speak(14, { seed }));
  assert.ok(raw.length >= 3 && sent.filter(e => e.type === 'on').length <= 1, `seed ${seed}: the tracker heard ${raw.length} notes, ${sent.filter(e => e.type === 'on').length} went through`);
 }
 const ref = melody(), { sent } = handsFree(sing(ref, { vibrato: 30 })), ons = sent.filter(e => e.type === 'on');
 assert.deepEqual(ons.map(e => e.midi), ref.map(n => n.midi));
 assert.ok(ons.every((e, i) => Math.abs(e.time - ref[i].start) < 20), `onsets ${ons.map((e, i) => Math.round(e.time - ref[i].start)).join(' ')}`);
 assert.equal(sent.filter(e => e.type === 'off').length, ons.length, 'an on without its off');
});
check('after talking, then singing: what was heard last decides whether a transcript counts as speech', () => {
 const talk = speak(10, { seed: 4 }), song = sing([{ midi: 64, start: 100, end: 900 }]), both = new Float32Array(talk.length + song.length);
 both.set(talk); both.set(song, talk.length);
 const sm = new SpeechOrMusic();
 let afterTalk = null;
 for (const f of analyze(both, SR)) { const t = timed(f, sizes, toMs); sm.push(t); if (afterTalk === null && t.t > toMs(talk.length) - 100) afterTalk = sm.wasSpeech(t.t); }
 assert.equal(afterTalk, true, 'right after talking, it was speech');
 assert.equal(sm.wasSpeech(toMs(both.length)), false, 'after singing, it was music');
});

check('spoken requests become actions: recording, loops, listening, a rhythm by style, slowing down, sing it back; questions and commands left alone', () => {
 const want = [
  ['record what I sing into slot 2', 'arm_loop_slot', { slot: 2, record: true, kind: 'notes' }],
  ['Record the sound into the second loop', 'arm_loop_slot', { slot: 2, record: true, kind: 'audio' }],
  ['stop recording', 'stop_loop_recording', {}],
  ['play loop three', 'play_loop_slot', { slot: 3, on: true }],
  ['stop slot 1', 'play_loop_slot', { slot: 1, on: false }],
  ['slow it down to 80', 'set_tempo', { bpm: 80 }],
  ['speed things up to 132 please', 'set_tempo', { bpm: 132 }],
  ['give me a jazz rhythm to practice', 'set_exercise', { pattern: STYLE_RHYTHMS.jazz.pattern, bpm: STYLE_RHYTHMS.jazz.bpm }],
  ['let\'s practise a waltz rhythm', 'set_exercise', { pattern: 'x...x...x...x...', bpm: 90 }],
  ['I want to sing it back', 'sing_back', {}],
  ['let\'s do a sing-back', 'sing_back', {}],
  ['start listening', 'start_listening', {}],
  ['stop listening', 'stop_listening', {}],
 ];
 for (const [text, action, args] of want) {
  const r = readIntent(text);
  assert.equal(r?.action, action, `"${text}" read as ${JSON.stringify(r)}`);
  assert.deepEqual(r.args, args, `"${text}"`);
  assert.ok(r.say.length > 3);
 }
 for (const text of ['what is a rhythm?', 'how do I record a loop?', 'tempo 90', 'turn on the metronome at 100 bpm', 'make it brighter', 'play a ii-V-I in G', 'set the cutoff to 800', 'set up a lesson: something to sing back at 90']) assert.equal(readIntent(text), null, `"${text}" read as ${JSON.stringify(readIntent(text))}`);
});

check('a phrase to sing back: in the key, inside the range, starting on the tonic or fifth, mostly by step', () => {
 for (let seed = 1; seed < 30; seed++) {
  const p = makePhrase({ key: 2, intervals: [0, 2, 3, 5, 7, 8, 10], low: 57, high: 69, length: 5, random: random(seed) });
  assert.equal(p.length, 5);
  assert.ok(p.every(m => m >= 57 && m <= 69 && [2, 4, 5, 7, 9, 10, 0].includes(m % 12)), `seed ${seed}: ${p}`);
  assert.ok([2, 9].includes(p[0] % 12), `starts on ${p[0]}`);
  assert.ok(p.slice(1).every((m, i) => m !== p[i]), `a repeated note: ${p}`);
 }
});
check('sing-back scoring: in tune and on time; a flat note and a late one named; an octave lower is fine; a missed note said', () => {
 const beat = 600, target = [60, 62, 64, 67].map((midi, i) => ({ midi, time: 1000 + i * beat }));
 const trailFor = notes => notes.flatMap(n => Array.from({ length: 40 }, (_, k) => ({ t: n.start + k * 5, semis: n.semis })));
 const sung = [{ midi: 60, start: 1004, end: 1400, semis: 60.05 }, { midi: 62, start: 1590, end: 2000, semis: 61.62 }, { midi: 64, start: 2275, end: 2600, semis: 64.1 }, { midi: 67, start: 2810, end: 3200, semis: 66.9 }];
 const r = scoreSingBack(target, sung, { trail: trailFor(sung), beatMs: beat });
 assert.deepEqual(r.notes.map(n => n.inTune), [true, false, true, true]);
 assert.deepEqual(r.notes.map(n => n.cents), [5, -38, 10, -10]);
 assert.deepEqual(r.notes.map(n => n.ms), [4, -10, 75, 10]);
 assert.match(r.text, /^3 of 4 notes in tune, 3 on time\. The second \(D\) was 38 cents flat\. The third came 75 ms late\.$/);
 const low = sung.map(n => ({ ...n, semis: n.semis - 12, midi: n.midi - 12 })), r2 = scoreSingBack(target, low, { trail: trailFor(low), beatMs: beat });
 assert.equal(r2.octave, -12); assert.deepEqual(r2.notes.map(n => n.cents), [5, -38, 10, -10]);
 assert.match(r2.text, /1 octave lower, which is fine/);
 const r3 = scoreSingBack(target, sung.slice(0, 3), { trail: trailFor(sung), beatMs: beat });
 assert.equal(r3.notes[3].got, null); assert.match(r3.text, /1 note wasn't heard/);
 const perfect = target.map(t => ({ midi: t.midi, start: t.time + 3, end: t.time + 400, semis: t.midi })), r4 = scoreSingBack(target, perfect, { trail: trailFor(perfect), beatMs: beat });
 assert.match(r4.text, /Spot on/);
});
check('a sing-back from sound: a sung reply transcribed and scored', () => {
 const beat = 600, phrase = [64, 62, 60, 62], target = phrase.map((midi, i) => ({ midi, time: 300 + i * beat }));
 const audio = sing(phrase.map((midi, i) => ({ midi, start: 300 + i * beat + (i === 2 ? 90 : 0), end: 300 + i * beat + 450, bend: i === 1 ? -0.35 : 0 })), { vibrato: 25 });
 const tracker = new NoteTracker(), trail = [], sung = [], open = new Map();
 for (const f of analyze(audio, SR)) {
  const t = timed(f, sizes, toMs);
  for (const e of tracker.push(t)) { if (e.type === 'on') open.set(e.midi, { midi: e.midi, start: e.time }); else if (open.has(e.midi)) { sung.push({ ...open.get(e.midi), end: e.time }); open.delete(e.midi); } }
  if (tracker.pitch.voiced) trail.push({ t: t.tPitch, semis: tracker.pitch.semis });
 }
 const r = scoreSingBack(target, sung, { trail, beatMs: beat });
 assert.deepEqual(r.notes.map(n => n.inTune), [true, false, true, true], r.text);
 assert.ok(Math.abs(r.notes[1].cents + 35) <= 6, `the flat note read ${r.notes[1].cents} cents`);
 assert.ok(Math.abs(r.notes[2].ms - 90) <= 15 && !r.notes[2].onTime, `the late note read ${r.notes[2].ms} ms`);
});

console.log(failed ? `\n${failed} failed` : 'voice mode: all checks passed');
process.exit(failed ? 1 : 0);
