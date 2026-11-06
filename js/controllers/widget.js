// The Controllers widget: the MIDI ports and what the app made of each (a device with a preset, detected by
// name or identity, or plain MIDI), and for a device in use its preset variation, program, encoder page with
// what each knob moves now, the pads as the controller shows them, MIDI learn, remapping, and saving it all as a
// preset; for plain MIDI, the channel listened to and where each channel goes, the mod wheel, the bend range;
// the app's arpeggiator; and the presets themselves (import, export, rename, duplicate, delete).
import { el, card } from '../plugin-ui.js';
import { midi } from './midi.js';
import { controllers, describe, shortName } from './runtime.js';
import { padColor } from './feedback.js';
import { browseList } from './actions.js';
import { param } from './registry.js';
import { arp } from '../arpeggiator.js';
import * as ws from '../workspace.js';

const opts = (pairs, value) => { const s = el('select'); pairs.forEach(([v, t]) => s.append(el('option', { value: v, textContent: t }))); if (value !== undefined) s.value = value; return s; };
const aria = (node, label) => { node.setAttribute('aria-label', label); return node; };
const css = rgb => `rgb(${rgb.map(v => Math.round(Math.min(1, v * 1.6 + (v > 0 ? 0.08 : 0)) * 255)).join(',')})`;
const STATUS = { official: 'official', community: 'community', user: 'yours' };
const VERIFIED = { hardware: 'checked on hardware', documented: 'from the maker\'s documentation, not yet checked on hardware', unverified: 'unverified' };
// What a control can be remapped to, as a menu: the actions, then "a parameter" (picked with MIDI learn).
const ACTIONS = [['', 'nothing'], ['notes', 'play notes'], ['page', 'knob of the page'], ['loop', 'loop slot'], ['clear', 'clear loop slot'], ['metronome', 'metronome on/off'], ['tap', 'tap tempo'], ['record', 'record'], ['panic', 'PANIC'], ['play', 'play'], ['stop', 'stop'], ['loop-toggle', 'loops play/stop'], ['step', 'sequencer step'], ['step-page', 'steps 1-8 / 9-16'], ['drum', 'drum'], ['browse', 'browse'], ['confirm', 'select'], ['tempo', 'tempo'], ['page-next', 'next page'], ['page-prev', 'previous page'], ['variation', 'next preset'], ['arp', 'app arpeggiator'], ['hold', 'hold / latch'], ['sustain', 'sustain'], ['bend', 'pitch bend'], ['mod', 'mod'], ['shift', 'shift']];

