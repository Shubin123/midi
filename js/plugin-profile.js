// Learning what a plug-in can do, the moment it loads: what kind of plug-in it is and what each of its
// controls does, from its name and its parameters (labels, ranges, units). Names that say it plainly
// ("Feedback", "Mix", "Reverb") are read directly; Laya (System 1) settles the rest in one fast call, choosing
// from the kinds and roles below, so the guide it produces is always in words written here. Profiles are
// kept in the browser per plug-in, so a plug-in is learned once.
import { read, save } from './storage.js';

// `words` are what a student might call its sound, so a question finds the plug-in ("make the echoes louder").
export const KINDS = {
 reverb: { words: ['reverb', 'room', 'hall', 'space', 'ambience'], match: /reverb|room|hall|plate|ambien|verb/i, says: 'a reverb: it places the sound in a room or hall, so it keeps ringing after each note' },
 delay: { words: ['delay', 'echo', 'echoes', 'repeats'], match: /delay|echo|dub/i, says: 'a delay: it repeats the sound as echoes' },
 distortion: { words: ['distortion', 'grit', 'crunch', 'drive', 'dirty'], match: /distort|overdrive|satur|fuzz|crush|degrade|amp\b|drive/i, says: 'a distortion: it pushes the sound until it breaks up, adding grit and warmth' },
 dynamics: { words: ['compressor', 'compression', 'punch', 'even out', 'squash'], match: /compress|limit|gate|expand|dynamic|leveller/i, says: 'a dynamics processor: it evens out loud and quiet parts' },
 filter: { words: ['eq', 'equaliser', 'equalizer', 'bass', 'treble'], match: /filter|eq\b|equali|tone|wah|vcf/i, says: 'a filter or EQ: it boosts or cuts parts of the frequency range' },
 modulation: { words: ['chorus', 'wobble', 'wide', 'thicker', 'flanger', 'phaser'], match: /chorus|flang|phas|trem|vibrato|ensemble|rotary|leslie|ring ?mod/i, says: 'a modulation effect: it moves the sound over time, making it wider, thicker or wobbly' },
 pitch: { words: ['pitch', 'harmony', 'octave'], match: /pitch|shift|tune|octav|harmon/i, says: 'a pitch effect: it changes or adds pitches' },
 utility: { words: ['gain', 'stereo', 'pan'], match: /gain|util|stereo|image|pan|meter|test|tone gen/i, says: 'a utility: it changes level, stereo or routing rather than the character of the sound' },
 synth: { words: ['synth', 'instrument'], match: /synth|jx|dx|osc|poly|mono|lead|bass/i, says: 'a synthesizer: it makes its own sound from oscillators, which you shape with its controls' },
 keys: { words: ['piano', 'keys', 'organ', 'instrument'], match: /piano|epiano|rhodes|organ|keys|clav/i, says: 'a keyboard instrument: it imitates a piano, electric piano or organ' },
 other: { words: [], match: /$^/, says: 'a plug-in that changes the sound' },
};

// What a control does; `match` reads plain names, and Laya chooses for the rest.
export const ROLES = {
 mix: { match: /\b(mix|wet|dry|blend|amount)\b/i, does: 'how much of the effect you hear against the dry sound' },
 time: { match: /\b(time|delay|length|pre-?delay)\b/i, does: 'how long the delay before the effect is' },
 feedback: { match: /feed ?back|\bfbk\b|regen|repeats/i, does: 'how many times the sound repeats before it dies away' },
 decay: { match: /decay|size|room|tail|reverb/i, does: 'how long the sound rings on' },
 tone: { match: /tone|damp|bright|colou?r|tilt|hi ?cut|lo ?cut|cutoff|\bfreq|vcf|filter/i, does: 'how bright or dark it sounds' },
 drive: { match: /drive|dist|fuzz|satur|crunch|\bgain\b/i, does: 'how hard the sound is pushed, and so how much it distorts' },
 level: { match: /output|level|volume|trim|makeup|\bvol\b/i, does: 'the output level' },
 threshold: { match: /thresh/i, does: 'the level at which it starts to act' },
 ratio: { match: /ratio/i, does: 'how strongly it turns loud parts down' },
 attack: { match: /attack|\batt\b/i, does: 'how quickly it responds when a note starts' },
 release: { match: /release|\brel\b/i, does: 'how slowly it lets go after a note' },
 rate: { match: /rate|speed|lfo/i, does: 'how fast it moves' },
 depth: { match: /depth|intens|\bmod\b|modulation/i, does: 'how far it moves' },
 resonance: { match: /reso|\bq\b|emph/i, does: 'the peak right at the cutoff, which sharpens the sound' },
 pitch: { match: /pitch|tune|detune|semi|octave|transpose|fine/i, does: 'the pitch' },
 envelope: { match: /env|sustain|adsr/i, does: 'how each note changes over time' },
 stereo: { match: /pan|stereo|width|spread/i, does: 'how wide the sound is between the speakers' },
 other: { match: /$^/, does: 'a setting of its own; move it while you play to hear what it does' },
};

