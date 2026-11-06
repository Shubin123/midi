// The one beat clock everything keeps time by (js/timing.js), and what shows it: the hit line's colour as each
// note lands, a timing strip under the keys with a dot per note early or late of its beat line, and a tempo
// readout (the target and the player's tempo, with an arrow when they drift). The clock follows whoever keeps
// the beat: the metronome or the sequencer (synth:beat-clock, with when their first beat is heard), an
// incoming MIDI clock while Sync to MIDI clock is on (synth:midi-clock), or, with none of those, the player's
// own pulse, which follows them as they speed up or slow down. Every note played is kept with its offset and
// grade (timing.onsets) for the teacher (js/teacher-bridge.js), which listens for notes and tempo flags here.
import { BeatClock, MidiClock, TempoWatch, DIFFICULTY, grade, estimateTempo, eventTimes } from './timing.js';
import { read, save } from './storage.js';

const PLAYED = /^(midi|computer|mouse|touch|audio)/; // audio: sung or played into the microphone (js/listening.js)
const COLORS = { good: '#6bcb77', ok: '#f4a261', off: '#ff6b6b', free: '#9aa5b1' };
const listeners = new Set();
const emit = (type, detail) => listeners.forEach(fn => fn(type, detail));

export const timing = {
 clock: new BeatClock(), midi: new MidiClock(), watch: new TempoWatch(),
 onsets: [], // { time, note, velocity, offsetMs, at, grade, chord }: the last 256 notes played
 on: read('timing-on-v1', true),
 levelId: read('timing-level-v1', 'normal'),
 sync: read('midi-clock-sync-v1', false),
 get level() { return DIFFICULTY[this.levelId] || DIFFICULTY.normal; },
 // fn(type, detail): 'note' with an onset, 'flag' with { kind, target, actual, trend }, 'clock' when the
 // beat's keeper changes.
 subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
 // A short line under the keys for a few seconds (the teacher's nudges).
 say(text, who = '') { const n = document.querySelector('.timing-nudge'); if (!n) return; n.textContent = text; n.dataset.who = who; n.hidden = false; clearTimeout(n._t); n._t = setTimeout(() => { n.hidden = true; }, 3500); },
 drawn: 0, // dots drawn in the last frame, for the tests
};
const clock = timing.clock;

/* ---- Who keeps the beat ---- */

const keepers = {}; // source → { bpm, at } of the metronome and the sequencer while they run
function follow() {
 if (timing.sync && clock.source === 'midi' && clock.running) return; // MIDI clock first, while it runs
 const k = keepers.sequencer ? 'sequencer' : keepers.metronome ? 'metronome' : null;
 if (k) { if (clock.source !== k || clock.origin !== keepers[k].at) { clock.start(k, keepers[k].bpm, keepers[k].at); timing.watch.reset(); emit('clock', k); } }
 else if (clock.external) { clock.stop(); timing.watch.reset(); emit('clock', 'none'); }
}
window.addEventListener('synth:beat-clock', ({ detail: { source, running, bpm, at } }) => {
 if (running) keepers[source] = { bpm, at }; else delete keepers[source];
 follow();
});
// The sequencer's tempo moves as a tempo lane plays: the beat carries on where it was.
window.addEventListener('synth:tempo', ({ detail: bpm }) => {
 if (keepers.sequencer) keepers.sequencer.bpm = bpm;
 if (clock.source === 'sequencer') clock.setTempo(bpm, performance.now());
});

// An incoming MIDI clock, followed while Sync to MIDI clock is on: the beat comes from its ticks, the session
// tempo follows it (to a tenth of a BPM), and a metronome that is on clicks on its beats instead of its own.
let midiQuiet = null, clicking = false;
const midiStopped = () => {
 timing.midi.stop(); clearTimeout(midiQuiet);
 if (clock.source === 'midi') { clock.stop('midi'); timing.watch.reset(); }
 if (clicking) { clicking = false; window.synth?.resumeClick(); }
 follow(); emit('clock', clock.source); render();
};
window.addEventListener('synth:midi-clock', ({ detail: { type, time } }) => {
 if (!timing.sync) return;
 if (type === 'stop') return midiStopped();
 if (type === 'start') timing.midi.start(time);
 else if (type === 'continue') timing.midi.continue(time);
 else {
  const r = timing.midi.tick(time);
  clearTimeout(midiQuiet); midiQuiet = setTimeout(midiStopped, 600); // ticks stopped without a Stop
  if (!r) return;
  const was = clock.source;
  clock.start('midi', r.bpm, r.origin);
  if (was !== 'midi') { timing.watch.reset(); emit('clock', 'midi'); }
  if (r.onBeat) {
   const bpm = Math.round(r.bpm * 10) / 10;
   if (window.synth && Math.abs(window.synth.tempo - bpm) >= 0.1) window.synth.tempo = bpm;
   if (window.synth?.metronome || clicking) { if (!clicking) { clicking = true; window.synth.suspendClick(); } window.synth.click(); }
  }
 }
});

