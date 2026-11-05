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
  this.onPhrase({
   pitchClasses: pcs, noteOns,
   durationMs: phrase[phrase.length - 1].time - phrase[0].time,
   noteCount: noteOns.length,
   scales: detectScale(pcs, [noteOns[noteOns.length - 1].pc, noteOns[0].pc, lowest.pc]),
   chords: this._chordWins(noteOns),
  });
 }
 // Notes struck within `chordWindowMs` of each other count as one chord.
 _chordWins(noteOns) {
  const chords = [];
  const close = win => {
   if (win.length < 3) return;
   const bass = win.reduce((lo, n) => Math.min(lo, n.note), Infinity);
   const c = detectChord(win.map(n => n.pc), bass);
   if (c.length) chords.push({ notes: win.map(n => pitchClassName(n.pc)), best: c[0] });
  };
  let win = [noteOns[0]];
  for (let i = 1; i < noteOns.length; i++) {
   if (noteOns[i].time - win[0].time <= this.chordWindowMs) win.push(noteOns[i]);
   else { close(win); win = [noteOns[i]]; }
  }
  close(win);
  return chords;
 }
 reset() { clearTimeout(this._timer); this.currentPhrase = []; this.heldNotes.clear(); }
}