export function createControllersWidget() {
 const { section, content } = card('controllers-module', 'Controllers');
 const status = el('p', { className: 'module-hint ctl-status', role: 'status' });
 const connect = el('button', { type: 'button', className: 'std-button', id: 'ctl-connect', textContent: 'Connect MIDI' });
 const allowSysex = el('button', { type: 'button', className: 'std-button', id: 'ctl-sysex', textContent: 'Allow pad colours and the screen (SysEx)', title: 'Asks the browser to let the app send SysEx to your controllers: their pad colours, screen and identity' });
 const devices = el('div', { className: 'ctl-devices' });
 const learnBar = el('p', { className: 'ctl-learn', role: 'status', hidden: true });
 content.append(el('div', { className: 'sequence-toolbar' }, connect, allowSysex), status, learnBar, devices, plainBox(), arpBox(), presetsBox());
 connect.onclick = () => midi.start({ sysex: false });
 allowSysex.onclick = () => midi.start({ sysex: true });

 const renderStatus = () => {
  const n = midi.ports.length;
  status.textContent = midi.state === 'ready' ? `MIDI: ${n ? `${n} input${n === 1 ? '' : 's'}` : 'no controller plugged in'}${midi.sysex ? ', SysEx allowed' : ''}.${midi.note ? ` ${midi.note}` : ''}` : midi.error || (midi.state === 'asking' ? 'Asking the browser for MIDI…' : 'MIDI is off. Connect to play a controller.');
  connect.hidden = midi.state === 'ready' || midi.state === 'unsupported';
  allowSysex.hidden = midi.state !== 'ready' || midi.sysex || !controllers.devices.some(d => d.preset.feedback?.requires === 'sysex');
 };

 let cards = new Map(), liveQueued = false;
 const render = () => {
  renderStatus();
  const list = controllers.devices;
  devices.replaceChildren(...list.map(d => (cards.get(d) || cards.set(d, deviceCard(d)).get(d)).root));
  for (const [d, c] of cards) if (!list.includes(d)) cards.delete(d); else c.update();
  if (!list.length && midi.state === 'ready') devices.append(el('p', { className: 'module-hint', textContent: 'Plug in a controller: it is found by itself. Anything unknown plays as a plain MIDI keyboard; give it a preset with MIDI learn.' }));
 };
 midi.subscribe(type => { if (['state', 'ports', 'settings'].includes(type)) render(); });
 controllers.subscribe((type, d) => {
  if (['devices', 'presets'].includes(type)) render();
  else if (['device', 'program', 'bank', 'arp'].includes(type)) cards.get(d.device || d)?.update();
  if (type === 'learn') showLearn(d);
  if ((type === 'event' || type === 'pickup') && !liveQueued) { liveQueued = true; requestAnimationFrame(() => { liveQueued = false; cards.get(d.device)?.live(); }); }
 });
 // The pads as the controller shows them, a few times a second while the widget is in view.
 setInterval(() => { if (!section.hidden && !section.classList.contains('minimized')) cards.forEach(c => c.pads()); }, 150);

 /* -- MIDI learn: click a control in the app, then move one on the controller -- */
 // pick: a click in the app is awaited, for MIDI learn ({ device }) or a remap row's "a parameter…" ({ device, control }).
 let pick = null;
 const showLearn = ({ device, learning, control, action, auto }) => {
  if (learning) { learnBar.hidden = false; learnBar.textContent = learning.param ? `Now move a knob, fader or pad on ${device.name} for ${learning.param}. (Escape cancels.)` : learning.action ? `Now press or move the control on ${device.name} that should ${describe(device, learning.action)}.` : `Click a control in the app, then move a knob, fader or pad on ${device.name}. (Escape cancels.)`; return; }
  document.documentElement.classList.remove('ctl-learning');
  learnBar.textContent = control ? `${device.control(control)?.label || control}${auto ? ' learned' : ''} → ${describe(device, device.variation.mappings[control])}.` : 'MIDI learn cancelled.';
  setTimeout(() => { if (!pick && !device.learning) learnBar.hidden = true; }, 4000);
  render();
 };
 const startLearn = d => {
  if (!d.use) d.setUse(true);
  pick = { device: d }; document.documentElement.classList.add('ctl-learning');
  showLearn({ device: d, learning: { pick: true } });
 };
 const pickFor = (d, control) => { pick = { device: d, control }; document.documentElement.classList.add('ctl-learning'); learnBar.hidden = false; learnBar.textContent = `Click the control in the app that ${d.control(control)?.label || control} should move. (Escape cancels.)`; };
 // The control clicked, by its id or "Widget › Control".
 const refOf = c => { if (c.id && ws.find(c.id)?.control) return c.id; const hit = ws.widgets().map(w => ({ widget: w, control: ws.controls(w).find(x => x.el === c) })).find(x => x.control); return hit ? ws.nameOf(hit) : null; };
 document.addEventListener('pointerdown', e => {
  if (!pick) return;
  const c = e.target.closest?.('input, select');
  if (!c || section.contains(c) || c.closest('#teacher-panel')) return;
  const ref = refOf(c);
  if (!ref) return;
  e.preventDefault();
  const { device, control } = pick; pick = null;
  if (control) { device.map(control, { do: 'param', param: ref, takeover: 'pickup' }); showLearn({ device, learning: null, control }); }
  else device.startLearn({ param: ref });
 }, true);
 document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; const d = pick?.device || controllers.devices.find(x => x.learning); if (!d) return; pick = null; if (d.learning) d.stopLearn(); else showLearn({ device: d, learning: null }); });

 /* -- One device -- */
 function deviceCard(d) {
  const root = el('div', { className: 'ctl-device' });
  const head = el('div', { className: 'ctl-head' }), use = el('input', { type: 'checkbox' }), useLabel = el('label', { className: 'ctl-use' }, use, ' Use the preset');
  const presetSel = aria(el('select'), `${d.port.name} preset`), variation = aria(el('select'), 'Preset variation'), program = aria(el('select'), 'Controller program');
  const page = aria(el('select'), 'Encoder page'), browseSel = aria(opts([['widgets', 'widgets'], ['variations', 'preset variations'], ['plugins', 'plug-in windows'], ['lessons', 'lessons']]), 'Main encoder browses');
  const arpSel = aria(opts([['auto', 'found by itself'], ['on', 'on'], ['off', 'off']]), 'Controller arpeggiator'), clock = el('input', { type: 'checkbox' });
  const note = el('p', { className: 'module-hint ctl-note' }), knobs = el('div', { className: 'ctl-knobs' }), padGrid = el('div', { className: 'ctl-pads' }), bank = el('span', { className: 'ctl-bank' });
  const learn = el('button', { type: 'button', textContent: 'MIDI learn', title: 'Click a control in the app, then move one on the controller' });
  const reset = el('button', { type: 'button', textContent: 'Reset to defaults', title: 'Forget what was learned and remapped for this device' });
  const saveAs = el('button', { type: 'button', textContent: 'Save as preset…' });
  const remap = el('details', { className: 'ctl-remap' }, el('summary', { textContent: 'Remap controls' }));
  const settings = el('div', { className: 'ctl-settings' },
   el('label', {}, 'Preset ', presetSel), el('label', {}, 'Variation ', variation), el('label', {}, 'Program ', program), el('label', {}, 'Page ', page),
   el('label', {}, 'Main encoder browses ', browseSel), el('label', {}, 'Its arpeggiator ', arpSel), el('label', { title: 'Sends the app\'s tempo as MIDI clock, so the controller\'s arpeggiator follows it (set its Sync to Ext)' }, clock, ' Send MIDI clock'));
  root.append(head, useLabel, note, settings, el('div', { className: 'ctl-live' }, knobs, el('div', {}, bank, padGrid)), el('div', { className: 'sequence-toolbar' }, learn, reset, saveAs), remap);
  use.onchange = () => d.setUse(use.checked);
  presetSel.onchange = () => { const fresh = controllers.choosePreset(d, presetSel.value); cards.delete(d); cards.set(fresh, deviceCard(fresh)); render(); };
  variation.onchange = () => d.setVariation(variation.value);
  program.onchange = () => d.setProgram(program.value);
  page.onchange = () => d.setPage(Number(page.value));
  browseSel.onchange = () => { d.browse = { list: browseSel.value, index: 0 }; d.persist(); };
  arpSel.onchange = () => { d.arpMode = arpSel.value; d.persist(); };
  clock.onchange = () => midi.set({ clockOut: clock.checked ? [...new Set([...midi.settings.clockOut, d.port.name])] : midi.settings.clockOut.filter(n => n !== d.port.name) });
  learn.onclick = () => startLearn(d);
  reset.onclick = () => { if (confirm(`Forget everything learned and remapped for ${d.port.name}?`)) d.resetMappings(); };
  saveAs.onclick = () => {
   const name = prompt('Name the preset', `${d.name} (mine)`);
   if (!name) return;
   try {
    const p = controllers.presetFrom(d, name), exists = controllers.preset(p.id);
    if (exists && !confirm(`There is already a preset called ${name}. Replace it?`)) return;
    controllers.savePreset(p, { overwrite: !!exists }); controllers.choosePreset(d, p.id); render();
   } catch (err) { note.textContent = err.message; }
  };
  const update = () => {
   const v = d.variation, by = { identity: `by its identity${d.firmware ? ` (firmware ${d.firmware})` : ''}`, name: 'by its port name', generic: 'as an unknown device', chosen: 'chosen by you' }[d.by] || '';
   head.replaceChildren(el('strong', { textContent: d.by === 'generic' ? d.port.name : `${d.name} detected` }), el('span', { className: 'module-hint', textContent: ` ${d.port.name}, ${by}${d.others.length ? `; also its ${d.others.map(p => p.name).join(', ')}` : ''}` }), el('span', { className: `badge ctl-${d.preset.status}`, title: VERIFIED[d.preset.verified], textContent: `${STATUS[d.preset.status]} · ${d.preset.verified}` }));
   use.checked = d.use; useLabel.lastChild.textContent = d.use ? ` Use the ${d.name} preset` : ` Use the ${d.name} preset (now plain MIDI)`;
   presetSel.replaceChildren(...controllers.presets.map(p => el('option', { value: p.id, textContent: `${p.name}${p.generic ? ' (generic)' : ''}${p.status === 'user' ? ' (yours)' : ''}` }))); presetSel.value = d.preset.id;
   variation.replaceChildren(...d.variations().map(x => el('option', { value: x.id, textContent: x.name }))); variation.value = d.variationId;
   program.replaceChildren(...d.preset.programs.map(g => el('option', { value: g.id, textContent: `${g.name}${g.id === d.programId && d.programAuto ? ' (detected)' : ''}` }))); program.value = d.programId;
   page.replaceChildren(...d.pages.map((p, i) => el('option', { value: i, textContent: p.name }))); page.value = d.pageIndex;
   browseSel.value = d.browse.list; arpSel.value = d.arpMode; clock.checked = midi.settings.clockOut.includes(d.port.name);
   [variation, program, page, browseSel, arpSel, learn, saveAs].forEach(x => { x.disabled = !d.use; });
   const g = d.program, f = d.preset.feedback, lines = [];
   if (d.use) {
    if (g.template) lines.push(`${g.name}: ${g.description || ''}`);
    if (d.programRaw !== undefined && g.id === 'user') lines.push('Your controller is in a program the app doesn\'t know the messages of. If you changed it in MIDI Control Center, use MIDI learn to teach the app its controls.');
    if (f?.pads?.programs && !f.pads.programs.includes(d.programId)) lines.push(`Pad colours and the screen work in the ${f.pads.programs.map(id => d.preset.programs.find(x => x.id === id)?.name).join(' or ')} program: ${d.preset.id === 'arturia/minilab3' ? 'hold Shift and press Pad 3 until the screen says DAW' : 'switch the controller to it'}. Everything else works as it is.`);
    if (f?.requires === 'sysex' && !midi.sysex) lines.push('Pad colours and the screen need SysEx, which isn\'t allowed: press Allow above.');
    if (d.unknown > 3) lines.push(`${d.unknown} messages from it weren't any control of this program: it may be in another program or a User program. Pick the program, or use MIDI learn.`);
    lines.push(v.description || '');
   } else lines.push(d.by === 'generic' ? 'Plays as a plain MIDI keyboard. Use a generic preset, or MIDI learn to make one.' : 'Plays as a plain MIDI keyboard; the preset is off.');
   note.textContent = lines.filter(Boolean).join(' ');
   remap.replaceChildren(el('summary', { textContent: 'Remap controls' }), ...d.controls.filter(c => d.program.messages[c.id] || d.overlay.learned[d.programId]?.[c.id]).map(c => {
    const a = v.mappings[c.id], sel = aria(opts(ACTIONS, a?.do || ''), `${c.label} does`), num = el('input', { type: 'number', min: 1, max: 16, value: a?.slot || a?.index || 1, hidden: !['page', 'loop', 'clear', 'step', 'drum'].includes(a?.do) });
    aria(num, `${c.label} number`);
    const set = () => { const k = sel.value, n = Number(num.value); d.map(c.id, k ? { do: k, ...(['page', 'loop', 'clear'].includes(k) ? { slot: n } : ['step', 'drum'].includes(k) ? { index: n } : {}) } : { do: 'none' }); update(); };
    sel.onchange = set; num.onchange = set;
    const toParam = el('button', { type: 'button', textContent: 'a parameter…', title: 'Click a control in the app to map this to it' });
    toParam.onclick = () => pickFor(d, c.id);
    return el('div', { className: 'sequence-toolbar ctl-map-row' }, el('span', { textContent: c.label }), sel, num, toParam, el('span', { className: 'module-hint', textContent: describe(d, a) }));
   }));
   live(); pads();
  };
  const live = () => {
   if (!d.use) { knobs.replaceChildren(); return; }
   const v = d.variation, row = c => { const a = v.mappings[c.id], p = a?.do === 'page' ? d.slotParam(a.slot) : a?.do === 'param' ? param(a.param) : null; return el('div', { className: 'ctl-knob', title: `${c.label}: ${describe(d, a)}` }, el('b', { textContent: shortName(c) }), el('span', { textContent: p ? p.name : describe(d, a) }), el('output', { textContent: p ? p.text : '' })); };
   knobs.replaceChildren(...d.controls.filter(c => /^(encoder|knob|fader)$/.test(c.type) && v.mappings[c.id] && /^(page|param|tempo)$/.test(v.mappings[c.id].do)).map(row));
  };
  const pads = () => {
   const ids = d.controls.filter(c => c.type === 'pad').map(c => c.id);
   if (!d.use || !ids.length) { padGrid.replaceChildren(); bank.textContent = ''; return; }
   if (padGrid.children.length !== ids.length) padGrid.replaceChildren(...ids.map(id => el('span', { className: 'ctl-pad', title: `${d.control(id).label}: ${describe(d, d.variation.mappings[id])}`, textContent: shortName(d.control(id)) })));
   const now = performance.now();
   ids.forEach((id, i) => { const p = padGrid.children[i]; p.style.background = css(padColor(d, id, now)); p.classList.toggle('ctl-bank-on', !d.bank || d.control(id).bank === d.bank); });
   bank.textContent = d.bank ? `Pads: bank ${d.bank}` : 'Pads';
  };
  update();
  return { root, update, live, pads };
 }
 render();
 return section;
}

