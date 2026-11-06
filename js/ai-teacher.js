// The teacher's conversation logic, independent of which engine answers. It keeps a short rolling history,
// sends one request at a time, and turns the reply into text plus an example to play. Models name what to
// play ("Dm7", "A minor pentatonic", "C4") and the notes are worked out here, because small models get note
// arithmetic wrong far more often than names. The engine is injected (js/providers.js, js/local-model.js): any
// object with `generate(messages, { think }) -> text` and an optional `interrupt()`.
import { parseChordName, parseScaleName, midiFromName, chordMidi, scaleRunMidi } from './pitch-analyzer.js';
import { exampleFromProse } from './requests.js';
import { readPattern } from './timing.js';

const MAX_HISTORY = 30; // messages, dropped oldest-first in user/assistant pairs
const MAX_NOTES = 40;

// No sample reply: small models copied one word for word, example included, whatever they were asked.
export const SYSTEM_PROMPT = `You are a friendly music theory teacher inside a live piano app. Guide the student one small step at a time.

Messages starting with [PLAYED] describe a phrase the student just played: the notes in order (MIDI numbers, 60 is middle C), the pitch classes, the app's scale or mode guess, and any chords. The guess comes from the pitch set alone; correct it if the order or the bass points to another tonic. A line starting with "Coach:" is the step the app is suggesting to the student next; they have not done it yet. Build on it and explain why it helps, unless it is clearly wrong. Any other message is the student's own question.

Messages with a [RHYTHM] block sum up the timing of a phrase played to a beat: the notes on a sixteenth grid bar by bar (x a note, . a rest; four characters a beat), the tempo, how early or late they were on average (negative is early) and how uneven, swing and syncopation, the pattern they are practising if any, what keeps happening across phrases, and the app's own step. Say what happened rhythmically and why it matters, give one concrete correction, and end with the next exercise as {"exercise": {"pattern": "<16 or 32 characters of x and .>", "bpm": <tempo>}}.

Reply in plain text, two to four short sentences, no Markdown, and never repeat the [PLAYED] or Coach: lines. Say what they played (or answer the question), explain the idea, and end with one concrete thing to try next.

To play an example, add one last line of JSON naming exactly what your reply is about. Use names, never numbers; the app works out the notes. Use one of these forms, filling in the real names:
{"chords": ["<chord symbol>", "<chord symbol>"]} plays chords in order, one per beat
{"scale": "<tonic> <scale or mode>"} plays a scale up and back down
{"notes": ["<note name and octave>"]} plays single notes in order (C4 is middle C; the student's 25 keys run from C3 to C5)
Leave the line out if there is nothing worth playing.

The app is also a synth workspace with widgets (oscillators, envelope, filter, step sequencer, loop recorder, automation, plug-ins, import and export) and a Settings menu. When the student asks about one, a [WORKSPACE] block lists the widgets and the current settings of the relevant ones; teach from those real names and values. In the same JSON line you can add "show" to point at a control, e.g. {"show": "Filter › Cutoff (Hz)"}, and, only when the student asks you to change something, "set" with the new value, e.g. {"set": {"Filter › Cutoff (Hz)": 800}}; a whole widget can be set to "hidden", "shown" or "minimised", and the tempo is "Step sequencer › Base BPM". For more than a setting, add "do" with the app's actions, e.g. {"do": [{"action": "set_tempo", "bpm": 90}, {"action": "start_metronome"}, {"action": "write_sequencer_pattern", "notes": [{"note": "C4", "step": 0}]}]}. Never claim to press buttons; tell the student which one to press.`;

