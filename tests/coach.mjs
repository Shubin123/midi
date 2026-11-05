import assert from 'node:assert/strict';
import { pcFromName, midiFromName, parseChordName, parseScaleName, chordMidi, scaleRunMidi, detectChord, detectScale, PhraseTracker, SCALE_TEMPLATES, fitToKeys, followKeys } from '../js/pitch-analyzer.js';
import { MOVES, CURRICULUM, buildMove, keyOf, describePlayed, layaState, layaQuestions, availableMoves } from '../js/coach.js';

/* ---- Names to notes ---- */
assert.deepEqual(['C', 'F#', 'Bb', 'E♭', 'B#', 'Cb', 'x'].map(pcFromName), [0, 6, 10, 3, 0, 11, null]);
assert.deepEqual(['C4', 'A4', 'B#3', 'Cb4', 'F#3', 'C-1', 'H2'].map(midiFromName), [60, 69, 60, 59, 54, 0, null]);
const chordOf = s => { const c = parseChordName(s); return c && { root: c.root, bass: c.bass, intervals: c.intervals }; };
assert.deepEqual(chordOf('Dm7'), { root: 2, bass: 2, intervals: [0, 3, 7, 10] });
assert.deepEqual(chordOf('CM7').intervals, [0, 4, 7, 11], 'capital M is major seventh');
assert.deepEqual(chordOf('Cm7').intervals, [0, 3, 7, 10], 'lower-case m is minor');
assert.deepEqual(chordOf('F#maj7'), { root: 6, bass: 6, intervals: [0, 4, 7, 11] });
assert.deepEqual(chordOf('Bb').intervals, [0, 4, 7]);
assert.deepEqual(chordOf('G7/B'), { root: 7, bass: 11, intervals: [0, 4, 7, 10] });
assert.deepEqual(chordOf('Bø7').intervals, [0, 3, 6, 10]);
assert.deepEqual(chordOf('Asus4').intervals, [0, 5, 7]);
assert.equal(parseChordName('Xyz'), null);
assert.equal(parseChordName('Cfoo'), null);

assert.deepEqual(parseScaleName('D Dorian'), { tonic: 2, scaleName: 'Dorian' });
assert.deepEqual(parseScaleName('A minor pentatonic scale'), { tonic: 9, scaleName: 'Minor Pentatonic' });
assert.deepEqual(parseScaleName('Bb major'), { tonic: 10, scaleName: 'Ionian (Major)' });
assert.deepEqual(parseScaleName('E phrygian dominant'), { tonic: 4, scaleName: 'Phrygian Dominant' });
assert.deepEqual(parseScaleName('C# harmonic minor'), { tonic: 1, scaleName: 'Harmonic Minor' });
assert.deepEqual(parseScaleName('G Mixolydian mode'), { tonic: 7, scaleName: 'Mixolydian' });
assert.equal(parseScaleName('hello'), null);
assert.equal(parseScaleName('C nonsense'), null);

assert.deepEqual(chordMidi(parseChordName('Cmaj7')), [48, 52, 55, 59], 'voiced from C3, on the default keyboard');
assert.deepEqual(chordMidi(parseChordName('G7/B')), [47, 55, 59, 62, 65], 'slash bass sits just below the root');
assert.deepEqual(scaleRunMidi(9, 'Minor Pentatonic'), [57, 60, 62, 64, 67, 69, 67, 64, 62, 60, 57]);

/* ---- The key-hint fix: chords use their bass, so C-F-G-C reads as C, not G ---- */
{
 let out; const t = new PhraseTracker(a => { out = a; }, { gapMs: 1 });
 [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]].forEach((c, i) => c.forEach(n => t.noteOn(n, 90, i * 600)));
 t._endPhrase();
 assert.equal(`${out.scales[0].tonicName} ${out.scales[0].scaleName}`, 'C Ionian (Major)');
 assert.deepEqual(out.chords.map(c => c.best.chordName), ['Cmaj', 'Fmaj', 'Gmaj', 'Cmaj']);
}