// Plain MIDI: the channel listened to (Omni, or one of 1 to 16), where each channel's notes go, the mod wheel,
// the pitch bend range, and whether the keys on screen follow a controller's octave.
function plainBox() {
 const s = midi.settings, box = el('details', { className: 'ctl-plain' }, el('summary', { textContent: 'MIDI channels, mod wheel and bend' }));
 const channel = aria(opts([['omni', 'Omni (all)'], ...Array.from({ length: 16 }, (_, i) => [String(i + 1), `Channel ${i + 1}`])], String(s.channel)), 'MIDI channel');
 channel.id = 'ctl-channel';
 const heard = el('span', { className: 'module-hint' });
 const mod = aria(opts([['vibrato', 'vibrato'], ['filterCutoff', 'filter cutoff'], ['filterResonance', 'resonance'], ['masterVolume', 'volume']], s.mod), 'Mod wheel moves');
 const bend = el('input', { type: 'number', min: 1, max: 24, value: s.bendRange }); aria(bend, 'Pitch bend range in semitones');
 const follow = el('input', { type: 'checkbox', checked: s.follow });
 const routes = el('div', { className: 'ctl-routes' }, ...Array.from({ length: 16 }, (_, i) => { const r = aria(opts([['synth', 'synth'], ['drums', 'drums'], ['off', 'off']], s.routes[i + 1] || 'synth'), `Channel ${i + 1} plays`); r.onchange = () => midi.set({ routes: { ...midi.settings.routes, [i + 1]: r.value } }); return el('label', {}, `${i + 1} `, r); }));
 channel.onchange = () => midi.set({ channel: channel.value === 'omni' ? 'omni' : Number(channel.value) });
 mod.onchange = () => midi.set({ mod: mod.value });
 bend.onchange = () => midi.set({ bendRange: Number(bend.value) });
 follow.onchange = () => midi.set({ follow: follow.checked });
 box.append(el('div', { className: 'sequence-toolbar' }, el('label', {}, 'Listen to ', channel), heard),
  el('p', { className: 'module-hint', textContent: 'Each channel\'s notes go to the synth (and a VST3 instrument), the drum kit, or nowhere: a keyboard on channel 1 and pads on channel 10, say.' }), routes,
  el('div', { className: 'sequence-toolbar' }, el('label', {}, 'Mod wheel moves ', mod), el('label', {}, 'Bend range ', bend, ' semitones'), el('label', { title: 'When a controller\'s Octave buttons move its keys, the keys on screen move too' }, follow, ' Keys on screen follow the controller')));
 midi.subscribe((type, d) => { if (type === 'message' && d.m.channel) heard.textContent = `Heard on channel ${d.m.channel} (${d.port.name}).`; });
 return box;
}

