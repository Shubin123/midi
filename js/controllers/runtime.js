// Controllers with presets (js/controllers/schema.json): when a port appears, the presets are matched to it (by
// its SysEx identity reply once SysEx is allowed, else by its name), and the best becomes the device's. A device
// is one controller, its main port and, if it has one, its DAW port. Its messages are read in the program it is
// in (found from what it sends when it changes), and each control does what the variation in use maps it to
// (js/controllers/actions.js): knobs and faders move parameters in pages of eight, absolute ones only once they
// reach the value (soft takeover, so nothing jumps), relative ones by steps; pads and buttons act on press, or
// on a hold or with Shift where the mapping says; keys play. What isn't mapped falls through to plain MIDI
// (js/controllers/midi.js), so the keys always play. Feedback (pad colours, the screen) is only sent while the
// preset is in use, at most every throttleMs and only what changed, and the controller is put back as it was
// (pads dark, screen clear, its program's exit message) when it is let go, unplugged, or the page closes.
// Choices (use the preset or not, variation, program, MIDI learn and remapping) are kept per device name.
import { midi } from './midi.js';
import { noteOn, cc as ccMessage } from './messages.js';
import { rank, variation, variationsFor, defaultProgram, indexProgram, decodeFor, programsSending, fill, learnedMessage, guessEncoding, heard, fit } from './preset.js';
import { validate } from './validate.js';
import { perform, recordLoop, seqRow } from './actions.js';
import { param, widgetParams, pluginWindow, laneParams } from './registry.js';
import { padColor, screenLines, rgbKey, GRADE_COLOR, COLORS } from './feedback.js';
import { targets as LANES } from '../automation.js';
import { timing } from '../timing-widget.js';
import { arp } from '../arpeggiator.js';
import { read, save } from '../storage.js';
import * as ws from '../workspace.js';

const PRESETS_URL = new URL('./presets/', import.meta.url);
export const USER_KEY = 'controller-presets-v1', CHOICES_KEY = 'controller-choices-v1';
const HOLD_MS = 500;
const listeners = new Set();
const emit = (type, detail) => listeners.forEach(fn => { try { fn(type, detail); } catch (err) { console.error(err); } });
const choices = () => read(CHOICES_KEY, {});
const seq = () => window.workspaceApi?.sequencer;
const base = name => String(name || '').replace(/\s*(midi|daw|mcu\/hui|mcu|hui|alv|din thru|port\s*\d*)\s*\d*$/i, '').trim().toLowerCase();

/* ---- A device ---- */

export class Device {
 constructor(hub, port, match) {
  Object.assign(this, { hub, port, dawPort: null, others: [], preset: match.preset, by: match.by });
  const saved = choices()[port.name] || {};
  this.overlay = { controls: [], learned: {}, mappings: {}, ...saved.overlay };
  this.use = saved.use ?? match.by !== 'generic'; // a generic preset is offered, not used, until chosen
  this.programId = this.preset.programs.some(g => g.id === saved.program) ? saved.program : defaultProgram(this.preset).id;
  this.programAuto = !saved.program;
  this.variationId = saved.variation && this.preset.variations.some(v => v.id === saved.variation) ? saved.variation : variationsFor(this.preset, this.programId)[0]?.id;
  this.pageIndex = 0; this.focus = null; this.plugin = null; this.lane = 0;
  this.shift = false; this.transpose = 0; this.row = null; this.stepPage = 0; this.browse = { list: saved.browse || 'widgets', index: 0 };
  this.recording = false; this.arpMode = saved.arp || 'auto';
  this.held = new Set(); this.pressed = new Map(); this.takeover = new Map(); this.lastValues = new Map();
  this.lights = new Map(); this.flashes = new Map(); this.transient = null; this.note = null;
  this.sent = new Map(); this.sentScreen = ''; this.queue = [];
  this.log = []; this.bank = null; this.learning = null; this.unknown = 0;
  this._arp = { times: [], on: false };
  this._index = null;
 }
 get name() { return this.preset.name; }
 get program() { return this.preset.programs.find(g => g.id === this.programId) || defaultProgram(this.preset); }
 get controls() { return [...this.preset.controls, ...this.overlay.controls]; }
 control(id) { return this.controls.find(c => c.id === id) || null; }
 variations() { return variationsFor(this.preset, this.programId); }
 get variation() {
  const v = variation(this.preset, this.variationId);
  return { ...v, mappings: { ...v.mappings, ...this.overlay.mappings[v.id] } };
 }
 mappingFor(id) { const a = this.variation.mappings[id]; return a && this.shift && a.shift ? a.shift : a || null; }
 index() { return (this._index ||= indexProgram(this.program, this.overlay.learned[this.programId])); }
 persist() {
  const all = choices();
  all[this.port.name] = { use: this.use, preset: this.preset.id, variation: this.variationId, program: this.programAuto ? null : this.programId, overlay: this.overlay, browse: this.browse.list, arp: this.arpMode };
  save(CHOICES_KEY, all);
 }
 changed() { this.persist(); emit('device', this); this.hub.markMapped(); }

