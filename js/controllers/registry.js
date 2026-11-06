// What a controller's knobs and faders can move: every widget's and plug-in window's controls, read from the
// page through js/workspace.js (so a VST3, WAM or captured plug-in's parameters are there as soon as its window
// is), with short names for a controller's screen. A widget can register its own list, in the order its knobs
// should take them (registerParams); one that doesn't offers its sliders, menus and switches as they appear.
// Parameters are named by element id ("filterCutoff"), by "Widget › Control" ("Delay › Feedback"), or as
// osc:<n|sub|noise>:<level|detune> (the first oscillator an octave or more down, or the first noise one),
// loop:<n>:volume, and tempo. Pages of eight are built from these (js/controllers/runtime.js).
import * as ws from '../workspace.js';

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const SHORT = { masterVolume: 'Volume', filterCutoff: 'Cutoff', filterResonance: 'Resonance', filterType: 'Filter type', attack: 'Attack', decay: 'Decay', sustain: 'Sustain', release: 'Release', oscSlop: 'Slop', baseOctave: 'Octave', 'seq-bpm': 'Tempo' };
const LOG = new Set(['filterCutoff']); // moved through on a log scale, as the ear hears it
const registered = new Map(); // widget id → () => [refs]

export function registerParams(widgetId, refs) { registered.set(widgetId, typeof refs === 'function' ? refs : () => refs); }

// The built-in widgets' own order: what a sound designer reaches for first.
registerParams('oscillators-group', () => window.oscillatorBank?.list().flatMap((_, i) => [`levelOsc${i + 1}`, `detuneOsc${i + 1}`, `octaveOsc${i + 1}`, `waveformOsc${i + 1}`]) || []);
registerParams('envelope-group', ['attack', 'decay', 'sustain', 'release', 'enableAdsr']);
registerParams('filter-group', ['filterCutoff', 'filterResonance', 'filterType', 'enableFilter']);
registerParams('looper-module', ['loop:1:volume', 'loop:2:volume', 'loop:3:volume', 'loop:4:volume']);

// The oscillator a token means, as its number from 1.
function oscIndex(which) {
 const list = window.oscillatorBank?.list() || [];
 if (/^\d+$/.test(which)) return Number(which) <= list.length ? Number(which) : null;
 const i = which === 'sub' ? list.findIndex(o => o.octave < 0 && o.on !== false) : which === 'noise' ? list.findIndex(o => /white|pink/.test(o.waveform)) : -1;
 return i < 0 ? null : i + 1;
}

const kindOf = el => (el.tagName === 'SELECT' ? 'select' : el.type === 'checkbox' ? 'switch' : 'number');
function fromElement(el, name, full) {
 const kind = kindOf(el), min = Number(el.min || 0), max = Number(el.max || 1), log = LOG.has(el.id) && min > 0;
 const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
 const p = {
  id: el.id || full, name, full, el, kind, min, max, step: Number(el.step) || 0,
  get value() { return kind === 'switch' ? el.checked : kind === 'select' ? el.value : Number(el.value); },
  // The value from 0 to 1, as a knob holds it.
  get norm() {
   if (kind === 'switch') return el.checked ? 1 : 0;
   if (kind === 'select') return el.options.length > 1 ? el.selectedIndex / (el.options.length - 1) : 0;
   const v = Number(el.value);
   return max > min ? (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min)) : 0;
  },
  setNorm(x) {
   x = Math.max(0, Math.min(1, x));
   if (kind === 'switch') { const on = x >= 0.5; if (el.checked !== on) { el.checked = on; fire(); } return; }
   if (kind === 'select') { const i = Math.round(x * (el.options.length - 1)); if (el.selectedIndex !== i) { el.selectedIndex = i; fire(); } return; }
   let v = log ? min * (max / min) ** x : min + (max - min) * x;
   if (p.step) v = Math.round(v / p.step) * p.step;
   el.value = v; fire();
  },
  // What the screen shows: the option's text, on or off, or the number as the control rounds it.
  get text() {
   if (kind === 'switch') return el.checked ? 'On' : 'Off';
   if (kind === 'select') return clean(el.selectedOptions[0]?.textContent);
   const v = Number(el.value), digits = p.step >= 1 || Math.abs(v) >= 100 ? 0 : p.step >= 0.1 || Math.abs(v) >= 10 ? 1 : 2;
   return v.toFixed(digits);
  },
 };
 return p;
}
const tempoParam = () => ({
 id: 'tempo', name: 'Tempo', full: 'Tempo · BPM', kind: 'number', min: 30, max: 300, step: 0.1, el: document.getElementById('seq-bpm'),
 get value() { return window.synth.tempo; }, get norm() { return (window.synth.tempo - 30) / 270; },
 setNorm(x) { window.synth.tempo = Math.round((30 + 270 * Math.max(0, Math.min(1, x))) * 10) / 10; },
 get text() { return `${window.synth.tempo} BPM`; },
});

