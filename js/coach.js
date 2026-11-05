// The teacher's fast "System 1" coaching: a fixed menu of next steps, each of which writes its own words and
// works out its own example notes from the key the student is in. Laya (js/laya.js) chooses which step fits
// what was just played; because Laya only picks from this menu, the theory and the notes are always right.
// Nothing here needs a model, so every move can be tested directly.
import { SCALE_TEMPLATES, spell, prefersFlats, chordMidi, scaleRunMidi } from './pitch-analyzer.js';

const has = (scaleName, step) => SCALE_TEMPLATES[scaleName].includes(step);
const MAJOR_LIKE = ['Ionian (Major)', 'Lydian', 'Mixolydian', 'Major Pentatonic', 'Lydian Dominant', 'Whole Tone'];

// The key the student is in, from the phrase analysis: tonic, scale, whether it is minor, and how to spell it.
export function keyOf(a) {
 const s = a.scales?.[0];
 const tonic = s ? s.tonic : (a.noteOns?.[0]?.note ?? 60) % 12;
 const scaleName = s ? s.scaleName : 'Ionian (Major)';
 const minor = !MAJOR_LIKE.includes(scaleName) && has(scaleName, 3) && !has(scaleName, 4);
 const flats = prefersFlats(tonic, minor);
 const name = pc => spell(pc, flats);
 const scaleLabel = scaleName.replace(' (Major)', '').replace(' (Minor)', '');
 return { tonic, scaleName, minor, flats, name, label: `${name(tonic)} ${scaleName === 'Ionian (Major)' ? 'major' : scaleName === 'Aeolian (Minor)' ? 'minor' : scaleLabel}` };
}

// A chord built on a pitch class: its notes on the keyboard, and a symbol such as "Dm7".
const chord = (k, root, intervals, suffix) => ({ midi: chordMidi({ root: root % 12, intervals }), symbol: k.name(root) + suffix, notes: intervals.map(i => k.name(root + i)) });
const triad = (k, root, minor) => chord(k, root, minor ? [0, 3, 7] : [0, 4, 7], minor ? 'm' : '');
const list = xs => xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0];
const run = (k, tonic, scaleName) => ({ steps: scaleRunMidi(tonic % 12, scaleName).map(n => [n]), bpm: 150 });
const chords = cs => ({ steps: cs.map(c => c.midi), bpm: 60 });
const scaleNotes = (k, tonic, scaleName) => SCALE_TEMPLATES[scaleName].map(s => k.name(tonic + s));