const fromName = (table, text) => Object.keys(table).find(k => table[k].match.test(text)) || null;

// The controls a profile is made from: { label, min, max, unit }, as js/workspace.js lists a plug-in window.
// `instrument` comes from the plug-in host. `laya` is the loaded LayaCoach, or null for names alone.
export async function learnPlugin(name, params, { instrument = false, laya = null } = {}) {
 const roles = Object.fromEntries(params.map(p => [p.label, fromName(ROLES, p.label)]));
 let kind = (instrument ? fromName({ keys: KINDS.keys, synth: KINDS.synth }, name) || 'synth' : null) || fromName(KINDS, name) || kindFromRoles(Object.values(roles));
 let ms = 0, learned = false;
 const unsure = params.filter(p => !roles[p.label]).slice(0, 12);
 if (laya && (!kind || kind === 'other' || unsure.length)) {
  const situation = `A ${instrument ? 'virtual instrument' : 'audio effect'} plug-in called "${name}" with these controls: ${params.map(p => p.label + (p.unit ? ` (${p.unit})` : '')).join(', ')}.`;
  const questions = {};
  if (!kind || kind === 'other') questions.kind = { type: 'choice', instructions: 'What kind of plug-in is it?', criteria: Object.fromEntries(Object.entries(KINDS).filter(([k]) => instrument ? ['synth', 'keys', 'other'].includes(k) : !['synth', 'keys'].includes(k)).map(([k, v]) => [k, v.says])) };
  unsure.forEach((p, i) => { questions[`p${i}`] = { type: 'choice', instructions: `What does the control "${p.label}" do?`, criteria: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.does])) }; });
  const res = await laya.ask(situation, questions);
  ms = res.ms; learned = true;
  if (res.answers.kind) kind = res.answers.kind.choice;
  unsure.forEach((p, i) => { roles[p.label] = res.answers[`p${i}`]?.choice || 'other'; });
 }
 return { name, kind: kind || 'other', instrument, roles: Object.fromEntries(params.map(p => [p.label, roles[p.label] || 'other'])), byLaya: learned, ms };
}

function kindFromRoles(roles) {
 const has = r => roles.includes(r);
 return has('feedback') && has('time') ? 'delay' : has('decay') ? 'reverb' : has('threshold') || has('ratio') ? 'dynamics' : has('drive') ? 'distortion' : has('rate') && has('depth') ? 'modulation' : has('resonance') ? 'filter' : null;
}

// A guide in the shape js/workspace-guide.js uses, from a profile: what it is, then one step per control.
// The mix and the plug-in's most characteristic controls come first.
const ORDER = ['mix', 'time', 'feedback', 'decay', 'drive', 'threshold', 'ratio', 'rate', 'depth', 'tone', 'resonance', 'attack', 'release', 'envelope', 'pitch', 'stereo', 'level', 'other'];
export function guideFromProfile(profile, title = profile.name) {
 const steps = Object.entries(profile.roles).sort((a, b) => ORDER.indexOf(a[1]) - ORDER.indexOf(b[1]))
  .map(([label, role]) => [`${label}: ${ROLES[role].does}.`, `${title} › ${label}`]);
 return { what: `${profile.name} is ${KINDS[profile.kind].says}.${profile.instrument ? ' Play the keys to hear it.' : ' Bypass compares the sound with and without it.'}`, how: steps };
}
export const summarize = p => `${p.name}: ${KINDS[p.kind].says}. Controls: ${Object.entries(p.roles).map(([l, r]) => `${l} (${r})`).join(', ')}.`;

/* ---- Kept per plug-in, so it is learned once ---- */

const KEY = 'teacher-plugin-profiles-v1';
const sig = (name, params) => `${name}|${params.map(p => p.label).join(',')}`;
export const cachedProfile = (name, params) => read(KEY, {})[sig(name, params)] || null;
export function keepProfile(profile, params) {
 const all = read(KEY, {});
 all[sig(profile.name, params)] = profile;
 const keys = Object.keys(all);
 if (keys.length > 60) delete all[keys[0]];
 save(KEY, all);
}
