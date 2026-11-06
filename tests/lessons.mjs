import assert from 'node:assert/strict';
import { LESSONS, UNITS, OMT, Attempt, findRun, findProgression, lessonById, nextLesson, explainPrompt } from '../js/lessons.js';
import { RHYTHM_LESSONS, RHYTHM_UNIT, events, findSameRhythm, findMarkedBeat } from '../js/rhythm-lessons.js';
import { chordMidi, parseChordName, SCALE_TEMPLATES, fitToKeys } from '../js/pitch-analyzer.js';

// Plays steps as a student would: each step's keys go down together, then come up.
const play = (...steps) => { const p = new Attempt(); for (const s of steps) { s.forEach(n => p.noteOn(n)); s.forEach(n => p.noteOff(n)); } return p; };
const notes = ns => ns.map(n => [n]);
const scale = (low, name) => notes([...SCALE_TEMPLATES[name].map(s => low + s), low + 12]);
const chords = (...names) => names.map(n => chordMidi(parseChordName(n)));
const check = (id, p) => lessonById(id).check(p);

/* ---- The course itself ---- */
assert.equal(new Set(LESSONS.map(l => l.id)).size, LESSONS.length, 'ids are unique');
for (const l of LESSONS) {
 assert.ok(UNITS.includes(l.unit), `${l.id}: a known unit`);
 assert.ok(l.page.startsWith(`${OMT.url}/`) && l.page.endsWith('.html'), `${l.id}: links its Open Music Theory chapter`);
 for (const k of ['title', 'text', 'task', 'hint']) assert.ok(l[k]?.length > 5, `${l.id}: has a ${k}`);
 assert.ok(l.example.steps.length && l.example.steps.every(s => s.length && s.every(Number.isInteger)), `${l.id}: example notes`);
 assert.deepEqual(fitToKeys(l.example.steps), l.example.steps, `${l.id}: the example already sits on C3-C5`);
 assert.equal(l.check(new Attempt()), false, `${l.id}: nothing played, nothing passed`);
}
assert.deepEqual(UNITS.filter(u => LESSONS.some(l => l.unit === u)), UNITS, 'every unit has lessons');
assert.equal(nextLesson('keyboard').id, 'enharmonic');
assert.equal(nextLesson(LESSONS.at(-1).id), null);

/* ---- Chords come from keys held together ---- */
{
 const p = new Attempt();
 [48, 52, 55].forEach(n => p.noteOn(n));
 p.noteOff(52); p.noteOff(55); // C held into the next chord
 [53, 57].forEach(n => p.noteOn(n));
 [48, 53, 57].forEach(n => p.noteOff(n));
 assert.deepEqual(p.chords.map(c => [c.root, c.quality]), [[0, 'maj'], [5, 'maj']], 'C, then F over a held C');
 assert.equal(p.chords[1].bass, 48, 'F/C keeps its bass');
 assert.deepEqual(play([60, 64]).chords, [], 'two keys are not a chord');
 assert.deepEqual(play([60, 61, 62]).chords.map(c => c.quality), [null], 'a cluster is recorded, as unknown');
}
assert.equal(findRun([60, 62, 64, 65, 67, 69, 71, 72], [2, 2, 1, 2, 2, 2, 1], 0), true);
assert.equal(findRun([72, 71, 69, 67, 65, 64, 62, 60], [2, 2, 1, 2, 2, 2, 1], 0), true, 'down counts too');
assert.equal(findRun([62, 64, 66, 67, 69, 71, 73, 74], [2, 2, 1, 2, 2, 2, 1], 0), false, 'from the wrong tonic');
assert.equal(findProgression(play(...chords('C', 'C', 'F', 'G')).chords, [[0, 'maj'], [5, 'maj'], [7, 'maj']])?.tonic, 0, 'a chord struck twice counts once');
assert.equal(findProgression(play(...chords('C', 'Am', 'F', 'G')).chords, [[0, 'maj'], [5, 'maj'], [7, 'maj']]), null, 'the chords must be in a row');

