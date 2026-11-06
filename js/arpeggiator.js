// An arpeggiator in the app, the alternative to a controller's own: while it is on, the keys held (or latched)
// play one at a time, up, down, up and down, in the order played, or at random, over one to three octaves, on
// the beat clock's grid (eighths, sixteenths or eighth triplets) when one runs, else at the session tempo. Its
// notes play through the synth like any other (source 'arp'), so an armed loop slot records them in time; they
// aren't graded as the player's timing (they are the machine's), but the chord held is: each new chord is told
// to the beat clock and the teacher once, silently, as source 'midi-held'.
import { timing } from './timing-widget.js';

const RATES = { '1/8': 2, '1/16': 4, '1/8T': 3 };
const listeners = new Set();
let timer = null, step = 0, sounding = null, nextAt = 0;

const order = (held, mode, octaves) => {
 const base = mode === 'order' ? held.map(h => h.note) : [...new Set(held.map(h => h.note))].sort((a, b) => a - b);
 const all = []; for (let o = 0; o < octaves; o++) all.push(...base.map(n => n + 12 * o).filter(n => n <= 127));
 if (mode === 'down') return all.reverse();
 if (mode === 'updown') return all.length > 2 ? [...all, ...all.slice(1, -1).reverse()] : all;
 return all;
};
const held = [];
const tell = (note, on, velocity, time) => window.dispatchEvent(new CustomEvent('synth:note', { detail: { note: '', midi: note, velocity: on ? velocity : 0, on, source: 'midi-held', silent: true, time } }));

export const arp = {
 on: false, latch: false, mode: 'up', rate: '1/16', octaves: 1, gate: 0.6,
 subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
 get notes() { return held.map(h => h.note); },
 set(changes) {
  const was = this.on;
  Object.assign(this, changes);
  if (changes.latch === false && !held.some(h => h.down)) this._clear();
  if (was && !this.on) this._clear();
  listeners.forEach(fn => fn(this));
 },
 // A key goes down or up while the arpeggiator is on.
 key(note, on, velocity = 0.8, time = performance.now()) {
  if (on) {
   if (this.latch && held.length && !held.some(h => h.down)) { held.forEach(h => tell(h.note, false, 0, time)); held.length = 0; } // a new chord replaces the latched one
   if (!held.some(h => h.note === note)) held.push({ note, velocity, down: true }); else held.find(h => h.note === note).down = true;
   tell(note, true, velocity, time);
   if (!timer) this._start(time);
  } else {
   const h = held.find(x => x.note === note);
   if (h) h.down = false;
   if (!this.latch) { held.splice(held.indexOf(h), 1); tell(note, false, 0, time); }
   if (!held.length) this._clear();
  }
 },
 _period() { return 60000 / (timing.clock.running ? timing.clock.bpm : window.synth.tempo) / RATES[this.rate]; },
 _start(time) {
  step = 0;
  const p = this._period();
  // On the grid: the next division of the beat from now, or now when nothing keeps the beat.
  nextAt = timing.clock.running ? timing.clock.timeOf(Math.ceil(timing.clock.beatAt(time) * RATES[this.rate]) / RATES[this.rate]) : time;
  if (nextAt < performance.now() - p) nextAt = performance.now();
  timer = setInterval(() => this._tick(), 5);
  this._tick();
 },
 _tick() {
  const now = performance.now();
  if (sounding && now >= sounding.off) { window.synth.midi.note(sounding.note, 0, false, sounding.off, 'arp'); sounding = null; }
  if (now < nextAt - 2) return;
  const seq = order(held, this.mode, this.octaves);
  if (!seq.length) { this._clear(); return; }
  const note = this.mode === 'random' ? seq[Math.floor(Math.random() * seq.length)] : seq[step % seq.length], p = this._period();
  if (sounding) window.synth.midi.note(sounding.note, 0, false, nextAt, 'arp');
  const v = held.find(h => h.note % 12 === note % 12)?.velocity ?? 0.8;
  window.synth.midi.note(note, v, true, nextAt, 'arp');
  sounding = { note, off: nextAt + p * this.gate };
  step++; nextAt += p;
 },
 _clear() {
  clearInterval(timer); timer = null;
  if (sounding) { window.synth.midi.note(sounding.note, 0, false, performance.now(), 'arp'); sounding = null; }
  held.forEach(h => tell(h.note, false, 0, performance.now())); held.length = 0;
 },
};
window.addEventListener('synth:panic', () => arp._clear());
