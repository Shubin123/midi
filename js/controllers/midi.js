// The MIDI ports. Access is asked for with SysEx (a controller's pad colours and screen need it) and, if that is
// refused, again without: every control still works, only the feedback is off, and the Controllers widget says
// why. Ports come and go while the page is open (plugged in, unplugged, the computer asleep and awake, a DAW
// holding one open): each input's messages go to whoever claims them (js/controllers/runtime.js, for a device
// with a preset), and what nobody claims plays as a plain MIDI keyboard does: notes on the listened channel
// (Omni, or 1 to 16) go where that channel is routed (the synth and any VST3 instrument, the drum kit, or
// nowhere), CC 64 is the sustain pedal, the pitch wheel bends, CC 1 (the mod wheel) adds vibrato or moves a
// control, and MIDI clock goes to the beat clock (synth:midi-clock). The app's own clock can go out to a
// device, so a hardware arpeggiator follows the session tempo.
import { read, save } from '../storage.js';
import { decode, IDENTITY_REQUEST, parseIdentity, hex } from './messages.js';
import { drums } from '../drums.js';

const KEY = 'midi-settings-v1';
const DEFAULTS = { channel: 'omni', routes: { 10: 'drums' }, mod: 'vibrato', bendRange: 2, follow: true, clockOut: [] };
const listeners = new Set();
const emit = (type, detail) => listeners.forEach(fn => { try { fn(type, detail); } catch (err) { console.error(err); } });