 /* -- Pages -- */
 get pages() {
  const own = this.variation.pages;
  const w = this.focus && ws.widgetById(this.focus);
  return w ? [...own, { id: 'focus', name: w.title, from: 'focus' }] : own;
 }
 get page() { return this.pages[Math.min(this.pageIndex, this.pages.length - 1)] || null; }
 pageParams(page = this.page) {
  if (!page) return [];
  if (page.from === 'focus') return widgetParams(ws.widgetById(this.focus));
  if (page.from === 'plugin') return widgetParams(pluginWindow(this.plugin));
  if (page.from === 'widget') return widgetParams(ws.find(page.widget)?.widget);
  if (page.from === 'automation') return laneParams(this.lane);
  return (page.params || []).map(r => param(r));
 }
 // The parameter the knob in `slot` (from 1; Shift + a knob is usually slot 9 to 16) moves on this page, or null.
 slotParam(slot) { return this.pageParams()[slot - 1] || null; }
 setPage(which) {
  const n = this.pages.length;
  if (!n) return '';
  const i = typeof which === 'number' ? ((which % n) + n) % n : this.pages.findIndex(p => p.id === which);
  if (i < 0) throw new Error(`${this.name} has no page ${which} (it has ${this.pages.map(p => p.id).join(', ')})`);
  this.pageIndex = i; this.takeover.clear(); this.seed();
  this.flash('Page', this.page.name);
  this.changed();
  return `Page ${this.page.name}`;
 }
 focusWidget(id) { this.focus = id; const w = ws.widgetById(id); if (w?.plugin) this.plugin = id; this.pageIndex = this.pages.length - 1; this.takeover.clear(); this.seed(); this.changed(); }
 // An absolute encoder the device can be told the value of (feedback.encoders) starts from its parameter's
 // value when the page changes, so it moves on from there with no pick-up.
 seed() {
  const f = this.preset.feedback?.encoders;
  if (!f || !this.canShow || (f.programs && !f.programs.includes(this.programId))) return;
  for (const [id, index] of Object.entries(f.index)) {
   const a = this.mappingFor(id), p = a?.do === 'page' ? this.slotParam(a.slot) : a?.do === 'param' ? param(a.param) : null;
   if (!p) continue;
   this.queue = this.queue.filter(q => q.seed !== id); // only the latest value of each
   this.queue.push(Object.assign(fill(f.message, { index, value: Math.round(p.norm * 127) }), { seed: id }));
   this.takeover.set(`${id}|${p.full}`, { caught: true, last: 0 });
  }
 }

 /* -- Variations and programs -- */
 setVariation(id) {
  if (!this.preset.variations.some(v => v.id === id)) throw new Error(`${this.name} has no preset variation ${id}`);
  this.releaseNotes();
  this.variationId = id; this.pageIndex = 0; this.takeover.clear(); this.lights.clear(); this.sent.clear(); this.sentScreen = ''; this.seed();
  this.flash('Preset', this.variation.name);
  this.changed();
  return this.variation.name;
 }
 nextVariation(by = 1) { const list = this.variations(), i = list.findIndex(v => v.id === this.variationId); return this.setVariation(list[(((i + by) % list.length) + list.length) % list.length].id); }
 setProgram(id, auto = false) {
  const g = this.preset.programs.find(x => x.id === id);
  if (!g) throw new Error(`${this.name} has no program ${id}`);
  if (g.id === this.programId) { if (!auto) { this.programAuto = false; this.changed(); } return g.name; }
  this.sendAll(this.program.exit);
  this.programId = g.id; this.programAuto = auto; this._index = null; this.takeover.clear();
  if (!this.variations().some(v => v.id === this.variationId)) this.variationId = this.variations()[0]?.id ?? this.variationId;
  this.sendAll(g.enter); this.sent.clear(); this.sentScreen = ''; this.seed();
  emit('program', { device: this, program: g, auto });
  this.changed();
  return g.name;
 }
 setUse(on) {
  if (on === this.use) return;
  if (!on) this.letGo(); else { this.sendAll(this.program.enter); this.sent.clear(); this.sentScreen = ''; }
  this.use = on; this.changed();
 }