/* ---- Each task passes when it is played, and not when it isn't ---- */
const cases = {
 keyboard: [notes([48, 60, 72]), notes([48, 62, 72])],
 enharmonic: [notes([66, 70]), notes([66, 69])],
 chromatic: [notes([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72]), notes([60, 61, 62, 63, 64, 65, 67, 68, 69, 70, 71, 72])],
 major_scale: [scale(50, 'Ionian (Major)'), scale(50, 'Dorian')],
 scale_degrees: [notes([59, 60]), notes([60, 59])],
 minor_scales: [scale(57, 'Harmonic Minor'), scale(57, 'Aeolian (Minor)')],
 key_signatures: [scale(55, 'Ionian (Major)'), scale(55, 'Mixolydian')],
 relative_minor: [scale(57, 'Aeolian (Minor)'), scale(57, 'Harmonic Minor')],
 intervals: [[[60, 67]], notes([60, 66])],
 inversion: [notes([60, 67, 72]), notes([60, 67, 71])],
 triads: [[[57, 60, 64]], [[57, 61, 64]]],
 roman_numerals: [chords('G', 'C', 'D'), chords('C', 'G', 'F')],
 seventh_chords: [chords('G7'), chords('Gmaj7')],
 functions: [chords('C', 'Dm', 'G7', 'C'), chords('C', 'G', 'F', 'C')],
 phrase_model: [chords('C', 'Am', 'Dm', 'G', 'C'), chords('C', 'Dm', 'Am', 'G', 'C')],
 cadences: [[[55, 59, 62], [48, 52, 55, 60]], [[55, 59, 62], [48, 55, 60, 64]]],
 doo_wop: [chords('C', 'Am', 'F', 'G'), chords('C', 'Am', 'G', 'F')],
 singer_songwriter: [chords('Am', 'F', 'C', 'G'), chords('C', 'G', 'Am', 'F')],
 puff: [chords('C', 'Em', 'F'), chords('C', 'E', 'F')],
 lament: [chords('Am', 'G', 'F', 'E'), chords('Am', 'G', 'F', 'Em')],
 pachelbel: [chords('C', 'G', 'Am', 'Em'), chords('C', 'G', 'Am', 'F')],
 plagal: [chords('Bb', 'F', 'C'), chords('F', 'Bb', 'C')],
 fifths_minor: [chords('Am', 'Dm', 'G', 'C'), chords('Am', 'Dm', 'E', 'Am')],
 blues: [chords('G', 'F', 'C'), chords('F', 'G', 'C')],
};
assert.deepEqual(Object.keys(cases).sort(), LESSONS.map(l => l.id).sort(), 'every lesson is tested');
for (const [id, [right, wrong]] of Object.entries(cases)) {
 assert.ok(check(id, play(...right)), `${id}: the right answer passes`);
 assert.equal(check(id, play(...wrong)), false, `${id}: a wrong answer doesn't`);
 assert.ok(check(id, play(...notes([40, 41]), ...right, ...notes([45]))), `${id}: passes among other notes`);
}

// A passed progression says what was played, in the key it was played in.
assert.equal(check('roman_numerals', play(...chords('G', 'C', 'D'))), 'I–IV–V in G');
assert.equal(check('plagal', play(...chords('Eb', 'Bb', 'F'))), '♭VII–IV–I in F');
assert.equal(check('lament', play(...chords('Dm', 'C', 'Bb', 'A'))), 'the lament, i–VII–VI–V, in D minor');
assert.equal(check('cadences', play([55, 59, 62], [48, 52, 55, 60])), 'a perfect authentic cadence in C');
assert.equal(check('cadences', play([59, 62, 67], [48, 52, 55, 60])), false, 'V in inversion: not a perfect authentic cadence');

/* ---- Tempo and rhythm: checked from when each key goes down ---- */

// Plays [time in ms, ...keys] hits as a student would: the keys go down together at that time, then come up.
const timed = hits => { const p = new Attempt(); for (const [t, ...ns] of hits) { ns.forEach(n => p.noteOn(n, t)); ns.forEach(n => p.noteOff(n)); } return p; };
// A rhythm as gaps between notes (ms), from `start`, one key per hit.
const at = (gaps, start = 0, key = 60) => gaps.reduce((hits, g) => [...hits, [hits.at(-1)[0] + g, key]], [[start, key]]);
// An example played as written: each step one beat at its tempo, rests included.
const asPlayed = ({ steps, bpm }) => timed(steps.map((s, i) => [i * 60000 / bpm, ...s]).filter(h => h.length > 1));
const rhythm = id => RHYTHM_LESSONS.find(l => l.id === id).check;

