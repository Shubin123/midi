// The teacher as an agent: typed actions that operate every widget, and read-only queries of the workspace's
// state, offered to a hosted model as tools (OpenAI-style function calling, js/providers.js) or written as a JSON
// line by a model without tools ({"do": [{"action": "set_tempo", "bpm": 90}]}). Each action says what it does,
// what its arguments are (checked before anything changes, with a clear reason when they are wrong), and
// whether it reads, changes or destroys; a change returns how to undo it. The Agent decides what happens to a
// call: reads run; changes run when "Agent can act" is on and are only suggested (for the student to apply with
// a click) when it is off; destructive ones (clearing a pattern or a loop, writing over the pattern, saving a
// file, opening the microphone) wait for the student to confirm. No more than eight changes a turn and twelve in
// ten seconds, and PANIC stops it for the rest of the turn. The teacher's panel (js/teacher-bridge.js) shows
// every one as it happens, with Undo.
import * as ws from './workspace.js';
import { SCALES } from './sequencer.js';
import { targets as LANES } from './automation.js';
import { listening, MODES } from './listening.js';
import { timing } from './timing-widget.js';
import { parseChordName, parseScaleName, NOTE_NAMES } from './pitch-analyzer.js';
import { readPattern } from './timing.js';
import { mappings, FEATURES, TARGETS as MAP_TARGETS, recordLane } from './listen-map.js';
import { soundMatch } from './sound-match.js';
import { describePatch } from './patch-infer.js';

const $ = id => document.getElementById(id);
const KEYS = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11 };
const keyOf = k => KEYS[String(k).trim().toUpperCase().replace('♯', '#').replace('♭', 'B').replace(/^([A-G])B$/, '$1B')];
const SCI = midi => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`; // C4 is MIDI 60, as models name notes
// "C4", "F#3", "Bb2" (scientific: C4 is middle C) or a MIDI number.
export function midiOf(n) {
 if (Number.isInteger(n)) return n >= 0 && n <= 127 ? n : null;
 const m = /^\s*([A-Ga-g])([#♯b♭]?)(-?\d)\s*$/.exec(String(n));
 if (!m) return null;
 const pc = keyOf(m[1] + (m[2] === 'b' || m[2] === '♭' ? 'B' : m[2] ? '#' : ''));
 return pc === undefined ? null : (Number(m[3]) + 1) * 12 + pc;
}
const synthNote = midi => NOTE_NAMES[midi % 12] + Math.floor(midi / 12); // the synth's own naming: C5 is MIDI 60
const fire = (el, ...types) => types.forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
const choose = (el, value) => { el.value = value; fire(el, 'input', 'change'); };
const click = el => el?.click();
const scaleName = s => Object.keys(SCALES).find(n => n.toLowerCase() === String(s).trim().toLowerCase()) || Object.keys(SCALES).find(n => n.toLowerCase().includes(String(s).trim().toLowerCase()));

/* ---- Checking arguments ---- */

// A short JSON-schema subset: type (number, integer, string, boolean, array, object), enum, minimum, maximum,
// items, minItems/maxItems. Returns the first problem in words, or ''.
function problem(schema, value, name) {
 const type = Array.isArray(schema.type) ? schema.type : [schema.type];
 const typeOk = type.some(t => (t === 'integer' ? Number.isInteger(value) : t === 'array' ? Array.isArray(value) : t === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : typeof value === t));
 if (schema.type && !typeOk) return `${name} must be ${type.join(' or ')}${schema.enum ? ` (one of ${schema.enum.join(', ')})` : ''}, not ${JSON.stringify(value)}`;
 if (schema.enum && !schema.enum.includes(value)) return `${name} must be one of ${schema.enum.join(', ')}, not ${JSON.stringify(value)}`;
 if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return `${name} must be from ${schema.minimum} to ${schema.maximum}, not ${value}`;
 if (Array.isArray(value)) {
  if (schema.minItems !== undefined && value.length < schema.minItems) return `${name} needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`;
  if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${name} takes at most ${schema.maxItems} items`;
  if (schema.items) for (let i = 0; i < value.length; i++) { const p = problem(schema.items, value[i], `${name}[${i}]`); if (p) return p; }
 }
 if (schema.type === 'object' && schema.properties && value) for (const [k, s] of Object.entries(schema.properties)) if (value[k] !== undefined) { const p = problem(s, value[k], `${name}.${k}`); if (p) return p; }
 return '';
}
export function check(action, args = {}) {
 const a = ACTIONS[action];
 if (!a) return `there is no action called ${action}`;
 for (const k of a.required || []) if (args[k] === undefined || args[k] === null || args[k] === '') return `${action} needs ${k}`;
 for (const [k, v] of Object.entries(args)) {
  if (!a.params?.[k]) return `${action} has no argument ${k} (it takes ${Object.keys(a.params || {}).join(', ') || 'none'})`;
  const p = problem(a.params[k], v, k);
  if (p) return p;
 }
 return '';
}

