// What the other widgets do with the Listening widget's input (js/listening.js):
// - Step sequencer › Record from audio: sing or play a bar against the beat (a bar of count-in first if the
//   metronome wasn't on), and each note lands on its sixteenth and on the nearest row of the key and scale; a
//   clap lands on the tonic. The pattern it replaces can be had back with Undo.
// - Loop recorder › Record: Notes keeps what you sing as notes, played back through the patch they were sung
//   with (as any played note is); Audio keeps the sound itself, beat-quantised like any loop, and plays it
//   from the start of each cycle.
// - Oscilloscope › Input (Listening): the input's waveform, with the detected note and a tick every period.
import { listening } from './listening.js';
import { timing } from './timing-widget.js';
import { NOTE_NAMES } from './pitch-analyzer.js';
import { el } from './plugin-ui.js';
import { read, save } from './storage.js';

const toMidi = note => Number(note.match(/-?\d+$/)[0]) * 12 + NOTE_NAMES.indexOf(note.replace(/-?\d+$/, '')); // synth naming: "C5" is 60
const wait = ms => new Promise(r => setTimeout(r, ms));
const SCI = midi => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

// Notes heard in a bar onto the sequencer's grid: each note's step is its sixteenth, its row the nearest row once
// moved by octaves into the rows' range (a voice an octave below the grid still lands on it), a clap the tonic.
export function gridFrom(heard, rows, barStart, beatMs, steps = 16) {
 const rowMidi = rows.map(toMidi), lo = rowMidi[0], hi = rowMidi.at(-1), sixteenth = beatMs / 4;
 const pattern = rows.map(() => Array(steps).fill(false));
 let placed = 0;
 for (const n of heard) {
  const step = Math.round((n.time - barStart) / sixteenth);
  if (step < 0 || step >= steps) continue;
  let row = 0;
  if (!n.clap) {
   let m = n.midi;
   while (m < lo - 6) m += 12;
   while (m > hi + 6) m -= 12;
   row = rowMidi.reduce((best, r, i) => (Math.abs(r - m) < Math.abs(rowMidi[best] - m) ? i : best), 0);
  }
  if (!pattern[row][step]) placed++;
  pattern[row][step] = true;
 }
 return { pattern, placed };
}

