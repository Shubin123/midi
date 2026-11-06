// Requests to change a setting, met at once and without a language model (System 1): "set the cutoff to 800",
// "turn off the filter", "make the attack longer", "oscillator 2 to square", "louder", "theme forest calm",
// "hide the oscilloscope", "turn on the panic button". The words are matched against every control the
// teacher can see (js/workspace.js), so a plug-in's controls are covered as soon as it loads. Nothing is
// guessed: words that fit two controls equally ("set the level to 0.5") ask which one, and a question ("how do
// I turn off the filter?") is left to the guides. Pure: the controls are passed in, so it is tested without a
// browser.
//
// An item is one control or widget: { name ("Widget › Control"), widget, label, id, kind ('number', 'select',
// 'checkbox' or 'widget'), value (a number, the option's value, true/false, or for a widget 'shown', 'hidden'
// or 'minimised'), min, max, step, options: [{ value, text }], and for a plug-in's control what the teacher
// learned about it (js/plugin-profile.js, through pluginWords()): aliases, the words it goes by ("wet",
// "reverb" for a reverb's Mix), and unit, the unit its numbers are in ('ms', 's', '%', 'hz') }. readCommand() returns null when the words are
// not a request to change something, or { changes: [{ item, value, say }] }, { ask: { text, choices } } when
// they fit several controls, or { problem } when they name a control but not a value it can take.

const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, zero: 0 };
// Words that only glue a request together.
const STOP = new Set('the a an to of my your its it this that please set change make turn switch put at by for me and is be value amount setting settings control knob slider some bit little lot much way all can could would will you i want like need lets let us now just so up down on off more less from with in into use go'.split(' '));
// Words for the same control, by element id: what people call it, where the label says something else.
export const ALIASES = {
 'seq-bpm': ['tempo', 'bpm', 'speed', 'metronome'],
 masterVolume: ['volume', 'master volume', 'loudness', 'output'],
 filterCutoff: ['cutoff', 'brightness', 'filter frequency'],
 filterResonance: ['resonance', 'q', 'reso'],
 filterType: ['filter type', 'filter mode'],
 synthesiaToggle: ['falling notes', 'synthesia', 'piano roll'],
 metronomeToggle: ['metronome', 'click'],
 uiTheme: ['theme', 'colours', 'colors', 'color scheme', 'colour scheme', 'skin'],
 uiScale: ['ui scale', 'zoom', 'interface size', 'text size'],
 numOctavesSelect: ['keyboard octaves', 'number of octaves', 'octaves on the keyboard'],
 baseOctave: ['keyboard octave', 'octave of the keyboard'],
 oscSlop: ['slop', 'drift'],
 visualizerSourceSelect: ['oscilloscope source', 'scope source', 'visualizer'],
 'settings-panic-button': ['panic button', 'panic'],
 'settings-teach-buttons': ['teach buttons', 'guide buttons', '🎓 buttons', '🎓', 'graduation buttons', 'mortarboard buttons'],
 'seq-key': ['sequencer key', 'key of the sequencer'],
 'seq-scale': ['sequencer scale', 'scale of the sequencer'],
};
// What a plug-in's control goes by, from the role the teacher learned it has, and the unit its numbers are in
// when its range makes that plain. A mix control also goes by the plug-in's own kind, less surely ("more
// reverb" is more of the reverb's mix, but "a bigger reverb" its decay), except for words that are another
// role's ("repeats" is a delay's feedback). A delay's time is what makes it longer or shorter.
const ROLE_WORDS = {
 mix: ['mix', 'wet', 'wetter', 'wetness', 'dry', 'drier', 'blend', 'amount'], time: ['time', 'delay time'], feedback: ['feedback', 'repeats', 'regeneration'],
 decay: ['decay', 'size', 'tail', 'room size', 'bigger', 'smaller', 'longer', 'shorter'], tone: ['tone', 'brighter', 'darker', 'brightness'], drive: ['drive', 'distortion', 'grit', 'crunch'],
 level: ['output', 'level', 'volume'], threshold: ['threshold'], ratio: ['ratio'], attack: ['attack'], release: ['release'], rate: ['rate', 'speed'], depth: ['depth'], resonance: ['resonance'],
};
export function pluginWords(role, kind = 'other', kindWords = [], { min, max } = {}) {
 if (!role || !ROLE_WORDS[role]) return { aliases: [], unit: '' };
 const taken = new Set(Object.values(ROLE_WORDS).flat());
 const aliases = [...ROLE_WORDS[role], ...(role === 'time' && kind === 'delay' ? ['longer', 'shorter'] : [])];
 const kinds = role === 'mix' ? kindWords.filter(w => !taken.has(w)) : [];
 const lo = Number(min), hi = Number(max);
 const unit = role === 'mix' && hi === 100 ? '%' : (role === 'time' && hi > 50) ? 'ms' : role === 'decay' && hi <= 30 ? 's' : role === 'tone' && hi > 1000 && lo >= 10 ? 'hz' : '';
 return { aliases, kinds, unit };
}