 /* -- Messages -- */
 handle(port, m, data, time) {
  if (port !== this.port) return true; // its DAW (MCU/HUI) or other port: nothing there plays as notes
  if (m.type === 'sysex') { this.sysex(data); return true; }
  if (!this.use) return false;
  let e = decodeFor(this.index(), m);
  if (!e && this.program.autolearn && !this.learning && (m.type === 'cc' || m.type === 'noteon')) e = this.autolearn(m);
  if (this.learning) return this.learn(m, e, time);
  if (!e) {
   // Another program's message: the device was switched (on the device itself); follow it.
   const could = programsSending(this.preset, m, this.overlay.learned).filter(g => g !== this.programId);
   if (could.length === 1 && (m.type === 'cc' || m.type === 'noteon')) { this.setProgram(could[0], true); e = decodeFor(this.index(), m); }
  }
  if (!e) { if (m.type === 'cc' || m.type === 'noteon') this.unknown++; return false; }
  e.time = time;
  const c = this.control(e.control);
  if (c?.bank && (e.kind === 'press' || e.kind === 'release')) { if (this.bank !== c.bank) { this.bank = c.bank; emit('bank', { device: this, bank: c.bank }); } }
  this.log.push({ control: e.control, kind: e.kind, value: e.value ?? e.delta ?? e.velocity, time }); if (this.log.length > 64) this.log.shift();
  emit('event', { device: this, e });
  const a = this.variation.mappings[e.control];
  if (!a) return e.kind === 'note' ? false : true; // known but unmapped: keys play plainly, the rest do nothing
  if (e.kind === 'press' || e.kind === 'release' || e.kind === 'toggle') return this.button(e, a);
  this.act(this.shift && a.shift ? a.shift : a, e);
  return true;
 }
 // SysEx from the device: which program or bank it is in (the preset's listen list), or for its hooks.
 sysex(data) {
  const h = heard(this.preset, data);
  if (h?.program) { const g = this.preset.programs.find(x => x.id === h.program); if (g && !(g.template && this.program.template)) this.setProgram(g.id, true); this.programRaw = h.raw; }
  if (h?.bank && h.bank !== this.bank) { this.bank = h.bank; emit('bank', { device: this, bank: h.bank }); }
  if (!h) this.hooks?.sysex?.(this.hub.hookApi(this), [...data]);
 }
 get hooks() { return this.preset.status === 'official' ? this.preset._hooks : null; }
 // A program whose controls take the first new CCs or notes heard, in order (Generic 8-knob).
 autolearn(m) {
  const learned = this.overlay.learned[this.programId] || {}, open = Object.entries(this.program.messages).find(([id, msg]) => msg.learn && !learned[id]);
  if (!open || (m.type === 'noteon' && this.control(open[0])?.type !== 'pad')) return null;
  const values = (this._autoValues ||= {})[`${m.number}`] ||= [];
  if (m.type === 'cc') { values.push(m.value); if (values.length < 3) return null; }
  this.overlay.learned[this.programId] = { ...learned, [open[0]]: learnedMessage(m, { relative: m.type === 'cc' ? guessEncoding(values) : null }) };
  this._index = null; this.changed();
  emit('learn', { device: this, learning: null, control: open[0], auto: true });
  return decodeFor(this.index(), m);
 }
 // Pads and buttons: at once, or (when the mapping has a hold) on release if short and as the hold if long.
 button(e, a) {
  const id = e.control;
  if (e.kind === 'press' && this.shift && a.shift) { this.act(a.shift, e); this.pressed.set(id, { done: true }); return true; }
  if (e.kind === 'press' || (e.kind === 'toggle' && e.on)) {
   this.hub.padHit(this, e);
   if (a.hold) { const p = { e, done: false }; p.timer = setTimeout(() => { p.done = true; this.act(a.hold, e); }, HOLD_MS); this.pressed.set(id, p); }
   else { this.pressed.set(id, { done: true }); this.act(a, e); }
   return true;
  }
  const p = this.pressed.get(id); this.pressed.delete(id);
  if (p && !p.done) { clearTimeout(p.timer); this.act(a, p.e); }
  if (!p || p.done || !a.hold) this.act(this.shift && a.shift ? a.shift : a, { ...e, kind: 'release' });
  return true;
 }
 act(a, e) {
  try {
   const text = perform(this, a, e);
   if (text) { if (!this.transient || this.transient.until < performance.now() || !/^(page|param)$/.test(a.do)) this.flash(this.control(e.control)?.label || e.control, text); emit('action', { device: this, control: e.control, action: a, text }); }
  } catch (err) { this.flash('!', err.message); emit('action', { device: this, control: e.control, action: a, text: err.message, error: true }); }
 }

 // A knob or fader on a parameter (a page's slot, or a fixed one). Absolute controls pick up: until the
 // control reaches the parameter's value (within 3%, or by passing it), it moves nothing, and the screen says
 // which way to turn. Relative ones step by 1/127 a click, faster when spun.
 moveParam(slot, e, takeover = 'pickup', ref = null) {
  const p = ref ? param(ref) : this.slotParam(slot);
  if (!p) { if (e.kind !== 'release') this.flash(slot ? `Knob ${slot}` : ref, 'Not mapped'); return ''; }
  const key = `${e.control}|${p.full}`;
  if (e.kind === 'value') {
   if (p.kind === 'number' && takeover !== 'jump') {
    const t = this.takeover.get(key) || { caught: false, last: null }, d = e.value - p.norm;
    if (t.caught && t.at !== undefined && Math.abs(p.norm - t.at) > 0.01) Object.assign(t, { caught: false, last: null }); // moved elsewhere since: pick it up again
    if (!t.caught && (Math.abs(d) < 0.03 || (t.last !== null && Math.sign(d) !== Math.sign(t.last)))) t.caught = true;
    t.last = d; this.takeover.set(key, t);
    if (!t.caught) { this.flash(p.name, `${d < 0 ? '▲ turn up' : '▼ turn down'} to ${p.text}`); emit('pickup', { device: this, control: e.control, param: p.full, d }); return ''; }
   }
   p.setNorm(e.value);
   const t = this.takeover.get(key); if (t) t.at = p.norm;
  } else if (e.kind === 'turn') {
   if (p.kind === 'number') p.setNorm(p.norm + (e.delta * (Math.abs(e.delta) > 3 ? 3 : 1)) / 127);
   else if (p.kind === 'select') { const k = this.takeover.get(key) || { acc: 0 }; k.acc += e.delta; if (Math.abs(k.acc) >= 3) { const n = p.el.options.length; p.el.selectedIndex = Math.max(0, Math.min(n - 1, p.el.selectedIndex + Math.sign(k.acc))); p.el.dispatchEvent(new Event('change', { bubbles: true })); k.acc = 0; } this.takeover.set(key, k); }
   else p.setNorm(e.delta > 0 ? 1 : 0);
  } else if (e.kind === 'press') p.setNorm(p.kind === 'switch' ? 1 - p.norm : e.velocity ?? 1);
  else return '';
  if (this.recording && seq()?.running && LANES[p.id]) this.writeLane(p.id, p.value);
  this.flash(p.name, p.text);
  return `${p.name} ${p.text}`;
 }

