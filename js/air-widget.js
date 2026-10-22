import createAir from '../plugins/air/index.js';
import { fxSlot } from './fx-chain.js';
import { read, save } from './storage.js';
import { el, renderParams, card } from './plugin-ui.js';
export function createAirWidget() {
 const { section, content } = card('air-module', 'Air');
 section.classList.remove('wide'); section.dataset.wide = 'false';
 const stored = read('synth-air-v1', {});
 const power = el('input', { type: 'checkbox', checked: !!stored.enabled });
 const params = el('div', { className: 'plugin-params' });
 content.append(
  el('div', { className: 'sequence-toolbar' }, el('label', {}, power, 'Enabled')),
  el('p', { className: 'module-hint' }, 'Adds presence around 2.8 kHz and a shelf plus harmonic sparkle above 6 kHz. Runs after the filter and master volume.'),
  params);
 const slot = fxSlot(10);
 let air;
 const values = { mid: 0, high: 0, trim: 0, ...stored.values };
 const persist = () => save('synth-air-v1', { enabled: power.checked, values });
 const start = () => {
  const ctx = window.synth.ensureAudio(); if (!ctx) return;
  air ||= createAir(ctx);
  Object.entries(values).forEach(([id, v]) => air.setParam(id, v));
  renderParams(params, air.params, (id, v) => { values[id] = v; air.setParam(id, v); persist(); });
  power.checked ? slot.set(air) : slot.clear();
 };
 power.onchange = () => { start(); persist(); };
 start();
 return section;
}
