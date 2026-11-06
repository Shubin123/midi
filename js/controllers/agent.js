// The teacher and its agent with a controller (js/agent-actions.js takes these actions in with the rest): read
// what is connected and what each control does, switch presets and pages, map a control, light pads and keys
// for an exercise, write on the controller's screen, and make, edit and export presets. Controls are named the
// way lessons and the student name them: by role ("knob 5", "fader 1", "pad 3", "main encoder"), label ("Pad 1
// (bank B)"), short name (K5) or id. Also what the teacher is told about the controller ([CONTROLLER]), and the
// requests System 1 meets at once, with no model ("switch to the drum preset", "map the faders to the loop
// volumes", "save this as my practice preset").
import { controllers, describe, shortName } from './runtime.js';
import { param } from './registry.js';
import { COLORS } from './feedback.js';
import { variation } from './preset.js';
import * as ws from '../workspace.js';

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const DEVICE = str('Which controller (its name or port), if more than one is connected');

export function deviceOf(ref) {
 const d = ref ? controllers.devices.find(x => [x.port.name, x.name, x.preset.id].some(n => norm(n) === norm(ref) || norm(n).includes(norm(ref)))) : controllers.active[0] || controllers.devices[0];
 if (!d) throw new Error(ref ? `no controller called ${ref} is connected (${controllers.devices.map(x => x.name).join(', ') || 'none is'})` : 'no MIDI controller is connected');
 return d;
}
// A control by role, label, short name or id: "knob 5", "K5", "Pad 1 (bank B)", "pad9", 5 (a pad's number).
export function controlOf(dev, ref) {
 const r = typeof ref === 'number' ? `pad ${ref}` : norm(ref).replace(/^(k|f|p)(\d+)$/, (_, k, n) => `${{ k: 'knob', f: 'fader', p: 'pad' }[k]} ${n}`).replace(/^(encoder|pot|v pot) (\d+)$/, 'knob $2').replace(/^slider (\d+)$/, 'fader $1');
 const c = dev.controls.find(x => norm(x.role) === r) || dev.controls.find(x => norm(x.label) === r) || dev.controls.find(x => norm(x.id) === r.replace(/ /g, '')) || dev.controls.find(x => norm(shortName(x)) === r);
 if (!c) throw new Error(`${dev.name} has no control "${ref}" (it has ${dev.controls.filter(x => x.role).map(x => x.role).slice(0, 24).join(', ')})`);
 return c;
}
// What a control can be told to move: a parameter the registry can find, as its element id or "Widget › Control".
function paramRef(to) {
 const p = param(to);
 if (p) return /^(tempo|osc:|loop:)/.test(to) || !p.el?.id ? to : p.el.id;
 const hit = ws.find(to);
 if (hit?.control && ['number', 'select', 'checkbox'].includes(hit.control.kind)) return hit.control.el.id || ws.nameOf(hit);
 throw new Error(`there is no control called "${to}" to map to`);
}
const ACTION_WORDS = ['loop', 'clear', 'metronome', 'tap', 'record', 'panic', 'play', 'stop', 'loop-toggle', 'step', 'step-page', 'drum', 'browse', 'confirm', 'tempo', 'page', 'page-next', 'page-prev', 'variation', 'arp', 'hold', 'sustain', 'notes', 'bend', 'mod', 'none'];
function actionOf({ to, action, number }) {
 if (to !== undefined) return { do: 'param', param: paramRef(to), takeover: 'pickup' };
 if (!ACTION_WORDS.includes(action)) throw new Error(`say what it should do: to (a control) or action (${ACTION_WORDS.join(', ')})`);
 if (['loop', 'clear', 'page'].includes(action)) return { do: action, slot: number || 1 };
 if (['step', 'drum'].includes(action)) return { do: action, index: number || 1 };
 return { do: action };
}
// Remapping a control that plays (keys, a strip, the pedal) or stops things (PANIC, record, stop, a loop) asks first.
const risky = (dev, c) => /^(keys|strip|wheel|pedal)$/.test(c.type) || /^(panic|record|stop|clear|loop)$/.test(dev.variation.mappings[c.id]?.do || '');
const COLOR_NAMES = { green: COLORS.good, amber: COLORS.ok, orange: COLORS.ok, red: COLORS.late, blue: COLORS.cue, white: COLORS.white, purple: COLORS.pageOn, cyan: COLORS.beat, off: null };
const restoreMapping = (dev, vid, id, was) => { const m = { ...dev.overlay.mappings[vid] }; if (was === undefined) delete m[id]; else m[id] = was; dev.overlay.mappings[vid] = m; dev.takeover.clear(); dev.changed(); };