assert.equal(new Set([...RHYTHM_LESSONS, ...LESSONS].map(l => l.id)).size, RHYTHM_LESSONS.length + LESSONS.length, 'ids are unique across the course');
for (const l of RHYTHM_LESSONS) {
 assert.equal(l.unit, RHYTHM_UNIT, `${l.id}: its unit`);
 assert.equal(l.page, undefined, `${l.id}: not from Open Music Theory, so no chapter link`);
 for (const k of ['title', 'text', 'task', 'hint']) assert.ok(l[k]?.length > 5, `${l.id}: has a ${k}`);
 assert.ok(l.example.steps.some(s => s.length) && l.example.steps.every(s => s.every(Number.isInteger)), `${l.id}: example notes (an empty step is a rest)`);
 assert.deepEqual(fitToKeys(l.example.steps), l.example.steps, `${l.id}: the example already sits on C3-C5`);
 assert.equal(l.check(new Attempt()), false, `${l.id}: nothing played, nothing passed`);
 assert.ok(l.check(asPlayed(l.example)), `${l.id}: playing the example passes`);
 assert.doesNotMatch(explainPrompt(l), /Open Music Theory/, `${l.id}: Explain more doesn't credit Open Music Theory`);
}
assert.match(explainPrompt(LESSONS[0]), /adapted from Open Music Theory \(https:/, 'the other lessons still do');

{
 const p = new Attempt(); p.noteOn(60, 0); p.noteOn(64, 20); p.noteOn(67, 35); p.noteOn(62, 500);
 assert.deepEqual(p.times, [0, 20, 35, 500], 'the attempt keeps when each key went down');
 assert.deepEqual(events(p.notes, p.times), [{ t: 0, low: 60 }, { t: 500, low: 62 }], 'keys struck together are one event, on the lowest');
}

// Long, short, short, long at 60 BPM, then at 90 BPM, with a pause between.
const slow = at([1000, 500, 500]), fast = at([667, 333, 333], 4000);
assert.equal(rhythm('tempo_rhythm')(timed([...slow, ...fast])), 'the same rhythm, 1.5 times faster');
assert.equal(rhythm('tempo_rhythm')(timed([...fast.map(([t, n]) => [t - 4000, n]), ...slow.map(([t, n]) => [t + 3000, n])])), 'the same rhythm, 1.5 times slower');
assert.ok(rhythm('tempo_rhythm')(timed([...slow, ...at([620, 370, 300], 4000)])), 'human timing, a little uneven, still counts');
assert.ok(rhythm('tempo_rhythm')(timed([...at([1000, 500, 500], 0, 48), ...at([500, 250, 250], 4000, 67)])), 'on any keys');
assert.ok(findSameRhythm(...Object.values(timed([[0, 48, 52, 55], [1000, 60], [1500, 60], [2000, 60], [4000, 48, 52, 55], [4500, 60], [4750, 60], [5000, 60]])).slice(0, 2)), 'a chord is one note of the rhythm');
assert.equal(rhythm('tempo_rhythm')(timed([...slow, ...at([1000, 500, 500], 4000)])), false, 'the same rhythm at the same tempo');
assert.equal(rhythm('tempo_rhythm')(timed([...at([500, 500, 500]), ...at([250, 250, 250], 3000)])), false, 'a steady pulse at two speeds is not yet a rhythm');
assert.equal(rhythm('tempo_rhythm')(timed([...slow, ...at([333, 333, 667], 4000)])), false, 'a different rhythm, faster');
assert.equal(rhythm('tempo_rhythm')(timed(at([1000, 500, 500, 2000, 500, 250]))), false, 'too few notes the second time');

// Eight even beats at 90 BPM with the first and fifth low.
const beat = (lows, gap = 667, jitter = () => 0) => timed(lows.map((n, i) => [i * gap + jitter(i), n]));
const MARKED = [48, 60, 64, 60, 55, 60, 64, 60];
assert.equal(rhythm('two_systems')(beat(MARKED)), 'a steady beat at 90 BPM, with its downbeats marked');
assert.ok(rhythm('two_systems')(beat(MARKED, 500, i => [0, 40, -30, 50, 0, -40, 30, -20][i])), 'a little human wobble is still steady');
assert.ok(rhythm('two_systems')(timed([[0, 48, 60], [500, 64], [1000, 67], [1500, 64], [2000, 48, 60], [2500, 64], [3000, 67], [3500, 64]])), 'chords with a low note mark the downbeats');
assert.ok(rhythm('two_systems')(beat([72, 70, ...MARKED, 40])), 'among other notes');
assert.equal(rhythm('two_systems')(beat(MARKED, 500, i => (i === 5 ? 300 : 0))), false, 'one beat late is not steady');
assert.equal(rhythm('two_systems')(beat([48, 60, 64, 60, 64, 60, 64, 60])), false, 'the fifth not marked');
assert.equal(rhythm('two_systems')(beat([60, 48, 64, 60, 55, 60, 64, 60])), false, 'the mark on the wrong beat');
assert.equal(rhythm('two_systems')(beat(MARKED.slice(0, 7))), false, 'seven beats are not eight');
assert.equal(rhythm('two_systems')(beat(MARKED, 2000)), false, 'too slow to be a groove');
assert.equal(findMarkedBeat([], []), null);

console.log('lessons: all checks passed');