/* ---- Every note ---- */

let lastEvent = -Infinity;
window.addEventListener('synth:note', ({ detail: { midi, velocity, on, source = '', time } }) => {
 if (!on || !PLAYED.test(source) || !timing.on) return;
 const t = time ?? performance.now(), chord = Math.abs(t - lastEvent) < 40; // a MIDI time stamp can come in just before a key's
 if (!chord) lastEvent = t;
 // The player's own pulse: set up from their first notes, gone after two bars of silence, and following them
 // (half the way to each note), so a tempo they change on purpose becomes the beat.
 if (clock.source === 'free' && t - (timing.onsets.at(-1)?.time ?? t) > clock.period * 8) clock.stop('free');
 let offsetMs = null, at = null;
 if (clock.running) { const n = clock.nearest(t, timing.level.grid); offsetMs = n.offsetMs; at = n.at; }
 const onset = { time: t, note: midi, velocity: Math.round(velocity * 127), offsetMs, at, grade: offsetMs === null ? null : grade(offsetMs, timing.level), chord, source: clock.source };
 timing.onsets.push(onset); if (timing.onsets.length > 256) timing.onsets.shift();
 if (!chord && !clock.external) {
  const recent = eventTimes(timing.onsets.filter(o => t - o.time < 8000).map(o => o.time)), est = estimateTempo(recent);
  if (est && clock.source === 'free') { clock.setTempo(est.bpm, t); clock.origin += (offsetMs ?? 0) * 0.5; }
  else if (est && !clock.running) { clock.start('free', est.bpm, t); emit('clock', 'free'); }
 }
 if (!chord) {
  if (onset.grade) flash(onset.grade);
  const flag = timing.watch.note(t, clock);
  if (flag) emit('flag', flag);
 }
 emit('note', onset);
 renderReadout(); wake();
});

function flash(g) {
 const line = document.querySelector('#keyboard-module .synthesia-hit-line');
 if (!line) return;
 line.classList.remove('hit-good', 'hit-ok', 'hit-off'); void line.offsetWidth;
 line.classList.add(`hit-${g}`);
 clearTimeout(line._t); line._t = setTimeout(() => line.classList.remove(`hit-${g}`), 220);
}

/* ---- The strip under the keys ---- */

let canvas = null, readout = null, frame = 0, drawing = false, colors = null;
const wake = () => { if (!drawing && canvas && timing.on) { drawing = true; requestAnimationFrame(draw); } };
function render() { wake(); renderReadout(); }

// The last two bars (four seconds with no beat) scroll past: beat lines, stronger at each bar, the moment now
// near the right with the next beats ahead of it, and a dot for each note, joined to the line it was nearest
// by a stroke as long as it was early or late.
function draw() {
 drawing = false;
 if (!canvas || !timing.on || !canvas.isConnected) return;
 const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
 if (!w) return;
 if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
 const g = canvas.getContext('2d'), now = performance.now(), span = clock.running ? clock.period * 8 : 4000, left = now - span * 0.85;
 const x = t => ((t - left) / span) * w;
 g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
 if (!colors || frame % 60 === 0) { const css = getComputedStyle(canvas); colors = { muted: css.getPropertyValue('--text-muted-color') || '#888', accent: css.getPropertyValue('--accent-color') || '#0ff' }; } // the theme's, looked up now and then
 const { muted, accent } = colors;
 if (clock.running) {
  for (let b = Math.floor(clock.beatAt(left)); clock.timeOf(b) < left + span; b++) {
   const bar = ((b % clock.beatsPerBar) + clock.beatsPerBar) % clock.beatsPerBar === 0;
   g.globalAlpha = bar ? 0.8 : 0.5; g.fillStyle = muted; g.fillRect(Math.round(x(clock.timeOf(b))), bar ? 3 : 8, bar ? 2 : 1, h - (bar ? 6 : 16));
  }
 }
 g.globalAlpha = 0.9; g.fillStyle = accent; g.fillRect(Math.round(x(now)), 2, 2, h - 4);
 let dots = 0;
 for (const o of timing.onsets) {
  if (o.time < left || o.chord) continue;
  const cx = x(o.time), cy = h / 2, color = COLORS[o.grade] || COLORS.free;
  if (o.offsetMs !== null) { g.globalAlpha = 0.8; g.strokeStyle = color; g.lineWidth = 2; g.beginPath(); g.moveTo(cx, cy); g.lineTo(x(o.time - o.offsetMs), cy); g.stroke(); }
  g.globalAlpha = 1; g.fillStyle = color; g.beginPath(); g.arc(cx, cy, 3 + (o.velocity / 127) * 3, 0, Math.PI * 2); g.fill();
  dots++;
 }
 g.globalAlpha = 1; timing.drawn = dots;
 if (++frame % 10 === 0) renderReadout();
 // Keep going while there is a beat or a dot to scroll by.
 if (clock.running || timing.onsets.some(o => o.time > left)) wake();
}