// A port pair: an input and the output of the same name (a controller's LEDs and screen are written there).
const pairName = n => String(n || '').replace(/\s*\b(in|out|input|output)\b\s*/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

export const midi = {
 state: 'idle', // idle, asking, unsupported, denied, ready
 sysex: false, error: '', note: '',
 access: null,
 ports: [], // { id, name, manufacturer, input, output, busy, identity, lastChannel }
 settings: { ...DEFAULTS, ...read(KEY, {}) },
 claims: [], // fn(port, message, data, time) → true when the message was handled
 subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
 set(changes) { Object.assign(this.settings, changes); save(KEY, this.settings); if (changes.bendRange && window.synth?.midi) window.synth.midi.bendRange = changes.bendRange; emit('settings', this.settings); },
 claim(fn) { this.claims.push(fn); return () => { this.claims = this.claims.filter(f => f !== fn); }; },
 port(id) { return this.ports.find(p => p.id === id) || null; },

 // Asks the browser for MIDI: with SysEx first, then without. Safari has no Web MIDI; Firefox asks through a
 // site permission add-on, and either may refuse SysEx alone.
 async start({ sysex = true } = {}) {
  if (!navigator.requestMIDIAccess) { this.state = 'unsupported'; this.error = 'This browser has no Web MIDI (Safari doesn\'t; use Chrome, Edge, Opera or Firefox).'; emit('state', this.state); return false; }
  this.state = 'asking'; emit('state', this.state);
  let access = null;
  if (sysex) {
   try { access = await navigator.requestMIDIAccess({ sysex: true }); this.sysex = true; this.note = ''; save('midi-sysex-v1', true); }
   catch (err) { this.note = `SysEx was not allowed (${err.name || err.message}): the controls work, but pad colours and the screen stay off. Allow MIDI device control (SysEx) for this site and reload to turn them on.`; }
  }
  if (!access) {
   try { access = await navigator.requestMIDIAccess({ sysex: false }); this.sysex = false; }
   catch (err) { this.state = 'denied'; this.error = `MIDI was not allowed (${err.name || err.message}). Allow MIDI for this site, then press Connect again.`; emit('state', this.state); return false; }
  }
  if (this.access && this.access !== access) { this.access.onstatechange = null; this.ports.forEach(p => { p.input.onmidimessage = null; p.input = null; }); } // asked again, with SysEx: the new access replaces the old
  this.access = access; this.state = 'ready'; this.error = '';
  access.onstatechange = () => this.scan();
  this.scan();
  emit('state', this.state);
  return true;
 },

 // Brings the port list up to date: new inputs are opened and listened to (one already held exclusively by
 // another app, as a DAW can on Windows, is marked busy), gone ones are said to be gone, so their notes stop.
 scan() {
  if (!this.access) return;
  const inputs = [...this.access.inputs.values()], outputs = [...this.access.outputs.values()];
  const seen = new Set();
  for (const input of inputs) {
   if (input.state !== 'connected') continue;
   seen.add(input.id);
   let p = this.port(input.id);
   const output = outputs.find(o => o.state === 'connected' && o.name === input.name) || outputs.find(o => o.state === 'connected' && pairName(o.name) === pairName(input.name)) || null;
   if (!p) {
    p = { id: input.id, name: input.name || 'MIDI input', manufacturer: input.manufacturer || '', input, output, busy: false, identity: null, lastChannel: null };
    this.ports.push(p);
    input.onmidimessage = e => this._message(p, e);
    input.open?.().catch(() => { p.busy = true; emit('ports', this.ports); });
    emit('connect', p);
   } else if (p.input !== input) { p.input = input; input.onmidimessage = e => this._message(p, e); }
   p.output = output;
  }
  for (const p of [...this.ports]) if (!seen.has(p.id)) { this.ports = this.ports.filter(x => x !== p); this.release(p); emit('disconnect', p); }
  emit('ports', this.ports);
 },

 // Sends to a port's output. SysEx only goes when it was allowed; returns whether it went.
 send(p, bytes, time) {
  const port = typeof p === 'string' ? this.port(p) : p;
  if (!port?.output || port.output.state === 'disconnected') return false;
  if (bytes[0] === 0xF0 && !this.sysex) return false;
  try { port.output.send(bytes, time); emit('sent', { port, bytes }); return true; } catch (err) { this.error = `Couldn't send to ${port.name}: ${err.message}`; return false; }
 },

 // Asks a device who it is (Universal SysEx Identity Request) and waits up to `ms` for its reply.
 identify(p, ms = 600) {
  return new Promise(resolve => {
   if (!this.sysex || !p.output) { resolve(null); return; }
   const t = setTimeout(() => { off(); resolve(null); }, ms);
   const off = this.subscribe((type, d) => { if (type === 'identity' && d.port === p) { clearTimeout(t); off(); resolve(d.identity); } });
   this.send(p, IDENTITY_REQUEST);
  });
 },

 _message(p, e) {
  const data = e.data, time = e.timeStamp || performance.now(), m = decode(data);
  if (m.type === 'clock') { window.dispatchEvent(new CustomEvent('synth:midi-clock', { detail: { type: m.what, time } })); return; }
  if (m.type === 'sysex') {
   const identity = parseIdentity(data);
   if (identity) { p.identity = identity; emit('identity', { port: p, identity }); return; }
  }
  if (m.channel) p.lastChannel = m.channel;
  emit('message', { port: p, m, data, time });
  for (const fn of this.claims) if (fn(p, m, data, time)) return;
  this.plain(p, m, time);
 },

 // A port went away mid-note: what it held stops, and its pedal lifts.
 release(p) {
  (p.held || new Set()).forEach(n => window.synth?.midi.note(n, 0, false, null, 'midi')); p.held?.clear();
  if (p.sustain) { window.synth?.midi.sustain(false); p.sustain = false; }
  if (p.bent) { window.synth?.midi.bend(0); p.bent = false; }
 },
 // Where a note on `channel` goes: the synth, the drum kit, or nowhere (Channel, and Route, in Controllers).
 route(channel) { const s = this.settings; return s.channel !== 'omni' && Number(s.channel) !== channel ? 'off' : s.routes[channel] || 'synth'; },
 // A message no preset took: a plain MIDI keyboard's.
 plain(p, m, time = null) {
  const s = this.settings, synth = window.synth;
  if (!synth?.midi || !m.channel) return;
  if (s.channel !== 'omni' && Number(s.channel) !== m.channel) return;
  const route = s.routes[m.channel] || 'synth';
  if (route === 'off') return;
  if (m.type === 'noteon' || m.type === 'noteoff') {
   const on = m.type === 'noteon';
   if (route === 'drums') { if (on) drums.hit(m.note, m.velocity / 127, time); return; }
   synth.midi.note(m.note, m.velocity / 127, on, time, 'midi');
   (p.held ||= new Set())[on ? 'add' : 'delete'](m.note);
   if (on && s.follow) followKeys(m.note);
  } else if (m.type === 'cc') {
   if (m.number === 64) { synth.midi.sustain(m.value >= 64); p.sustain = m.value >= 64; }
   else if (m.number === 1) modWheel(m.value / 127);
   else if (m.number === 120 || m.number === 123) synth.midi.releaseAll();
  } else if (m.type === 'bend') { synth.midi.bend(((m.value - 8192) / 8192) * synth.midi.bendRange); p.bent = m.value !== 8192; }
 },
};

// The mod wheel: vibrato, or a control between its least and most (Settings in the Controllers widget).
export function modWheel(x, to = midi.settings.mod) {
 if (to === 'vibrato' || !to) { window.synth.midi.vibrato(x); return; }
 const input = document.getElementById(to);
 if (!input) return;
 const lo = Number(input.min), hi = Number(input.max);
 input.value = to === 'filterCutoff' ? lo * (hi / lo) ** x : lo + (hi - lo) * x;
 input.dispatchEvent(new Event('input', { bubbles: true }));
}

// The keys on screen follow the controller: a note played below or above them moves the Keyboard Octave so it
// shows (a controller's Octave buttons transpose its keys).
export function followKeys(note) {
 const synth = window.synth, [lo, hi] = synth.keyRange;
 if (note >= lo && note <= hi) return false;
 const span = Math.round((hi - lo) / 12);
 return synth.showOctave(note < lo ? Math.floor(note / 12) : Math.floor(note / 12) - span + 1);
}

/* ---- The app's clock, out to devices ---- */

// While the metronome or the sequencer keeps the beat, 24 clock ticks a beat go to the ports listed in
// settings.clockOut, scheduled 60 ms ahead with each message's time stamp; Start when the beat starts, Stop when
// it stops.
const clockOut = { running: false, next: 0, timer: null, bpm: 120 };
function clockTick() {
 const ports = midi.ports.filter(p => midi.settings.clockOut.includes(p.name) && p.output);
 if (!ports.length) return;
 const ahead = performance.now() + 60, period = 60000 / clockOut.bpm / 24;
 while (clockOut.next < ahead) { ports.forEach(p => midi.send(p, [0xF8], clockOut.next)); clockOut.next += period; }
}
window.addEventListener('synth:beat-clock', ({ detail: { running, bpm, at } }) => {
 const ports = midi.ports.filter(p => midi.settings.clockOut.includes(p.name) && p.output);
 if (running) {
  clockOut.bpm = bpm;
  if (!clockOut.running) { clockOut.running = true; const start = Math.max(performance.now(), at || 0); ports.forEach(p => midi.send(p, [0xFA], start)); clockOut.next = start; clearInterval(clockOut.timer); clockOut.timer = setInterval(clockTick, 20); clockTick(); }
 } else if (clockOut.running) { clockOut.running = false; clearInterval(clockOut.timer); ports.forEach(p => midi.send(p, [0xFC])); }
});
window.addEventListener('synth:tempo', ({ detail }) => { clockOut.bpm = detail; });

// Woken from sleep, a port can have gone and come back without a state change: look again.
document.addEventListener('visibilitychange', () => { if (!document.hidden && midi.access) midi.scan(); });
export { hex };