export const CONTROLLER_ACTIONS = {
 read_controller_state: { kind: 'read', says: 'Read the MIDI controllers connected: each one\'s preset and variation, the program it is in, the encoder page and what each knob, fader and pad does now, and what it does by itself with Shift.',
  params: { device: DEVICE },
  run: ({ device }) => {
   if (!controllers.devices.length) return { text: 'No MIDI controller is connected.' };
   const list = device ? [deviceOf(device)] : controllers.devices;
   return { text: JSON.stringify(list.map(d => ({ ...d.summary(), shiftLayer: (d.preset.shiftLayer || []).map(s => `${s.with}: ${s.does}`), lit: [...d.lights.keys()].map(id => d.control(id)?.label) }))) };
  } },
 list_controller_presets: { kind: 'read', says: 'List the controller presets (each with its variations, who made it and how far it is verified) and which one each connected controller uses.', params: {},
  run: () => ({ text: JSON.stringify(controllers.presets.map(p => ({ id: p.id, name: p.name, status: p.status, verified: p.verified, generic: !!p.generic, variations: p.variations.map(v => v.name), usedBy: controllers.devices.filter(d => d.preset === p).map(d => `${d.port.name}${d.use ? ` (${d.variation.name})` : ' (off)'}`) }))) }) },
 switch_controller_preset: { kind: 'change', says: 'Switch a controller to another preset variation ("Looper & drums", "Sound design", "Teacher / practice", "Performance") or to another preset. Held notes are let go and the pads redrawn.',
  params: { preset: str('A variation\'s name, or a preset\'s name or id'), device: DEVICE }, required: ['preset'],
  run: ({ preset, device }) => {
   const d = deviceOf(device), want = norm(preset).replace(/\b(preset|variation|the|my)\b/g, '').replace(/\s+/g, ' ').trim();
   const v = d.variations().find(x => norm(x.name) === want || x.id === want) || d.variations().find(x => norm(x.name).includes(want) || (want.length > 3 && want.split(' ').every(w => norm(x.name).includes(w))));
   if (v) { const was = d.variationId, use = d.use; if (!d.use) d.setUse(true); d.setVariation(v.id); return { text: `${d.name}: ${v.name}`, undo: () => { d.setVariation(was); d.setUse(use); } }; }
   const p = controllers.presets.find(x => norm(x.name) === want || x.id === preset) || controllers.presets.find(x => norm(x.name).includes(want));
   if (!p) throw new Error(`${d.name} has no variation "${preset}" (it has ${d.variations().map(x => x.name).join(', ')}) and there is no such preset`);
   const was = d.preset.id, port = d.port.name;
   controllers.choosePreset(d, p.id);
   return { text: `${port}: preset ${p.name}`, undo: () => controllers.choosePreset(deviceOf(port), was) };
  } },
 set_controller_page: { kind: 'change', says: 'Put the controller\'s knobs on a page: Synth, Plugin (the focused plug-in window), Air/FX, Automation (the lane\'s steps), or any widget or plug-in window by its title.',
  params: { page: str('A page\'s name, or a widget\'s or plug-in\'s title'), device: DEVICE }, required: ['page'],
  run: ({ page, device }) => {
   const d = deviceOf(device), was = { index: d.pageIndex, focus: d.focus };
   const i = d.pages.findIndex(p => norm(p.name) === norm(page) || p.id === norm(page) || norm(p.name).split(' ').includes(norm(page)));
   if (i >= 0) d.setPage(i);
   else { const hit = ws.find(page); if (!hit || hit.control) throw new Error(`${d.name} has no page "${page}" (${d.pages.map(p => p.name).join(', ')}) and there is no widget of that name`); d.focusWidget(hit.widget.id); }
   return { text: `${d.name}'s knobs on ${d.page.name}: ${d.pageParams().slice(0, 8).map((p, k) => `knob ${k + 1} ${p?.name || '—'}`).join(', ')}`, undo: () => { d.focus = was.focus; d.setPage(was.index); } };
  } },
 map_control: { kind: 'change', danger: ({ control, device }) => { try { const d = deviceOf(device); return risky(d, controlOf(d, control)); } catch { return false; } },
  says: 'Map one control of the controller ("knob 5", "fader 1", "pad 3") to a control in the app (to: "Filter › Resonance", "loop:2:volume", "masterVolume") or to an action (action: loop, metronome, tap, record, drum, step, page, …, with a number for a loop slot, drum or step). In the variation in use; Undo puts it back.',
  params: { control: str('The controller\'s control, by its name: knob 5, fader 2, pad 1, main encoder'), to: str('A control in the app: "Widget › Control", an element id, osc:2:level, loop:1:volume, tempo'), action: str('Or an action', { enum: ACTION_WORDS }), number: { type: 'integer', minimum: 1, maximum: 16, description: 'The loop slot, drum or step for an action' }, device: DEVICE }, required: ['control'],
  run: ({ control, to, action, number, device }) => {
   const d = deviceOf(device), c = controlOf(d, control), a = actionOf({ to, action, number }), vid = d.variationId, was = d.overlay.mappings[vid]?.[c.id];
   if (!d.use) d.setUse(true);
   d.map(c.id, a);
   return { text: `${c.label} → ${describe(d, a)}`, undo: () => restoreMapping(d, vid, c.id, was) };
  } },
 light_pads: { kind: 'change', says: 'Light pads on the controller (to show which to play in an exercise), and keys on the screen\'s keyboard; for some seconds, or until lit again. Colour green, amber, red, blue, white, purple, cyan, or off.',
  params: { pads: { type: 'array', items: { type: ['string', 'integer'] }, maxItems: 24, description: 'Pads by name or number: ["pad 1", "pad 2"] or [1, 2]' }, keys: { type: 'array', items: { type: ['string', 'integer'] }, maxItems: 25, description: 'Keys to light on the screen, as note names (C4) or MIDI numbers' }, color: str('The colour', { enum: Object.keys(COLOR_NAMES) }), seconds: { type: 'number', minimum: 0, maximum: 600, description: 'How long; 0 until changed' }, blink: { type: 'boolean', description: 'Blinking' }, device: DEVICE },
  run: ({ pads = [], keys = [], color = 'blue', seconds = 0, blink = false, device }, env = {}) => {
   if (!pads.length && !keys.length) throw new Error('say which pads (or keys) to light');
   const out = [];
   let undo = () => {};
   if (pads.length) {
    const d = deviceOf(device), ids = pads.map(p => controlOf(d, p).id), was = ids.map(id => [id, d.lights.get(id)]);
    d.light(ids, COLOR_NAMES[color], { ms: seconds * 1000, blink });
    out.push(`${ids.map(id => d.control(id).label).join(', ')} ${color === 'off' ? 'off' : `lit ${color}${blink ? ', blinking' : ''}`}`);
    undo = () => was.forEach(([id, l]) => (l ? d.lights.set(id, l) : d.lights.delete(id)));
   }
   if (keys.length) { const n = env.lightKeys?.(keys, seconds) ?? 0; out.push(`${n} key${n === 1 ? '' : 's'} lit on the screen`); }
   return { text: out.join('; '), undo };
  } },
 show_on_screen: { kind: 'change', says: 'Write a short hint on the controller\'s screen (two lines; about 10 and 18 characters on a MiniLab 3), for some seconds.',
  params: { line1: str('First line'), line2: str('Second line'), seconds: { type: 'number', minimum: 1, maximum: 120, description: 'How long (6 if not given)' }, device: DEVICE }, required: ['line1'],
  run: ({ line1, line2 = '', seconds = 6, device }) => {
   const d = deviceOf(device), f = d.preset.feedback?.screen;
   if (!f) throw new Error(`${d.name} has no screen`);
   const was = d.note;
   d.show([line1, line2], seconds * 1000);
   return { text: `${d.name}'s screen: "${String(line1).slice(0, f.widths[0])}"${line2 ? ` / "${String(line2).slice(0, f.widths[1] ?? f.widths[0])}"` : ''}${d.canShow ? '' : ` (not shown now: ${d.summary().feedback})`}`, undo: () => { d.note = was; } };
  } },
 create_preset_from_mappings: { kind: 'change', danger: ({ name }) => !!controllers.preset(`user/${norm(name).replace(/ /g, '-')}`),
  says: 'Save the controller as it is now (its preset with what was learned and remapped) as a preset of the student\'s own, and use it. Asks first if it would replace one.',
  params: { name: str('The new preset\'s name'), device: DEVICE }, required: ['name'],
  run: ({ name, device }) => {
   const d = deviceOf(device), p = controllers.presetFrom(d, name), old = controllers.preset(p.id), wasPreset = d.preset.id, port = d.port.name;
   controllers.savePreset(p, { overwrite: true });
   controllers.choosePreset(d, p.id);
   return { text: `saved and using ${p.name}`, undo: () => { controllers.choosePreset(deviceOf(port), wasPreset); if (old) controllers.savePreset(old, { overwrite: true }); else controllers.deletePreset(p.id); } };
  } },
 edit_preset_mapping: { kind: 'destructive', says: 'Change what a control does in one of the student\'s own saved presets (official ones stay as they are: save your own first with create_preset_from_mappings). The student confirms, as it rewrites the preset.',
  params: { preset: str('The preset\'s name or id'), control: str('The control'), to: str('A control in the app'), action: str('Or an action', { enum: ACTION_WORDS }), number: { type: 'integer', minimum: 1, maximum: 16, description: 'The slot, drum or step' }, variation: str('Which variation (the first, if not given)') }, required: ['preset', 'control'],
  run: ({ preset, control, to, action, number, variation: vname }) => {
   const p = controllers.presets.find(x => x.id === preset || norm(x.name) === norm(preset));
   if (!p) throw new Error(`there is no preset called ${preset}`);
   if (p.status !== 'user') throw new Error(`${p.name} is ${p.status}: it stays as it is. Save your own copy first (create_preset_from_mappings)`);
   const copy = JSON.parse(controllers.exportPreset(p)), v = vname ? copy.variations.find(x => norm(x.name) === norm(vname) || x.id === vname) : copy.variations[0];
   if (!v) throw new Error(`${p.name} has no variation ${vname}`);
   const c = copy.controls.find(x => norm(x.role) === norm(control) || norm(x.label) === norm(control) || x.id === control);
   if (!c) throw new Error(`${p.name} has no control ${control}`);
   const before = JSON.parse(controllers.exportPreset(p)), a = actionOf({ to, action, number });
   v.mappings = { ...variation(copy, v.id).mappings, [c.id]: a };
   controllers.savePreset(copy, { overwrite: true });
   controllers.devices.filter(d => d.preset.id === p.id).forEach(d => controllers.choosePreset(d, p.id));
   return { text: `${p.name} (${v.name}): ${c.label} → ${a.param || a.do}`, undo: () => { controllers.savePreset(before, { overwrite: true }); controllers.devices.filter(d => d.preset.id === p.id).forEach(d => controllers.choosePreset(d, p.id)); } };
  } },
 export_preset: { kind: 'destructive', says: 'Save a controller preset as a .json file (to share it, or keep it).', params: { preset: str('Its name or id (the one in use if not given)') },
  run: ({ preset }) => {
   const p = preset ? controllers.presets.find(x => x.id === preset || norm(x.name) === norm(preset)) : deviceOf().preset;
   if (!p) throw new Error(`there is no preset called ${preset}`);
   const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([controllers.exportPreset(p)], { type: 'application/json' })), download: `${p.id.replace('/', '-')}.json` });
   a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
   return { text: `saved ${a.download}` };
  } },
};