const ARROW = { rushing: '↑', dragging: '↓' };
function renderReadout() {
 if (!readout) return;
 const src = { metronome: 'metronome', sequencer: 'sequencer', midi: 'MIDI clock', free: 'your pulse' }[clock.source];
 const actual = timing.watch.actual, drift = actual && clock.external ? actual / clock.bpm - 1 : 0;
 const state = drift > timing.watch.threshold ? 'rushing' : drift < -timing.watch.threshold ? 'dragging' : '';
 readout.querySelector('.timing-source').textContent = src ? `♩ ${Math.round(clock.bpm * 10) / 10} · ${src}` : 'Play along with the metronome, the sequencer or a MIDI clock, or just play: your own pulse becomes the beat.';
 const you = readout.querySelector('.timing-tempo');
 you.textContent = clock.external && actual ? `you ${Math.round(actual)} ${ARROW[state] || '='}` : '';
 you.dataset.state = state;
 you.title = state ? `You are ${state}` : 'On tempo';
}

// The Timing switch and Difficulty in the Keyboard's toolbar, the strip under its keys, and Sync to MIDI
// clock in Metronome & Tempo.
export function mountTiming(keyboardModule, metronomeGroup) {
 const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
 const toggle = el('input', { type: 'checkbox', id: 'timingToggle', checked: timing.on });
 const level = el('select', { id: 'timingLevel' }, ...Object.entries(DIFFICULTY).map(([id, d]) => el('option', { value: id, textContent: d.label })));
 level.value = timing.levelId;
 level.setAttribute('aria-label', 'Timing difficulty');
 const bar = keyboardModule.querySelector('.keyboard-toolbar');
 bar.append(el('label', {}, toggle, ' Timing'), el('label', { className: 'timing-level' }, 'Difficulty ', level));
 canvas = el('canvas', { className: 'timing-canvas' });
 canvas.setAttribute('aria-hidden', 'true');
 readout = el('div', { className: 'timing-readout', role: 'status' }, el('span', { className: 'timing-source' }), el('span', { className: 'timing-tempo' }), el('span', { className: 'timing-nudge', hidden: true }));
 const strip = el('div', { className: 'timing-strip', hidden: !timing.on }, canvas, readout);
 keyboardModule.append(strip);
 toggle.onchange = () => { timing.on = toggle.checked; save('timing-on-v1', timing.on); strip.hidden = !timing.on; level.closest('label').hidden = !timing.on; if (!timing.on) timing.watch.reset(); render(); };
 level.closest('label').hidden = !timing.on;
 level.onchange = () => { timing.levelId = level.value; save('timing-level-v1', level.value); };
 const sync = el('input', { type: 'checkbox', id: 'midiClockSync', checked: timing.sync });
 sync.onchange = () => { timing.sync = sync.checked; save('midi-clock-sync-v1', timing.sync); if (!timing.sync) midiStopped(); };
 metronomeGroup?.querySelector('.metronome-controls')?.append(el('label', { className: 'midi-sync', title: 'Follow the tempo and beat of a MIDI clock from your DAW or drum machine' }, sync, ' Sync to MIDI clock'));
 new ResizeObserver(() => wake()).observe(canvas);
 timing.subscribe(type => { if (type === 'clock') render(); });
 render();
}