/* ---- What the workspace is doing (read-only) ---- */

const seq = () => window.workspaceApi?.sequencer;
function sequencerState() {
 const s = seq(), rows = s?.notes || [];
 const key = Number($('seq-key')?.value ?? 0), scale = $('seq-scale')?.value, octave = Number($('seq-octave')?.value ?? 4);
 return { key: Object.keys(KEYS).find(k => KEYS[k] === key && !k.endsWith('B') || KEYS[k] === key), scale, octave, playing: !!s?.running,
  rows: Object.fromEntries(rows.map((n, r) => [SCI(Number(n.match(/-?\d+$/)[0]) * 12 + NOTE_NAMES.indexOf(n.replace(/-?\d+$/, ''))), (s.pattern[r] || []).map(on => (on ? 'x' : '.')).join('')])) };
}
const loopsState = () => window.synth.loops().map((l, i) => ({ slot: i + 1, notes: l.events.filter(e => e.type === 'noteon').length, audio: !!l.audio, seconds: Math.round(l.duration / 100) / 10, playing: l.playing, recording: l.recording }));
const pluginsState = () => [...document.querySelectorAll('#plugin-host-module .plugin-row')].map(r => ({ name: r.querySelector('strong')?.textContent.trim(), bypassed: !!r.querySelector('input[type=checkbox]')?.checked }));
export function state(part = 'all', { performance: recent = () => [] } = {}) {
 const p = window.synth.params(), parts = {
  patch: { oscillators: p.oscillators.map(({ id, ...o }) => o), slop: p.common.oscSlop, envelope: p.adsr, filter: p.filter, volume: Number($('masterVolume')?.value) },
  tempo: { bpm: window.synth.tempo, metronome: window.synth.metronome, beat: timing.clock.running ? `kept by ${timing.clock.source} at ${Math.round(timing.clock.bpm * 10) / 10}` : 'none', follow: timing.follow },
  sequencer: sequencerState(),
  automation: (seq()?.lanes || []).map(l => ({ target: l.target, enabled: l.enabled, mode: l.mode, points: l.points })),
  loops: loopsState(),
  plugins: pluginsState(),
  widgets: ws.widgets().filter(w => !w.menu).map(w => `${w.title}${w.hidden ? ' (hidden)' : w.minimized ? ' (minimised)' : ''}`),
  listening: { on: listening.active, input: listening.label, mode: listening.settings.mode, headphones: listening.settings.headphones, latencyMs: listening.latencyMs },
  performance: recent(),
 };
 return part === 'all' ? parts : { [part]: parts[part] };
}

/* ---- The actions ---- */

const num = (description, minimum, maximum) => ({ type: 'number', description, minimum, maximum });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = description => ({ type: 'boolean', description });
const SLOT = { type: 'integer', description: 'Loop slot, 1 to 4', minimum: 1, maximum: 4 };
const WIDGET = str('A widget\'s title, e.g. "Filter", "Step sequencer", "Listening"');
const loopButton = (what, slot) => $(`loop-slot-${what}-${slot - 1}`);
const sequencerPatternFrom = (notes, base = null) => {
 const s = seq(), rows = s.notes.map(n => Number(n.match(/-?\d+$/)[0]) * 12 + NOTE_NAMES.indexOf(n.replace(/-?\d+$/, '')));
 const pattern = base ? base.map(r => [...r]) : rows.map(() => Array(16).fill(false));
 const missed = [];
 for (const { note, step } of notes) {
  const m = midiOf(note);
  let row = m === null ? -1 : rows.indexOf(m);
  if (row < 0 && m !== null) { const near = rows.reduce((b, r, i) => (Math.abs(r - m) < Math.abs(rows[b] - m) ? i : b), 0); if (Math.abs(rows[near] - m) <= 1) row = near; }
  if (row < 0) { missed.push(String(note)); continue; }
  pattern[row][step] = true;
 }
 return { pattern, missed, rows: rows.map(SCI) };
};
const lane = target => [...document.querySelectorAll('#automation .automation-lane')].find(b => b.querySelector('label')?.textContent.trim() === LANES[target]?.label);
const builtInSelect = () => document.querySelector('#plugin-host-module select[aria-label="Built-in effect"]');

