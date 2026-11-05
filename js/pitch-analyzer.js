// Local, synchronous music analysis for the AI teacher: pitch classes (mod 12), scale/mode and chord
// detection, and a tracker that turns live notes into phrases. No network; every call is microseconds.
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const SCALE_TEMPLATES = {
 'Ionian (Major)': [0, 2, 4, 5, 7, 9, 11],
 'Dorian': [0, 2, 3, 5, 7, 9, 10],
 'Phrygian': [0, 1, 3, 5, 7, 8, 10],
 'Lydian': [0, 2, 4, 6, 7, 9, 11],
 'Mixolydian': [0, 2, 4, 5, 7, 9, 10],
 'Aeolian (Minor)': [0, 2, 3, 5, 7, 8, 10],
 'Locrian': [0, 1, 3, 5, 6, 8, 10],
 'Melodic Minor': [0, 2, 3, 5, 7, 9, 11],
 'Lydian Dominant': [0, 2, 4, 6, 7, 9, 10],
 'Altered': [0, 1, 3, 4, 6, 8, 10],
 'Harmonic Minor': [0, 2, 3, 5, 7, 8, 11],
 'Phrygian Dominant': [0, 1, 4, 5, 7, 8, 10],
 'Major Pentatonic': [0, 2, 4, 7, 9],
 'Minor Pentatonic': [0, 3, 5, 7, 10],
 'Blues': [0, 3, 5, 6, 7, 10],
 'Whole Tone': [0, 2, 4, 6, 8, 10],
 'Diminished (HW)': [0, 1, 3, 4, 6, 7, 9, 10],
 'Diminished (WH)': [0, 2, 3, 5, 6, 8, 9, 11],
};

export const CHORD_TEMPLATES = {
 'maj': [0, 4, 7], 'min': [0, 3, 7], 'dim': [0, 3, 6], 'aug': [0, 4, 8],
 'maj7': [0, 4, 7, 11], 'min7': [0, 3, 7, 10], '7': [0, 4, 7, 10],
 'dim7': [0, 3, 6, 9], 'min7b5': [0, 3, 6, 10], 'sus4': [0, 5, 7],
 'sus2': [0, 2, 7], '9': [0, 2, 4, 7, 10],
};

export const midiToPitchClass = n => ((n % 12) + 12) % 12;
export const pitchClassName = pc => NOTE_NAMES[midiToPitchClass(pc)];

// A full diatonic set fits all seven modes equally, so ties go to the tonic the player leaned on:
// `tonicHints` lists pitch classes in priority order (the phrase's last, first and lowest notes).
const hintRank = (pc, hints) => { const i = hints.indexOf(pc); return i < 0 ? hints.length : i; };

export function detectScale(pitchClasses, tonicHints = []) {
 const pcSet = new Set(pitchClasses.map(midiToPitchClass));
 const hints = tonicHints.map(midiToPitchClass);
 const results = [];
 for (const [name, template] of Object.entries(SCALE_TEMPLATES)) {
  for (let tonic = 0; tonic < 12; tonic++) {
   const shifted = template.map(t => (t + tonic) % 12);
   const shiftedSet = new Set(shifted);
   const missing = shifted.filter(t => !pcSet.has(t));
   const extra = [...pcSet].filter(p => !shiftedSet.has(p));
   const score = (shifted.length - missing.length) / shifted.length;
   if (score >= 0.5 && extra.length <= 2) {
    results.push({ tonic, tonicName: NOTE_NAMES[tonic], scaleName: name, template: shifted, score,
     missing: missing.map(m => NOTE_NAMES[m]), extra: extra.map(e => NOTE_NAMES[e]) });
   }
  }
 }
 results.sort((a, b) => b.score - a.score || a.extra.length - b.extra.length || hintRank(a.tonic, hints) - hintRank(b.tonic, hints));
 return results.slice(0, 5);
}