// The menu. `pick` is the short description Laya reads; `build` returns the tip and its example.
export const MOVES = {
 scale_run: {
  pick: 'play the whole scale up and back down',
  build: k => ({ say: `Play the whole ${k.label} scale up and back down: ${list(scaleNotes(k, k.tonic, k.scaleName))}. Listen first.`, example: run(k, k.tonic, k.scaleName) }),
 },
 home_chord: {
  pick: 'build the home chord of this key',
  build: k => { const c = triad(k, k.tonic, k.minor); return { say: `Build the home chord: take every other note from ${k.name(k.tonic)} to get ${list(c.notes)}, the ${c.symbol} chord. Play them together.`, example: chords([c]) }; },
 },
 seventh_chord: {
  pick: 'add a seventh to the home chord',
  build: k => {
   const third = k.minor ? 3 : 4, fifth = has(k.scaleName, 6) && !has(k.scaleName, 7) ? 6 : 7;
   const seventh = has(k.scaleName, 11) ? 11 : 10;
   const suffix = { '4,7,11': 'maj7', '4,7,10': '7', '3,7,10': 'm7', '3,7,11': 'm(maj7)', '3,6,10': 'm7b5' }[[third, fifth, seventh].join()] || '7';
   const c = chord(k, k.tonic, [0, third, fifth, seventh], suffix);
   return { say: `Stack one more third on the home chord: ${list(c.notes)} make ${c.symbol}, a richer, jazzier sound.`, example: chords([triad(k, k.tonic, k.minor), c]) };
  },
 },
 main_chords: {
  pick: 'play the three main chords of the key',
  build: k => {
   const cs = k.minor ? [triad(k, k.tonic, true), triad(k, k.tonic + 5, true), triad(k, k.tonic + 7, false), triad(k, k.tonic, true)]
    : [triad(k, k.tonic, false), triad(k, k.tonic + 5, false), triad(k, k.tonic + 7, false), triad(k, k.tonic, false)];
   const roman = k.minor ? 'i, iv and V' : 'I, IV and V';
   return { say: `Most songs lean on three chords. In ${k.name(k.tonic)}${k.minor ? ' minor' : ''} they are ${roman}: ${list(cs.slice(0, 3).map(c => c.symbol))}. Play them in turn and back home.`, example: chords(cs) };
  },
 },
 two_five_one: {
  pick: 'try the ii V I cadence in this key',
  build: k => {
   const cs = k.minor ? [chord(k, k.tonic + 2, [0, 3, 6, 10], 'm7b5'), chord(k, k.tonic + 7, [0, 4, 7, 10], '7'), chord(k, k.tonic, [0, 3, 7, 10], 'm7')]
    : [chord(k, k.tonic + 2, [0, 3, 7, 10], 'm7'), chord(k, k.tonic + 7, [0, 4, 7, 10], '7'), chord(k, k.tonic, [0, 4, 7, 11], 'maj7')];
   return { say: `The ii–V–I is the strongest way home in jazz: ${cs.map(c => c.symbol).join(' → ')}. Each chord's root falls a fifth to the next.`, example: chords(cs) };
  },
 },
 relative_key: {
  pick: 'explore the relative major or minor',
  build: k => {
   const rel = k.minor ? (k.tonic + 3) % 12 : (k.tonic + 9) % 12, name = k.minor ? 'Ionian (Major)' : 'Aeolian (Minor)';
   const word = k.minor ? 'major' : 'minor';
   return { say: `Same notes, new home: ${k.name(rel)} ${word} is the relative ${word} of ${k.label}. Start and end on ${k.name(rel)} and hear the mood change.`, example: run(k, rel, name) };
  },
 },
 neighbour_mode: {
  pick: 'change one note to try a neighbouring mode',
  build: k => {
   const next = { 'Ionian (Major)': 'Mixolydian', Mixolydian: 'Lydian', Lydian: 'Ionian (Major)', 'Aeolian (Minor)': 'Dorian', Dorian: 'Phrygian', Phrygian: 'Aeolian (Minor)' }[k.scaleName] || (k.minor ? 'Dorian' : 'Mixolydian');
   const from = new Set(SCALE_TEMPLATES[k.scaleName]), to = SCALE_TEMPLATES[next];
   const changed = to.filter(s => !from.has(s)).map(s => k.name(k.tonic + s));
   const label = next.replace(' (Major)', ' (major)').replace(' (Minor)', ' (minor)');
   return { say: `Change one note and the colour shifts: ${k.name(k.tonic)} ${label}${changed.length ? ` uses ${list(changed)} instead` : ''}. Play it and compare.`, example: run(k, k.tonic, next) };
  },
 },
 pentatonic: {
  pick: 'simplify to the five-note pentatonic scale',
  build: k => {
   const name = k.minor ? 'Minor Pentatonic' : 'Major Pentatonic';
   return { say: `Drop the two notes that make half steps and you get the ${k.name(k.tonic)} ${k.minor ? 'minor' : 'major'} pentatonic: ${list(scaleNotes(k, k.tonic, name))}. Almost any order sounds good, so improvise with it.`, example: run(k, k.tonic, name) };
  },
 },
 blues: {
  pick: 'add the blue note with the blues scale',
  // The blue note is a flattened fifth, so it is written as a flat (Eb in A blues), whatever the key.
  build: k => {
   const notes = SCALE_TEMPLATES.Blues.map(s => (s === 6 ? spell(k.tonic + 6, true) : k.name(k.tonic + s)));
   return { say: `Add the "blue" note ${notes[3]}, a flattened fifth, to the minor pentatonic and you have the ${k.name(k.tonic)} blues scale: ${list(notes)}.`, example: run(k, k.tonic, 'Blues') };
  },
 },
 arpeggio: {
  pick: 'play the home chord one note at a time',
  build: k => {
   const c = triad(k, k.tonic, k.minor), up = [...c.midi, c.midi[0] + 12];
   return { say: `Now spread the ${c.symbol} chord out one note at a time, an arpeggio: ${list([...c.notes, c.notes[0]])}, then back down.`, example: { steps: [...up, ...up.slice(0, -1).reverse()].map(n => [n]), bpm: 140 } };
  },
 },
 steady_time: {
  pick: 'play the same phrase again with steady timing',
  build: (k, a) => ({ say: 'Play that phrase again, keeping every note evenly spaced. Here it is with steady timing.', example: { steps: (a.noteOns || []).slice(0, 16).map(n => [n.note]), bpm: 110 } }),
 },
};