// What the teacher reads about the controllers in use: one short paragraph each, the controls by name with what
// they do now, and what the device does by itself with Shift, so it can say "turn knob 5 to brighten the sound"
// or "hold Shift and press pad 1 to start the arpeggiator".
export function controllerContext() {
 const list = controllers.active;
 if (!list.length) return '';
 return `[CONTROLLER]\n${list.map(d => {
  const v = d.variation, by = (pred) => d.controls.filter(pred).filter(c => v.mappings[c.id] && v.mappings[c.id].do !== 'none');
  const say = cs => cs.map(c => `${c.label}: ${describe(d, v.mappings[c.id])}`).join('; ');
  const pads = by(c => c.type === 'pad'), shift = (d.preset.shiftLayer || []).map(s => `${s.with}: ${s.does}${s.hold ? ` (held: ${s.hold})` : ''}`);
  return [`${d.name} is connected (preset ${v.name}, ${d.program.name} program${d.programAuto ? ', detected' : ''}; knobs on the ${d.page?.name || ''} page; feedback ${d.summary().feedback}).`,
   `Knobs and faders: ${say(by(c => /^(encoder|knob|fader)$/.test(c.type)))}.`,
   pads.length ? `Pads${d.bank ? ` (bank ${d.bank} in use)` : ''}: ${say(pads)}.` : '',
   `Buttons: ${say(by(c => c.type === 'button'))}.`,
   shift.length ? `On the controller itself: ${shift.join('; ')}.` : '',
   'Name its controls this way when you tell the student what to touch; light_pads shows them which pads to play.'].filter(Boolean).join(' ');
 }).join('\n')}`;
}

