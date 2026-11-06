// The oscillator bank: every note layers any number of oscillators, each with its own waveform, octave,
// detune, level, start delay and pulse width. It replaces the fixed Oscillator 1, Oscillator 2 and Sub
// Oscillator widgets: a sub oscillator is one an octave or two down, and noise is a waveform. buildVoice()
// is the one place a note's sources are made, so the synth (js/synth.js) and the waveform tests
// (tests/waveforms.html) render through the same code.
import { read, save } from './storage.js';

export const WAVEFORMS = { sine: 'Sine', square: 'Square', sawtooth: 'Sawtooth', triangle: 'Triangle', pulse: 'Pulse', white: 'White noise', pink: 'Pink noise' };
export const isNoise = waveform => waveform === 'white' || waveform === 'pink';
export const MAX_OSCILLATORS = 8;
// [min, max] of each setting; octaves are whole steps.
export const RANGES = { octave: [-2, 2], detune: [-100, 100], level: [0, 1], delay: [0, 50], pulseWidth: [0.01, 0.99] };
export const DEFAULTS = { waveform: 'sawtooth', octave: 0, detune: 0, level: 0.7, delay: 0, pulseWidth: 0.5, on: true };
// A new session starts with the sound the fixed oscillators made: two sawtooths and a square two octaves down.
export const DEFAULT_STACK = [{ ...DEFAULTS }, { ...DEFAULTS }, { ...DEFAULTS, waveform: 'square', octave: -2, level: 0.5 }];

let nextId = 1;
const clamp = (v, [lo, hi], fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback);
// An oscillator with every setting present and in range, and an id that live changes can find it by.
export function normalize(o = {}) {
 return {
  id: o.id || `osc-${nextId++}`,
  waveform: o.waveform in WAVEFORMS ? o.waveform : DEFAULTS.waveform,
  octave: Math.round(clamp(o.octave, RANGES.octave, DEFAULTS.octave)),
  detune: clamp(o.detune, RANGES.detune, DEFAULTS.detune),
  level: clamp(o.level, RANGES.level, DEFAULTS.level),
  delay: clamp(o.delay, RANGES.delay, DEFAULTS.delay),
  pulseWidth: clamp(o.pulseWidth, RANGES.pulseWidth, DEFAULTS.pulseWidth),
  on: o.on !== false,
 };
}

// A pulse wave from its Fourier series, high for `width` of each cycle and centred on zero, two units from low
// to high (at width 0.5, a ±1 square, as loud as before). It is band-limited at every width. (It used to be a sawtooth through a hard step, which assumed the sawtooth spans ±1. Web
// Audio's spans ±0.945, so the width came out wrong and reversed, and widths near the ends were mostly DC,
// with no tone at all at 0.01 and 0.99.) Waves are kept per context and width.
const pulseWaves = new WeakMap();
export function pulseWave(ctx, width) {
 let cache = pulseWaves.get(ctx);
 if (!cache) pulseWaves.set(ctx, (cache = new Map()));
 const d = Math.round(width * 1000) / 1000;
 if (!cache.has(d)) {
  const N = 2048, real = new Float32Array(N), imag = new Float32Array(N);
  for (let n = 1; n < N; n++) { real[n] = (2 / (n * Math.PI)) * Math.sin(2 * Math.PI * n * d); imag[n] = (4 / (n * Math.PI)) * Math.sin(Math.PI * n * d) ** 2; }
  cache.set(d, new PeriodicWave(ctx, { real, imag, disableNormalization: true }));
 }
 return cache.get(d);
}
// Two seconds of white noise, looped by every noise oscillator. `random` is injectable so tests are repeatable.
export function noiseBuffer(ctx, random = Math.random) {
 const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), data = buffer.getChannelData(0);
 for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1;
 return buffer;
}

