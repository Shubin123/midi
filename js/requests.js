// Requests to play something, met without a language model: the key, chord names, Roman numerals, scale,
// mood and texture ("only chords", "a lick") are read from the words, and the notes are built the same way as
// the lessons', so they are always right and play at once. Laya chooses a progression only when the words
// leave it open ("something dreamy"). Requests to change the last example (again, longer, shorter, faster,
// slower, higher, lower) are met here too.
import { parseChordName, parseScaleName, chordMidi, scaleRunMidi, SCALE_TEMPLATES, pcFromName, spell, prefersFlats } from './pitch-analyzer.js';

/* ---- The key ---- */

const NOTE = /^([a-g])([#♯b♭]?)(m|min|maj)?$/i;
const QUALITY = /^(major|minor|maj|min)$/i;
const SAD = /\b(sad|melanchol\w*|dark|moody|emotional|minor|haunting|gloomy)\b/i;

// "a g# lick" → G♯; "in D minor" → D minor; the article "a" is a key only when the words say so ("A minor").
export function readKey(text) {
 const words = String(text).replace(/[,.!?;:()]/g, ' ').split(/\s+/).filter(Boolean);
 for (let i = 0; i < words.length; i++) {
  const m = NOTE.exec(words[i]);
  if (!m) continue;
  const next = words[i + 1] || '', prev = (words[i - 1] || '').toLowerCase();
  const marked = m[2] || m[3] || QUALITY.test(next) || /^(sharp|flat|blues|key|scale|lick|riff|major|minor)$/i.test(next) || ['in', 'of', 'key'].includes(prev) || /^[A-G]$/.test(m[1]) && i > 0;
  if (!marked || (m[1] === 'a' && !m[2] && !m[3] && !QUALITY.test(next) && !/^(sharp|flat)$/i.test(next))) continue;
  const acc = m[2] || (/^sharp$/i.test(next) ? '#' : /^flat$/i.test(next) ? 'b' : '');
  const tonic = pcFromName(m[1].toUpperCase() + acc);
  const minor = /^(m|min)$/i.test(m[3] || '') || /^(minor|min)$/i.test(next) || (!/^(major|maj)$/i.test(next) && m[3] !== 'maj' && SAD.test(text));
  return { tonic, minor, flats: acc ? /[b♭]/.test(acc) : prefersFlats(tonic, minor) };
 }
 return null;
}

/* ---- Chords ---- */

const SUFFIX = { maj: '', min: 'm', 7: '7', m7: 'm7', maj7: 'maj7', dim: 'dim', m7b5: 'm7b5', aug: '+' };
const named = (key, iv, q) => `${spell(key.tonic + iv, key.flats)}${SUFFIX[q]}`;
const build = names => names.map(n => chordMidi(parseChordName(n)));

// Progressions by name and mood, as [half steps above the tonic, quality], in major and in minor.
export const PROGRESSIONS = {
 blues: { words: /blues|bluesy|shuffle/, says: 'a blues: I, IV and V as dominant sevenths', major: [[0, '7'], [5, '7'], [0, '7'], [7, '7'], [5, '7'], [0, '7']], minor: [[0, 'm7'], [5, 'm7'], [0, 'm7'], [7, '7'], [5, 'm7'], [0, 'm7']] },
 jazz: { words: /jazz|jazzy|ii.?v|two.?five|swing/, says: 'a ii–V–I, the jazz cadence', major: [[2, 'm7'], [7, '7'], [0, 'maj7']], minor: [[2, 'm7b5'], [7, '7'], [0, 'm7']] },
 pop: { words: /\bpop\b|happy|uplifting|anthem|bright|cheerful/, says: 'the pop progression I–V–vi–IV', major: [[0, 'maj'], [7, 'maj'], [9, 'min'], [5, 'maj']], minor: [[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']] },
 sad: { words: /sad|melanchol|emotional|gloomy|moody|haunting/, says: 'a minor-key loop, i–VI–III–VII', major: [[9, 'min'], [5, 'maj'], [0, 'maj'], [7, 'maj']], minor: [[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']] },
 lament: { words: /lament|descend|spanish|flamenco|andalusian/, says: 'the lament, with the bass walking down to V', major: [[9, 'min'], [7, 'maj'], [5, 'maj'], [4, 'maj']], minor: [[0, 'min'], [10, 'maj'], [8, 'maj'], [7, 'maj']] },
 doo_wop: { words: /doo.?wop|50s|fifties|oldies/, says: 'the doo-wop progression I–vi–IV–V', major: [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, 'maj']], minor: [[0, 'min'], [8, 'maj'], [5, 'min'], [7, 'maj']] },
 epic: { words: /epic|cinematic|film|heroic|dramatic/, says: 'a cinematic loop, vi–IV–I–V', major: [[9, 'min'], [5, 'maj'], [0, 'maj'], [7, 'maj']], minor: [[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']] },
 pachelbel: { words: /pachelbel|canon/, says: 'the Pachelbel progression', major: [[0, 'maj'], [7, 'maj'], [9, 'min'], [4, 'min'], [5, 'maj'], [0, 'maj'], [5, 'maj'], [7, 'maj']], minor: [[0, 'min'], [7, 'maj'], [8, 'maj'], [3, 'maj'], [5, 'min'], [0, 'min'], [5, 'min'], [7, 'maj']] },
 gospel: { words: /gospel|amen|plagal|church|hymn/, says: 'plagal motion, IV to I', major: [[0, 'maj'], [5, 'maj'], [0, 'maj'], [5, 'maj'], [0, 'maj']], minor: [[0, 'min'], [5, 'min'], [0, 'min'], [5, 'min'], [0, 'min']] },
 cadence: { words: /cadence|classical|resolve|home|simple|basic/, says: 'the basic phrase, I–IV–V–I', major: [[0, 'maj'], [5, 'maj'], [7, 'maj'], [0, 'maj']], minor: [[0, 'min'], [5, 'min'], [7, 'maj'], [0, 'min']] },
};

// Roman numerals: degrees of the major scale (of natural minor in a minor key), ♭ lowering one; capitals are
// major, lower case minor, ° diminished, ø half-diminished, 7 adds the seventh.
const DEGREES = { i: 0, ii: 2, iii: 4, iv: 5, v: 7, vi: 9, vii: 11 }, MINOR_DEGREES = { i: 0, ii: 2, iii: 3, iv: 5, v: 7, vi: 8, vii: 10 };
const NUMERAL = /^([b♭#]?)(vii|vi|iv|v|iii|ii|i)(°|o|ø|\+)?(maj7|7)?$/i;
function numerals(text, key) {
 const run = String(text).match(/\b[b♭]?(?:VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)[°oø+]?(?:maj7|7)?(?:\s*(?:[-–—,>→]|then|to)\s*[b♭]?(?:VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)[°oø+]?(?:maj7|7)?)+/);
 if (!run) return null;
 const parts = run[0].split(/\s*(?:[-–—,>→]|then|to)\s*/).map(p => NUMERAL.exec(p)).filter(Boolean);
 if (parts.length < 2) return null;
 return parts.map(([, flat, deg, mark, seventh]) => {
  // An accidental counts from the major scale (♭VII is a whole step below the tonic in any key); a bare
  // numeral in a minor key means that key's own degree (VI in A minor is F).
  const upper = deg === deg.toUpperCase(), base = (flat ? DEGREES : key.minor ? MINOR_DEGREES : DEGREES)[deg.toLowerCase()] - (flat && flat !== '#' ? 1 : 0) + (flat === '#' ? 1 : 0);
  const q = mark === 'ø' ? 'm7b5' : mark === '°' || mark === 'o' ? 'dim' : mark === '+' ? 'aug' : seventh === 'maj7' ? 'maj7' : seventh ? (upper ? '7' : 'm7') : upper ? 'maj' : 'min';
  return named(key, (base + 12) % 12, q);
 });
}

// Chord symbols written out: "Dm7 G7 Cmaj7", "G#7, C#7, D#7". Two or more in a row, so "A" alone is not a chord.
export function chordList(text) {
 const tokens = String(text).split(/\s*(?:[,.;:!?()]|→|->|–|—|\bthen\b|\band\b|\s)\s*/).filter(Boolean);
 let best = [], run = [];
 for (const t of tokens) {
  const ok = /^[A-G][#♯b♭]?[a-z0-9°ø+]*$/.test(t) && parseChordName(t);
  if (ok) run.push(t); else { if (run.length > best.length) best = run; run = []; }
 }
 if (run.length > best.length) best = run;
 return best.length >= 2 ? best : null;
}

// A scale named outright ("the A minor pentatonic"), as an example: up and back down.
export function scaleIn(text) {
 const words = String(text).replace(/[,.!?;:()"]/g, ' ').split(/\s+/);
 for (let i = 0; i < words.length; i++) for (let j = Math.min(words.length, i + 5); j > i + 1; j--) {
  if (!/^[A-Ga-g][#♯b♭]?$/.test(words[i]) || (words[i] === 'a' && !QUALITY.test(words[i + 1] || ''))) continue;
  const s = parseScaleName(words.slice(i, j).join(' ').replace(/^([a-g])/, c => c.toUpperCase()));
  // Plain "D minor" names a key, not a scale to play, unless the word "scale" is there.
  if (!s || (/Ionian|Aeolian/.test(s.scaleName) && !/\bscale\b/i.test(text))) continue;
  const name = `${spell(s.tonic, prefersFlats(s.tonic))} ${s.scaleName.replace('Ionian (Major)', 'major').replace('Aeolian (Minor)', 'natural minor').toLowerCase()}`;
  return { steps: scaleRunMidi(s.tonic, s.scaleName).map(n => [n]), bpm: 150, label: name, say: `The ${name} scale, up and back down.` };
 }
 return null;
}

// An example read from a reply's own words, for when a model suggests something to play but its JSON line is
// missing or unusable: chord symbols in a row, notes spelled out ("D-F-A, G-B-D-F"), or a scale by name.
export function exampleFromProse(text) {
 const chords = chordList(text);
 if (chords) return { steps: build(chords), bpm: 60, label: chords.join(' → ') };
 const groups = [...String(text).matchAll(/\b([A-G][#♯b♭]?)((?:-[A-G][#♯b♭]?){2,})\b/g)].map(m => [m[1], ...m[2].split('-').filter(Boolean)]);
 if (groups.length) {
  const steps = groups.map(g => { let at = 47; return g.map(n => { const pc = pcFromName(n); at += ((pc - at) % 12 + 12) % 12 || 12; return at; }); });
  return { steps, bpm: 60, label: groups.map(g => g.join('-')).join(' → ') };
 }
 const scale = scaleIn(text);
 return scale ? { steps: scale.steps, bpm: scale.bpm, label: scale.label } : null;
}

/* ---- Licks ---- */

// Single-note figures over a scale, as positions in a two-octave run of it.
const LICKS = {
 call: [0, 1, 2, 4, 3, 2, 1, 0, 2, 1, 0],
 rise: [0, 1, 2, 3, 4, 5, 4, 5, 7],
 fall: [7, 6, 5, 4, 3, 2, 1, 0],
};
function lick(key, blues, mood) {
 const scale = blues ? 'Blues' : key.minor ? 'Minor Pentatonic' : 'Major Pentatonic';
 const run = [...SCALE_TEMPLATES[scale], ...SCALE_TEMPLATES[scale].map(s => s + 12), 24].map(s => 48 + key.tonic + s);
 const shape = mood === 'sad' ? LICKS.fall : mood === 'happy' ? LICKS.rise : LICKS.call;
 return { steps: shape.map(i => [run[Math.min(i, run.length - 1)]]), scale };
}

/* ---- Changing the last example ---- */

const MORE = /\b(longer|extend|twice|double|more bars|keep going)\b/i, LESS = /\bshorter\b/i;
const FASTER = /\b(faster|quicker|speed (it )?up)\b/i, SLOWER = /\b(slower|slow (it )?down)\b/i;
const HIGHER = /\b(higher|up an octave)\b/i, LOWER = /\b(lower|down an octave)\b/i;
const AGAIN = /\b(again|same|repeat|one more time|that one)\b/i;

const REFERS = /\b(it|that|this|lick|riff|example|progression|melody|chords?|scale|one|again|same)\b/i;
function changeLast(text, last) {
 if (!last || !REFERS.test(text)) return null; // "make the cutoff lower" is not about the example
 let { steps, bpm } = last, done = [];
 if (MORE.test(text)) { steps = [...steps, ...steps]; done.push('twice as long'); }
 if (LESS.test(text)) { steps = steps.slice(0, Math.max(2, Math.ceil(steps.length / 2))); done.push('half as long'); }
 if (FASTER.test(text)) { bpm = Math.min(300, Math.round(bpm * 1.33)); done.push('faster'); }
 if (SLOWER.test(text)) { bpm = Math.max(30, Math.round(bpm / 1.33)); done.push('slower'); }
 if (HIGHER.test(text)) { steps = steps.map(s => s.map(n => n + 12)); done.push('an octave higher'); }
 if (LOWER.test(text)) { steps = steps.map(s => s.map(n => n - 12)); done.push('an octave lower'); }
 if (!done.length && !AGAIN.test(text)) return null;
 return { steps, bpm, label: `${last.label}${done.length ? ` (${done.join(', ')})` : ''}`, say: done.length ? `The same example, ${done.join(' and ')}.` : 'Here it is again.' };
}

/* ---- Reading a request ---- */

const PLAY = /\b(play|make|write|compose|improvise|give me|create|show me|let me hear|demonstrate)\b/i;
const CHORDS_ONLY = /\b(only|just|all)\s+(play\s+)?chords?\b|\bin chords\b|\bchordal\b|\bchord (lick|riff|progression)\b/i;
const MELODIC = /\b(lick|riff|melody|run|solo|line|phrase|improv\w*)\b/i;

// { steps, bpm, label, say } for a request to play something, or null when it isn't one this can meet.
// `last` is the example played last ({ steps, bpm, label }); `pick` is Laya's choice, used only when the
// words don't settle which progression to play.
export async function meetRequest(text, { last = null, pick = null } = {}) {
 const changed = changeLast(text, last);
 const key = readKey(text);
 if (changed && !key) return changed;
 if (!PLAY.test(text) && !CHORDS_ONLY.test(text) && !changed) return null;
 const k = key || { tonic: 0, minor: SAD.test(text), flats: false };
 const keyName = `${spell(k.tonic, k.flats)}${k.minor ? ' minor' : ''}`;

 const written = chordList(text);
 if (written) return { steps: build(written), bpm: 60, label: written.join(' → '), say: `${written.join(' → ')}, one chord per beat.` };
 const roman = numerals(text, k);
 if (roman) return { steps: build(roman), bpm: 60, label: roman.join(' → '), say: `In ${keyName}: ${roman.join(' → ')}.` };

 const scale = !/\b(progression|chords?)\b/i.test(text) && scaleIn(text);
 if (scale) return scale;

 const mood = /happy|uplifting|bright|cheerful/i.test(text) ? 'happy' : SAD.test(text) ? 'sad' : '';
 const blues = /blues|bluesy/i.test(text);
 // A lick is single notes, unless the request asks for chords.
 if (MELODIC.test(text) && !CHORDS_ONLY.test(text)) {
  const l = lick(k, blues, mood);
  return { steps: l.steps, bpm: 140, label: `${keyName} ${blues ? 'blues ' : ''}lick`, say: `${/^[AEF]/.test(keyName) ? 'An' : 'A'} ${keyName} lick on the ${spell(k.tonic, k.flats)} ${l.scale.toLowerCase()} scale.` };
 }
 let name = Object.keys(PROGRESSIONS).find(id => PROGRESSIONS[id].words.test(text));
 if (!name && MELODIC.test(text)) name = k.minor && !blues ? 'sad' : 'blues'; // a lick in chords: a short blues loop
 if (!name && pick && /\b(progression|chords?|something|loop|vibe|feel)\b/i.test(text)) {
  name = (await pick(`A student asks the teacher: "${text}"`, 'Which chord progression fits the request best?', Object.fromEntries(Object.entries(PROGRESSIONS).map(([id, p]) => [id, p.says])))).choice;
 }
 if (!name && !/\b(progression|chords?|something|loop|vibe|feel)\b/i.test(text)) return changed;
 const p = PROGRESSIONS[name || 'cadence'], chordNames = (k.minor ? p.minor : p.major).map(([iv, q]) => named(k, iv, q));
 return { steps: build(chordNames), bpm: 60, label: chordNames.join(' → '), say: `${p.says[0].toUpperCase()}${p.says.slice(1)}, in ${keyName}: ${chordNames.join(' → ')}.` };
}
