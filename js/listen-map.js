// What the microphone hears, steering the sound (js/listening.js frames):
// - Live mappings (Automation › From the microphone): a feature of what is heard (its pitch, loudness,
//   brightness, how many onsets a second, or the tempo it is tapped at) moves a control between two values, as
//   it happens: voice brightness opening the filter, loudness the volume. Each has its own on/off switch; switched
//   off (or when listening stops) the control goes back to where it was. They are kept.
// - Record a lane: the sequencer plays one bar while a feature is read at each of its 16 steps, and the steps
//   become that lane's points (filter cutoff from how loud you sing, tempo from how fast you tap).
// - Monitoring (Master & Settings): the input heard through Air and the plug-ins, and the input gain. Only with
//   headphones (on speakers the microphone would hear itself); a steady, loud, pure tone that keeps on is taken
//   for feedback and monitoring switches itself off.
import { listening } from './listening.js';
import { targets as LANES } from './automation.js';
import { pulseFromOnsets } from './timing.js';
import { el } from './plugin-ui.js';
import { read, save } from './storage.js';

const KEY = 'listen-mappings-v1';
// Each feature, 0 to 1 (null while there is nothing to read).
export const FEATURES = {
 loudness: { label: 'Loudness', read: s => (s.db === undefined ? null : Math.max(0, Math.min(1, (s.db - s.gate) / (-10 - s.gate)))) },
 pitch: { label: 'Pitch', read: s => (s.semis === null ? null : Math.max(0, Math.min(1, (s.semis - 48) / 36))) }, // C3 to C6
 brightness: { label: 'Brightness', read: s => (s.centroid > 0 && s.db > s.gate ? Math.max(0, Math.min(1, Math.log(s.centroid / 300) / Math.log(5000 / 300))) : null) },
 density: { label: 'Onsets a second', read: s => Math.min(1, s.rate / 8) },
 tempo: { label: 'Tapped tempo', read: s => (s.bpm ? (s.bpm - 30) / 270 : null) }, // 30-300 BPM, as the tempo target's own range
};
// What a mapping can move: the automation targets, the envelope and the first oscillator's level.
export const TARGETS = { ...Object.fromEntries(Object.entries(LANES).map(([id, t]) => [id, { label: t.label, min: t.min, max: t.max }])),
 attack: { label: 'Envelope attack · s', min: 0.001, max: 2 }, release: { label: 'Envelope release · s', min: 0.001, max: 5 }, levelOsc1: { label: 'Oscillator 1 level', min: 0, max: 1 } };
const LOG = new Set(['filterCutoff']); // moved through on a log scale, as the slider is
export const valueFor = (target, x, lo, hi) => (LOG.has(target) && lo > 0 ? lo * (hi / lo) ** x : lo + (hi - lo) * x);

// The features of the moment from the listener: level, pitch, brightness, onsets a second over the last two
// seconds, and the pulse of the onsets.
const onsets = [];
export function features(now = performance.now()) {
 const f = listening.last, s = { db: f?.db, gate: listening.settings.gateDb, semis: f?.pitch?.voiced ? f.pitch.semis : null, centroid: f?.centroid ?? 0 };
 while (onsets.length && now - onsets[0] > 8000) onsets.shift();
 s.rate = onsets.filter(t => now - t < 2000).length / 2;
 s.bpm = onsets.length >= 6 ? pulseFromOnsets(onsets)?.bpm ?? null : null;
 return Object.fromEntries(Object.entries(FEATURES).map(([k, v]) => [k, v.read(s)]));
}
listening.subscribe((type, e) => { if (type === 'note' && e.type === 'on') onsets.push(e.time); if (type === 'clap') onsets.push(e.time); });

const setControl = (target, v) => {
 if (target === 'tempo') { window.synth.tempo = Math.round(v * 10) / 10; return; }
 const input = document.getElementById(target);
 if (!input) return;
 input.value = v; input.dispatchEvent(new Event('input', { bubbles: true }));
};
const controlValue = target => (target === 'tempo' ? window.synth.tempo : Number(document.getElementById(target)?.value));

/* ---- Live mappings ---- */