// `root` is the workspace, which isn't in the page yet when this runs.
export function mountListenTools(sequencer, root = document) {
 /* ---- Step sequencer › Record from audio ---- */
 const seq = root.querySelector('#step-sequencer'), toolbar = seq?.querySelector('.sequence-toolbar');
 const record = el('button', { id: 'seq-record', textContent: '● Record from audio', title: 'Sing or play one bar into the microphone: it becomes the pattern, on sixteenths, in the key and scale' });
 const undo = el('button', { id: 'seq-record-undo', textContent: 'Undo recording', hidden: true });
 const status = el('span', { className: 'module-hint seq-record-status', role: 'status' });
 toolbar?.append(record, undo, status);
 let before = null;
 const clockReady = () => new Promise(r => { const go = () => (timing.clock.external ? r() : setTimeout(go, 20)); go(); });
 record.onclick = async () => {
  record.disabled = true;
  try {
   if (!listening.active && !(await listening.start())) { status.textContent = listening.error; return; }
   if (sequencer.running) sequencer.stop();
   const m = document.getElementById('metronomeToggle'), countIn = !timing.clock.external;
   if (countIn && !m.checked) m.click();
   await clockReady();
   const clock = timing.clock, now = performance.now(), bar = clock.beatsPerBar;
   const first = Math.ceil((clock.beatAt(now) + (countIn ? bar : 0.5)) / bar) * bar, barStart = clock.timeOf(first), beatMs = clock.period;
   const heard = [], take = ({ detail: d }) => { if (d.on && d.source?.startsWith('audio')) heard.push({ midi: d.midi, time: d.time, clap: d.source === 'audio-clap' }); };
   window.addEventListener('synth:note', take);
   record.dataset.barStart = barStart; // for whoever drives it (the tests, the teacher)
   while (performance.now() < barStart + bar * beatMs) {
    const left = barStart - performance.now();
    status.textContent = left > 0 ? `Count-in: sing from the next bar (${Math.ceil(left / beatMs)})…` : `Recording: beat ${Math.min(bar, Math.floor(-left / beatMs) + 1)} of ${bar}…`;
    await wait(50);
   }
   await wait(250); // the last note is known a little after it was sung
   window.removeEventListener('synth:note', take);
   const { pattern, placed } = gridFrom(heard, sequencer.notes, barStart, beatMs);
   if (!placed) { status.textContent = 'Nothing was heard in that bar. Try again, a little louder.'; return; }
   before = sequencer.pattern.map(r => [...r]);
   sequencer.setPattern(pattern);
   undo.hidden = false;
   status.textContent = `Recorded ${placed} note${placed === 1 ? '' : 's'} from audio into the pattern.`;
  } catch (err) { status.textContent = err.message; } finally { record.disabled = false; }
 };
 undo.onclick = () => { if (before) { sequencer.setPattern(before); before = null; } undo.hidden = true; status.textContent = 'The pattern is back as it was.'; };

 /* ---- Loop recorder › Record: Notes or Audio ---- */
 const looper = root.querySelector('#launchpadLooperContainer');
 const kind = el('select', { id: 'looper-record-kind' }, el('option', { value: 'notes', textContent: 'Notes (play back through their patch)' }), el('option', { value: 'audio', textContent: 'Audio heard by Listening' }));
 kind.setAttribute('aria-label', 'What a loop records');
 kind.value = read('looper-record-kind-v1', 'notes');
 window.synth.loopKind = kind.value;
 kind.onchange = () => { window.synth.loopKind = kind.value; save('looper-record-kind-v1', kind.value); };
 const loopStatus = el('span', { className: 'module-hint', role: 'status' });
 looper?.before(el('div', { className: 'sequence-toolbar looper-kind' }, el('label', {}, 'Record ', kind), loopStatus));
 const takes = new Map();
 window.addEventListener('synth:loop-record', async ({ detail: { id, on, at, duration } }) => {
  if (on) {
   takes.set(id, (async () => {
    if (!listening.active && !(await listening.start())) throw new Error(listening.error);
    return listening.record();
   })());
   takes.get(id).catch(err => { loopStatus.textContent = err.message; });
   return;
  }
  const pending = takes.get(id);
  takes.delete(id);
  if (!pending) return;
  try {
   const handle = await pending;
   await wait(Math.max(0, listening.latencyMs) + 30); // the end of the bar is still on its way in
   const { samples, sampleRate, at: first } = await handle.stop();
   const from = Math.round(((at - first) / 1000) * sampleRate), length = Math.round((duration / 1000) * sampleRate);
   const ctx = window.synth.context, buffer = ctx.createBuffer(1, Math.max(1, length), sampleRate), out = buffer.getChannelData(0);
   for (let i = 0; i < length; i++) { const j = from + i; out[i] = j >= 0 && j < samples.length ? samples[j] : 0; }
   window.synth.setLoopAudio(id, buffer);
   loopStatus.textContent = `Slot ${id + 1}: ${(duration / 1000).toFixed(1)} s of audio.`;
  } catch (err) { loopStatus.textContent = err.message; window.synth.setLoopAudio(id, null); }
 });

 /* ---- Oscilloscope › Input (Listening) ---- */
 window.synth.scopeOverlay = (g, w, h, analyser) => {
  g.save(); g.shadowBlur = 0;
  g.font = `600 ${Math.max(11, Math.round(h / 9))}px Poppins, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'top';
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() || '#0ff';
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim() || '#fff';
  const p = listening.last?.pitch;
  if (!analyser) g.fillText('Input: not listening (press 🎙 Listen)', 10, 8);
  else if (p?.voiced && p.midi !== null) {
   g.fillText(`Input · ${SCI(p.midi)} ${p.cents >= 0 ? '+' : '−'}${Math.abs(Math.round(p.cents))}¢ · ${p.hz.toFixed(1)} Hz`, 10, 8);
   // A tick every period of the detected pitch, across the window the scope shows.
   const period = (analyser.context.sampleRate / p.hz) * (w / analyser.fftSize);
   g.strokeStyle = accent; g.globalAlpha = 0.35; g.lineWidth = 1;
   for (let x = period; x < w && period > 3; x += period) { g.beginPath(); g.moveTo(x, h - 14); g.lineTo(x, h); g.stroke(); }
  } else g.fillText(`Input · ${listening.label || 'listening'}`, 10, 8);
  g.restore();
 };
}
