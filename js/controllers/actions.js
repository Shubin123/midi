// What a mapped control does in the app (a mapping's "do", js/controllers/schema.json). Each acts as the
// student would, mostly through the page's own buttons, so the widgets, their saved state and the teacher see
// the same as for a click: perform(device, action, event) for a press, a turn or a value. The device
// (js/controllers/runtime.js) holds what they share: the page, Shift, the sequencer row and step page, the
// browse cursor, the held keys.
import * as ws from '../workspace.js';
import { drums, KIT } from '../drums.js';
import { NOTE_NAMES } from '../pitch-analyzer.js';
import { midi, modWheel, followKeys } from './midi.js';
import { browsable, pluginWindow } from './registry.js';
import { arp } from '../arpeggiator.js';

const $ = id => document.getElementById(id);
const click = el => { if (el && !el.disabled) { el.click(); return true; } return false; };
const seq = () => window.workspaceApi?.sequencer;
const synthName = m => NOTE_NAMES[m % 12] + Math.floor(m / 12); // the synth's names: MIDI 60 is C5
const loops = () => window.synth.loops();

/* ---- Loops ---- */

// A pad for loop slot n (from 1): empty, it arms and records (from the next beat while the metronome runs);
// recording, it stops and plays what it took; playing, it stops; stopped, it plays.
export function loopPad(n) {
 const i = n - 1, l = loops()[i], arm = $(`loop-slot-arm-${i}`), play = $(`loop-slot-play-${i}`);
 if (!l || !arm) return '';
 if (l.recording) { click(arm); if (loops()[i].events.length || loops()[i].audio) click(play); return `Loop ${n} playing`; }
 if (l.playing) { click(play); return `Loop ${n} stopped`; }
 if (l.events.length || l.audio) { click(play); return `Loop ${n} playing`; }
 if (arm.textContent !== 'Record') click(arm); // arm
 click(arm); // and record
 return `Loop ${n} recording`;
}
export function clearLoop(n) {
 const i = n - 1, l = loops()[i];
 if (!l) return '';
 if (l.recording) click($(`loop-slot-arm-${i}`));
 if (loops()[i].playing) click($(`loop-slot-play-${i}`));
 click($(`loop-slot-clear-${i}`));
 return `Loop ${n} cleared`;
}
// Record: the slot recording stops; otherwise the first empty slot records.
export function recordLoop() {
 const ls = loops(), rec = ls.findIndex(l => l.recording);
 if (rec >= 0) return loopPad(rec + 1);
 const empty = ls.findIndex(l => !l.events.length && !l.audio && !l.playing);
 return empty >= 0 ? loopPad(empty + 1) : 'Every loop slot is full';
}
export function stopAll() {
 seq()?.stop();
 loops().forEach((l, i) => { if (l.recording) click($(`loop-slot-arm-${i}`)); if (loops()[i].playing) click($(`loop-slot-play-${i}`)); });
 return 'Stopped';
}
export function toggleLoops() {
 const ls = loops(), playing = ls.some(l => l.playing);
 ls.forEach((l, i) => { if (playing ? l.playing : (l.events.length || l.audio) && !l.recording) click($(`loop-slot-play-${i}`)); });
 return playing ? 'Loops stopped' : 'Loops playing';
}

/* ---- The step sequencer ---- */

// The row a step pad writes: the last key played that is one of the sequencer's rows, or the top row.
export function seqRow(dev) {
 const rows = seq()?.notes || [];
 const r = dev.row === null ? -1 : rows.indexOf(synthName(dev.row));
 return r >= 0 ? r : rows.length - 1;
}
export function toggleStep(dev, index) {
 const s = seq();
 if (!s) return '';
 const step = (index - 1 + dev.stepPage * 8) % 16, row = seqRow(dev), p = s.pattern.map(r => [...r]);
 p[row][step] = !p[row][step];
 s.setPattern(p);
 return `${s.notes[row]} step ${step + 1} ${p[row][step] ? 'on' : 'off'}`;
}

/* ---- The main encoder ---- */