export const mappings = {
 list: read(KEY, []).filter(m => FEATURES[m.feature] && TARGETS[m.target]),
 was: new Map(), // the control's value before a mapping took it
 persist() { save(KEY, this.list.map(({ id, feature, target, min, max, on }) => ({ id, feature, target, min, max, on }))); },
 add(m) { const t = TARGETS[m.target]; const n = { id: `map-${Date.now()}-${this.list.length}`, feature: 'brightness', target: 'filterCutoff', min: t?.min ?? 0, max: t?.max ?? 1, on: true, ...m }; this.list.push(n); this.persist(); return n; },
 remove(id) { const m = this.list.find(x => x.id === id); if (m) this.release(m); this.list = this.list.filter(x => x.id !== id); this.persist(); },
 set(id, changes) { const m = this.list.find(x => x.id === id); if (!m) return; if (changes.on === false || (changes.target && changes.target !== m.target)) this.release(m); Object.assign(m, changes); this.persist(); },
 // Puts a control back where it was before a mapping moved it.
 release(m) { if (this.was.has(m.id)) { setControl(m.target, this.was.get(m.id)); this.was.delete(m.id); } },
 releaseAll() { this.list.forEach(m => this.release(m)); },
 // Moves every mapped control to the features of now, smoothed (a tenth of the way per frame, about 50 ms).
 tick() {
  if (!listening.active) { this.releaseAll(); return; }
  const now = features();
  for (const m of this.list) {
   if (!m.on) continue;
   const x = now[m.feature];
   if (x === null || x === undefined) continue;
   if (!this.was.has(m.id)) this.was.set(m.id, controlValue(m.target));
   const want = valueFor(m.target, x, m.min, m.max), have = m.smooth ?? want;
   m.smooth = m.feature === 'tempo' ? want : have + (want - have) * 0.25;
   setControl(m.target, m.smooth);
  }
 },
};
let ticking = false;
listening.subscribe(type => {
 if (type === 'frame' && !ticking && mappings.list.some(m => m.on)) { ticking = true; requestAnimationFrame(() => { ticking = false; mappings.tick(); }); }
 if (type === 'state' && !listening.active) mappings.releaseAll();
});

/* ---- Recording a lane ---- */

// Plays the sequencer for one bar and writes the feature at each step into the target's lane (added if there is
// none), which is then switched on. Resolves to the 16 values.
export async function recordLane(sequencer, feature, target, { min = TARGETS[target].min, max = TARGETS[target].max } = {}) {
 if (!listening.active) throw new Error('Start listening first (🎙 Listen in the Listening widget).');
 if (!LANES[target]) throw new Error(`${target} has no automation lane`);
 if (sequencer.running) sequencer.stop();
 const values = Array(16).fill(null);
 const tempo = window.synth.tempo, stepMs = 60000 / tempo / 4;
 let started = null;
 const sample = () => {
  if (started === null) return;
  const step = Math.floor((performance.now() - started) / stepMs);
  if (step >= 0 && step < 16) { const x = features()[feature]; if (x !== null && x !== undefined) values[step] = values[step] === null ? x : Math.max(values[step], x); }
 };
 const timer = setInterval(sample, 10);
 await sequencer.start({ bars: 1, click: true, onStart: () => { started = performance.now(); } });
 await new Promise(r => setTimeout(r, Math.max(0, (started ?? performance.now()) + 16 * stepMs - performance.now())));
 clearInterval(timer);
 // Steps where nothing was heard take the step before (the first, the first heard).
 const first = values.find(v => v !== null) ?? 0;
 for (let i = 0; i < 16; i++) values[i] ??= i ? values[i - 1] : first;
 const points = values.map(x => Math.round(valueFor(target, x, min, max) * 1000) / 1000);
 const lane = () => [...document.querySelectorAll('#automation .automation-lane')].find(b => b.querySelector('label')?.textContent.trim() === LANES[target].label);
 if (!lane()) { const sel = document.getElementById('automation-target'); sel.value = target; sel.dispatchEvent(new Event('change')); document.getElementById('add-lane').click(); }
 const box = lane();
 points.forEach((v, i) => { const input = box.querySelector(`input[aria-label="${LANES[target].label} step ${i + 1} value"]`); if (input) { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); } });
 const on = box.querySelector('input[type=checkbox]'); if (!on.checked) on.click();
 return points;
}