// The app's arpeggiator.
function arpBox() {
 const on = el('input', { type: 'checkbox', id: 'arp-on' }), latch = el('input', { type: 'checkbox', id: 'arp-latch' });
 const mode = aria(opts([['up', 'up'], ['down', 'down'], ['updown', 'up and down'], ['order', 'as played'], ['random', 'random']], arp.mode), 'Arpeggiator pattern');
 const rate = aria(opts([['1/8', 'eighths'], ['1/16', 'sixteenths'], ['1/8T', 'eighth triplets']], arp.rate), 'Arpeggiator rate');
 const octaves = aria(opts([['1', '1 octave'], ['2', '2 octaves'], ['3', '3 octaves']], String(arp.octaves)), 'Arpeggiator octaves');
 on.onchange = () => arp.set({ on: on.checked }); latch.onchange = () => arp.set({ latch: latch.checked });
 mode.onchange = () => arp.set({ mode: mode.value }); rate.onchange = () => arp.set({ rate: rate.value }); octaves.onchange = () => arp.set({ octaves: Number(octaves.value) });
 arp.subscribe(a => { on.checked = a.on; latch.checked = a.latch; });
 return el('div', { className: 'sequence-toolbar ctl-arp' }, el('strong', { textContent: 'Arpeggiator' }), el('label', {}, on, ' On'), el('label', {}, latch, ' Latch'), mode, rate, octaves,
  el('span', { className: 'module-hint', textContent: 'Plays the keys you hold on the beat; a loop slot records it in time.' }));
}