 // Record: a loop into the first empty slot (Record again stops it); while the sequencer plays, knob moves
 // are written into the automation lanes of what they move, at the step playing, until Record is pressed again
 // or the sequencer stops. A lane recorded into is switched on when the take ends.
 record() {
  if (this.recording) { this.endTake(); return 'Automation recorded'; }
  if (seq()?.running) { this.recording = true; this.take = new Set(); emit('device', this); return 'Recording knob moves into lanes'; }
  return recordLoop();
 }
 writeLane(target, value) {
  const label = LANES[target].label, box = () => [...document.querySelectorAll('#automation .automation-lane')].find(b => b.querySelector('label')?.textContent.trim() === label);
  if (!box()) { const sel = document.getElementById('automation-target'); sel.value = target; sel.dispatchEvent(new Event('change')); document.getElementById('add-lane').click(); }
  const b = box(), on = b?.querySelector('input[type=checkbox]');
  if (!b) return;
  if (on.checked) on.click(); // the lane would play over the knob while it is being recorded
  this.take.add(target);
  const step = seq().step, input = b.querySelector(`input[aria-label="${label} step ${step + 1}"]`);
  if (input) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
 }
 endTake() {
  this.recording = false;
  for (const target of this.take || []) { const b = [...document.querySelectorAll('#automation .automation-lane')].find(x => x.querySelector('label')?.textContent.trim() === LANES[target].label); const on = b?.querySelector('input[type=checkbox]'); if (on && !on.checked) on.click(); }
  this.take = null; emit('device', this);
 }

 // The controller's own arpeggiator plays notes at a machine's even spacing, one at a time: six notes in a row
 // within 2.5 ms of the same gap (no player is that steady) and its notes are the arpeggiator's until the gap
 // changes. Set to on or off, it is believed instead.
 hardwareArp(note, e) {
  if (this.arpMode !== 'auto') return this.arpMode === 'on';
  if (!e.on) return this._arp.on;
  const a = this._arp, t = e.time ?? performance.now();
  a.times.push(t); if (a.times.length > 7) a.times.shift();
  const gaps = a.times.slice(1).map((x, i) => x - a.times[i]), last = gaps.at(-1);
  if (a.on) { if (!(Math.abs(last - a.gap) < 8 || Math.abs(last - 2 * a.gap) < 8) || this.held.size > 1) { a.on = false; emit('arp', { device: this, on: false }); } }
  else if (gaps.length >= 5 && gaps.slice(-5).every(g => g > 40 && Math.abs(g - last) < 2.5)) { a.on = true; a.gap = last; emit('arp', { device: this, on: true, gap: last }); }
  return a.on;
 }

 /* -- MIDI learn -- */
 // learning: { param } (map a control to that parameter) or { action } (map it to that action), or { control }
 // (what this control sends, for a User program or an unknown device). The next control moved is it.
 startLearn(what) { this.learning = { ...what, values: [] }; emit('learn', { device: this, learning: this.learning }); }
 stopLearn() { this.learning = null; emit('learn', { device: this, learning: null }); }
 learn(m, e, time) {
  const L = this.learning;
  if (!(m.type === 'cc' || m.type === 'noteon' || m.type === 'bend' || m.type === 'pressure')) return m.type === 'noteoff';
  let id = e?.control;
  if (!id || L.control) {
   // A control the preset doesn't know (or one being taught): what it sends is learned. A CC is watched for a
   // few messages to tell a relative encoder from a knob.
   if (m.type === 'cc') { L.values.push(m.value); if (L.values.length < 4 && !L.timer) { L.timer = setTimeout(() => { L.timer = null; this.learn(m, null, time); }, 400); return true; } }
   clearTimeout(L.timer);
   id = L.control || `learned-${this.overlay.controls.length + 1}`;
   if (!this.control(id)) this.overlay.controls.push({ id, type: m.type === 'cc' ? 'knob' : m.type === 'noteon' ? 'pad' : 'strip', label: `${m.type === 'cc' ? 'Knob' : m.type === 'noteon' ? 'Pad' : 'Strip'} ${this.overlay.controls.length + 1}` });
   const msg = learnedMessage(m, { relative: m.type === 'cc' ? guessEncoding(L.values) : null });
   this.overlay.learned[this.programId] = { ...this.overlay.learned[this.programId], [id]: msg };
   this._index = null;
  }
  const action = L.param ? { do: 'param', param: L.param, takeover: 'pickup' } : L.action || null;
  if (action) this.overlay.mappings[this.variationId] = { ...this.overlay.mappings[this.variationId], [id]: action };
  this.learning = null;
  emit('learn', { device: this, learning: null, control: id, action });
  this.changed();
  return true;
 }
 // Maps a control to an action ({ do, ... }) in the variation in use; returns what it did before, for undo.
 map(id, action) {
  if (!this.control(id)) throw new Error(`${this.name} has no control ${id} (it has ${this.controls.map(c => c.id).join(', ')})`);
  const was = this.variation.mappings[id] || null;
  this.overlay.mappings[this.variationId] = { ...this.overlay.mappings[this.variationId], [id]: action || { do: 'none' } };
  this.takeover.clear(); this.changed();
  return was;
 }
 resetMappings() { this.overlay = { controls: [], learned: {}, mappings: {} }; this._index = null; this.takeover.clear(); this.changed(); }