/* ---- Monitoring ---- */

export const monitor = {
 on: false, node: null, guard: [],
 // Hear the input through Air and the plug-ins. Only with headphones.
 set(on) {
  if (on && !listening.settings.headphones) throw new Error('Only with headphones: on speakers the microphone would hear itself and howl. Tick I\'m wearing headphones in the Listening widget.');
  this.on = on; this.guard = []; this._wire();
  emitMonitor();
 },
 _wire() {
  const n = listening.nodes;
  if (this.node && (!this.on || this.node.context !== n?.ctx || this.from !== n?.gain)) { try { this.from?.disconnect(this.node); } catch { /* gone */ } this.node.disconnect(); this.node = null; }
  if (this.on && n && !this.node) { this.node = new GainNode(n.ctx, { gain: 1 }); n.gain.connect(this.node); this.node.connect(window.synth.fx.input); this.from = n.gain; }
 },
 // Feedback: loud (over -12 dB), pure (clarity over 0.95), one pitch within 15 cents, for most of a second.
 check(f) {
  if (!this.on) return;
  const g = this.guard;
  g.push({ t: f.t, loud: f.db > -12 && f.clarity > 0.95, semis: f.hz > 0 ? 69 + 12 * Math.log2(f.hz / 440) : null });
  while (g.length && f.t - g[0].t > 900) g.shift();
  const loud = g.filter(x => x.loud && x.semis !== null);
  if (g.length > 40 && loud.length >= g.length * 0.9 && Math.max(...loud.map(x => x.semis)) - Math.min(...loud.map(x => x.semis)) < 0.15) {
   this.on = false; this._wire(); this.tripped = true; emitMonitor('Feedback: the input kept howling, so monitoring is off. Use headphones, or turn the input gain down.');
  }
 },
};
const monitorListeners = new Set();
const emitMonitor = (why = '') => monitorListeners.forEach(fn => fn(monitor.on, why));
listening.subscribe((type, f) => {
 if (type === 'state') { if (!listening.settings.headphones && monitor.on) { monitor.on = false; emitMonitor('Monitoring is off: it needs headphones.'); } monitor._wire(); }
 if (type === 'frame' && f) monitor.check(f);
});

/* ---- The controls ---- */

const opts = (pairs, value) => { const s = el('select'); pairs.forEach(([v, t]) => s.append(el('option', { value: v, textContent: t }))); if (value !== undefined) s.value = value; return s; };