// The parameter a reference names, or null when it isn't on the page (a plug-in not loaded, no noise oscillator).
export function param(ref) {
 if (!ref) return null;
 if (ref === 'tempo') return tempoParam();
 let m = /^osc:(\d+|sub|noise):(level|detune|octave)$/.exec(ref);
 if (m) { const i = oscIndex(m[1]), el = i && document.getElementById(`${m[2]}Osc${i}`); return el ? fromElement(el, `Osc ${i}${m[1] === 'sub' ? ' sub' : m[1] === 'noise' ? ' noise' : ''} ${m[2]}`, `Oscillators › ${m[2]} ${i}`) : null; }
 m = /^loop:(\d):volume$/.exec(ref);
 if (m) { const el = document.getElementById(`loop-slot-volume-${Number(m[1]) - 1}`); return el ? fromElement(el, `Loop ${m[1]} vol`, `Loop recorder › Slot ${m[1]} volume`) : null; }
 const byId = document.getElementById(ref);
 if (byId && /^(INPUT|SELECT)$/.test(byId.tagName)) {
  const osc = /^(level|detune|octave|waveform)Osc(\d+)$/.exec(ref);
  const w = ws.widgets().find(x => x.el.contains(byId));
  return fromElement(byId, osc ? `Osc ${osc[2]} ${osc[1] === 'waveform' ? 'wave' : osc[1]}` : SHORT[ref] || clean(ws.labelOf(byId)).replace(/\s*\(.*\)$/, ''), `${w?.title || ''} › ${ws.labelOf(byId)}`);
 }
 const hit = ws.find(ref);
 if (hit?.control && ['number', 'select', 'checkbox'].includes(hit.control.kind)) return fromElement(hit.control.el, hit.control.label.replace(/\s*\(.*\)$/, ''), ws.nameOf(hit));
 return null;
}

// A widget's parameters, in its registered order or as its controls appear (the sliders first).
export function widgetParams(w) {
 if (!w) return [];
 const own = registered.get(w.id)?.();
 if (own) return own.map(param).filter(Boolean);
 const list = ws.controls(w).filter(c => ['number', 'select', 'checkbox'].includes(c.kind));
 list.sort((a, b) => (a.kind === 'number' ? 0 : 1) - (b.kind === 'number' ? 0 : 1));
 return list.map(c => fromElement(c.el, c.label.replace(/\s*\(.*\)$/, ''), `${w.title} › ${c.label}`));
}

// The widgets the main encoder steps through: every shown widget, then the open plug-in windows.
export const browsable = () => ws.widgets().filter(w => !w.menu && !w.hidden && (!w.plugin || !w.el.hidden));
// The plug-in window a Plugin page shows: the one picked with the main encoder, else the one last clicked,
// else the first open, else the first loaded.
let touched = null;
if (typeof document !== 'undefined') document.addEventListener('pointerdown', e => { const el = e.target.closest?.('.plugin-window'); if (el) touched = ws.widgets().find(w => w.el === el)?.id || touched; }, true);
export function pluginWindow(picked) {
 const wins = ws.widgets().filter(w => w.plugin);
 return wins.find(w => w.id === picked) || wins.find(w => w.id === touched) || wins.find(w => !w.el.hidden) || wins[0] || null;
}

// The selected automation lane's steps as parameters (lane 1 unless another is picked).
export function laneParams(index = 0) {
 const boxes = [...document.querySelectorAll('#automation .automation-lane')], box = boxes[Math.min(index, boxes.length - 1)];
 if (!box) return [];
 const label = clean(box.querySelector('label')?.textContent);
 return [...box.querySelectorAll('input[type=range]')].map((el, i) => fromElement(el, `Step ${i + 1}`, `${label} step ${i + 1}`)).map(p => Object.assign(p, { lane: label }));
}
