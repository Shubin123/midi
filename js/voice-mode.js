// Voice mode for the teacher: talk and sing into the same microphone, hands-free. Three parts, all plain
// arithmetic and words (no browser), so Node can test them (tests/voice-mode.mjs):
// - SpeechOrMusic tells talking from singing, frame by frame, from the Listening widget's frames: singing holds
//   a pitch (within 0.7 of a semitone for 230 ms or more), talking glides through short voiced syllables, four or
//   five a second, with consonants (energy without a clear pitch) between. The teacher takes what speech
//   recognition hears only when it was talk, and the notes only when it was music.
// - readIntent turns a spoken (or typed) request into one of the app's actions (js/agent-actions.js), for
//   requests System 1 can meet at once: "record what I sing into slot 2", "stop recording", "play loop 3",
//   "slow it down to 80", "give me a jazz rhythm to practise", "sing it back", "start listening".
// - Sing it back: makePhrase picks a short phrase in the key for the student to sing back, and scoreSingBack
//   says how it went, note by note: in tune or how many cents off (in whatever octave they sing), and how early
//   or late against the beat.

const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const semisOf = hz => 69 + 12 * Math.log2(hz / 440);

/* ---- Talking or singing ---- */

export class SpeechOrMusic {
 constructor({ gateDb = -50, windowMs = 900, holdMs = 230 } = {}) { Object.assign(this, { gateDb, windowMs, holdMs }); this.reset(); }
 reset() { this.frames = []; this.label = 'quiet'; this.lastSpeech = -Infinity; this.lastMusic = -Infinity; }
 // f: a timed frame ({ t, db, clarity, hz }). Returns 'music', 'speech' or 'quiet' for the window ending now.
 push(f) {
  const fr = this.frames;
  fr.push({ t: f.t, loud: f.db >= this.gateDb, voiced: f.db >= this.gateDb && f.clarity >= 0.8 && f.hz > 60 && f.hz < 1500, semis: f.hz > 0 ? semisOf(f.hz) : null });
  while (fr.length && f.t - fr[0].t > this.windowMs) fr.shift();
  const loud = fr.filter(x => x.loud).length / fr.length;
  if (loud < 0.15) { this.label = 'quiet'; return this.label; }
  // Voiced runs, and the longest stretch of one that holds its pitch.
  const runs = [];
  let run = null;
  for (const x of fr) {
   if (x.voiced) { if (!run) runs.push(run = []); run.push(x); } else run = null;
  }
  let held = 0;
  for (const r of runs) {
   for (let i = 0, j = 0; j < r.length; j++) {
    while (i < j && Math.abs(r[j].semis - median(r.slice(i, j + 1).map(x => x.semis))) > 0.7) i++;
    held = Math.max(held, r[j].t - r[i].t);
   }
  }
  const energetic = fr.filter(x => x.loud && !x.voiced).length / fr.length;
  const starts = runs.filter(r => r.length >= 3).length / (this.windowMs / 1000);
  if (held >= this.holdMs) { this.label = 'music'; this.lastMusic = f.t; }
  else if (starts >= 1.5 || energetic > 0.15) { this.label = 'speech'; this.lastSpeech = f.t; }
  else this.label = 'quiet';
  return this.label;
 }
 // Whether what was heard over the last `ms` before `t` was talk rather than singing.
 wasSpeech(t, ms = 3000) { return this.lastSpeech >= t - ms && this.lastSpeech >= this.lastMusic - 300; }
}

// In voice mode the notes wait: a note-on is let through once its note has sounded for `holdMs` while what is
// heard is music (a syllable of speech rarely holds still that long), with its own time stamp; a note that ends
// first, or is still heard as talk `talkMs` after it began, is dropped, and so is its note-off. (A sung note just
// begun can be heard as talk for a moment: the window still holds what came before.) push(events, label, now)
// returns the events to send.
export class HandsFreeGate {
 constructor({ holdMs = 120, talkMs = 400 } = {}) { this.holdMs = holdMs; this.talkMs = talkMs; this.reset(); }
 reset() { this.waiting = new Map(); this.passed = new Set(); }
 push(events, label, now) {
  const out = [];
  for (const e of events) {
   if (e.type === 'on') this.waiting.set(e.midi, e);
   else if (this.waiting.delete(e.midi)) { /* too short to be sung: dropped with its on */ }
   else if (this.passed.delete(e.midi)) out.push(e);
  }
  for (const [m, e] of this.waiting) {
   if (label === 'speech' && now - e.time >= this.talkMs) this.waiting.delete(m);
   else if (label === 'music' && now - e.time >= this.holdMs) { this.waiting.delete(m); this.passed.add(m); out.push(e); }
  }
  return out;
 }
 // Note-offs for the notes let through (the input stopped).
 flush(time) { const out = [...this.passed].map(midi => ({ type: 'off', midi, velocity: 0, time })); this.reset(); return out; }
}