 /* -- Feedback -- */
 flash(title, value, ms = 1500) { this.transient = { title: String(title), value: String(value), until: performance.now() + ms }; }
 // A hint on the screen for a while (or until replaced): the teacher's show_on_screen.
 show(lines, ms = 6000) { this.note = { lines: [].concat(lines).slice(0, 2).map(String), until: ms ? performance.now() + ms : 0 }; this.transient = null; }
 light(ids, rgb, { ms = 0, blink = false } = {}) { for (const id of ids) { if (rgb) this.lights.set(id, { rgb, until: ms ? performance.now() + ms : 0, blink }); else this.lights.delete(id); } }
 flashPad(id, rgb, ms = 160) { this.flashes.set(id, { rgb, until: performance.now() + ms }); }
 get canShow() { const f = this.preset.feedback; return !!f && this.use && (f.requires !== 'sysex' || midi.sysex) && !!this.port.output; }
 sendAll(list = []) { (list || []).forEach(t => this.queue.push(fill(t, {}))); }
 // What changed since the last frame, queued; the queue drains at most `per` messages a frame.
 render(now = performance.now(), per = 24) {
  const f = this.preset.feedback;
  if (this.canShow) {
   const ok = list => !list || list.includes(this.programId);
   if (f.pads && ok(f.pads.programs)) {
    const scale = f.pads.scale || 127;
    for (const [id, index] of Object.entries(f.pads.index)) {
     const rgb = padColor(this, id, now), key = rgbKey(rgb);
     if (this.sent.get(id) === key) continue;
     this.sent.set(id, key);
     this.queue = this.queue.filter(q => q.pad !== id);
     this.queue.push(Object.assign(fill(f.pads.message, { index, r: rgb[0] * scale, g: rgb[1] * scale, b: rgb[2] * scale }), { pad: id }));
    }
   }
   if (f.leds) for (const id of f.leds.controls) {
    const on = padColor(this, id, now).some(v => v > 0.1), key = on ? 'on' : 'off', m = this.program.messages[id];
    if (!m || this.sent.get(id) === key) continue;
    this.sent.set(id, key);
    const ch = Number.isInteger(m.channel) ? m.channel : 1, v = on ? f.leds.on ?? 127 : f.leds.off ?? 0;
    this.queue.push(m.note !== undefined ? noteOn(ch, m.note, v) : ccMessage(ch, m.cc, v));
   }
   if (f.screen && ok(f.screen.programs)) {
    const lines = screenLines(this, now).map((s, i) => String(s).slice(0, f.screen.widths[i] ?? f.screen.widths[0])), key = lines.join('\n');
    if (key !== this.sentScreen) { this.sentScreen = key; this.queue = this.queue.filter(q => !q.screen); this.queue.push(Object.assign(fill(f.screen.message, { line1: lines[0] || '', line2: lines[1] || '', line3: lines[2] || '', line4: lines[3] || '' }), { screen: true })); }
   }
  }
  if (this.hooks?.frame && this.canShow) for (const b of this.hooks.frame(this.hub.hookApi(this), now) || []) this.queue.push(b);
  for (let i = 0; i < per && this.queue.length; i++) midi.send(this.port, [...this.queue.shift()]);
 }
 // Lets go of every note this device holds.
 releaseNotes() {
  this.held.forEach(n => window.synth.midi.note(n, 0, false, null, 'midi')); this.held.clear();
  this.pressed.forEach(p => clearTimeout(p.timer)); this.pressed.clear();
  if (window.synth.midi.sustained) window.synth.midi.sustain(false);
  window.synth.midi.bend(0); window.synth.midi.vibrato(0);
  if (arp.on) arp._clear();
  if (this.recording) this.endTake();
 }
 // The controller as it was: notes off, pads dark, the screen clear, the program's exit message.
 letGo({ unplugged = false } = {}) {
  this.releaseNotes();
  if (unplugged) return;
  const f = this.preset.feedback;
  if (this.canShow) {
   this.queue = [];
   if (f.pads) for (const index of Object.values(f.pads.index)) this.queue.push(fill(f.pads.message, { index, r: 0, g: 0, b: 0 }));
   if (f.screen) this.queue.push(fill(f.screen.message, { line1: '', line2: '', line3: '', line4: '' }));
  }
  this.sendAll(this.program.exit);
  this.flush();
  this.sent.clear(); this.sentScreen = '';
 }
 flush() { while (this.queue.length) midi.send(this.port, [...this.queue.shift()]); }
 seqRow() { return seqRow(this); }
 // What the teacher and read_controller_state read.
 summary() {
  const v = this.variation, knobs = this.controls.filter(c => /^(encoder|knob)$/.test(c.type) && v.mappings[c.id]?.do === 'page');
  return {
   device: this.port.name, preset: this.preset.id, name: this.name, using: this.use, status: this.preset.status, verified: this.preset.verified,
   program: this.program.name, programDetected: this.programAuto, variation: v.name, variationId: v.id, variations: this.variations().map(x => x.name),
   page: this.page?.name || null, pages: this.pages.map(p => p.name), bank: this.bank, shift: this.shift, recordingAutomation: this.recording,
   knobs: knobs.map(c => `${c.label}: ${this.slotParam(v.mappings[c.id].slot)?.name || 'nothing'}`),
   mappings: Object.fromEntries(this.controls.filter(c => v.mappings[c.id]).map(c => [c.label, describe(this, v.mappings[c.id])])),
   feedback: this.canShow ? 'on' : this.preset.feedback ? (midi.sysex ? 'off' : 'off: SysEx not allowed') : 'none',
  };
 }
}