/* ---- Every coaching move, in several keys, checked musically ---- */
const analysis = (tonic, scaleName, extra = {}) => ({ scales: [{ tonic, scaleName, tonicName: '', score: 1 }], chords: [], pitchClasses: SCALE_TEMPLATES[scaleName].map(s => (tonic + s) % 12), noteCount: 8, noteOns: [60, 62, 64].map(note => ({ note })), ...extra });
const names = ex => ex.steps.map(s => detectChord(s, Math.min(...s))[0]?.chordName);
const pcs = ex => [...new Set(ex.steps.flat().map(n => n % 12))].sort((a, b) => a - b);
const sorted = (tonic, scaleName) => SCALE_TEMPLATES[scaleName].map(s => (tonic + s) % 12).sort((a, b) => a - b);

const cMajor = analysis(0, 'Ionian (Major)'), aMinor = analysis(9, 'Aeolian (Minor)'), dDorian = analysis(2, 'Dorian'), bbMajor = analysis(10, 'Ionian (Major)'), fsMinor = analysis(6, 'Aeolian (Minor)');

assert.equal(keyOf(cMajor).label, 'C major');
assert.equal(keyOf(aMinor).label, 'A minor');
assert.equal(keyOf(dDorian).label, 'D Dorian');
assert.equal(keyOf(dDorian).minor, true);
assert.equal(keyOf(bbMajor).label, 'Bb major', 'flat keys spell with flats');
assert.equal(keyOf(fsMinor).label, 'F# minor');