// One note's sources, started at `when` and mixed into `out`. `frequency` is the note's pitch before each
// oscillator's octave and detune; `slop` (0-0.1) adds up to slop × 100 cents of random detune per oscillator,
// like analogue drift. `taps[i]`, when given, also receives oscillator i alone (for the oscilloscope).
// Returns one layer per sounding oscillator: { id, source, gain, pulse, nodes }.
export function buildVoice(ctx, oscillators, { frequency, when = ctx.currentTime, slop = 0, random = Math.random, noise = null, out, taps = [] }) {
 const layers = [];
 oscillators.forEach((o, i) => {
  if (!o.on) return;
  let source, last;
  const nodes = [], pulse = o.waveform === 'pulse';
  if (isNoise(o.waveform)) {
   if (!noise) return;
   source = last = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
   if (o.waveform === 'pink') {
    const f = new BiquadFilterNode(ctx, { type: 'lowpass' });
    f.frequency.setValueAtTime(1500, when); f.Q.setValueAtTime(0.707, when); // as scheduled values, as before
    last = last.connect(f); nodes.push(f);
   }
  } else {
   const cents = o.detune + (random() * 2 - 1) * slop * 100, hz = frequency * 2 ** o.octave * 2 ** (cents / 1200);
   source = last = pulse ? new OscillatorNode(ctx, { periodicWave: pulseWave(ctx, o.pulseWidth), frequency: hz }) : new OscillatorNode(ctx, { type: o.waveform, frequency: hz });
  }
  const gain = new GainNode(ctx, { gain: o.level });
  last.connect(gain).connect(out);
  if (taps[i]) gain.connect(taps[i]);
  source.start(when + o.delay / 1000);
  nodes.push(source, gain);
  layers.push({ id: o.id, source, gain, pulse, nodes });
 });
 return layers;
}

/* ---- The widget ---- */

const el = (tag, { ariaLabel, ...props } = {}, ...children) => { const e = Object.assign(document.createElement(tag), props); if (ariaLabel) e.setAttribute('aria-label', ariaLabel); e.append(...children); return e; };
const OCTAVES = [-2, -1, 0, 1, 2];