// What it steps through: widgets (the default), the preset's variations, plug-in windows, or the course.
export function browseList(dev) {
 if (dev.browse.list === 'variations') return dev.variations().map(v => ({ id: v.id, name: v.name, kind: 'variation' }));
 if (dev.browse.list === 'plugins') return ws.widgets().filter(w => w.plugin).map(w => ({ id: w.id, name: w.title, kind: 'plugin' }));
 if (dev.browse.list === 'lessons') return (dev.hub.teacher?.lessons() || []).map(l => ({ id: l.id, name: l.title, kind: 'lesson' }));
 return browsable().map(w => ({ id: w.id, name: w.title, kind: w.plugin ? 'plugin' : 'widget' }));
}
export function browse(dev, by) {
 const list = browseList(dev);
 if (!list.length) return 'Nothing to browse';
 dev.browse.index = (((dev.browse.index + by) % list.length) + list.length) % list.length;
 const item = list[dev.browse.index];
 if (item.kind === 'widget' || item.kind === 'plugin') { const w = ws.widgets().find(x => x.id === item.id); if (w && !w.el.hidden) w.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
 dev.flash(`${dev.browse.index + 1}/${list.length}`, item.name);
 return item.name;
}
// Click: the widget or plug-in under the cursor becomes the encoders' page; a variation is switched to; a
// lesson starts.
export function confirm(dev) {
 const item = browseList(dev)[dev.browse.index];
 if (!item) return '';
 if (item.kind === 'variation') { dev.setVariation(item.id); return `Preset ${item.name}`; }
 if (item.kind === 'lesson') { dev.hub.teacher?.start(item.id); return `Lesson: ${item.name}`; }
 const w = ws.widgets().find(x => x.id === item.id);
 if (!w) return '';
 if (w.plugin && w.el.hidden) ws.reveal(w);
 ws.show({ widget: w, control: null });
 dev.focusWidget(w.id);
 return `Knobs on ${w.title}`;
}

/* ---- Everything ---- */

// Does `a` for event `e` ({ kind, value, delta, velocity, note, on, time }). Returns a few words for the
// screen and the Controllers widget, or ''.
export function perform(dev, a, e) {
 const synth = window.synth, press = e.kind === 'press' || (e.kind === 'toggle' && e.on), turn = e.kind === 'turn' ? Math.sign(e.delta) : 0;
 switch (a.do) {
  case 'notes': {
   if (e.kind === 'pressure') { if (a.to !== 'none') synth.midi.vibrato(e.value); return ''; }
   const note = Math.max(0, Math.min(127, e.note + dev.transpose));
   if (e.on) dev.row = note;
   // The app's arpeggiator plays the keys held; the controller's own plays notes that are its, not the player's.
   if (arp.on) { arp.key(note, e.on, e.velocity, e.time ?? performance.now()); return ''; }
   const route = e.on || !dev.held.has(note) ? midi.route(e.channel) : 'synth'; // a note let go stops where it started
   if (route === 'off') return '';
   if (route === 'drums') { if (e.on) drums.hit(note, e.velocity, e.time); return ''; }
   const machine = dev.hardwareArp(note, e);
   synth.midi.note(note, e.velocity, e.on, e.time, machine ? 'arp' : 'midi');
   if (e.on) { dev.held.add(note); if (midi.settings.follow) followKeys(note); } else dev.held.delete(note);
   return '';
  }
  case 'bend': synth.midi.bend((e.value ?? 0) * synth.midi.bendRange); return '';
  case 'mod': modWheel(e.value ?? (e.kind === 'pressure' ? e.value : 0), a.to || midi.settings.mod); return '';
  case 'pressure': synth.midi.vibrato(e.value ?? 0); return '';
  case 'sustain': if (e.kind === 'value') synth.midi.sustain(e.value >= 0.5); else if (e.kind !== 'turn') synth.midi.sustain(press); return '';
  case 'hold': if (!press) return ''; if (arp.on) { arp.set({ latch: !arp.latch }); return `Latch ${arp.latch ? 'on' : 'off'}`; } synth.midi.sustain(!synth.midi.sustained); return `Hold ${synth.midi.sustained ? 'on' : 'off'}`;
  case 'shift': dev.shift = press; return '';
  case 'page': return dev.moveParam(a.slot, e, a.takeover);
  case 'param': return dev.moveParam(null, e, a.takeover, a.param);
  case 'page-next': case 'page-prev': if (!press && !turn) return ''; return dev.setPage(dev.pageIndex + (turn || (a.do === 'page-next' ? 1 : -1)) * (a.by || 1));
  case 'set-page': if (!press) return ''; return dev.setPage(a.page);
  case 'browse': if (turn) return browse(dev, turn); if (e.kind === 'value') { const list = browseList(dev); dev.browse.index = Math.round(e.value * Math.max(0, list.length - 1)) - 0; return browse(dev, 0); } return '';
  case 'confirm': return press ? confirm(dev) : '';
  case 'tempo': {
   if (turn) synth.tempo = Math.round((synth.tempo + turn * (Math.abs(e.delta) > 2 ? 5 : 1)) * 10) / 10;
   else if (e.kind === 'value') synth.tempo = Math.round(30 + 270 * e.value);
   else return '';
   dev.flash('Tempo', `${synth.tempo} BPM`); return `${synth.tempo} BPM`;
  }
  case 'loop': return press ? loopPad(a.slot) : '';
  case 'clear': return press ? clearLoop(a.slot) : '';
  case 'metronome': if (!press) return ''; click($('metronomeToggle')); return `Metronome ${$('metronomeToggle').checked ? 'on' : 'off'}`;
  case 'tap': if (!press) return ''; synth.tap(e.time ?? performance.now()); return `${synth.tempo} BPM`;
  case 'record': if (!press) return ''; return dev.record();
  case 'panic': if (!press) return ''; synth.panic(); return 'Panic';
  case 'play': if (!press) return ''; if (!seq()?.running) seq()?.start(); return 'Playing';
  case 'stop': return press ? stopAll() : '';
  case 'loop-toggle': return press ? toggleLoops() : '';
  case 'step': return press ? toggleStep(dev, a.index) : '';
  case 'step-page': if (!press) return ''; dev.stepPage = dev.stepPage ? 0 : 1; return `Steps ${dev.stepPage ? '9-16' : '1-8'}`;
  case 'drum': case 'note': {
   if (e.kind === 'pressure') return '';
   const note = a.note ?? KIT[((a.index || 1) - 1) % KIT.length];
   const kit = a.do === 'drum' && dev.variation.drums !== 'instrument';
   if (kit) { if (press) drums.hit(note, e.velocity ?? 0.8, e.time); return press ? drums.name(note) : ''; }
   if (press || e.kind === 'release') synth.midi.note(note, e.velocity || 0.8, press, e.time, 'midi-pad');
   return '';
  }
  case 'arp': if (!press) return ''; arp.set({ on: !arp.on }); return `Arpeggiator ${arp.on ? 'on' : 'off'}`;
  case 'variation': if (!press && !turn) return ''; return dev.nextVariation(turn || a.by || 1);
  case 'octave': if (!press) return ''; dev.transpose = Math.max(-48, Math.min(48, dev.transpose + 12 * (a.by || 1))); return `Octave ${dev.transpose / 12 >= 0 ? '+' : ''}${dev.transpose / 12}`;
  case 'lesson-pad': return '';
  default: return '';
 }
}
export { clearLoop as clear, pluginWindow };