// Prefers the chord that explains every note, then one rooted on the bass note: C-E-G-B is Cmaj7, not Cmaj or Em.
export function detectChord(pitchClasses, bassPc = null) {
 const pcSet = new Set(pitchClasses.map(midiToPitchClass));
 if (pcSet.size < 3) return [];
 const results = [];
 for (const [name, template] of Object.entries(CHORD_TEMPLATES)) {
  for (let root = 0; root < 12; root++) {
   const shifted = new Set(template.map(t => (t + root) % 12));
   const matched = [...shifted].filter(t => pcSet.has(t)).length;
   const extra = [...pcSet].filter(p => !shifted.has(p)).length;
   const score = matched / shifted.size;
   if (score >= 0.75) results.push({ root, rootName: NOTE_NAMES[root], chordName: `${NOTE_NAMES[root]}${name}`, score, extra });
  }
 }
 const bass = bassPc === null ? null : midiToPitchClass(bassPc);
 results.sort((a, b) => b.score - a.score || a.extra - b.extra || (b.root === bass) - (a.root === bass));
 return results.slice(0, 5);
}

export function buildScale(tonicPc, templateName, octave = 4) {
 const t = SCALE_TEMPLATES[templateName];
 return t ? t.map(s => octave * 12 + tonicPc + s) : null;
}

// Collects note-ons and note-offs and reports a phrase once every key is up and `gapMs` passes in silence.
export class PhraseTracker {
 constructor(onPhrase, { gapMs = 800, chordWindowMs = 50 } = {}) {
  this.onPhrase = onPhrase; this.gapMs = gapMs; this.chordWindowMs = chordWindowMs;
  this.currentPhrase = []; this.heldNotes = new Set(); this._timer = null;
 }
 noteOn(note, vel, time) {
  this.heldNotes.add(note);
  this.currentPhrase.push({ note, pc: midiToPitchClass(note), velocity: vel, time, type: 'on' });
  clearTimeout(this._timer);
 }
 noteOff(note, time) {
  if (!this.heldNotes.delete(note)) return;
  this.currentPhrase.push({ note, pc: midiToPitchClass(note), time, type: 'off' });
  if (this.heldNotes.size === 0) {
   clearTimeout(this._timer);
   this._timer = setTimeout(() => this._endPhrase(), this.gapMs);
  }
 }
 _endPhrase() {
  if (!this.currentPhrase.length) return;
  const phrase = this.currentPhrase; this.currentPhrase = [];
  const noteOns = phrase.filter(e => e.type === 'on');
  const pcs = [...new Set(noteOns.map(e => e.pc))];
  const lowest = noteOns.reduce((lo, e) => (e.note < lo.note ? e : lo), noteOns[0]);
  // The tonic hints use the bass of the first and last chord (or the note itself), not the top of a chord:
  // C-F-G-C played as triads ends on G at the top but is plainly in C.
  const wins = this._windows(noteOns), bass = win => win.reduce((lo, n) => (n.note < lo.note ? n : lo)).pc;
  this.onPhrase({
   pitchClasses: pcs, noteOns,
   durationMs: phrase[phrase.length - 1].time - phrase[0].time,
   noteCount: noteOns.length,
   scales: detectScale(pcs, [bass(wins[wins.length - 1]), bass(wins[0]), lowest.pc]),
   chords: this._chordWins(wins),
  });
 }
 // Notes struck within `chordWindowMs` of each other form one window (a chord, or a single note).
 _windows(noteOns) {
  const wins = [];
  let win = [noteOns[0]];
  for (let i = 1; i < noteOns.length; i++) {
   if (noteOns[i].time - win[0].time <= this.chordWindowMs) win.push(noteOns[i]);
   else { wins.push(win); win = [noteOns[i]]; }
  }
  wins.push(win);
  return wins;
 }
 _chordWins(wins) {
  const chords = [];
  for (const win of wins) {
   if (win.length < 3) continue;
   const bass = win.reduce((lo, n) => Math.min(lo, n.note), Infinity);
   const c = detectChord(win.map(n => n.pc), bass);
   if (c.length) chords.push({ notes: win.map(n => pitchClassName(n.pc)), best: c[0] });
  }
  return chords;
 }
 reset() { clearTimeout(this._timer); this.currentPhrase = []; this.heldNotes.clear(); }
}