// A mapping in words: "loop slot 1", "page knob 5 (Cutoff)".
export function describe(dev, a) {
 if (!a) return 'nothing';
 const p = a.do === 'param' ? param(a.param) : a.do === 'page' ? dev.slotParam(a.slot) : null;
 const words = { notes: 'plays notes', bend: 'pitch bend', mod: `mod (${a.to || midi.settings.mod})`, sustain: 'sustain', hold: 'hold / latch', page: `knob ${a.slot} of the page${p ? ` (${p.name})` : ''}`, param: `${p?.name || a.param}`,
  'page-next': 'next page', 'page-prev': 'previous page', 'set-page': `page ${a.page}`, browse: 'browse', confirm: 'select', tempo: 'tempo', loop: `loop slot ${a.slot}`, metronome: 'metronome on/off', tap: 'tap tempo', record: 'record',
  panic: 'PANIC', step: `sequencer step ${a.index}`, 'step-page': 'steps 1-8 / 9-16', drum: `drum ${a.note ?? a.index}`, note: `note ${a.note}`, play: 'play', stop: 'stop', 'loop-toggle': 'loops play/stop', arp: 'arpeggiator', variation: 'next preset', octave: `octave ${a.by > 0 ? 'up' : 'down'}`, shift: 'shift', 'lesson-pad': 'lesson pad', none: 'nothing' }[a.do] || a.do;
 return `${words}${a.hold ? `; held: ${describe(dev, a.hold)}` : ''}${a.shift ? `; with Shift: ${describe(dev, a.shift)}` : ''}`;
}

/* ---- Every device ---- */