// Every preset: what it is, and for the user's own, rename, duplicate, delete and export; import a file.
function presetsBox() {
 const box = el('details', { className: 'ctl-presets' }, el('summary', { textContent: 'Presets' }));
 const list = el('div'), file = el('input', { type: 'file', accept: '.json,application/json', hidden: true }), problems = el('p', { className: 'module-hint', role: 'status' });
 const importBtn = el('button', { type: 'button', textContent: 'Import preset…', onclick: () => file.click() });
 file.onchange = async () => {
  const f = file.files[0]; file.value = '';
  if (!f) return;
  try { const text = await f.text(); let p; try { p = controllers.importPreset(text); } catch (err) { if (!/already a preset/.test(err.message) || !confirm(`${err.message}. Replace it?`)) throw err; p = controllers.importPreset(text, { overwrite: true }); } problems.textContent = `Imported ${p.name}.`; }
  catch (err) { problems.textContent = err.message; }
 };
 const download = p => { const a = el('a', { href: URL.createObjectURL(new Blob([controllers.exportPreset(p)], { type: 'application/json' })), download: `${p.id.replace('/', '-')}.json` }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
 const render = () => {
  list.replaceChildren(...controllers.presets.map(p => {
   const row = el('div', { className: 'sequence-toolbar ctl-preset-row' }, el('strong', { textContent: p.name }), el('span', { className: `badge ctl-${p.status}`, title: VERIFIED[p.verified], textContent: `${STATUS[p.status]} · ${p.verified}` }), el('span', { className: 'module-hint', textContent: p.models.join(', ') }));
   const dup = el('button', { type: 'button', textContent: 'Duplicate', onclick: () => { const name = prompt('Name the copy', `${p.name} copy`); if (!name) return; try { const c = JSON.parse(controllers.exportPreset(p)); Object.assign(c, { id: `user/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, status: 'user' }); delete c.hooks; controllers.savePreset(c); } catch (err) { problems.textContent = err.message; } } });
   row.append(dup, el('button', { type: 'button', textContent: 'Export', onclick: () => download(p) }));
   if (p.status === 'user') {
    row.append(el('button', { type: 'button', textContent: 'Rename', onclick: () => { const name = prompt('New name', p.name); if (!name) return; try { controllers.savePreset({ ...JSON.parse(controllers.exportPreset(p)), name }, { overwrite: true }); } catch (err) { problems.textContent = err.message; } } }),
     el('button', { type: 'button', textContent: 'Delete', onclick: () => { if (confirm(`Delete the preset ${p.name}?`)) controllers.deletePreset(p.id); } }));
   }
   return row;
  }));
  problems.textContent = controllers.problems.map(x => `${x.id} wasn't loaded: ${x.problems.slice(0, 2).join('; ')}`).join(' ');
 };
 controllers.subscribe(type => { if (type === 'presets') render(); });
 box.append(el('p', { className: 'module-hint', textContent: 'A preset is one JSON file (js/controllers/schema.json). Imported presets are JSON only: a preset\'s script is never run unless it is bundled with the app.' }), list, el('div', { className: 'sequence-toolbar' }, importBtn), file, problems);
 render();
 return box;
}
export { browseList };