/* ---- Names to notes: models name a scale or chord, and the notes are worked out here, exactly. ---- */

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const accidental = s => [...s].reduce((n, a) => n + (a === '#' || a === '♯' ? 1 : -1), 0);

// "C", "F#", "Bb", "E♭" → pitch class 0-11, or null.
export function pcFromName(name) {
 const m = /^([A-Ga-g])([#♯b♭]*)$/.exec(String(name).trim());
 return m ? midiToPitchClass(LETTER[m[1].toUpperCase()] + accidental(m[2])) : null;
}

// Scientific pitch, as the models write it: "C4" is middle C, MIDI 60 (and "B#3" is MIDI 60 too).
export function midiFromName(name) {
 const m = /^([A-Ga-g])([#♯b♭]*)(-?\d)$/.exec(String(name).trim());
 return m ? (Number(m[3]) + 1) * 12 + LETTER[m[1].toUpperCase()] + accidental(m[2]) : null;
}

// Flat keys (F, Bb, Eb, Ab, Db, Gb and their relative minors) spell with flats; the rest with sharps.
export const prefersFlats = (tonic, minor = false) => [5, 10, 3, 8, 1, 6].includes(minor ? (tonic + 3) % 12 : tonic);
export const spell = (pc, flats = false) => (flats ? FLAT_NAMES : NOTE_NAMES)[midiToPitchClass(pc)];

// Chord symbols, by the suffix after the root. Exact case first, so "CM7" is major seventh and "Cm7" minor.
export const CHORD_FORMULAS = {
 '': [0, 4, 7], M: [0, 4, 7], maj: [0, 4, 7], major: [0, 4, 7],
 m: [0, 3, 7], min: [0, 3, 7], '-': [0, 3, 7], minor: [0, 3, 7],
 dim: [0, 3, 6], '°': [0, 3, 6], o: [0, 3, 6], aug: [0, 4, 8], '+': [0, 4, 8],
 7: [0, 4, 7, 10], dom7: [0, 4, 7, 10],
 maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], 'Δ': [0, 4, 7, 11], 'Δ7': [0, 4, 7, 11],
 m7: [0, 3, 7, 10], min7: [0, 3, 7, 10], '-7': [0, 3, 7, 10],
 m7b5: [0, 3, 6, 10], min7b5: [0, 3, 6, 10], 'ø': [0, 3, 6, 10], 'ø7': [0, 3, 6, 10],
 dim7: [0, 3, 6, 9], '°7': [0, 3, 6, 9], o7: [0, 3, 6, 9],
 mmaj7: [0, 3, 7, 11], mM7: [0, 3, 7, 11], minmaj7: [0, 3, 7, 11],
 sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7], '7sus4': [0, 5, 7, 10],
 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14],
 add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], 5: [0, 7],
};