export const controllers = {
 presets: [], problems: [], devices: [], ready: null, schema: null,
 teacher: null, // { lessons(), start(id) }, set by the teacher (js/teacher-bridge.js)
 arp,
 chord: () => '', // the chord held, from the teacher's analyser
 subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
 preset(id) { return this.presets.find(p => p.id === id) || null; },
 device(ref) { return this.devices.find(d => d.port.id === ref || d.port.name === ref || d.preset.id === ref || d.name === ref) || (ref === undefined || ref === null ? this.devices.find(d => d.use) || this.devices[0] || null : null); },
 get active() { return this.devices.filter(d => d.use); },

 // The bundled presets (presets/index.json lists them) and the user's, each checked against the schema; one
 // that fails is left out, with its problems in `problems`.
 async load() {
  this.schema = await (await fetch(new URL('../schema.json', PRESETS_URL))).json();
  const index = await (await fetch(new URL('index.json', PRESETS_URL))).json();
  const bundled = await Promise.all(index.presets.map(async path => {
   try { const p = await (await fetch(new URL(path, PRESETS_URL))).json(); return this.accept(p, path); }
   catch (err) { this.problems.push({ id: path, problems: [err.message] }); return null; }
  }));
  this.presets = bundled.filter(Boolean);
  for (const p of read(USER_KEY, [])) this.accept({ ...p, status: 'user' }, 'user');
  await Promise.all(this.presets.filter(p => p.hooks && p.status === 'official').map(p => this.loadHooks(p)));
  emit('presets', this.presets);
 },
 accept(p, from) {
  const problems = validate(p, this.schema);
  if (problems.length) { this.problems.push({ id: p?.id || from, problems }); return null; }
  this.presets = this.presets.filter(x => x.id !== p.id).concat(from === 'user' ? [p] : []);
  if (from === 'user') emit('presets', this.presets);
  return p;
 },
 // A preset's hooks (official presets only): a module beside it, given a limited API (send to the device it
 // matched, read its state), never the page.
 async loadHooks(p) {
  try {
   const mod = await import(new URL(`${p.id.split('/')[0]}/${p.hooks}`, PRESETS_URL));
   p._hooks = mod.default || mod;
  } catch (err) { this.problems.push({ id: p.id, problems: [`hooks: ${err.message}`] }); }
 },
 hookApi(dev) { return Object.freeze({ send: bytes => midi.send(dev.port, bytes), state: () => dev.summary(), program: () => dev.programId }); },

 async start() {
  this.ready ||= (async () => {
   await this.load();
   midi.claim((port, m, data, time) => this.devices.find(d => d.port === port || d.others.includes(port))?.handle(port, m, data, time) || (this.waiting || []).includes(port));
   midi.subscribe((type, d) => {
    if (type === 'connect') this.attach(d);
    if (type === 'disconnect') this.detach(d);
    if (type === 'identity') this.rematch(d.port);
    if (type === 'state' && midi.sysex) this.devices.forEach(dev => { dev.sent.clear(); dev.sentScreen = ''; this.ask(dev); midi.identify(dev.port).then(id => id && this.rematch(dev.port)); });
   });
   midi.ports.forEach(p => this.attach(p));
   setInterval(() => this.frame(), 40);
   window.addEventListener('pagehide', () => this.devices.forEach(d => d.use && d.letGo()));
   timing.subscribe((type, o) => { if (type === 'note') this.timed(o); });
   window.addEventListener('synth:beat-clock', ({ detail }) => { if (detail.source === 'sequencer' && !detail.running) this.devices.forEach(d => { if (d.recording) d.endTake(); }); });
  })();
  return this.ready;
 },
 // A new port: the DAW port of a device already here, or a device of its own with the best preset.
 attach(port) {
  if (this.devices.some(d => d.port === port || d.others.includes(port))) return;
  const ranked = rank(this.presets, { name: port.name, identity: port.identity });
  // A device's other port (its DAW port, its Analog Lab port): kept with it, its messages kept from playing.
  const other = ranked.find(r => r.role === 'daw' || r.role === 'ignore');
  if (other) {
   const owner = this.devices.find(d => d.preset === other.preset && base(d.port.name) === base(port.name));
   if (owner) { owner.others.push(port); if (other.role === 'daw') owner.dawPort = port; emit('device', owner); }
   else (this.waiting ||= []).push(port);
   return;
  }
  const best = ranked[0];
  if (!best) return;
  const dev = new Device(this, port, best);
  const saved = choices()[port.name];
  if (saved?.preset && saved.preset !== dev.preset.id && this.preset(saved.preset)) { dev.preset = this.preset(saved.preset); dev.programId = defaultProgram(dev.preset).id; dev.variationId = saved.variation || variationsFor(dev.preset, dev.programId)[0].id; }
  this.devices.push(dev);
  for (const w of (this.waiting || []).filter(x => base(x.name) === base(port.name) && fit(dev.preset, { name: x.name }).score)) { dev.others.push(w); if (fit(dev.preset, { name: w.name }).role === 'daw') dev.dawPort = w; }
  this.waiting = (this.waiting || []).filter(x => !dev.others.includes(x));
  if (dev.use) dev.sendAll(dev.program.enter);
  emit('devices', this.devices);
  this.markMapped();
  this.ask(dev);
  midi.identify(port).then(id => { if (id) this.rematch(port); });
 },
 // Asks the device which program and bank it is in (its replies arrive as SysEx, read by sysex()).
 ask(dev) { if (midi.sysex) (dev.preset.queries || []).forEach(q => midi.send(dev.port, fill(q, {}))); },
 // The device's identity reply arrived: a preset that knows it by identity beats one that matched its name.
 rematch(port) {
  const dev = this.devices.find(d => d.port === port);
  const best = rank(this.presets, { name: port.name, identity: port.identity })[0];
  if (!best) return;
  if (!dev) { this.attach(port); return; }
  dev.firmware = port.identity?.firmware;
  if (best.preset !== dev.preset && best.by === 'identity' && !choices()[port.name]?.preset) this.choosePreset(dev, best.preset.id);
  else emit('device', dev);
 },
 choosePreset(dev, id) {
  const p = this.preset(id);
  if (!p) throw new Error(`there is no controller preset ${id}`);
  dev.letGo();
  const fresh = new Device(this, dev.port, { preset: p, by: 'chosen' });
  fresh.dawPort = dev.dawPort; fresh.others = dev.others; fresh.use = true; fresh.overlay = { controls: [], learned: {}, mappings: {} };
  this.devices[this.devices.indexOf(dev)] = fresh;
  fresh.persist(); fresh.sendAll(fresh.program.enter); this.ask(fresh);
  emit('devices', this.devices); this.markMapped();
  return fresh;
 },
 // Unplugged (or asleep): its notes stop at once; nothing is sent to a port that has gone.
 detach(port) {
  const dev = this.devices.find(d => d.port === port);
  if (dev) { dev.letGo({ unplugged: true }); this.devices = this.devices.filter(d => d !== dev); emit('devices', this.devices); this.markMapped(); return; }
  const owner = this.devices.find(d => d.others.includes(port));
  if (owner) { owner.others = owner.others.filter(x => x !== port); if (owner.dawPort === port) owner.dawPort = null; emit('device', owner); }
  this.waiting = (this.waiting || []).filter(x => x !== port);
 },
 // Feedback at most every throttleMs (40 by default) a device, twenty messages at a time (500 a second).
 frame() { const now = performance.now(); for (const d of this.devices) if (d.use && now - (d.rendered || 0) >= (d.preset.feedback?.throttleMs ?? 40) - 5) { d.rendered = now; d.render(now, 20); } },

 // A pad press is remembered for lessons and flashed by its timing when the beat clock grades it.
 padHits: [],
 padHit(dev, e) { this.padHits.push({ device: dev, control: e.control, time: e.time ?? performance.now(), velocity: e.velocity }); if (this.padHits.length > 64) this.padHits.shift(); },
 timed(onset) {
  if (!onset.grade) return;
  const hit = [...this.padHits].reverse().find(h => !h.grade && Math.abs(h.time - onset.time) < 30);
  if (!hit) return;
  hit.grade = onset.grade;
  // Pads that play (drums, notes, an exercise's) flash how well they were timed; a loop or transport pad doesn't.
  if (/^(drum|note|lesson-pad)$/.test(hit.device.mappingFor(hit.control)?.do || '')) hit.device.flashPad(hit.control, GRADE_COLOR[onset.grade], 220);
 },

 // The on-screen controls a hardware control moves now get a badge with its name (K5, F2), so it is clear
 // which are mapped.
 markMapped() {
  clearTimeout(this._markTimer);
  this._markTimer = setTimeout(() => {
   document.querySelectorAll('[data-hw]').forEach(el => { el.removeAttribute('data-hw'); el.classList.remove('hw-mapped'); });
   for (const d of this.active) {
    const v = d.variation;
    for (const c of d.controls) {
     const a = v.mappings[c.id], p = a?.do === 'page' ? d.slotParam(a.slot) : a?.do === 'param' ? param(a.param) : null;
     const el = p?.el?.closest?.('label, .plugin-param') || p?.el;
     if (el) { el.classList.add('hw-mapped'); el.dataset.hw = [el.dataset.hw, shortName(c)].filter(Boolean).join(' '); }
    }
   }
  }, 30);
 },

 /* -- User presets -- */
 userPresets() { return this.presets.filter(p => p.status === 'user'); },
 // A preset of the device as it is now: its own preset with what was learned and remapped written in.
 presetFrom(dev, name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
  const p = JSON.parse(JSON.stringify(dev.preset));
  delete p._hooks; delete p.hooks;
  Object.assign(p, { id: `user/${slug}`, name, status: 'user', verified: 'unverified', author: 'you', version: '1.0.0', generic: false, description: `Made from ${dev.preset.name} in this browser.` });
  p.detect = { ports: [{ name: `^${dev.port.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, role: 'main' }] };
  p.controls = [...p.controls, ...dev.overlay.controls];
  p.programs = p.programs.map(g => ({ ...g, messages: { ...g.messages, ...dev.overlay.learned[g.id] } }));
  p.variations = p.variations.map(v => ({ ...v, mappings: { ...v.mappings, ...dev.overlay.mappings[v.id] } }));
  return p;
 },
 savePreset(p, { overwrite = false } = {}) {
  const list = read(USER_KEY, []);
  if (!overwrite && list.some(x => x.id === p.id)) throw new Error(`there is already a preset called ${p.name}`);
  const problems = validate(p, this.schema);
  if (problems.length) throw new Error(`the preset isn't valid: ${problems.slice(0, 3).join('; ')}`);
  save(USER_KEY, [...list.filter(x => x.id !== p.id), p]);
  this.accept(p, 'user');
  return p;
 },
 deletePreset(id) {
  const list = read(USER_KEY, []), p = list.find(x => x.id === id);
  if (!p) throw new Error(`there is no user preset ${id}`);
  save(USER_KEY, list.filter(x => x.id !== id));
  this.presets = this.presets.filter(x => x.id !== id);
  emit('presets', this.presets);
  return p;
 },
 // A preset from a file: the JSON is checked; a preset with hooks keeps them out (community presets are JSON
 // only).
 importPreset(text, { overwrite = false } = {}) {
  let p;
  try { p = JSON.parse(text); } catch (err) { throw new Error(`that isn't a preset file (${err.message})`); }
  if (p.hooks) { delete p.hooks; p.description = `${p.description || ''} (Its script was left out: presets from files are JSON only.)`.trim(); }
  if (p.status === 'official') p.status = 'community';
  if (!/^user\//.test(p.id || '')) p.id = `user/${String(p.id || p.name || 'imported').split('/').pop()}`;
  return this.savePreset(p, { overwrite });
 },
 exportPreset(p) { const copy = { ...p }; delete copy._hooks; return JSON.stringify(copy, null, 1); },
};
export const shortName = c => (c.role ? c.role.replace(/^knob /, 'K').replace(/^fader /, 'F').replace(/^pad /, 'P').replace(/^encoder /, 'E') : c.label);