// Fills `root` (the Oscillators widget) with a row per oscillator and keeps the list saved. Each row's
// controls are numbered by position (waveformOsc1, detuneOsc1, ...), so automation lanes and the teacher's
// lessons name the first oscillator as they always have. Changes are announced on window: 'synth:oscillator'
// ({ id, level } or { id, pulseWidth }) for notes already sounding, 'synth:oscillators' when one is added or
// removed. The oscilloscope's source menu lists every oscillator.
export function mountBank(root, { key = 'synth-oscillators-v1' } = {}) {
 const saved = read(key, null);
 let list = (Array.isArray(saved) && saved.length ? saved : DEFAULT_STACK).slice(0, MAX_OSCILLATORS).map(o => normalize({ ...o, id: null }));
 const rows = el('div', { className: 'osc-bank' });
 const add = el('button', { type: 'button', id: 'addOscillator', className: 'std-button osc-add', textContent: '+ Add oscillator' });
 const reset = el('button', { type: 'button', className: 'std-button osc-reset', textContent: 'Reset', title: 'Back to two sawtooths and a square two octaves down' });
 root.querySelector('.control-title').after(rows, el('div', { className: 'osc-actions' }, add, reset));
 const persist = () => save(key, list.map(({ id, ...o }) => o));
 const announce = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));

 // The oscilloscope's sources: the master output, then each oscillator on its own, then what the Listening
 // widget hears (js/listening.js).
 const syncScope = () => {
  const select = document.getElementById('visualizerSourceSelect');
  if (!select) return;
  const was = select.value;
  select.replaceChildren(el('option', { value: 'master', textContent: 'Master Output' }), ...list.map((_, i) => el('option', { value: `osc${i + 1}`, textContent: `Oscillator ${i + 1}` })), el('option', { value: 'input', textContent: 'Input (Listening)' }));
  select.value = [...select.options].some(o => o.value === was) ? was : 'master';
 };

 const slider = (n, field, label, step) => {
  const [min, max] = RANGES[field];
  return el('input', { type: 'range', id: `${field}Osc${n}`, className: 'horizontal-slider', min, max, step, value: list[n - 1][field], ariaLabel: `Oscillator ${n} ${label}` });
 };
 const row = (o, i) => {
  const n = i + 1;
  const waveform = el('select', { id: `waveformOsc${n}`, ariaLabel: `Oscillator ${n} waveform` }, ...Object.entries(WAVEFORMS).map(([value, text]) => el('option', { value, textContent: text })));
  waveform.value = o.waveform;
  const octave = el('select', { id: `octaveOsc${n}`, ariaLabel: `Oscillator ${n} octave` }, ...OCTAVES.map(v => el('option', { value: v, textContent: v > 0 ? `+${v}` : String(v) })));
  octave.value = o.octave;
  const on = el('input', { type: 'checkbox', id: `enableOsc${n}`, checked: o.on, ariaLabel: `Oscillator ${n} on` });
  const remove = el('button', { type: 'button', className: 'osc-remove', textContent: '×', title: `Remove oscillator ${n}`, ariaLabel: `Remove oscillator ${n}`, disabled: list.length === 1 });
  const pitch = [el('label', {}, 'Octave ', octave), el('label', {}, 'Detune (cents) ', slider(n, 'detune', 'detune', 1))];
  const width = el('label', {}, 'Pulse width ', slider(n, 'pulseWidth', 'pulse width', 0.01));
  const shape = () => { pitch.forEach(l => { l.hidden = isNoise(o.waveform); }); width.hidden = o.waveform !== 'pulse'; };
  const box = el('fieldset', { className: 'osc-row' },
   el('legend', {}, el('span', { textContent: `Oscillator ${n}` }), el('label', { className: 'osc-on' }, on, 'On'), remove),
   el('label', {}, 'Waveform ', waveform), ...pitch,
   el('label', {}, 'Level ', slider(n, 'level', 'level', 0.01)),
   el('label', {}, 'Delay (ms) ', slider(n, 'delay', 'start delay', 0.1)), width);
  shape();
  box.addEventListener('input', e => {
   const field = e.target.id === `enableOsc${n}` ? 'on' : e.target.id.replace(/Osc\d+$/, '');
   if (!(field in DEFAULTS)) return;
   Object.assign(o, normalize({ ...o, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
   if (field === 'waveform') shape();
   if (field === 'level' || field === 'pulseWidth') announce('synth:oscillator', { id: o.id, [field]: o[field] });
   persist();
  });
  // Code that changes a select or checkbox may announce it with 'change' alone; handling it twice is harmless.
  box.addEventListener('change', e => { if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') e.target.dispatchEvent(new Event('input', { bubbles: true })); });
  remove.onclick = () => bank.remove(o.id);
  return box;
 };
 const render = () => {
  rows.replaceChildren(...list.map(row));
  add.disabled = list.length >= MAX_OSCILLATORS;
  add.title = add.disabled ? `Up to ${MAX_OSCILLATORS} oscillators` : 'Layer another oscillator in every note';
  syncScope();
 };
 add.onclick = () => bank.add();

 const bank = {
  // A copy of the current oscillators, for one note (the looper keeps it with the notes it records).
  list: () => list.map(o => ({ ...o })),
  add(o = {}) {
   if (list.length >= MAX_OSCILLATORS) return null;
   const added = normalize({ ...DEFAULTS, ...o, id: null });
   list.push(added); render(); persist(); announce('synth:oscillators', { count: list.length });
   return added.id;
  },
  remove(id) {
   if (list.length === 1 || !list.some(o => o.id === id)) return false;
   list = list.filter(o => o.id !== id); render(); persist(); announce('synth:oscillators', { count: list.length });
   return true;
  },
  // Replaces the whole stack (tests, and the Reset button).
  set(next) { list = (next.length ? next : DEFAULT_STACK).slice(0, MAX_OSCILLATORS).map(o => normalize({ ...o, id: null })); render(); persist(); announce('synth:oscillators', { count: list.length }); },
  reset() { bank.set(DEFAULT_STACK); },
  buildVoice, pulseWave, noiseBuffer,
 };
 reset.onclick = () => bank.reset();
 render();
 return bank;
}