// Said too when the teacher's tools are offered (hosted models; js/providers.js). A change made with a tool is
// not made again from the JSON line.
export const TOOLS_PROMPT = 'You also have tools that read and change the workspace. Use get_controls or describe_plugin to read a widget or plug-in before teaching it, and set_control or arrange_widget when the student asks you to change something; then say in a sentence what you changed. Use the exact names the tools give. You can also operate the whole workspace as an agent: get_state reads the patch, tempo, sequencer, loops, plug-ins and the latest performance; set_tempo, start_metronome, set_key_scale, write_sequencer_pattern, play_sequencer, set_oscillator, set_param, write_automation, arm_loop_slot, play_loop_slot, load_plugin, set_exercise, play_example_phrase, start_listening and the rest change it. To set up a lesson: set the tempo and key, start the metronome, write the exercise into the sequencer, play it once, then listen. Clearing, saving a file and opening the microphone wait for the student to confirm; if the student has not let you act, your changes are offered to them as suggestions. Make only the changes asked for.';

// Reasoning models write their thinking inline; only the answer after it is shown. A reply that is still
// inside an unfinished <think> block (it ran out of room) has no answer yet.
export function stripThinking(text) {
 const s = String(text);
 const open = s.lastIndexOf('<think>'), close = s.lastIndexOf('</think>');
 if (open >= 0 && close < open) return '';
 return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const KEYS = ['chords', 'scale', 'notes', 'play', 'show', 'set', 'exercise', 'do'];
// The last balanced {...} in the reply that parses as JSON and names something to play.
function findExample(reply) {
 for (let start = reply.lastIndexOf('{'); start >= 0; start = reply.lastIndexOf('{', start - 1)) {
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < reply.length; i++) {
   const c = reply[i];
   if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
   else if (c === '"') inStr = true;
   else if (c === '{' || c === '[') depth++;
   else if (c === '}' || c === ']') { if (--depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) continue;
  try {
   const obj = JSON.parse(reply.slice(start, end));
   if (obj && typeof obj === 'object' && !Array.isArray(obj) && KEYS.some(k => k in obj)) return { obj, start, end };
  } catch { /* not this one */ }
 }
 return repaired(reply);
}

// Models often get the line nearly right: curly or single quotes, a trailing comma, a missing closing bracket
// (it ran out of room). The last object that starts with one of our keys is mended and read.
const OPENS = new RegExp(`\\{\\s*["“'](${KEYS.join('|')})["”']\\s*:`, 'g');
function repaired(reply) {
 const starts = [...reply.matchAll(OPENS)];
 if (!starts.length) return null;
 const start = starts.at(-1).index;
 let text = reply.slice(start).split('\n')[0].replace(/[“”]/g, '"').replace(/'/g, '"').replace(/,\s*([}\]])/g, '$1');
 const stack = [];
 let inStr = false, esc = false, end = text.length;
 for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
  if (c === '"') inStr = true;
  else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
  else if (c === '}' || c === ']') { stack.pop(); if (!stack.length) { end = i + 1; break; } }
 }
 const closed = text.slice(0, end).replace(/,\s*$/, '') + (inStr ? '"' : '') + [...stack].reverse().join('');
 try {
  const obj = JSON.parse(closed);
  return obj && typeof obj === 'object' && KEYS.some(k => k in obj) ? { obj, start, end: start + reply.slice(start).split('\n')[0].length } : null; // the rest of its line goes
 } catch { return null; }
}

// Words that mean the reply suggests playing something.
const SUGGESTS = /\b(play|try|listen|hear|here (is|are)|sounds? like)\b/i;

const validNote = n => Number.isInteger(n) && n >= 0 && n <= 127;

// Splits a reply into its text and an example: { steps: [[midi, ...], ...], bpm, label }. Chords play one per
// beat, a scale up and back down, notes in order; names the app does not recognise are skipped, and the old
// {"play": [60, [60, 64, 67]]} form of MIDI numbers still works. At most 40 notes, tempo held to 30-300 BPM.
// "show" (a control or list of them) and "set" ({ control: value }) come back as `actions` when present.
export function parsePlayCommand(raw) {
 const reply = stripThinking(raw);
 const found = findExample(reply);
 const clean = s => s.replace(/```(?:json)?/g, '').split('\n').filter(l => !/^\s*(\[PLAYED\]|Coach:)/.test(l)).join('\n').trim();
 if (!found) {
  // No usable JSON line: the example is read from the reply's own words, if it suggests one.
  return { text: clean(reply), play: SUGGESTS.test(reply) ? exampleFromProse(reply) : null };
 }
 const { obj } = found, steps = [], labels = [];
 const add = step => { const total = steps.flat().length; if (step.length && total + step.length <= MAX_NOTES) steps.push(step); };
 const chordNames = (Array.isArray(obj.chords) ? obj.chords : []).filter(c => typeof c === 'string' && parseChordName(c));
 chordNames.forEach(c => add(chordMidi(parseChordName(c))));
 if (chordNames.length) labels.push(chordNames.join(' → '));
 const scale = typeof obj.scale === 'string' && parseScaleName(obj.scale);
 if (scale) { scaleRunMidi(scale.tonic, scale.scaleName).forEach(n => add([n])); labels.push(obj.scale.trim()); }
 const notes = (Array.isArray(obj.notes) ? obj.notes : []).map(n => (typeof n === 'string' ? midiFromName(n) : n)).filter(validNote);
 notes.forEach(n => add([n]));
 if (notes.length) labels.push(`${notes.length} notes`);
 for (const item of Array.isArray(obj.play) ? obj.play : []) add((Array.isArray(item) ? item : [item]).filter(validNote));
 const bpm = Number.isFinite(obj.bpm) && obj.bpm > 0 ? Math.max(30, Math.min(300, obj.bpm)) : (chordNames.length ? 60 : 120);
 const text = clean(reply.slice(0, found.start) + reply.slice(found.end));
 const show = (Array.isArray(obj.show) ? obj.show : [obj.show]).filter(x => typeof x === 'string' && x.trim()).slice(0, 4);
 const set = obj.set && typeof obj.set === 'object' && !Array.isArray(obj.set) ? Object.entries(obj.set).filter(([k, v]) => k.trim() && ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 6) : [];
 // The app's actions (js/agent-actions.js), for a model without tools: [{ action, …args }], at most eight.
 const todo = (Array.isArray(obj.do) ? obj.do : []).filter(d => d && typeof d === 'object' && typeof d.action === 'string').slice(0, 8);
 const prose = !steps.length && !obj.show && !obj.set && !obj.do && SUGGESTS.test(text) ? exampleFromProse(text) : null;
 const out = { text, play: steps.length ? { steps, bpm, label: labels.join(', ') || `${steps.flat().length} notes` } : prose };
 // A rhythm exercise: a pattern of one or two bars on the sixteenth grid, at a tempo.
 const pattern = readPattern(obj.exercise?.pattern);
 if (pattern) { const at = Number.isFinite(Number(obj.exercise.bpm)) ? Math.max(40, Math.min(220, Math.round(Number(obj.exercise.bpm)))) : 90; out.exercise = { id: 'model', pattern, bpm: at, label: `${pattern.match(/.{16}/g).join(' | ')} at ${at} BPM` }; }
 if (show.length || set.length || todo.length) out.actions = { show, set, ...(todo.length ? { do: todo } : {}) };
 return out;
}

// The [PLAYED] summary the model reads, plus the System 1 coach's suggestion when there is one.
export function phraseMessage(a, coachHint = '') {
 const midi = a.noteOns.slice(0, 48).map(n => n.note).join(', ') + (a.noteOns.length > 48 ? ', ...' : '');
 const parts = [`${a.noteCount} notes, ${Math.round(a.durationMs)}ms`, `midi: [${midi}]`, `pcs: [${a.pitchClasses.join(', ')}]`];
 if (a.scales.length) { const b = a.scales[0]; parts.push(`best: ${b.tonicName} ${b.scaleName} (${b.score.toFixed(2)})`); }
 if (a.chords.length) parts.push(`chords: ${a.chords.map(c => c.best.chordName).join(' → ')}`);
 return `[PLAYED] ${parts.join(' | ')}${coachHint ? `\nCoach: ${coachHint}` : ''}`;
}

export class AiTeacher {
 constructor() {
  this.engine = null;
  this.conversationHistory = [];
  this.onResponse = null; this.onError = null; this.onStatus = null;
  this._queue = Promise.resolve(); this._generation = 0;
 }
 get isConfigured() { return !!this.engine; }
 setEngine(engine) { this.engine = engine; }

 // opts.think asks a reasoning model to think first (System 2); opts.coach adds the System 1 suggestion.
 // opts.context is sent with this one message (the workspace as it is now) but not kept in the history.
 // opts.quick is an answer the app already gave: the model replies only if it is wrong (else onConfirm()).
 // opts.rhythm is the phrase's [RHYTHM] summary (js/timing.js), read with it in the same request.
 analyzePhrase(a, opts = {}) { return this._send(`${phraseMessage(a, opts.coach)}${opts.rhythm ? `\n${opts.rhythm}` : ''}`, opts); }
 ask(q, opts = {}) { return this._send(q, opts); }
 reset() { this._generation++; this.conversationHistory = []; this.engine?.interrupt?.(); }
 // Drops the answer being made (PANIC), keeping the conversation.
 stop() { this._generation++; this.engine?.interrupt?.(); this.onStatus?.('ready'); }

 // One request at a time, so the history always alternates user and assistant turns.
 // Requests queued before a reset() are skipped.
 _send(msg, opts) {
  const generation = this._generation;
  return this._queue = this._queue.then(() => generation === this._generation ? this._request(msg, opts) : null);
 }

 // opts.tools ({ definitions, run }) are the workspace tools a hosted model may call while answering.
 async _request(msg, { think = false, context = '', quick = '', onConfirm = null, tools = null } = {}) {
  if (!this.engine) { this.onError?.('Set up a model in Settings first.'); return null; }
  this.onStatus?.(think ? 'reasoning' : 'thinking');
  const history = this.conversationHistory, generation = this._generation, started = performance.now();
  while (history.length >= MAX_HISTORY) history.splice(0, 2); // still opens with a user turn
  history.push({ role: 'user', content: msg });
  let reply;
  try {
   // Supervising: the app already gave a quick answer (System 1); the model confirms it or answers itself.
   const asked = quick ? `${msg}\n\n(The app's quick answer was: "${quick}". If that answers the question correctly, reply with just OK. Otherwise answer the question yourself.)` : msg;
   const turn = context || quick ? [...history.slice(0, -1), { role: 'user', content: context ? `${context}\n\n${asked}` : asked }] : history;
   const used = new Set(), withTools = tools && { definitions: tools.definitions, run: (name, args) => { used.add(name); return tools.run(name, args); } };
   const raw = await this.engine.generate([{ role: 'system', content: tools ? `${SYSTEM_PROMPT}\n\n${TOOLS_PROMPT}` : SYSTEM_PROMPT }, ...turn], withTools ? { think, tools: withTools } : { think });
   this._toolsUsed = used;
   if (generation !== this._generation) { history.pop(); return null; } // reset() while generating: discard
   reply = stripThinking(raw);
   if (!reply) throw new Error(/<think>/.test(raw) ? 'The model ran out of room while thinking. Try again, or switch to Fast.' : 'The model returned nothing. Try again, or pick another model.');
  } catch (err) {
   history.pop();
   this.onStatus?.('ready');
   // A reset() (interrupt) aborts the request; that is not an error to report.
   if (err.name !== 'AbortError' && generation === this._generation) this.onError?.(err.message || 'The model failed to answer.');
   return null;
  }
  if (quick && /^\W*(ok|yes|correct)\b/i.test(reply) && reply.length < 60) {
   history.push({ role: 'assistant', content: quick });
   this.onStatus?.('ready'); onConfirm?.();
   return { confirmed: true };
  }
  history.push({ role: 'assistant', content: reply });
  this.onStatus?.('ready');
  const { text, play, actions = null, exercise = null } = parsePlayCommand(reply);
  if (actions && (this._toolsUsed?.has('set_control') || this._toolsUsed?.has('arrange_widget'))) actions.set = []; // done already, by the tools
  const seconds = (performance.now() - started) / 1000;
  this.onResponse?.(text, play, { think, seconds, actions, exercise });
  return { text, playCmd: play, seconds, actions };
 }
}
