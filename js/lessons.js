// A course for the keyboard, adapted from Open Music Theory by Kris Shaffer, Bryn Hughes, Brian Moseley and
// contributors (https://openmusictheory.github.io), licensed CC BY-SA 4.0; the lesson texts in this file are
// shared under the same license. Each lesson retells one idea from a chapter in a few sentences, plays an
// example, and sets a task that is checked from what the student plays, so no model is needed to teach or
// mark it. The examples are written around C3-C5; the teacher moves them onto the student's 25 keys.
import { SCALE_TEMPLATES, detectChord, midiToPitchClass, chordMidi, parseChordName, spell, prefersFlats } from './pitch-analyzer.js';

export const OMT = { title: 'Open Music Theory', url: 'https://openmusictheory.github.io', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' };
const page = name => `${OMT.url}/${name}.html`;

/* ---- What the student played: notes in order, and each set of keys held down together as a chord ---- */

// Chords come from the keys held at once, not from timing, so a slowly rolled chord still counts. A chord is
// recorded when its first key is released; holding a common tone into the next chord is fine.
export class Attempt {
 constructor() { this.reset(); }
 reset() { this.notes = []; this.chords = []; this.held = new Set(); this._peak = []; }
 noteOn(n) {
  this.notes.push(n); this.held.add(n);
  if (this.held.size >= this._peak.length) this._peak = [...this.held];
  if (this.notes.length > 64) this.notes.shift();
 }
 noteOff(n) {
  if (!this.held.delete(n)) return;
  if (this._peak.length >= 3) { this.chords.push(chordOf(this._peak)); if (this.chords.length > 16) this.chords.shift(); }
  this._peak = [];
 }
}

// { root, quality, bass, top }; quality is a CHORD_TEMPLATES name ('maj', 'min', '7', ...), or null if unknown.
export function chordOf(notes) {
 const bass = Math.min(...notes), top = Math.max(...notes), best = detectChord(notes, bass)[0];
 return best ? { root: best.root, quality: best.chordName.slice(best.rootName.length), bass, top } : { root: null, quality: null, bass, top };
}

const pc = midiToPitchClass;
const stepsOf = name => { const t = SCALE_TEMPLATES[name]; return [...t.slice(1), 12].map((s, i) => s - t[i]); };
const pairs = notes => notes.slice(1).map((n, i) => [notes[i], n]);

// A run of notes moving by `steps` half steps, up (or back down), starting on `tonic` if one is given.
export function findRun(notes, steps, tonic = null) {
 const down = [...steps].reverse().map(s => -s);
 for (let i = 0; i + steps.length < notes.length; i++) {
  if (tonic !== null && pc(notes[i]) !== tonic) continue;
  if ([steps, down].some(pat => pat.every((d, k) => notes[i + k + 1] - notes[i + k] === d))) return true;
 }
 return false;
}

// Progressions are lists of [half steps above the tonic, quality]; an entry may list alternatives. Qualities
// are loose here, so V can be V7: 'maj' takes a major triad or any seventh chord built on one.
const FAMILY = { maj: ['maj', 'maj7', '7', '9'], min: ['min', 'min7'], dim: ['dim', 'min7b5', 'dim7'], 7: ['7', '9'] };
const options = entry => (Array.isArray(entry[0]) ? entry : [entry]);
const fits = (c, tonic, [iv, q]) => c.root === (tonic + iv) % 12 && FAMILY[q].includes(c.quality);

// The first place the progression was played, in any key unless `tonic` is given: { tonic, chords } or null.
// A chord struck twice in a row counts once.
export function findProgression(chords, spec, tonic = null) {
 const seq = chords.filter((c, i) => i === 0 || c.root !== chords[i - 1].root || c.quality !== chords[i - 1].quality);
 for (let s = 0; s + spec.length <= seq.length; s++) {
  if (seq[s].root === null) continue;
  for (const [iv] of options(spec[0])) {
   const t = pc(seq[s].root - iv);
   if (tonic !== null && t !== tonic) continue;
   if (spec.every((entry, k) => options(entry).some(o => fits(seq[s + k], t, o)))) return { tonic: t, chords: seq.slice(s, s + spec.length) };
  }
 }
 return null;
}

/* ---- Examples ---- */

const chords = (names, bpm = 60) => ({ steps: names.map(n => chordMidi(parseChordName(n))), bpm });
const line = (notes, bpm = 120) => ({ steps: notes.map(n => [n]), bpm });
const scaleUp = (low, name) => [...SCALE_TEMPLATES[name].map(s => low + s), low + 12];
// A passed check says what was played: "I–IV–V in G".
const inKey = (found, words, minor = false) => !!found && `${words} in ${spell(found.tonic, prefersFlats(found.tonic, minor))}${minor ? ' minor' : ''}`;

/* ---- The course ---- */

export const UNITS = ['Fundamentals', 'Harmony', 'Pop and rock harmony'];

export const LESSONS = [
 {
  id: 'keyboard', unit: 'Fundamentals', title: 'Pitches on the keyboard', page: page('pitches'),
  text: 'The keyboard repeats a pattern of twelve keys: seven white keys named A to G, and five black keys in groups of two and three. Every key with the same letter belongs to one pitch class; each C sits just left of a pair of black keys. A pitch is a pitch class in a particular register: middle C is C4, the C above it C5 and the C below it C3. Your 25 keys run from C3 to C5.',
  example: line([48, 60, 72], 80),
  task: 'Play every C on your keyboard, from the lowest to the highest.',
  hint: 'Look for the white key just left of each pair of black keys, and play them going up.',
  check: p => findRun(p.notes, [12, 12], 0),
 },
 {
  id: 'enharmonic', unit: 'Fundamentals', title: 'Sharps, flats and enharmonic names', page: page('pitches'),
  text: 'A sharp raises a note by one key and a flat lowers it by one, so the black key between C and D is both C♯ and D♭. Two names for the same key are enharmonic equivalents. White keys have them too: E♯ is the same key as F, and C♭ the same as B.',
  example: line([60, 61, 62, 61, 60], 100),
  task: 'Play the key that is both F♯ and G♭, then the one that is both A♯ and B♭.',
  hint: 'F♯/G♭ is the first black key of the group of three; A♯/B♭ is the last one.',
  check: p => pairs(p.notes).some(([a, b]) => pc(a) === 6 && pc(b) === 10),
 },
 {
  id: 'chromatic', unit: 'Fundamentals', title: 'Half steps and the chromatic scale', page: page('scales'),
  text: 'A half step is the distance from one key to the very next one, black or white. A whole step is two half steps. The chromatic scale moves only by half steps, so it plays every key in order: from one C to the next is twelve half steps.',
  example: line(Array.from({ length: 13 }, (_, i) => 60 + i), 220),
  task: 'Play the chromatic scale from a C up to the next C: all thirteen keys in a row.',
  hint: 'Don\'t skip any key, black or white, between the two Cs.',
  check: p => findRun(p.notes, Array(12).fill(1), 0),
 },
 {
  id: 'major_scale', unit: 'Fundamentals', title: 'The major scale', page: page('scales'),
  text: 'A major scale climbs by whole (W) and half (H) steps in the order W W H W W W H. Its first note, the tonic, names the scale and comes back an octave higher at the top. From C the pattern lands only on white keys; from D it needs two black keys, F♯ and C♯.',
  example: line(scaleUp(50, 'Ionian (Major)'), 150),
  task: 'Play the D major scale going up: D E F♯ G A B C♯ D.',
  hint: 'Count the pattern from D: whole, whole, half, whole, whole, whole, half.',
  check: p => findRun(p.notes, stepsOf('Ionian (Major)'), 2),
 },
 {
  id: 'scale_degrees', unit: 'Fundamentals', title: 'Scale degrees and solfège', page: page('scales'),
  text: 'Within a key each note has a number, its scale degree (1 to 7), and a solfège syllable: do, re, mi, fa, sol, la, ti. The tonic is 1, do. Ti sits a half step below do and leans strongly up into it, which is why a major scale sounds finished when it gets home.',
  example: line([...scaleUp(48, 'Ionian (Major)').slice(0, 7), 59, 60], 150),
  task: 'In C major, play ti then do: B up to the C just above it.',
  hint: 'B is the white key just left of C; go up one half step.',
  check: p => pairs(p.notes).some(([a, b]) => b - a === 1 && pc(b) === 0),
 },
 {
  id: 'minor_scales', unit: 'Fundamentals', title: 'Natural and harmonic minor', page: page('scales'),
  text: 'Minor scales lower the third degree of major. The natural minor scale goes W H W W H W W, with me, le and te in place of mi, la and ti, and its top step to do is a whole step, so it sounds less settled. Raising the seventh degree back to ti gives the harmonic minor scale, which ends with a half step into do.',
  example: line([...scaleUp(57, 'Aeolian (Minor)'), ...scaleUp(57, 'Harmonic Minor')], 160),
  task: 'Play the A harmonic minor scale going up: A B C D E F G♯ A.',
  hint: 'Play the white keys from A to A, but use G♯ instead of G.',
  check: p => findRun(p.notes, stepsOf('Harmonic Minor'), 9),
 },
 {
  id: 'key_signatures', unit: 'Fundamentals', title: 'Key signatures and the circle of fifths', page: page('keySignatures'),
  text: 'Going round the circle of fifths, each new key starts a fifth higher and adds one sharp: C major has none, G major has F♯, D major F♯ and C♯. Sharps are added in the order F C G D A E B ("Father Charles Goes Down And Ends Battle"), and flats in the reverse order, B E A D G C F.',
  example: line([48, 55, 50, 57, 52], 90),
  task: 'Play the G major scale going up. It has one sharp: F♯.',
  hint: 'From G: G A B C D E F♯ G.',
  check: p => findRun(p.notes, stepsOf('Ionian (Major)'), 7),
 },
 {
  id: 'relative_minor', unit: 'Fundamentals', title: 'Relative keys', page: page('keySignatures'),
  text: 'A major key and a minor key that share a key signature are relatives. C major and A minor both have no sharps or flats: the tonic of the relative minor is the sixth degree (la) of the major key, three half steps below its tonic.',
  example: line([...scaleUp(48, 'Ionian (Major)'), ...scaleUp(57, 'Aeolian (Minor)')], 160),
  task: 'Play the A natural minor scale going up, on white keys only.',
  hint: 'Start on A and play every white key up to the next A.',
  check: p => findRun(p.notes, stepsOf('Aeolian (Minor)'), 9),
 },
 {
  id: 'intervals', unit: 'Fundamentals', title: 'Intervals', page: page('intervals'),
  text: 'An interval is the distance between two notes. Count half steps for its exact size (C to E is four), and count letter names, including both ends, for its number (C, D, E: a third). Together they give the quality: a third of four half steps is a major third, and of three a minor third. Unisons, fourths, fifths and octaves are perfect; a perfect fifth spans seven half steps.',
  example: { steps: [[60], [64], [60, 64], [60, 63], [60, 67]], bpm: 70 },
  task: 'Play a perfect fifth, seven half steps, from any note: one note after the other, or both together.',
  hint: 'From C, count seven keys up to G. Play just those two notes.',
  check: p => pairs(p.notes).some(([a, b]) => Math.abs(b - a) === 7),
 },
 {
  id: 'inversion', unit: 'Fundamentals', title: 'Inverting intervals', page: page('intervals'),
  text: 'Move the lower note of an interval up an octave and you invert it: C up to E, a major third of four half steps, becomes E up to C, a minor sixth of eight. The half steps of an interval and its inversion add up to twelve and their numbers to nine. Major turns into minor, augmented into diminished, and perfect stays perfect.',
  example: { steps: [[60, 64], [64, 72], [60, 67], [67, 72]], bpm: 60 },
  task: 'Invert a perfect fifth: play C up to G, then G up to the C above it, a perfect fourth.',
  hint: 'C to G is seven half steps; G to the next C is five.',
  check: p => pairs(p.notes).some(([a, b], i) => b - a === 7 && pairs(p.notes).slice(i + 1).some(([c, d]) => d - c === 5 && pc(c) === pc(b) && pc(d) === pc(a))),
 },
 {
  id: 'triads', unit: 'Fundamentals', title: 'Triads', page: page('triads'),
  text: 'A triad stacks two thirds: a root, a third above it, and a fifth above the root. Its quality comes from those intervals: major has a major third and perfect fifth (C E G), minor a minor third and perfect fifth (C E♭ G), diminished a minor third and diminished fifth (B D F), augmented a major third and augmented fifth (C E G♯). Chord symbols write them C, Cm, Bdim and C+.',
  example: chords(['C', 'Cm', 'Bdim', 'C+']),
  task: 'Play a minor triad on any root. Tip: play a major triad, then lower its middle note one half step.',
  hint: 'A minor triad is three half steps, then four: A C E, or D F A.',
  check: p => p.chords.some(c => c.quality === 'min'),
 },
 {
  id: 'roman_numerals', unit: 'Fundamentals', title: 'Chords in a key: Roman numerals', page: page('triads'),
  text: 'Build a triad on each degree of a major scale and you get I ii iii IV V vi vii°: capitals for major, lower case for minor, and ° for diminished. In C major they are C, Dm, Em, F, G, Am and Bdim. The three major ones, I, IV and V, carry a great deal of music.',
  example: chords(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim', 'C'], 100),
  task: 'Play I, IV and V of a major key, in that order: in C, the chords C, F and G.',
  hint: 'IV is built on the fourth degree and V on the fifth: from C, that is F A C and G B D.',
  check: p => inKey(findProgression(p.chords, [[0, 'maj'], [5, 'maj'], [7, 'maj']]), 'I–IV–V'),
 },
 {
  id: 'seventh_chords', unit: 'Fundamentals', title: 'Seventh chords', page: page('triads'),
  text: 'Stack one more third on a triad and you have a seventh chord. Five kinds occur in major and minor keys: major seventh (Cmaj7: C E G B), dominant seventh (G7: G B D F), minor seventh (Dm7: D F A C), half-diminished (Bø7: B D F A) and diminished seventh (B°7: B D F A♭). The chord on the fifth degree, V7, is always a dominant seventh.',
  example: chords(['Cmaj7', 'G7', 'Dm7', 'Bm7b5', 'Bdim7']),
  task: 'Play the dominant seventh on G: G B D F (or a dominant seventh on any root).',
  hint: 'Take a major triad and add the note a minor third above its top: G B D, plus F.',
  check: p => p.chords.some(c => c.quality === '7'),
 },
 {
  id: 'functions', unit: 'Harmony', title: 'Harmonic functions: T, S and D', page: page('harmonicFunctions'),
  text: 'In classical music, chords fall into three functions. Tonic (T: I, and often vi) is home. Dominant (D: V and vii°) holds ti, the leading tone, and pulls back home. Subdominant, also called predominant (S: ii and IV), leads away from tonic towards dominant. Progressions tend to cycle T, S, D and back to T.',
  example: chords(['C', 'F', 'G', 'C']),
  task: 'Play T, S, D, T in a major key: in C, play C, then F or Dm, then G or G7, then C.',
  hint: 'The subdominant can be IV (F A C) or ii (D F A); the dominant is V (G B D).',
  check: p => inKey(findProgression(p.chords, [[0, 'maj'], [[5, 'maj'], [2, 'min']], [7, 'maj'], [0, 'maj']]), 'T–S–D–T'),
 },
 {
  id: 'phrase_model', unit: 'Harmony', title: 'The idealized phrase', page: page('harmonicSyntax1'),
  text: 'The simplest complete phrase is I–V–I: start at home, rise to the tension of the dominant, and resolve. It grows by adding a subdominant before V (I–IV–V–I, I–ii–V–I), and a vi before that (I–vi–ii–V–I). Every version starts on tonic, moves through S to D, and closes on I.',
  example: chords(['C', 'Am', 'Dm', 'G', 'C']),
  task: 'Play I–vi–ii–V–I in a major key: in C, the chords C, Am, Dm, G and C.',
  hint: 'vi is the minor chord on the sixth degree (A C E in C); ii the minor chord on the second (D F A).',
  check: p => inKey(findProgression(p.chords, [[0, 'maj'], [9, 'min'], [2, 'min'], [7, 'maj'], [0, 'maj']]), 'I–vi–ii–V–I'),
 },
 {
  id: 'cadences', unit: 'Harmony', title: 'Cadences', page: page('cadenceTypes'),
  text: 'A cadence ends a phrase. An authentic cadence goes from V to I, with sol to do in the bass. If the melody also lands on do it is a perfect authentic cadence (PAC), the strongest close; landing on mi makes it imperfect (IAC). A phrase that stops on V is a half cadence (HC): a comma rather than a full stop.',
  example: { steps: [[48, 64, 67, 72], [53, 65, 69, 72], [55, 62, 67, 71], [48, 64, 67, 72], [48, 64, 67, 72], [53, 65, 69, 72], [55, 62, 67, 71]], bpm: 70 },
  task: 'Play a perfect authentic cadence: V then I in root position, with the tonic on top of the last chord. In C: G B D (or G7), then C E G C.',
  hint: 'Put the root of each chord at the bottom, and make the highest note of the final chord its root.',
  check: p => {
   const found = findProgression(p.chords, [[7, 'maj'], [0, 'maj']]);
   if (!found) return false;
   const [v, i] = found.chords, t = found.tonic;
   return pc(v.bass) === (t + 7) % 12 && pc(i.bass) === t && pc(i.top) === t && inKey(found, 'a perfect authentic cadence');
  },
 },
 {
  id: 'doo_wop', unit: 'Pop and rock harmony', title: 'The \'50s doo-wop progression', page: page('popRockHarmony-dooWop'),
  text: 'Pop and rock songs often loop a stock progression. The "50s doo-wop" progression cycles I–vi–IV–V (or I–vi–ii–V), as in "Duke of Earl", and it has never gone away. Because it loops, a song can start it on another chord: "Viva la Vida" begins on IV.',
  example: chords(['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G'], 90),
  task: 'Play I–vi–IV–V in a major key: in C, the chords C, Am, F and G.',
  hint: 'Root position works best here: C E G, A C E, F A C, G B D.',
  check: p => inKey(findProgression(p.chords, [[0, 'maj'], [9, 'min'], [[5, 'maj'], [2, 'min']], [7, 'maj']]), 'I–vi–IV–V'),
 },
 {
  id: 'singer_songwriter', unit: 'Pop and rock harmony', title: 'The singer/songwriter progression', page: page('popRockHarmony-sscp'),
  text: 'The singer/songwriter progression loops vi–IV–I–V. The same four chords, Am–F–C–G, can sound like C major or like A minor (i–VI–III–VII): which chord the loop starts and ends on decides, and songwriters play on that ambiguity. "With or Without You" runs the same cycle from I: I–V–vi–IV.',
  example: chords(['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'G'], 90),
  task: 'Play vi–IV–I–V: in C, the chords Am, F, C and G.',
  hint: 'Start on the minor chord a minor third below the tonic: A C E in C major.',
  check: p => inKey(findProgression(p.chords, [[9, 'min'], [5, 'maj'], [0, 'maj'], [7, 'maj']]), 'vi–IV–I–V'),
 },
 {
  id: 'puff', unit: 'Pop and rock harmony', title: 'The "Puff" progression', page: page('popRockHarmony-puff'),
  text: 'The "Puff" progression, named after "Puff, the Magic Dragon", opens a phrase with I–iii–IV. Where classical music would put a first-inversion I over mi in the bass, pop uses a root-position iii chord. In minor, as in "House of the Rising Sun", it becomes i–III–IV.',
  example: chords(['C', 'Em', 'F', 'C'], 80),
  task: 'Play I–iii–IV in a major key: in C, the chords C, Em and F.',
  hint: 'iii is the minor chord on the third degree: E G B in C major.',
  check: p => inKey(findProgression(p.chords, [[0, 'maj'], [4, 'min'], [5, 'maj']]), 'I–iii–IV'),
 },
 {
  id: 'lament', unit: 'Pop and rock harmony', title: 'The lament progression', page: page('popRockHarmony-lament'),
  text: 'The lament progression walks the bass down from do to sol in minor: i–VII–VI–V, in A minor Am–G–F–E. Baroque composers built laments over it as a repeating ground bass, as in Purcell\'s "Dido\'s Lament", and rock still uses it.',
  example: chords(['Am', 'G', 'F', 'E', 'Am'], 70),
  task: 'Play i–VII–VI–V in a minor key: in A minor, the chords Am, G, F and E.',
  hint: 'The last chord, V, is major even in minor: E G♯ B.',
  check: p => inKey(findProgression(p.chords, [[0, 'min'], [10, 'maj'], [8, 'maj'], [7, 'maj']]), 'the lament, i–VII–VI–V,', true),
 },
 {
  id: 'pachelbel', unit: 'Pop and rock harmony', title: 'The Pachelbel progression', page: page('popRockHarmony-pachelbel'),
  text: 'The Pachelbel progression comes from the famous Canon in D: I–V–vi–iii–IV–I–IV–V. Many songs use just its first four chords to begin a phrase and then go their own way.',
  example: chords(['C', 'G', 'Am', 'Em', 'F', 'C', 'F', 'G'], 90),
  task: 'Play the opening four chords, I–V–vi–iii: in C, the chords C, G, Am and Em.',
  hint: 'After C and G, play the two minor chords: A C E, then E G B.',
  check: p => inKey(findProgression(p.chords, [[0, 'maj'], [7, 'maj'], [9, 'min'], [4, 'min']]), 'I–V–vi–iii'),
 },
 {
  id: 'plagal', unit: 'Pop and rock harmony', title: 'Plagal progressions', page: page('popRockHarmony-plagal'),
  text: 'IV to I is a plagal motion, and rock leans on it far more than classical music does: whole verses rock between I and IV. The double-plagal progression goes back two fourths, ♭VII–IV–I, as in the coda of "Hey Jude".',
  example: chords(['C', 'F', 'C', 'Bb', 'F', 'C'], 80),
  task: 'Play the double-plagal ♭VII–IV–I: in C, the chords B♭, F and C.',
  hint: '♭VII is the major chord a whole step below the tonic: B♭ D F in C.',
  check: p => inKey(findProgression(p.chords, [[10, 'maj'], [5, 'maj'], [0, 'maj']]), '♭VII–IV–I'),
 },
 {
  id: 'fifths_minor', unit: 'Pop and rock harmony', title: 'The circle of fifths in minor', page: page('popRockHarmony-fifths'),
  text: 'In i–iv–VII–III every root falls a fifth to the next: in A minor, Am–Dm–G–C. Because it ends on the relative major, songs can let it tip into that key, or carry on round the circle as "I Will Survive" does.',
  example: chords(['Am', 'Dm', 'G', 'C'], 80),
  task: 'Play i–iv–VII–III in a minor key: in A minor, the chords Am, Dm, G and C.',
  hint: 'Each new root is a fifth below the last: A, D, G, C.',
  check: p => inKey(findProgression(p.chords, [[0, 'min'], [5, 'min'], [10, 'maj'], [3, 'maj']]), 'i–iv–VII–III', true),
 },
 {
  id: 'blues', unit: 'Pop and rock harmony', title: 'The 12-bar blues', page: page('popRockHarmony-blues'),
  text: 'A 12-bar blues is three four-bar phrases: I I I I, then IV IV I I, then V IV I I. The phrases start on tonic, subdominant and dominant in turn. The last phrase may end with a turnaround that leads back to the top.',
  example: chords(['C', 'C', 'C', 'C', 'F', 'F', 'C', 'C', 'G', 'F', 'C', 'C'], 120),
  task: 'Play the last phrase: V–IV–I. In C, the chords G, F and C.',
  hint: 'Walk down from V to IV, then home: G B D, F A C, C E G.',
  check: p => inKey(findProgression(p.chords, [[7, 'maj'], [5, 'maj'], [0, 'maj']]), 'V–IV–I'),
 },
];

export const lessonById = id => LESSONS.find(l => l.id === id);
export const nextLesson = id => LESSONS[LESSONS.findIndex(l => l.id === id) + 1] || null;

// What the model is asked when the student wants more than the lesson says.
export const explainPrompt = l => `The student is on the lesson "${l.title}", adapted from Open Music Theory (${l.page}). The lesson says: ${l.text} Their task: ${l.task} Explain this idea a little more deeply in your own words, and give one example to play.`;