// "Dm7", "F#maj7", "Bb", "G7/B" → { root, bass, intervals }, or null for anything unrecognised.
export function parseChordName(text) {
 const m = /^\s*([A-Ga-g][#♯b♭]?)([^/\s]*)(?:\s*\/\s*([A-Ga-g][#♯b♭]?))?\s*$/.exec(String(text));
 if (!m) return null;
 const intervals = CHORD_FORMULAS[m[2]] ?? CHORD_FORMULAS[m[2].toLowerCase()];
 if (!intervals) return null;
 const root = pcFromName(m[1]);
 return { root, bass: m[3] ? pcFromName(m[3]) : root, intervals };
}

const SCALE_ALIASES = [
 [/^(major|ionian|maj)$/, 'Ionian (Major)'], [/^(natural minor|minor|aeolian|min)$/, 'Aeolian (Minor)'],
 [/^dorian$/, 'Dorian'], [/^phrygian$/, 'Phrygian'], [/^lydian$/, 'Lydian'], [/^mixolydian$/, 'Mixolydian'], [/^locrian$/, 'Locrian'],
 [/^harmonic minor$/, 'Harmonic Minor'], [/^(melodic minor|jazz minor)$/, 'Melodic Minor'],
 [/^(major pentatonic|pentatonic major|pentatonic)$/, 'Major Pentatonic'], [/^(minor pentatonic|pentatonic minor)$/, 'Minor Pentatonic'],
 [/^(blues|minor blues)$/, 'Blues'], [/^whole[ -]?tone$/, 'Whole Tone'],
 [/^(diminished|half[ -]whole diminished|octatonic)$/, 'Diminished (HW)'], [/^whole[ -]half diminished$/, 'Diminished (WH)'],
 [/^(lydian dominant|lydian b7)$/, 'Lydian Dominant'], [/^(altered|super ?locrian)$/, 'Altered'], [/^(phrygian dominant|spanish phrygian)$/, 'Phrygian Dominant'],
];

// "D Dorian", "A minor pentatonic scale", "Bb major" → { tonic, scaleName } (a SCALE_TEMPLATES key), or null.
export function parseScaleName(text) {
 const m = /^\s*([A-Ga-g][#♯b♭]?)\s+(.+?)\s*$/.exec(String(text));
 if (!m) return null;
 const kind = m[2].toLowerCase().replace(/\s+/g, ' ').replace(/ (scale|mode)$/, '').replace(/[()]/g, '');
 const hit = SCALE_ALIASES.find(([re]) => re.test(kind));
 return hit ? { tonic: pcFromName(m[1]), scaleName: hit[1] } : null;
}

// Voicings that sit on the app's default keyboard (MIDI 48-72): chord roots and scale tonics between C3 and B3.
export function chordMidi({ root, bass = root, intervals }, low = 48) {
 const notes = intervals.map(i => low + root + i);
 if (bass === root) return notes;
 return [low + root - ((root - bass + 12) % 12), ...notes]; // a slash chord's bass goes just below the root
}
export function scaleRunMidi(tonic, scaleName, low = 48) {
 const up = [...SCALE_TEMPLATES[scaleName].map(s => low + tonic + s), low + tonic + 12];
 return [...up, ...up.slice(0, -1).reverse()];
}

/* ---- The keyboard: everything the teacher plays fits on a 25-key controller, two octaves from C to C. ---- */

export const KEYS_LOW = 48, KEYS_SPAN = 24; // a 25-key controller's default range, C3-C5, and the app's keyboard

// The window follows the student's octave buttons: a note played outside it moves it by whole octaves.
export function followKeys(low, note) {
 if (note < low) return note - midiToPitchClass(note);
 if (note > low + KEYS_SPAN) return Math.ceil((note - KEYS_SPAN) / 12) * 12;
 return low;
}

// The octave move (in semitones) nearest zero that brings lo..hi inside low..high, or null if none does.
function octaveMove(notes, low, high) {
 const min = Math.ceil((low - Math.min(...notes)) / 12), max = Math.floor((high - Math.max(...notes)) / 12);
 return min <= max ? Math.min(Math.max(0, min), max) * 12 : null;
}

// Moves an example onto the keys from `low` to `low + 24`: the whole example by octaves when it fits, so a run
// keeps its shape; otherwise each step on its own. A chord that still doesn't fit keeps its bass at the bottom
// and closes up within the octave above it (G7/B becomes B D F G).
export function fitToKeys(steps, low = KEYS_LOW) {
 const high = low + KEYS_SPAN, all = steps.flat();
 if (!all.length) return steps;
 const whole = octaveMove(all, low, high);
 if (whole !== null) return steps.map(s => s.map(n => n + whole));
 return steps.map(s => {
  if (!s.length) return s;
  const d = octaveMove(s, low, high);
  if (d !== null) return s.map(n => n + d);
  const bass = low + midiToPitchClass(Math.min(...s) - low);
  return [...new Set(s.map(n => bass + midiToPitchClass(n - bass)))].sort((a, b) => a - b);
 });
}