// Automation › From the microphone: the live mappings, and Record a lane.
export function mountMappings(root, sequencer) {
 const box = el('div', { className: 'listen-map' });
 const rows = el('div', { className: 'listen-map-rows' });
 const add = el('button', { type: 'button', id: 'listen-map-add', textContent: '+ Add mapping' });
 const feature = opts(Object.entries(FEATURES).map(([k, f]) => [k, f.label]), 'loudness'), lane = opts(Object.entries(LANES).map(([k, t]) => [k, t.label]), 'filterCutoff');
 feature.id = 'listen-lane-feature'; lane.id = 'listen-lane-target';
 feature.setAttribute('aria-label', 'Feature to record'); lane.setAttribute('aria-label', 'Lane to record into');
 const rec = el('button', { type: 'button', id: 'listen-lane-record', textContent: '● Record lane' }), status = el('span', { className: 'module-hint', role: 'status' });
 box.append(el('div', { className: 'sequence-toolbar' }, el('strong', { textContent: 'From the microphone' }), add),
  el('p', { className: 'module-hint', textContent: 'While Listening hears you, a feature of your voice or instrument moves a control: brightness opening the filter, loudness the volume. Each switches off on its own; the control then goes back.' }),
  rows,
  el('div', { className: 'sequence-toolbar' }, el('label', {}, 'Record ', feature), el('label', {}, 'into ', lane), rec, status));
 root.append(box);
 const render = () => {
  rows.replaceChildren(...mappings.list.map((m, i) => {
   const on = el('input', { type: 'checkbox', checked: m.on }), f = opts(Object.entries(FEATURES).map(([k, x]) => [k, x.label]), m.feature), t = opts(Object.entries(TARGETS).map(([k, x]) => [k, x.label]), m.target);
   const lo = el('input', { type: 'number', value: m.min, step: 'any' }), hi = el('input', { type: 'number', value: m.max, step: 'any' });
   on.setAttribute('aria-label', `Mapping ${i + 1} on`); f.setAttribute('aria-label', `Mapping ${i + 1} feature`); t.setAttribute('aria-label', `Mapping ${i + 1} target`); lo.setAttribute('aria-label', `Mapping ${i + 1} from`); hi.setAttribute('aria-label', `Mapping ${i + 1} to`);
   on.onchange = () => mappings.set(m.id, { on: on.checked });
   f.onchange = () => mappings.set(m.id, { feature: f.value });
   t.onchange = () => { const r = TARGETS[t.value]; mappings.set(m.id, { target: t.value, min: r.min, max: r.max }); render(); };
   lo.onchange = () => mappings.set(m.id, { min: Number(lo.value) });
   hi.onchange = () => mappings.set(m.id, { max: Number(hi.value) });
   const x = el('button', { type: 'button', textContent: '×', title: 'Remove this mapping', onclick: () => { mappings.remove(m.id); render(); } });
   return el('div', { className: 'sequence-toolbar listen-map-row' }, on, f, '→', t, el('label', {}, 'from ', lo), el('label', {}, 'to ', hi), x);
  }));
 };
 add.onclick = () => { mappings.add({ feature: 'brightness', target: 'filterCutoff', min: 300, max: 6000 }); render(); };
 rec.onclick = async () => {
  rec.disabled = true;
  try {
   if (!listening.active && !(await listening.start())) { status.textContent = listening.error; return; }
   status.textContent = `Recording ${FEATURES[feature.value].label.toLowerCase()} into ${LANES[lane.value].label} for one bar…`;
   const points = await recordLane(sequencer, feature.value, lane.value);
   status.textContent = `Recorded: ${LANES[lane.value].label} from ${Math.round(points[0] * 100) / 100} to ${Math.round(points[15] * 100) / 100}, lane on.`;
  } catch (err) { status.textContent = err.message; } finally { rec.disabled = false; }
 };
 render();
}

// Master & Settings: the input gain, and hearing the input through Air and the plug-ins.
export function mountMonitor(group) {
 const gain = el('input', { type: 'range', id: 'listen-input-gain', className: 'horizontal-slider', min: 0, max: 4, step: 0.05, value: listening.settings.inputGain });
 const out = el('output', { textContent: `${listening.settings.inputGain.toFixed(2)}×` });
 gain.oninput = () => { listening.set({ inputGain: Number(gain.value) }); out.textContent = `${Number(gain.value).toFixed(2)}×`; };
 const box = el('input', { type: 'checkbox', id: 'listen-monitor' }), note = el('span', { className: 'module-hint listen-monitor-note' });
 const label = el('label', { className: 'listen-check', title: 'Hear what the microphone hears, through Air and the plug-ins. Headphones only.' }, box, ' Hear the input through Air and the plug-ins');
 box.onchange = () => { try { monitor.set(box.checked); note.textContent = box.checked ? 'You hear the input through the effects.' : ''; } catch (err) { box.checked = false; note.textContent = err.message; } };
 const sync = () => { box.disabled = !listening.settings.headphones; label.classList.toggle('disabled', box.disabled); if (box.disabled && !box.checked) note.textContent = note.textContent || 'Needs headphones (Listening widget).'; };
 monitorListeners.add((on, why) => { box.checked = on; if (why) note.textContent = why; });
 listening.subscribe(type => { if (type === 'state') { sync(); if (Number(gain.value) !== listening.settings.inputGain) { gain.value = listening.settings.inputGain; out.textContent = `${listening.settings.inputGain.toFixed(2)}×`; } } });
 group.append(el('label', { className: 'listen-gain' }, el('span', {}, 'Input gain (Listening) ', out), gain), label, note);
 sync();
}