/* ---- Requests met at once (System 1) ---- */

// Returns [{ action, args }] for a request about the controller, or null.
export function readControllerCommand(text, dev = controllers.active[0]) {
 if (!dev) return null;
 const t = norm(text);
 let m = /^(?:please )?(?:switch|change|go|set)? ?(?:the controller |the minilab |my controller )?(?:to|use|load) (?:the |my )?(.+?) (?:preset|variation|mode|layout)$/.exec(t) || /^(?:use|load) (?:the |my )?(.+?) (?:preset|variation)$/.exec(t);
 if (m) {
  const want = m[1].replace(/\bdrums?\b/, 'drum'), v = dev.variations().find(x => norm(x.name).includes(want) || (want === 'drum' && /drum/.test(norm(x.name))) || (want === 'practice' && x.id === 'practice') || (want === 'teacher' && x.id === 'practice'));
  if (v) return [{ action: 'switch_controller_preset', args: { preset: v.name } }];
 }
 m = /^(?:save|keep|store) (?:this|it|these mappings|the mappings|my mappings) as (?:a |my |the )?(.+?)(?: preset)?$/.exec(t);
 if (m) return [{ action: 'create_preset_from_mappings', args: { name: `My ${m[1].replace(/^my /, '')}` } }];
 m = /^map (?:the )?faders? to (?:the )?loop (?:slot )?volumes?$/.exec(t);
 if (m) { const faders = dev.controls.filter(c => c.type === 'fader' && /^fader \d$/.test(c.role || '')).slice(0, 4); if (faders.length) return faders.map((c, i) => ({ action: 'map_control', args: { control: c.role, to: `loop:${i + 1}:volume` } })); }
 m = /^map (?:the )?(knob|fader|pad|encoder) (\d+) to (?:the )?(.+)$/.exec(t);
 if (m) { const hit = ws.find(m[3]); if (hit?.control) return [{ action: 'map_control', args: { control: `${m[1] === 'encoder' ? 'knob' : m[1]} ${m[2]}`, to: hit.control.el.id || ws.nameOf(hit) } }]; }
 m = /^(?:put )?(?:the )?knobs on (?:the )?(.+?)(?: page)?$/.exec(t) || /^(?:show|open) (?:the )?(.+?) page(?: on the (?:knobs|controller))?$/.exec(t);
 if (m && (dev.pages.some(p => norm(p.name).split(' ').includes(m[1]) || norm(p.name) === m[1]) || ws.find(m[1])?.widget)) return [{ action: 'set_controller_page', args: { page: m[1] } }];
 return null;
}