// Words that mean a control without naming it.
const IMPLIED = [
 { words: /\b(louder|quieter|softer)\b/, id: 'masterVolume', dir: m => (m === 'louder' ? 1 : -1) },
 { words: /\bturn (?:it|the sound|everything) (up|down)\b/, id: 'masterVolume', dir: m => (m === 'up' ? 1 : -1) },
 { words: /\b(brighter|darker|duller)\b/, id: 'filterCutoff', dir: m => (m === 'brighter' ? 1 : -1) },
];
const WIDGET_WORDS = { Oscilloscope: ['scope', 'visualizer'], 'Loop recorder': ['looper', 'loops'], 'Step sequencer': ['sequencer'], 'Envelope (ADSR)': ['envelope', 'adsr'], Plugins: ['plug-ins', 'plugin host'], 'Import / Export': ['export', 'import'] };

/* ---- The words ---- */

// Lower case, with the usual spellings made one: "osc 2", "second oscillator" and "oscillator two" are all
// "oscillator 2"; "high pass" is "highpass"; "per cent" is "%".
export function normalize(text) {
 let s = ` ${String(text).toLowerCase().replace(/[’']/g, '\'').replace(/[“”"]/g, ' ')} `;
 s = s.replace(/\bosc(?:illator)?s?\s*(\d)\b/g, 'oscillator $1').replace(/\boscs?\b/g, 'oscillator');
 s = s.replace(new RegExp(`\\b(${Object.keys(ORDINALS).join('|')})\\s+oscillator\\b`, 'g'), (_, o) => `oscillator ${ORDINALS[o]}`);
 s = s.replace(new RegExp(`\\boscillator\\s+(${Object.keys(NUMBERS).join('|')})\\b`, 'g'), (_, n) => `oscillator ${NUMBERS[n]}`);
 s = s.replace(/\b(high|low|band)[\s-]pass\b/g, '$1pass').replace(/\bcut[\s-]off\b/g, 'cutoff').replace(/\bper ?cent\b/g, '%').replace(/\bsaw\b(?!tooth)/g, 'sawtooth');
 s = s.replace(/\b(\d+(?:\.\d+)?)\s*k(?:hz)?\b/g, (_, n) => `${Number(n) * 1000} hz`);
 s = s.replace(/\bhalf a second\b/g, '0.5 s').replace(/\ba quarter of a second\b/g, '0.25 s').replace(/\b(a|one) second\b/g, '1 s');
 return s.replace(/[!?.;]+(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
}
const stem = w => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);
const tokens = s => normalize(s).replace(/\([^)]*\)/g, ' ').split(/[^a-z0-9#🎓.%-]+/).map(w => w.replace(/^[.-]+|[.-]+$/g, '')).filter(w => w && !STOP.has(w));
const has = (s, phrase) => ` ${s} `.includes(` ${normalize(phrase)} `);

// A question about how to do something is for the guides, not a request to do it ("can you…" is a request).
const QUESTION = /^(how|what|why|where|when|which|who|whose|does|do|did|is|are|was|were|should|explain|tell me|teach|show me how)\b/;
const POLITE = /^(please|hey|ok|okay|so|now|teacher|and|then|can you|could you|would you|will you|i want( you)? to|i'd like( you)? to|i would like( you)? to|i need( you)? to|let's|lets|go ahead and)\s+/;
// Asking for music is for the composer (js/requests.js), even with a setting's word in it ("a lick in A minor").
const MUSIC = /\b(play|plays|playing|lick|riff|melody|progression|chords?|song|tune|compose|improvise|give me|arpeggio)\b/;
const CHANGE = /\b(set|change|make|turn|switch|put|increase|decrease|raise|lower|reduce|boost|bump|drop|enable|disable|activate|deactivate|mute|unmute|bypass|unbypass|use|select|pick|choose|hide|unhide|minimi[sz]e|collapse|expand|restore|start|stop)\b/;

// What a clause asks for: on or off, up or down (by how much), an extreme, or a value.
function intentOf(c) {
 const out = {};
 if (/\b(unbypass|un-bypass)\b/.test(c)) out.bypass = false;
 else if (/\bbypass\b/.test(c)) out.bypass = true;
 if (/\b(turn|switch|shut|put|flip|toggle)\b.*\boff\b|\b(disable|deactivate|mute|silence|stop)\b|\boff$/.test(c)) out.on = false;
 else if (/\b(turn|switch|put|flip)\b.*\bon\b|\b(enable|activate|unmute|start)\b|\bon$/.test(c)) out.on = true;
 if (/\b(hide|remove)\b/.test(c)) out.layout = 'hidden';
 else if (/\b(minimi[sz]e|collapse)\b/.test(c)) out.layout = 'minimised';
 else if (/\b(unhide|expand|restore|unminimi[sz]e|bring back|show)\b/.test(c)) out.layout = 'shown';
 if (/\b(max(imum)?|all the way up|full)\b/.test(c)) out.extreme = 'max';
 else if (/\b(min(imum)?|all the way down)\b/.test(c)) out.extreme = 'min';
 const up = c.match(/\b(up|increase|raise|more|higher|boost|bump|louder|brighter|faster|longer|bigger|wider|wetter|next)\b/), down = c.match(/\b(down|decrease|reduce|lower|less|fewer|drop|quieter|softer|darker|duller|slower|shorter|smaller|narrower|drier|dryer|previous)\b/);
 if (up && !down) out.dir = 1; else if (down && !up) out.dir = -1;
 out.amount = /\b(a (little|bit|touch)|slightly|a tad)\b/.test(c) ? 0.5 : /\b(a lot|much|way)\b/.test(c) ? 2 : 1;
 return out;
}

// A number the words give, with its unit: "to 800 hz", "by 10", "at 50%", "200 ms". The oscillator's own number
// ("oscillator 2") is not a value. Returns { n, unit, by } or null, and the clause with the value taken out.
function numberIn(c) {
 const re = /(?:\b(to|at|by|=|of|is)\s+)?(-?\d+(?:\.\d+)?)\s*(hz|ms|milliseconds?|s|secs?|seconds?|%|cents?|bpm|x|db|octaves?)?(?![\w.])/g;
 let best = null;
 for (const m of c.matchAll(re)) {
  if (/(oscillator|slot|loop|lane|step)\s*$/.test(c.slice(0, m.index + (m[1] ? m[1].length + 1 : 0)))) continue;
  const unit = (m[3] || '').replace(/^milliseconds?$/, 'ms').replace(/^(secs?|seconds?)$/, 's').replace(/^cents$/, 'cent').replace(/^octaves$/, 'octave');
  const found = { n: Number(m[2]), unit, by: m[1] === 'by', at: m.index, text: m[0] };
  if (!best || m[1] || !best.text.match(/^(to|at|by|=|of|is)\b/)) best = found; // "to …" wins; else the last
 }
 return best && { ...best, rest: `${c.slice(0, best.at)} ${c.slice(best.at + best.text.length)}`.replace(/\s+/g, ' ').trim() };
}

// The words after "to" (or "=", "at"), for an option by name: "set the theme to forest calm".
const target = c => c.match(/\b(?:to|=|at|into)\s+(.+)$/)?.[1].trim() || '';

/* ---- Matching controls ---- */

const unitOf = item => (item.unit || item.label.match(/\((hz|s|ms|%|cents?)\)/i)?.[1] || (item.id === 'seq-bpm' ? 'bpm' : /detune/i.test(item.label) ? 'cent' : /delay/i.test(item.label) && Number(item.max) <= 100 ? 'ms' : '')).toLowerCase().replace(/^cents$/, 'cent');
// Whether a number in `unit` can go into a control in `own` units: the same, seconds for milliseconds, or a
// percentage of any range. A control of no known unit takes anything.
const fitsUnit = (unit, own) => !own || unit === own || unit === '%' || (/^(ms|s)$/.test(unit) && /^(ms|s)$/.test(own)) || unit === 'x';
const optionFor = (item, words) => {
 if (!words) return null;
 const want = normalize(words).replace(/^(a|an|the)\s+/, '').replace(/\s+(wave|waveform|theme|mode|filter|scale|key)$/, '');
 const opts = item.options || [];
 return opts.find(o => normalize(o.text) === want || normalize(o.value) === want)
  || (want.length >= 3 && opts.find(o => normalize(o.text).startsWith(want)))
  || (/^\d+$/.test(want) && opts.find(o => normalize(o.text).split(' ')[0] === want)) || null;
};
// An option named anywhere in the words ("highpass", "a square wave"), for when there is no "to".
const optionAnywhere = (item, c) => (item.options || []).filter(o => normalize(o.text).length >= 4 && has(c, o.text)).sort((a, b) => b.text.length - a.text.length)[0] || null;
// An option by one of its own words, when only one option has it ("the ocean theme" is Ocean Depth).
const optionByWord = (item, words) => { const found = (item.options || []).filter(o => tokens(o.text).some(w => w.length >= 4 && words.includes(w))); return found.length === 1 ? found[0] : null; };

// How well the words name an item: its label's words (an oscillator's number must agree), its widget's, and
// the names it goes by. 0 means not named at all.
// A switch called On, Enabled or Bypass is named by its widget alone ("turn off the filter", "bypass the delay");
// so is a choice whose option the words give ("switch the filter to highpass").
function score(item, words, c, to, num) {
 const index = c.match(/\boscillator (\d)\b/)?.[1], own = item.label.match(/\boscillator (\d)\b/i)?.[1];
 if (index && own && index !== own) return 0;
 const label = tokens(item.label).filter(w => !['on', 'enabled', 'bypass'].includes(w) && (w !== own || index));
 const option = item.kind === 'select' && !!(optionFor(item, to) || optionAnywhere(item, c));
 const hit = w => (words.includes(w) ? 1 : words.map(stem).includes(stem(w)) ? 0.9 : 0);
 const l = label.length ? label.reduce((s, w) => s + hit(w), 0) / label.length : 0;
 const wTokens = [...tokens(item.widget), ...(WIDGET_WORDS[item.widget] || []).flatMap(tokens)], widget = wTokens.some(w => hit(w) > 0);
 const alias = [...(ALIASES[item.id] || []), ...(item.aliases || [])].some(a => has(c, a)) || (item.kind === 'widget' && (WIDGET_WORDS[item.widget] || []).some(a => has(c, a)));
 const kindWord = (item.kinds || []).some(a => has(c, a));
 // "set the delay to 500 ms": in a named plug-in, the one control whose numbers are in milliseconds.
 const unit = !!(widget && num?.unit && item.unit && (num.unit === item.unit || (/^(ms|s)$/.test(num.unit) && /^(ms|s)$/.test(item.unit))));
 if (l < 0.5 && !alias && !kindWord && !unit && !(widget && (item.kind === 'widget' || !label.length || option))) return 0;
 return 4 * l + (l === 1 ? 2 : 0) + (widget ? 2 : 0) + (alias ? 5 : kindWord ? 3 : 0) + (unit ? 3 : 0) + (item.kind === 'widget' && widget ? 1 : 0);
}

const round = (v, item) => { const step = Number(item.step) || 0; const d = step && step < 1 ? Math.min(4, String(step).split('.')[1]?.length || 0) : step ? 0 : 3; return Number(v.toFixed(d)); };
const clamp = (v, item) => Math.min(item.max === '' || item.max == null ? Infinity : Number(item.max), Math.max(item.min === '' || item.min == null ? -Infinity : Number(item.min), v));

// The new value for a number control from what the words asked: an amount in the control's own unit, a step
// up or down (times 1.5 for frequencies and times, ±10 BPM, otherwise a tenth of the range), or an extreme.
function numberValue(item, intent, num) {
 const unit = unitOf(item), min = Number(item.min), max = Number(item.max), now = Number(item.value), ranged = item.min !== '' && item.max !== '' && item.min != null && item.max != null;
 if (intent.extreme) return intent.extreme === 'max' ? max : min;
 if (num) {
  let n = num.n;
  if (num.unit === 'ms' && unit === 's') n /= 1000;
  else if (num.unit === 's' && unit === 'ms') n *= 1000;
  else if (num.unit === '%' && unit !== '%' && ranged) n = max <= 1 ? n / 100 : min + (n / 100) * (max - min);
  else if (!num.unit && ranged && max <= 1 && n > 1 && n <= 100 && !num.by) n /= 100; // "volume 70"
  if (num.by) n = now + (intent.dir === -1 ? -n : n);
  return n;
 }
 if (!intent.dir) return null;
 const times = /^(hz|s|ms)$/.test(unit) || /cutoff|attack|decay|release|time|frequency/i.test(item.label);
 if (unit === 'bpm') return now + intent.dir * 10 * intent.amount;
 if (times && now > 0) return now * 1.5 ** (intent.dir * intent.amount);
 return now + intent.dir * intent.amount * (ranged ? (max - min) / 10 : Math.max(1, Math.abs(now) / 4));
}

// One clause: which control and what value, or why not.
function readClause(c, items, carried = {}) {
 const intent = { ...carried, ...intentOf(c) };
 const num = numberIn(c), words = tokens(num ? num.rest : c), to = target(num ? num.rest : c);
 let implied = null;
 for (const imp of IMPLIED) { const m = c.match(imp.words); if (m) implied = { id: imp.id, dir: imp.dir(m[1]) }; }
 const fits = item => {
  if (item.kind === 'widget') return intent.layout && !num && !optionFor(item, to) ? { value: intent.layout } : null;
  if (item.kind === 'checkbox') {
   const on = intent.bypass !== undefined ? (/^bypass/i.test(item.label) ? intent.bypass : !intent.bypass) : intent.on ?? (intent.layout === 'shown' ? true : intent.layout === 'hidden' ? false : undefined);
   if (on === undefined || (num && num.unit !== 'bpm')) return null; // "metronome on at 90 bpm" sets the tempo too
   return { value: /^bypass/i.test(item.label) && intent.bypass === undefined ? !on : on };
  }
  if (item.kind === 'select') {
   const opt = optionFor(item, to) || (num && optionFor(item, String(num.n))) || optionAnywhere(item, c) || optionByWord(item, words);
   if (opt) return { value: opt.value, option: true };
   // "key to D minor": D for the Key, and the rest for another choice in the same widget (its Scale).
   const [first, ...rest] = to.split(' '), head = rest.length && optionFor(item, first);
   if (head) {
    const sibling = rest.length && items.filter(i => i.kind === 'select' && i.widget === item.widget && i !== item).map(i => ({ item: i, o: optionFor(i, rest.join(' ')) })).find(x => x.o);
    return { value: head.value, option: true, also: sibling ? { item: sibling.item, value: sibling.o.value } : null };
   }
   if (intent.dir && !to) { const opts = item.options || [], i = opts.findIndex(o => String(o.value) === String(item.value)), j = Math.max(0, Math.min(opts.length - 1, i + intent.dir)); return j !== i ? { value: opts[j].value } : { same: true }; }
   return null;
  }
  if (item.kind === 'number') {
   if (intent.on !== undefined && !num && !intent.dir) return null;
   if (num?.unit && !fitsUnit(num.unit, unitOf(item))) return null; // 500 ms is not a mix
   const v = numberValue(item, intent, num);
   return v === null || !Number.isFinite(v) ? null : { value: round(clamp(v, item), item) };
  }
  return null;
 };
 let ranked = items.map(item => ({ item, s: implied?.id === item.id ? 6 : score(item, words, c, to, num) })).filter(x => x.s > 0);
 if (implied && !ranked.some(x => x.item.id !== implied.id && x.s >= 6)) { intent.dir ??= implied.dir; }
 const named = ranked.length > 0;
 ranked = ranked.map(x => { const f = fits(x.item); return f && { ...x, ...f, s: x.s + (f.option ? 3 : 0) }; }).filter(Boolean);
 // An option named outright ("highpass", "forest calm") finds its control even when the control isn't named.
 if (!ranked.length && !num) ranked = items.filter(i => i.kind === 'select').map(item => { const o = optionAnywhere(item, c); return o && { item, value: o.value, s: 3, option: true, fallback: true }; }).filter(Boolean);
 if (!ranked.length) return named ? { problem: c } : null;
 ranked.sort((a, b) => b.s - a.s);
 const top = ranked.filter(x => x.s >= ranked[0].s - 0.5);
 if (top.length > 1 && new Set(top.map(x => x.item.name)).size > 1) return { ask: top.slice(0, 8) };
 return { change: { ...top[0], byName: top[0].s - (top[0].option ? 3 : 0) > 0 && !top[0].fallback }, intent, num };
}

const shown = (item, v) => (item.kind === 'checkbox' ? (v ? 'on' : 'off') : item.kind === 'select' ? (item.options || []).find(o => String(o.value) === String(v))?.text ?? v : item.kind === 'widget' ? v : String(v));
const same = (item, v) => (item.kind === 'number' ? Math.abs(Number(item.value) - Number(v)) < 1e-9 : String(item.value) === String(v));
// Words that ask for a change without a verb ("filter off", "louder").
const DIRECTION = /\b(on|off|up|down|louder|quieter|softer|brighter|darker|higher|lower|more|less|fewer|faster|slower|longer|shorter|bigger|smaller|wider|narrower|wetter|drier|dryer|max(imum)?|min(imum)?)\b/;

// The whole request: clauses joined by "and", "then" or commas are read one by one. One that names a control
// without saying what to do takes the last clause's on/off or up/down ("turn off the filter and the
// envelope"), or the next clause's value ("set attack and release to 0.2"). A tempo given in passing
// ("metronome on at 90 bpm") is set as well. With no verb at all, only a named control and its value count
// ("cutoff 800", "filter lowpass"): a word on its own ("dorian") is something to learn about, not to set.
export function readCommand(text, items) {
 let s = normalize(text);
 for (let i = 0; i < 4; i++) s = s.replace(POLITE, '');
 s = s.replace(/\s+(please|for me|thanks|thank you)$/, '');
 if (!s || QUESTION.test(s) || MUSIC.test(s)) return null;
 const terse = !CHANGE.test(s) && !DIRECTION.test(s) && !/\bbring back\b/.test(s);
 const clauses = s.split(/\s*(?:,|\band then\b|\bthen\b|\band\b)\s*/).filter(Boolean);
 const changes = [], already = [], problems = [];
 let carried = {}, ask = null;
 const results = clauses.map(c => {
  const intent = intentOf(c), r = readClause(c, items, carried);
  if (intent.on !== undefined || intent.dir || intent.bypass !== undefined || intent.layout) carried = { on: intent.on, dir: intent.dir, bypass: intent.bypass, layout: intent.layout, amount: intent.amount };
  return { c, r };
 });
 results.forEach((x, i) => {
  if (!x.r?.problem) return;
  const later = results.slice(i + 1).find(y => y.r?.num)?.r.num;
  if (later) x.r = readClause(`${x.c} to ${later.text.replace(/^(to|at|by|=|of|is)\s+/, '')}`, items);
 });
 for (const { r } of results) {
  if (!r) continue;
  if (r.problem) { problems.push(r.problem); continue; }
  if (r.ask) { ask ||= r.ask; continue; }
  const { item, value, byName } = r.change;
  if (terse && (!byName || item.kind === 'checkbox' || item.kind === 'widget')) continue;
  if (r.change.same || same(item, value)) already.push({ item, say: `${item.name} is already ${shown(item, item.value)}` });
  else changes.push({ item, value, say: `${item.name} ${item.kind === 'widget' ? `is now ${value}` : `to ${shown(item, value)}`}` });
  const also = r.change.also;
  if (also && !same(also.item, also.value)) changes.push({ item: also.item, value: also.value, say: `${also.item.name} to ${shown(also.item, also.value)}` });
  const bpm = r.num?.unit === 'bpm' && item.id !== 'seq-bpm' && items.find(i => i.id === 'seq-bpm');
  if (bpm && !same(bpm, r.num.n)) changes.push({ item: bpm, value: round(clamp(r.num.n, bpm), bpm), say: `${bpm.name} to ${r.num.n}` });
 }
 if (changes.length || already.length) return { changes, already };
 if (terse) return null;
 if (ask) return { ask: { text: `Which one: ${ask.map(x => x.item.name).join(', ')}?`, choices: ask.map(x => ({ item: x.item, value: x.value, label: x.item.name })) } };
 if (problems.length) return { problem: problems[0] };
 return null;
}