assert.deepEqual(pcs(buildMove('scale_run', dDorian).example), sorted(2, 'Dorian'));
assert.deepEqual(names(buildMove('home_chord', cMajor).example), ['Cmaj']);
assert.deepEqual(names(buildMove('home_chord', aMinor).example), ['Amin']);
assert.match(buildMove('home_chord', bbMajor).say, /Bb, D and F, the Bb chord/);
assert.deepEqual(names(buildMove('seventh_chord', cMajor).example), ['Cmaj', 'Cmaj7']);
assert.deepEqual(names(buildMove('seventh_chord', dDorian).example), ['Dmin', 'Dmin7']);
assert.deepEqual(names(buildMove('main_chords', cMajor).example), ['Cmaj', 'Fmaj', 'Gmaj', 'Cmaj']);
assert.deepEqual(names(buildMove('main_chords', aMinor).example), ['Amin', 'Dmin', 'Emaj', 'Amin'], 'minor uses a major V');
assert.deepEqual(names(buildMove('two_five_one', cMajor).example), ['Dmin7', 'G7', 'Cmaj7']);
assert.deepEqual(names(buildMove('two_five_one', aMinor).example), ['Bmin7b5', 'E7', 'Amin7']);
assert.match(buildMove('two_five_one', bbMajor).say, /Cm7 → F7 → Bbmaj7/);
assert.deepEqual(pcs(buildMove('relative_key', cMajor).example), sorted(9, 'Aeolian (Minor)'));
assert.deepEqual(pcs(buildMove('relative_key', aMinor).example), sorted(0, 'Ionian (Major)'));
assert.match(buildMove('relative_key', cMajor).say, /A minor is the relative minor of C major/);
assert.deepEqual(pcs(buildMove('neighbour_mode', cMajor).example), sorted(0, 'Mixolydian'));
assert.match(buildMove('neighbour_mode', cMajor).say, /Mixolydian uses A# instead/);
assert.deepEqual(pcs(buildMove('neighbour_mode', aMinor).example), sorted(9, 'Dorian'));
assert.deepEqual(pcs(buildMove('pentatonic', cMajor).example), sorted(0, 'Major Pentatonic'));
assert.deepEqual(pcs(buildMove('pentatonic', aMinor).example), sorted(9, 'Minor Pentatonic'));
assert.deepEqual(pcs(buildMove('blues', aMinor).example), sorted(9, 'Blues'));
assert.match(buildMove('blues', aMinor).say, /blue" note Eb, a flattened fifth.*A, C, D, Eb, E and G/);
assert.match(buildMove('blues', analysis(4, 'Aeolian (Minor)')).say, /E blues scale: E, G, A, Bb, B and D/);
assert.deepEqual(buildMove('arpeggio', cMajor).example.steps.flat(), [48, 52, 55, 60, 55, 52, 48]);
assert.deepEqual(buildMove('steady_time', cMajor).example.steps, [[60], [62], [64]]);
// Every move builds in every key and scale without throwing, with a non-empty example on the keyboard range.
for (const id of CURRICULUM) for (const scaleName of Object.keys(SCALE_TEMPLATES)) for (let tonic = 0; tonic < 12; tonic++) {
 const m = buildMove(id, analysis(tonic, scaleName));
 assert.ok(m.say.length > 20 && !/undefined|NaN/.test(m.say), `${id} in ${tonic} ${scaleName}: ${m.say}`);
 assert.ok(m.example.steps.length && m.example.steps.flat().every(n => Number.isInteger(n) && n >= 36 && n <= 84), `${id} notes in range`);
}

/* ---- Everything the teacher plays fits on a 25-key controller, C3-C5 by default ---- */
{
 const onKeys = (steps, low = 48) => steps.flat().every(n => n >= low && n <= low + 24);
 const cls = steps => steps.map(s => [...new Set(s.map(n => n % 12))].sort((a, b) => a - b));
 for (let tonic = 0; tonic < 12; tonic++) for (const scaleName of ['Ionian (Major)', 'Aeolian (Minor)', 'Dorian']) {
  for (const id of Object.keys(MOVES)) {
   const { steps } = buildMove(id, analysis(tonic, scaleName)).example;
   for (const low of [36, 48, 60]) {
    const fitted = fitToKeys(steps, low);
    assert.ok(onKeys(fitted, low), `${id} in ${tonic} ${scaleName} fits ${low}-${low + 24}`);
    assert.deepEqual(cls(fitted), cls(steps), `${id} keeps its notes`);
   }
  }
 }
 assert.deepEqual(fitToKeys([[48, 52, 55]]), [[48, 52, 55]], 'already on the keys: unchanged');
 assert.deepEqual(fitToKeys([[72], [74], [76], [77]]), [[60], [62], [64], [65]], 'a run above the keys moves down whole');
 assert.deepEqual(fitToKeys([[60, 64, 67]], 36), [[48, 52, 55]], 'and follows the window down');
 assert.deepEqual(fitToKeys([chordMidi(parseChordName('G7/B'))]), [[59, 62, 65, 67]], 'a slash chord below the keys keeps its bass at the bottom');
 assert.deepEqual(fitToKeys([[40], [60], [90]]), [[52], [60], [66]], 'too wide to move whole: each note on its own');
 assert.equal(followKeys(48, 60), 48);
 assert.equal(followKeys(48, 72), 48, 'the top C is on the keys');
 assert.equal(followKeys(48, 45), 36, 'octave down on the controller');
 assert.equal(followKeys(48, 79), 60, 'octave up');
 assert.equal(followKeys(36, 72), 48, 'and back');
}

/* ---- What Laya is asked ---- */
assert.equal(describePlayed({ ...cMajor, chords: [{ best: { chordName: 'Cmaj' } }, { best: { chordName: 'Fmaj' } }] }), 'You played the chords C → F, in C major.');
assert.equal(describePlayed(cMajor), "That's the C major scale.");
const state = layaState(cMajor, ['scale_run', 'home_chord']);
assert.match(state, /Steps already suggested this session: play the whole scale up and back down; build the home chord of this key\./);
const q = layaQuestions(availableMoves(['scale_run', 'home_chord']));
assert.deepEqual(Object.keys(q), ['move', 'explain', 'level']);
assert.ok(!('scale_run' in q.move.criteria), 'recent suggestions are not offered again');
assert.ok(Object.keys(q.move.criteria).length <= 20, 'within Laya\'s option limit');
assert.ok(Object.values(q.move.criteria).every(t => t.split(' ').length <= 9), 'options are short enough for Laya\'s 192-token head');
assert.deepEqual(Object.keys(MOVES).sort(), [...CURRICULUM].sort());
// Moves the phrase already shows are not offered: after a ii-V-I in sevenths, no home chord or seventh chord.
{
 const iiVI = { ...cMajor, chords: ['Dmin7', 'G7', 'Cmaj7'].map(chordName => ({ best: { chordName } })) };
 const opts = availableMoves([], iiVI);
 for (const id of ['home_chord', 'arpeggio', 'main_chords', 'seventh_chord', 'two_five_one']) assert.ok(!opts.includes(id), `${id} not offered after a ii-V-I`);
 assert.ok(opts.includes('relative_key') && opts.includes('blues'));
 assert.ok(!availableMoves([], { ...cMajor, scales: [{ tonic: 9, scaleName: 'Blues' }] }).includes('blues'));
 assert.ok(!availableMoves([], cMajor).includes('scale_run'), 'a full scale was just played');
 assert.ok(availableMoves(CURRICULUM, iiVI).length > 0, 'never runs out of moves');
}

console.log('coach: all checks passed');