/* ---- Spoken requests ---- */

const WORDS = { one: 1, two: 2, three: 3, four: 4, first: 1, second: 2, third: 3, fourth: 4 };
const slotOf = s => { const m = /\b(?:slot|loop)\s*(\d|one|two|three|four)\b|\b(first|second|third|fourth)\s+(?:slot|loop)\b/i.exec(s); const v = m && (m[1] || m[2]); return v ? Number(WORDS[v.toLowerCase()] ?? v) : null; };
// Rhythms to practise, by style, on the sixteenth grid.
export const STYLE_RHYTHMS = {
 jazz: { pattern: 'x..x..x.x..x..x.', bpm: 100, says: 'a swung jazz comping rhythm' },
 swing: { pattern: 'x..x..x.x..x..x.', bpm: 110, says: 'a swing rhythm' },
 rock: { pattern: 'x...x.x.x...x.x.', bpm: 110, says: 'a rock beat' },
 funk: { pattern: 'x..x..x...x.x..x', bpm: 96, says: 'a funk rhythm' },
 latin: { pattern: 'x..x..x...x.x...', bpm: 100, says: 'the son clave' },
 bossa: { pattern: 'x..x..x...x..x..', bpm: 90, says: 'a bossa nova rhythm' },
 reggae: { pattern: '..x...x...x...x.', bpm: 80, says: 'off-beats, as in reggae' },
 waltz: { pattern: 'x...x...x...', bpm: 90, says: 'a waltz' },
 simple: { pattern: 'x...x...x...x...', bpm: 90, says: 'four steady beats' },
};
// A request System 1 can meet with one of the app's actions: { action, args, say } (or for a sing-back, action
// 'sing_back'), else null. Questions are left alone.
export function readIntent(text) {
 const s = String(text).trim(), q = s.toLowerCase();
 if (!q || /^(how|what|why|which|where|when|can you explain|could you explain)\b/.test(q) && !/^(how about|what about)/.test(q)) return null;
 const slot = slotOf(q);
 if (/\bstop (the )?record/.test(q)) return { action: 'stop_loop_recording', args: slot ? { slot } : {}, say: 'Stopped recording.' };
 if (/\brecord\b/.test(q) && slot) {
  const kind = /\b(audio|sound|the sound|raw)\b/.test(q) ? 'audio' : 'notes';
  return { action: 'arm_loop_slot', args: { slot, record: true, kind }, say: `Recording ${kind === 'audio' ? 'the sound' : 'what you sing'} into slot ${slot}.` };
 }
 if (/\b(play|start)\b.*\b(slot|loop)\b/.test(q) && slot) return { action: 'play_loop_slot', args: { slot, on: true }, say: `Playing slot ${slot}.` };
 if (/\bstop\b.*\b(slot|loop)\b/.test(q) && slot) return { action: 'play_loop_slot', args: { slot, on: false }, say: `Stopped slot ${slot}.` };
 if (/\b(start|begin) listening\b|\blisten to me\b/.test(q)) return { action: 'start_listening', args: {}, say: 'Listening.' };
 if (/\b(make (it|the synth|this) sound like (this|that|me)|match (this|that|my) sound|copy (this|that) sound)\b/.test(q)) return { action: 'match_sound', args: { again: true }, say: 'Play or sing one note, and I\'ll find a patch like it.' };
 if (/\bstop listening\b/.test(q)) return { action: 'stop_listening', args: {}, say: 'I\'ve stopped listening.' };
 if (/\bsing (it|that|this|them) back\b|\bsing-?back\b(?! to)|\bcall and response\b|\bear training\b/.test(q) && !/\bsomething to sing\b/.test(q)) return { action: 'sing_back', args: {}, say: 'Listen, then sing it back.' };
 // "tempo 90" and "the metronome at 100" are System 1's commands already (js/commands.js); this is "slow it down to 80".
 const tempo = /\b(slow (?:it |this |things )?down|speed (?:it |this |things )?up)\b\D*(\d{2,3})\b/.exec(q);
 if (tempo) { const bpm = Number(tempo[2]); if (bpm >= 30 && bpm <= 300) return { action: 'set_tempo', args: { bpm }, say: `Tempo ${bpm}.` }; }
 const rhythm = /\b(rhythm|beat|groove|pattern)\b/.test(q) && /\b(give me|practi[cs]e|teach me|i want|let'?s|show me)\b/.test(q);
 if (rhythm) {
  const style = Object.keys(STYLE_RHYTHMS).find(k => new RegExp(`\\b${k}`).test(q)) || 'simple';
  const r = STYLE_RHYTHMS[style];
  return { action: 'set_exercise', args: { pattern: r.pattern.length === 12 ? r.pattern + 'x...' : r.pattern, bpm: r.bpm }, say: `Here is ${r.says} to practise, at ${r.bpm} BPM: listen once, then play or clap along.` };
 }
 return null;
}

/* ---- Sing it back ---- */

// A phrase of `length` notes of the scale (intervals from `key`), stepping mostly by step with a leap now and
// then, within [low, high] (MIDI), starting and ending on the tonic or its fifth. `random` makes it repeatable.
export function makePhrase({ key = 0, intervals = [0, 2, 4, 5, 7, 9, 11], low = 60, high = 72, length = 4, random = Math.random } = {}) {
 const pcs = new Set(intervals.map(i => (i + key) % 12)), notes = [];
 for (let m = low; m <= high; m++) if (pcs.has(((m % 12) + 12) % 12)) notes.push(m);
 const homes = notes.filter(m => (m - key + 120) % 12 === 0 || (m - key + 120) % 12 === 7);
 let at = notes.indexOf(homes[Math.floor(random() * homes.length)] ?? notes[0]);
 const out = [notes[at]];
 while (out.length < length) {
  const step = random() < 0.75 ? (random() < 0.5 ? -1 : 1) : (random() < 0.5 ? -2 : 2);
  at = Math.max(0, Math.min(notes.length - 1, at + step));
  if (notes[at] === out.at(-1)) at = Math.max(0, Math.min(notes.length - 1, at + (step > 0 ? -1 : 1)));
  out.push(notes[at]);
 }
 return out;
}

// How a sing-back went. target: [{ midi, time }] (time on the page's clock); sung: [{ midi, start, end }];
// trail: the pitch heard, [{ t, semis }]. Each target note takes the first sung note within half a beat of it, in
// order; its pitch is the median of the trail inside the note, in the octave the student sings in. Returns
// { notes: [{ want, got, cents, ms, inTune }], inTune, onTime, octave, text }.
export function scoreSingBack(target, sung, { trail = [], beatMs = 500, tuneCents = 25, timeMs = 60 } = {}) {
 const used = new Set(), pairs = target.map(t => {
  const i = sung.findIndex((s, k) => !used.has(k) && Math.abs(s.start - t.time) <= beatMs / 2);
  if (i < 0) return { t, s: null };
  used.add(i);
  const s = sung[i], inside = trail.filter(p => p.t >= s.start + 40 && p.t <= (s.end ?? s.start + 300) - 20).map(p => p.semis);
  return { t, s, semis: inside.length ? median(inside) : s.midi };
 });
 const found = pairs.filter(p => p.s);
 const octave = found.length ? Math.round(median(found.map(p => p.semis - p.t.midi)) / 12) * 12 : 0;
 const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
 const notes = pairs.map(({ t, s, semis }) => {
  if (!s) return { want: t.midi, got: null, cents: null, ms: null, inTune: false, onTime: false };
  const cents = Math.round((semis - octave - t.midi) * 100), ms = Math.round(s.start - t.time);
  return { want: t.midi, got: Math.round(semis), cents, ms, inTune: Math.abs(cents) <= tuneCents, onTime: Math.abs(ms) <= timeMs };
 });
 const inTune = notes.filter(n => n.inTune).length, onTime = notes.filter(n => n.onTime).length, missed = notes.filter(n => n.got === null).length;
 const worst = notes.filter(n => n.got !== null && !n.inTune).sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents))[0];
 const late = notes.filter(n => n.got !== null && !n.onTime).sort((a, b) => Math.abs(b.ms) - Math.abs(a.ms))[0];
 const ord = i => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][i] || `${i + 1}th`;
 const parts = [`${inTune} of ${target.length} notes in tune, ${onTime} on time.`];
 if (missed) parts.push(`${missed === target.length ? 'Nothing was heard' : `${missed} note${missed === 1 ? ' wasn\'t' : 's weren\'t'} heard`}: sing a little louder, or nearer the microphone.`);
 if (worst) parts.push(`The ${ord(notes.indexOf(worst))} (${names[worst.want % 12]}) was ${Math.abs(worst.cents)} cents ${worst.cents < 0 ? 'flat' : 'sharp'}.`);
 if (late) parts.push(`The ${ord(notes.indexOf(late))} came ${Math.abs(late.ms)} ms ${late.ms > 0 ? 'late' : 'early'}.`);
 if (inTune === target.length && onTime === target.length) parts.push('Spot on: try a harder one.');
 if (octave) parts.push(`(You sang it ${Math.abs(octave / 12)} octave${Math.abs(octave) > 12 ? 's' : ''} ${octave < 0 ? 'lower' : 'higher'}, which is fine.)`);
 return { notes, inTune, onTime, octave, text: parts.join(' ') };
}