// Each: { says, params, required, kind: 'read' | 'change' | 'destructive', run(args, env) → { text, undo? } }.
// `danger(args)` makes a change destructive only sometimes (writing over a pattern that has notes).
export const ACTIONS = {
 get_state: { kind: 'read', says: 'Read the workspace: the patch (oscillators, envelope, filter, volume), tempo and metronome, the step sequencer (key, scale, rows and steps), automation lanes, loop slots, plug-ins, widgets, listening, and the latest performance summaries.',
  params: { part: str('Which part, or all', { enum: ['all', 'patch', 'tempo', 'sequencer', 'automation', 'loops', 'plugins', 'widgets', 'listening', 'performance'] }) },
  run: ({ part = 'all' }, env) => ({ text: JSON.stringify(state(part, env)) }) },

 set_tempo: { kind: 'change', says: 'Set the session tempo (the metronome, sequencer and loops follow it).', params: { bpm: num('Beats per minute', 30, 300) }, required: ['bpm'],
  run: ({ bpm }) => { const was = window.synth.tempo; window.synth.tempo = Math.round(bpm * 10) / 10; return { text: `tempo ${window.synth.tempo} BPM (was ${was})`, undo: () => { window.synth.tempo = was; } }; } },
 start_metronome: { kind: 'change', says: 'Start the metronome, at a tempo if given.', params: { bpm: num('Beats per minute', 30, 300) },
  run: ({ bpm }) => { const m = $('metronomeToggle'), was = m.checked, tempo = window.synth.tempo; if (bpm) window.synth.tempo = bpm; if (!m.checked) click(m); return { text: `metronome on at ${window.synth.tempo} BPM`, undo: () => { if (m.checked !== was) click(m); window.synth.tempo = tempo; } }; } },
 stop_metronome: { kind: 'change', says: 'Stop the metronome.', params: {},
  run: () => { const m = $('metronomeToggle'), was = m.checked; if (m.checked) click(m); return { text: 'metronome off', undo: () => { if (m.checked !== was) click(m); } }; } },
 set_key_scale: { kind: 'change', says: 'Set the step sequencer\'s key and scale (and octave); its rows, and snapping in Listening, follow it.',
  params: { key: str('Tonic: C, C#, Db, D … B'), scale: str(`One of: ${Object.keys(SCALES).join(', ')}`), octave: { type: 'integer', description: 'Octave of the rows, 2 to 6', minimum: 2, maximum: 6 } }, required: ['key', 'scale'],
  run: ({ key, scale, octave }) => {
   const k = keyOf(key), sc = scaleName(scale);
   if (k === undefined) throw new Error(`"${key}" isn't a key; use C, C#, Db, D … B`);
   if (!sc) throw new Error(`"${scale}" isn't a scale here; use one of ${Object.keys(SCALES).join(', ')}`);
   const was = { key: $('seq-key').value, scale: $('seq-scale').value, octave: $('seq-octave').value, pattern: seq().pattern.map(r => [...r]) };
   $('seq-key').value = k; $('seq-scale').value = sc; if (octave) $('seq-octave').value = octave;
   fire($('seq-key'), 'change');
   return { text: `key ${NOTE_NAMES[k]} ${sc}${octave ? `, octave ${octave}` : ''}`, undo: () => { $('seq-key').value = was.key; $('seq-scale').value = was.scale; $('seq-octave').value = was.octave; fire($('seq-key'), 'change'); seq().setPattern(was.pattern); } };
  } },
 write_sequencer_pattern: { kind: 'change', danger: ({ mode = 'replace' }) => mode === 'replace' && seq()?.pattern.some(r => r.some(Boolean)), says: 'Write notes into the 16-step sequencer: each note (a name like "E4", on one of its rows) at a step from 0 to 15. Replaces the pattern unless mode is add.',
  params: { notes: { type: 'array', description: 'The notes', minItems: 1, maxItems: 64, items: { type: 'object', properties: { note: { type: ['string', 'integer'], description: 'Note name and octave (C4 is middle C) or MIDI number' }, step: { type: 'integer', minimum: 0, maximum: 15, description: 'Step, 0 to 15' } } } }, mode: str('replace or add', { enum: ['replace', 'add'] }) }, required: ['notes'],
  run: ({ notes, mode = 'replace' }) => {
   const was = seq().pattern.map(r => [...r]), bad = notes.find(n => n.note === undefined || !Number.isInteger(n.step));
   if (bad) throw new Error('every note needs a note and a step');
   const { pattern, missed, rows } = sequencerPatternFrom(notes, mode === 'add' ? was : null);
   if (missed.length === notes.length) throw new Error(`none of ${missed.join(', ')} is on the sequencer's rows (${rows.join(' ')}); change the key, scale or octave first`);
   seq().setPattern(pattern);
   return { text: `wrote ${notes.length - missed.length} note${notes.length - missed.length === 1 ? '' : 's'} into the step sequencer${missed.length ? ` (not on its rows: ${missed.join(', ')})` : ''}`, undo: () => seq().setPattern(was) };
  } },
 clear_sequencer: { kind: 'destructive', says: 'Clear every step of the sequencer.', params: {},
  run: () => { const was = seq().pattern.map(r => [...r]); click($('seq-clear')); return { text: 'the step sequencer is empty', undo: () => seq().setPattern(was) }; } },
 play_sequencer: { kind: 'change', says: 'Play the step sequencer, for a number of bars (then it stops) or until stopped.', params: { bars: { type: 'integer', minimum: 1, maximum: 32, description: 'Bars to play' } },
  run: ({ bars }) => { if (seq().running) seq().stop(); seq().start(bars ? { bars } : {}); return { text: `the sequencer plays${bars ? ` ${bars} bar${bars === 1 ? '' : 's'}` : ''}`, undo: () => seq().stop() }; } },
 stop_sequencer: { kind: 'change', says: 'Stop the step sequencer.', params: {}, run: () => { seq().stop(); return { text: 'the sequencer stopped' }; } },

 set_param: { kind: 'change', says: 'Set any control of a widget or plug-in by its workspace name ("Filter › Cutoff (Hz)", "Envelope (ADSR) › Attack (s)", "Master & Settings › Volume", "Air › Mid Air", "Delay › Feedback"); numbers are held to the control\'s range.',
  params: { control: str('"Widget › Control", as get_controls names it'), value: { type: ['number', 'string', 'boolean'], description: 'The new value' } }, required: ['control', 'value'],
  run: ({ control, value }) => { const r = ws.set(control, value); return { text: `${r.name} ${r.to}`, undo: () => ws.restore(r.name, r.from) }; } },
 set_oscillator: { kind: 'change', says: 'Change one oscillator of the bank: its waveform, octave, detune (cents), level, or switch it off.',
  params: { index: { type: 'integer', description: 'Oscillator number, from 1', minimum: 1, maximum: 8 }, waveform: str('sine, square, sawtooth, triangle, pulse, white or pink', { enum: ['sine', 'square', 'sawtooth', 'triangle', 'pulse', 'white', 'pink'] }), octave: { type: 'integer', minimum: -2, maximum: 2, description: 'Octave, −2 to 2' }, detune: num('Cents', -100, 100), level: num('0 to 1', 0, 1), on: bool('Sounding') }, required: ['index'],
  run: ({ index, ...set }) => {
   if (!$(`waveformOsc${index}`)) throw new Error(`there is no oscillator ${index}; the bank has ${document.querySelectorAll('[id^=waveformOsc]').length}`);
   const ids = { waveform: `waveformOsc${index}`, octave: `octaveOsc${index}`, detune: `detuneOsc${index}`, level: `levelOsc${index}` }, undos = [], done = [];
   for (const [k, v] of Object.entries(set)) {
    if (k === 'on') { const box = document.querySelector(`#oscillators-group .osc-row:nth-of-type(${index}) .osc-on input`) || [...document.querySelectorAll('#oscillators-group .osc-on input')][index - 1]; if (!box) continue; const was = box.checked; if (was !== v) click(box); undos.push(() => { if (box.checked !== was) click(box); }); done.push(v ? 'on' : 'off'); continue; }
    const el = $(ids[k]); if (!el) continue;
    const r = ws.set(el.id, v); undos.push(() => ws.restore(r.name, r.from)); done.push(`${k} ${r.to}`);
   }
   if (!done.length) throw new Error('say what to change: waveform, octave, detune, level or on');
   return { text: `oscillator ${index}: ${done.join(', ')}`, undo: () => undos.reverse().forEach(u => u()) };
  } },

 add_automation_lane: { kind: 'change', says: 'Add an automation lane for a target (it moves while the sequencer plays).', params: { target: str(`One of: ${Object.keys(LANES).join(', ')}`, { enum: Object.keys(LANES) }) }, required: ['target'],
  run: ({ target }) => {
   if (lane(target)) return { text: `${LANES[target].label} already has a lane` };
   choose($('automation-target'), target); click($('add-lane'));
   return { text: `added a ${LANES[target].label} lane`, undo: () => [...(lane(target)?.querySelectorAll('button') || [])].find(b => b.textContent === 'Remove')?.click() };
  } },
 write_automation: { kind: 'change', says: 'Shape an automation lane over the 16 steps: 16 values, or a ramp from one value to another; and switch it on or off. Adds the lane if there is none.',
  params: { target: str('The lane\'s target', { enum: Object.keys(LANES) }), points: { type: 'array', items: { type: 'number' }, minItems: 16, maxItems: 16, description: '16 values' }, from: { type: 'number', description: 'A ramp\'s first value' }, to: { type: 'number', description: 'A ramp\'s last value' }, mode: str('linear or hold', { enum: ['linear', 'hold'] }), enabled: bool('Lane on') }, required: ['target'],
  run: ({ target, points, from, to, mode, enabled = true }) => {
   const t = LANES[target];
   const values = points || (from !== undefined && to !== undefined ? Array.from({ length: 16 }, (_, i) => from + ((to - from) * i) / 15) : null);
   const out = values?.find(v => v < t.min - 1e-9 || v > t.max + 1e-9);
   if (out !== undefined) throw new Error(`${t.label} goes from ${t.min} to ${t.max}; ${points ? out : `a ramp to ${to}`} is outside it`);
   const had = !!lane(target);
   if (!had) { choose($('automation-target'), target); click($('add-lane')); }
   const box = lane(target), was = { points: [...(seq().lanes.find(l => l.target === target)?.points || [])], mode: box.querySelector('select').value, enabled: box.querySelector('input[type=checkbox]').checked };
   const apply = (vals, m, on) => {
    vals?.forEach((v, i) => { const input = box.querySelector(`input[aria-label="${t.label} step ${i + 1} value"]`); if (input) { input.value = Math.round(v * 1000) / 1000; fire(input, 'input', 'change'); } });
    if (m) choose(box.querySelector('select'), m);
    const c = box.querySelector('input[type=checkbox]'); if (c.checked !== on) click(c);
   };
   apply(values, mode, enabled);
   return { text: `${t.label} lane ${values ? `shaped from ${Math.round(values[0])} to ${Math.round(values[15])}` : 'set'}${enabled ? ', on' : ', off'}`, undo: () => { if (!had) [...box.querySelectorAll('button')].find(b => b.textContent === 'Remove')?.click(); else apply(was.points, was.mode, was.enabled); } };
  } },

 arm_loop_slot: { kind: 'change', says: 'Arm a loop slot, and with record start recording into it (on the next beat while the metronome runs); what it keeps follows the loop recorder\'s Record setting, or kind.',
  params: { slot: SLOT, record: bool('Start recording too'), kind: str('notes or audio (the sound heard by Listening)', { enum: ['notes', 'audio'] }) }, required: ['slot'],
  run: ({ slot, record = false, kind }) => {
   const k = $('looper-record-kind'), wasKind = k?.value;
   if (kind && k) choose(k, kind);
   const arm = loopButton('arm', slot);
   if (arm.disabled) throw new Error(`slot ${slot} can't be armed now (another slot is recording, or it is playing)`);
   if (!/Record|Stop Rec/.test(arm.textContent)) click(arm); // arm
   if (record && arm.textContent === 'Record') click(arm);
   return { text: `slot ${slot} ${record ? 'recording' : 'armed'}${kind ? ` (${kind})` : ''}`, undo: () => { if (arm.textContent === 'Stop Rec') click(arm); if (kind && k) choose(k, wasKind); } };
  } },
 stop_loop_recording: { kind: 'change', says: 'Stop recording a loop slot (it keeps what was recorded).', params: { slot: SLOT }, required: ['slot'],
  run: ({ slot }) => { const arm = loopButton('arm', slot); if (arm.textContent !== 'Stop Rec') throw new Error(`slot ${slot} isn't recording`); click(arm); return { text: `slot ${slot} recorded` }; } },
 play_loop_slot: { kind: 'change', says: 'Play or stop a loop slot (on the next beat while the metronome runs).', params: { slot: SLOT, on: bool('Play (true) or stop (false)') }, required: ['slot'],
  run: ({ slot, on = true }) => {
   const l = window.synth.loops()[slot - 1], play = loopButton('play', slot);
   if (on && !l.events.length && !l.audio) throw new Error(`slot ${slot} is empty`);
   if (on !== l.playing) click(play);
   return { text: `slot ${slot} ${on ? 'playing' : 'stopped'}`, undo: () => { if (window.synth.loops()[slot - 1].playing === on) click(play); } };
  } },
 clear_loop_slot: { kind: 'destructive', says: 'Clear a loop slot.', params: { slot: SLOT }, required: ['slot'],
  run: ({ slot }) => {
   const l = window.synth.loops()[slot - 1], kept = { events: l.events.map(e => ({ ...e })), duration: l.duration, audio: l.audio };
   if (l.playing) click(loopButton('play', slot));
   click(loopButton('clear', slot));
   return { text: `slot ${slot} cleared`, undo: () => { if (kept.events.length) window.synth.setLoop(slot - 1, kept.events, kept.duration); if (kept.audio) { if (!kept.events.length) window.synth.setLoop(slot - 1, [], kept.duration); window.synth.setLoopAudio(slot - 1, kept.audio); } } };
  } },

 load_plugin: { kind: 'change', says: 'Load a built-in effect plug-in into the chain.', params: { name: str('Reverb, Delay, Compressor, Saturator, Chorus, …') }, required: ['name'],
  run: async ({ name }) => {
   const sel = builtInSelect(), opt = [...sel.options].find(o => o.textContent.toLowerCase() === String(name).toLowerCase() || o.value === String(name).toLowerCase());
   if (!opt) throw new Error(`there is no built-in plug-in called ${name}; there are ${[...sel.options].map(o => o.textContent).join(', ')}`);
   const before = pluginsState().length;
   choose(sel, opt.value);
   [...document.querySelectorAll('#plugin-host-module button')].find(b => b.textContent === 'Add built-in').click();
   for (let i = 0; i < 100 && pluginsState().length === before; i++) await new Promise(r => setTimeout(r, 30));
   const row = [...document.querySelectorAll('#plugin-host-module .plugin-row')].at(-1);
   return { text: `loaded ${opt.textContent}`, undo: () => [...(row?.querySelectorAll('button') || [])].find(b => b.textContent === 'Remove')?.click() };
  } },
 set_plugin_param: { kind: 'change', says: 'Set a loaded plug-in\'s control.', params: { plugin: str('Its window title, e.g. "Delay"'), param: str('The control, e.g. "Feedback"'), value: { type: ['number', 'string', 'boolean'], description: 'The new value' } }, required: ['plugin', 'param', 'value'],
  run: ({ plugin, param, value }) => { const r = ws.set(`${plugin} › ${param}`, value); return { text: `${r.name} ${r.to}`, undo: () => ws.restore(r.name, r.from) }; } },
 bypass_plugin: { kind: 'change', says: 'Bypass a loaded plug-in, or bring it back.', params: { plugin: str('Its name'), on: bool('Bypassed (true) or in the chain (false)') }, required: ['plugin'],
  run: ({ plugin, on = true }) => {
   const row = [...document.querySelectorAll('#plugin-host-module .plugin-row')].find(r => r.querySelector('strong')?.textContent.trim().toLowerCase() === String(plugin).toLowerCase());
   if (!row) throw new Error(`no plug-in called ${plugin} is loaded (${pluginsState().map(p => p.name).join(', ') || 'none are'})`);
   const box = row.querySelector('input[type=checkbox]'), was = box.checked;
   if (box.checked !== on) { box.checked = on; fire(box, 'change'); }
   return { text: `${plugin} ${on ? 'bypassed' : 'in the chain'}`, undo: () => { box.checked = was; fire(box, 'change'); } };
  } },

 import_file: { kind: 'read', says: 'Point the student at Import / Export\'s import button: only they can choose a file from their computer.', params: {},
  run: () => { ws.show('Import / Export › + Import file…'); return { text: 'pointed at + Import file…: the student chooses the file' }; } },
 export_midi: { kind: 'destructive', says: 'Save a .mid file of the step sequencer, a loop slot, or the performance heard by Listening.', params: { source: str('sequencer, loop1 … loop4, or performance', { enum: ['sequencer', 'loop1', 'loop2', 'loop3', 'loop4', 'performance'] }) }, required: ['source'],
  run: ({ source }) => {
   const sel = document.querySelector('#io-module select[aria-label="Bounce source"]');
   choose(sel, source === 'sequencer' ? 'seq' : source === 'performance' ? 'listen' : `loop${Number(source.slice(4)) - 1}`);
   [...document.querySelectorAll('#io-module button')].find(b => b.textContent === 'Export MIDI').click();
   return { text: document.querySelector('#io-module [role=status]')?.textContent || 'exported' };
  } },
 render_audio: { kind: 'change', says: 'Render the step sequencer or a loop slot to an audio clip in Import / Export (in real time; it can be played and downloaded from there).', params: { source: str('sequencer or loop1 … loop4', { enum: ['sequencer', 'loop1', 'loop2', 'loop3', 'loop4'] }), repeats: { type: 'integer', minimum: 1, maximum: 32, description: 'Bars or loop lengths' } }, required: ['source'],
  run: ({ source, repeats = 1 }) => {
   choose(document.querySelector('#io-module select[aria-label="Bounce source"]'), source === 'sequencer' ? 'seq' : `loop${Number(source.slice(4)) - 1}`);
   const r = document.querySelector('#io-module input[type=number]'); if (r) choose(r, repeats);
   [...document.querySelectorAll('#io-module button')].find(b => b.textContent === 'Render audio').click();
   return { text: `rendering ${source}, ${repeats} time${repeats === 1 ? '' : 's'}` };
  } },

 show_widget: { kind: 'change', says: 'Show a hidden or minimised widget.', params: { widget: WIDGET }, required: ['widget'], run: ({ widget }) => { const r = ws.arrange(widget, 'shown'); return { text: `${r.name} shown`, undo: () => ws.restore(r.name, r.from) }; } },
 hide_widget: { kind: 'change', says: 'Hide a widget (Settings shows it again).', params: { widget: WIDGET }, required: ['widget'], run: ({ widget }) => { const r = ws.arrange(widget, 'hidden'); return { text: `${r.name} hidden`, undo: () => ws.restore(r.name, r.from) }; } },
 focus_widget: { kind: 'read', says: 'Bring a widget or control into view and make it pulse.', params: { widget: str('A widget title or "Widget › Control"') }, required: ['widget'],
  run: ({ widget }) => { const shown = ws.show(widget); if (!shown) throw new Error(`there is no widget or control called ${widget}`); return { text: `pointing at ${shown}` }; } },

 start_listening: { kind: 'destructive', says: 'Open the microphone and listen (the student confirms: it is their microphone).', params: { mode: str('melody, chords or rhythm', { enum: Object.keys(MODES) }) },
  run: async ({ mode }) => { const was = listening.settings.mode; if (mode) listening.set({ mode }); const ok = await listening.start(); if (!ok) throw new Error(listening.error); return { text: `listening to ${listening.label}${mode ? ` (${mode})` : ''}`, undo: () => { listening.stop(); listening.set({ mode: was }); } }; } },
 stop_listening: { kind: 'change', says: 'Close the microphone.', params: {}, run: () => { listening.stop(); return { text: 'the microphone is closed' }; } },
 set_listening_mode: { kind: 'change', says: 'How Listening hears: melody (one note at a time), chords, or rhythm (claps and taps).', params: { mode: str('melody, chords or rhythm', { enum: Object.keys(MODES) }) }, required: ['mode'],
  run: ({ mode }) => { const was = listening.settings.mode, sel = $('listen-mode'); if (sel) choose(sel, mode); else listening.set({ mode }); return { text: `Listening hears ${MODES[mode]}`, undo: () => (sel ? choose(sel, was) : listening.set({ mode: was })) }; } },

 map_feature: { kind: 'change', says: 'While Listening hears the student, let a feature of their sound move a control between two values (brightness opening the filter, loudness the volume).',
  params: { feature: str('loudness, pitch, brightness, density (onsets a second) or tempo (tapped)', { enum: Object.keys(FEATURES) }), target: str('The control', { enum: Object.keys(MAP_TARGETS) }), from: { type: 'number', description: 'At the feature\'s least' }, to: { type: 'number', description: 'At its most' } }, required: ['feature', 'target'],
  run: ({ feature, target, from, to }) => { const t = MAP_TARGETS[target], m = mappings.add({ feature, target, min: from ?? t.min, max: to ?? t.max }); document.querySelector('#listen-map-add')?.dispatchEvent(new Event('mappings')); return { text: `${FEATURES[feature].label.toLowerCase()} moves ${t.label} from ${m.min} to ${m.max}`, undo: () => mappings.remove(m.id) }; } },
 record_lane: { kind: 'change', says: 'Record an automation lane from the microphone: the sequencer plays one bar while a feature of what the student sings or plays is read at each step.',
  params: { feature: str('loudness, pitch, brightness, density or tempo', { enum: Object.keys(FEATURES) }), target: str('The lane', { enum: Object.keys(LANES) }) }, required: ['feature', 'target'],
  run: async ({ feature, target }) => { const s = seq(), was = s.lanes.find(l => l.target === target)?.points.slice(); const points = await recordLane(s, feature, target); return { text: `${LANES[target].label} recorded from ${FEATURES[feature].label.toLowerCase()}: ${points.map(Math.round).join(' ')}`, undo: () => { const l = s.lanes.find(x => x.target === target); if (l && was) l.points.splice(0, 16, ...was); } }; } },
 match_sound: { kind: 'change', danger: () => !listening.active, says: 'Make it sound like this: record one note the student plays or sings (or use the one in Sound match already) and find a synth patch for it; says how close it got. Apply it with apply_inferred_patch.',
  params: { again: bool('Record a new note even if there is one') },
  run: async ({ again = false }) => {
   if (again || !soundMatch.take) { const t = await soundMatch.record(); await soundMatch.match(t.samples, t.sampleRate, 'your note'); }
   else if (!soundMatch.result) await soundMatch.match(soundMatch.take.samples, soundMatch.take.sampleRate, soundMatch.take.name);
   const r = soundMatch.result;
   return { text: `match ${r.match}% (first guess ${r.guessMatch}%): ${describePatch(r.patch)}` };
  } },
 apply_inferred_patch: { kind: 'destructive', says: 'Put the patch Sound match found on the synth (the oscillators, envelope and filter), replacing the current one; Undo brings it back.', params: {},
  run: () => soundMatch.apply() },
 play_example_phrase: { kind: 'change', says: 'Play an example through the synth, lighting the keys: notes in order, chords one per beat, or a scale up and down.',
  params: { notes: { type: 'array', items: { type: ['string', 'integer'] }, maxItems: 32, description: 'Note names, e.g. ["C4", "E4", "G4"]' }, chords: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Chord symbols, e.g. ["Dm7", "G7", "Cmaj7"]' }, scale: str('e.g. "A minor pentatonic"'), bpm: num('Speed', 30, 300) },
  run: ({ notes, chords, scale, bpm }, env) => {
   let steps = [], label = '';
   if (notes?.length) { steps = notes.map(midiOf).filter(m => m !== null).map(m => [m]); label = `${steps.length} notes`; }
   else if (chords?.length) { steps = chords.map(c => parseChordName(c)).filter(Boolean).map(c => env.chordMidi(c)); label = chords.join(' → '); }
   else if (scale && parseScaleName(scale)) { const s = parseScaleName(scale); steps = env.scaleRun(s).map(m => [m]); label = scale; }
   if (!steps.length) throw new Error('give notes (like "C4"), chord symbols or a scale name');
   env.play(steps, bpm || (chords?.length ? 60 : 120), label);
   return { text: `playing ${label}` };
  } },
 sing_back: { kind: 'change', danger: () => !listening.active, says: 'A sing-back round: a short phrase in the sequencer\'s key plays from the next bar against the metronome, the student sings it back in the bar after, and is told how in tune and on time each note was. Opens the microphone (asking first) if it isn\'t.',
  params: { length: { type: 'integer', minimum: 3, maximum: 8, description: 'Notes in the phrase' } },
  run: ({ length = 4 }, env) => { env.singBack({ length }); return { text: `a sing-back round of ${length} notes: listen, then sing` }; } },
 set_exercise: { kind: 'change', says: 'Set a rhythm exercise: a pattern of one or two bars on the sixteenth grid ("x" a hit, "." a rest), at a tempo. The metronome starts, the pattern plays once from the next bar, and the phrases after it are marked against it.',
  params: { pattern: str('16 or 32 characters of x and .'), bpm: num('Tempo', 40, 220) }, required: ['pattern'],
  run: ({ pattern, bpm = 90 }, env) => {
   const p = readPattern(pattern);
   if (!p) throw new Error(`"${pattern}" isn't a pattern: 16 or 32 characters of x and .`);
   const was = env.exercise(), tempo = window.synth.tempo, clicking = $('metronomeToggle').checked;
   env.setExercise({ id: 'agent', pattern: p, bpm: Math.round(bpm), label: `${p.match(/.{16}/g).join(' | ')} at ${Math.round(bpm)} BPM` });
   return { text: `exercise ${p} at ${Math.round(bpm)} BPM`, undo: () => { env.setExercise(was); window.synth.tempo = tempo; if ($('metronomeToggle').checked !== clicking) click($('metronomeToggle')); } };
  } },
};
export const READS = Object.keys(ACTIONS).filter(k => ACTIONS[k].kind === 'read');

// The tools as a hosted model is offered them.
export const definitions = () => Object.entries(ACTIONS).map(([name, a]) => ({ type: 'function', function: { name, description: `${a.says}${a.kind === 'destructive' ? ' The student confirms it first.' : ''}`, parameters: { type: 'object', properties: a.params || {}, required: a.required || [] } } }));

/* ---- The agent ---- */

export const LIMITS = { perTurn: 8, perWindow: 12, windowMs: 10000 };

// Decides what happens to each call. `canAct()` is the panel's "Agent can act" switch; `show(entry)` puts what
// happened in the panel: { kind: 'done' | 'suggest' | 'confirm' | 'refused', action, args, text, who, undo?,
// apply? }. `env` gives the actions what they need from the teacher (playing, the exercise, the summaries).
export class Agent {
 constructor({ canAct = () => true, show = () => {}, env = {} } = {}) { Object.assign(this, { canAct, show, env }); this.times = []; this.turn = 0; this.halted = false; this.batch = []; }
 // A model's turn starts: the per-turn count and PANIC's stop are reset, and the changes of this turn gathered.
 begin() { this.turn = 0; this.halted = false; this.batch = []; }
 end() { const done = this.batch; this.batch = []; return done; }
 halt() { this.halted = true; }
 summary(action, args) { return `${action.replace(/_/g, ' ')}${Object.keys(args).length ? ` ${JSON.stringify(args)}` : ''}`; }
 async _run(action, args, who) {
  const r = await ACTIONS[action].run(args, this.env);
  if (ACTIONS[action].kind !== 'read') { this.batch.push(r); this.show({ kind: 'done', action, args, text: r.text, who, undo: r.undo }); }
  return r;
 }
 // Returns what the model is told, in words.
 async call(action, args = {}, who = 'System 2') {
  args = args && typeof args === 'object' ? args : {};
  const why = check(action, args);
  if (why) { this.show({ kind: 'refused', action, args, text: why, who }); return `Not done: ${why}.`; }
  const a = ACTIONS[action];
  if (a.kind === 'read') { try { return (await a.run(args, this.env)).text; } catch (err) { return `Not done: ${err.message}.`; } }
  if (this.halted) return 'Stopped: the student pressed PANIC, so nothing more changes this turn.';
  const now = performance.now();
  this.times = this.times.filter(t => now - t < LIMITS.windowMs);
  if (this.turn >= LIMITS.perTurn || this.times.length >= LIMITS.perWindow) { this.show({ kind: 'refused', action, args, text: 'too many changes at once', who }); return `Not done: too many changes at once (at most ${LIMITS.perTurn} a turn and ${LIMITS.perWindow} in ${LIMITS.windowMs / 1000} s). Say what you did and stop.`; }
  this.turn++; this.times.push(now);
  const apply = () => this._run(action, args, who);
  if (a.kind === 'destructive' || a.danger?.(args)) { this.show({ kind: 'confirm', action, args, text: this.summary(action, args), who, apply }); return `Waiting for the student to confirm (${this.summary(action, args)}): it only happens if they agree.`; }
  if (!this.canAct()) { this.show({ kind: 'suggest', action, args, text: this.summary(action, args), who, apply }); return `Suggested to the student, who can apply it with one click (the agent may not act on its own): ${this.summary(action, args)}.`; }
  try { const r = await apply(); return `Done: ${r.text}.`; }
  catch (err) { this.show({ kind: 'refused', action, args, text: err.message, who }); return `Not done: ${err.message}.`; }
 }
}