// Suggested order when Laya is unsure or not loaded: from the scale itself out towards harmony and colour.
export const CURRICULUM = ['scale_run', 'home_chord', 'arpeggio', 'main_chords', 'seventh_chord', 'pentatonic', 'relative_key', 'neighbour_mode', 'two_five_one', 'blues', 'steady_time'];

// One sentence naming what was played, from the analysis (no model involved).
export function describePlayed(a) {
 const k = keyOf(a);
 if (a.chords?.length >= 2) return `You played the chords ${a.chords.map(c => c.best.chordName.replace(/maj$/, '').replace(/min/, 'm')).join(' → ')}, in ${k.label}.`;
 if (a.chords?.length === 1) return `You played ${a.chords[0].best.chordName.replace(/maj$/, ' major').replace(/min$/, ' minor')}.`;
 if (a.pitchClasses.length >= 5) return `That's the ${k.label} scale.`;
 return `Those notes fit ${k.label}.`;
}

export const buildMove = (id, a) => ({ id, ...MOVES[id].build(keyOf(a), a) });

// What Laya reads: the situation in plain English, and the three questions it answers at once.
export function layaState(a, history = []) {
 const k = keyOf(a);
 const notes = (a.noteOns || []).slice(0, 24).map(n => k.name(n.note % 12)).join(' ');
 return `Piano lesson. The student just played ${a.noteCount} notes: ${notes}. ${describePlayed(a)} `
  + `${a.chords?.length ? `Chords: ${a.chords.map(c => c.best.chordName).join(', ')}.` : 'No chords, single notes only.'} `
  + `Steps already suggested this session: ${history.length ? history.slice(-6).map(id => MOVES[id].pick).join('; ') : 'none yet'}.`;
}
export function layaQuestions(options) {
 return {
  move: { type: 'choice', instructions: 'Which exercise should the teacher suggest next, so the student keeps learning one step at a time?', criteria: Object.fromEntries(options.map(id => [id, MOVES[id].pick])) },
  explain: { type: 'noul', instructions: 'The student would benefit from a deeper explanation of the theory behind what they just played' },
  level: { type: 'score', instructions: 'How advanced is what the student just played?', criteria: ['a few single notes', 'a scale or a simple chord', 'chord progressions or seventh chords'] },
 };
}

// The moves Laya may choose from: not the last three suggestions, and not what the phrase shows the student
// can already do (chords, sevenths, the scale they just played), so the lesson keeps moving forward.
export function availableMoves(history, a = null) {
 const recent = history.slice(-3), skip = new Set(recent);
 if (a) {
  const chords = a.chords || [], sevenths = chords.some(c => /7/.test(c.best.chordName)), scale = a.scales?.[0]?.scaleName || '';
  if (chords.length) { skip.add('home_chord'); skip.add('arpeggio'); }
  if (chords.length >= 3) skip.add('main_chords');
  if (sevenths) { skip.add('seventh_chord'); if (chords.length >= 3) skip.add('two_five_one'); }
  if (!chords.length && a.pitchClasses?.length >= 7) skip.add('scale_run');
  if (scale === 'Blues') skip.add('blues');
  if (/Pentatonic/.test(scale)) skip.add('pentatonic');
 }
 const out = CURRICULUM.filter(id => !skip.has(id));
 return out.length ? out : CURRICULUM.filter(id => !recent.includes(id));
}
export const fallbackMove = (history, a) => availableMoves(history, a)[0];
