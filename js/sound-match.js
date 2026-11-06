// The Sound match widget: a patch for the synth that sounds like a recorded note (js/patch-infer.js). Record one
// note from the Listening widget's input, drop an audio file on it, or send a clip from Import / Export (its
// Match this sound); it reads the note, finds a patch, and says how close it got. ▶ A plays the recording, ▶ B
// the patch at the same pitch, so they can be compared; Apply puts the patch on the synth (oscillators,
// envelope, filter), and Undo puts the old one back.
import { inferPatch, renderPatch, describePatch } from './patch-infer.js';
import { decodeAudioFile, AUDIO_EXTENSIONS } from './audio-files.js';
import { listening } from './listening.js';
import { el, card } from './plugin-ui.js';

const $ = id => document.getElementById(id);
const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const SCI = m => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;
const fire = (e, ...types) => types.forEach(t => e.dispatchEvent(new Event(t, { bubbles: true })));

// The synth's patch as patch-infer reads it, and put back.
export function currentPatch() { const p = window.synth.params(); return { oscillators: p.oscillators.map(({ id, ...o }) => o), adsr: { ...p.adsr }, filter: { ...p.filter } }; }
export function applyPatch(patch) {
 window.oscillatorBank.set(patch.oscillators);
 const set = (id, v) => { const e = $(id); if (!e) return; if (e.type === 'checkbox') { if (e.checked !== v) { e.checked = v; fire(e, 'change'); } } else { e.value = v; fire(e, 'input', 'change'); } };
 set('enableAdsr', patch.adsr.enabled); set('attack', patch.adsr.attack); set('decay', patch.adsr.decay); set('sustain', patch.adsr.sustain); set('release', patch.adsr.release);
 set('enableFilter', patch.filter.enabled); set('filterType', patch.filter.type); set('filterCutoff', Math.round(patch.filter.cutoff)); set('filterResonance', patch.filter.resonance);
}

export const soundMatch = {
 take: null, // { samples, sampleRate, name }
 result: null, // the last inferPatch result
 undo: null,
 listeners: new Set(),
 emit() { this.listeners.forEach(fn => fn(this)); },
 // Reads a note (mono samples) and finds its patch.
 async match(samples, sampleRate, name = 'the recording', onProgress = () => {}) {
  this.take = { samples, sampleRate, name }; this.result = null; this.error = ''; this.busy = true; this.emit();
  try { this.result = await inferPatch(samples, sampleRate, { onProgress }); return this.result; }
  catch (err) { this.error = err.message; throw err; }
  finally { this.busy = false; this.emit(); }
 },
 // Records one note from the Listening widget's input: from the first sound to when it fades (at most 4 s).
 async record({ seconds = 4, onState = () => {} } = {}) {
  if (!listening.active && !(await listening.start())) throw new Error(listening.error || 'The microphone didn\'t open.');
  const rec = await listening.record();
  onState('Play or sing one note…');
  const t0 = performance.now();
  let heard = null;
  while (performance.now() - t0 < seconds * 1000) {
   await new Promise(r => setTimeout(r, 50));
   const db = listening.last?.db ?? -180;
   if (db > listening.settings.gateDb + 6) heard ??= performance.now();
   else if (heard && performance.now() - heard > 400 && db < listening.settings.gateDb) break; // it has faded
  }
  const { samples, sampleRate } = await rec.stop();
  if (!heard) throw new Error('No note was heard: play or sing one, a little louder.');
  return { samples, sampleRate };
 },
 apply() {
  if (!this.result) throw new Error('Find a patch first.');
  const was = currentPatch();
  applyPatch(this.result.patch);
  this.undo = () => { applyPatch(was); this.undo = null; this.emit(); };
  this.emit();
  return { text: `the synth's patch is now the match: ${describePatch(this.result.patch)}`, undo: this.undo };
 },
 // Plays the recording (A) or the patch at its pitch (B) to the speakers, through the master volume.
 async play(which) {
  const ctx = window.synth.ensureAudio();
  await ctx.resume();
  let x = this.take?.samples, rate = this.take?.sampleRate;
  if (which === 'B') { const r = this.result; if (!r) return; x = await renderPatch(r.patch, { hz: r.analysis.hz, hold: r.analysis.hold, sampleRate: rate }); }
  if (!x) return;
  this.source?.stop?.();
  const b = ctx.createBuffer(1, x.length, rate); b.copyToChannel(x, 0);
  const src = this.source = new AudioBufferSourceNode(ctx, { buffer: b });
  src.connect(window.synth.instrumentInput); src.start();
  this.playing = which; this.emit();
  src.onended = () => { if (this.source === src) { this.playing = null; this.emit(); } };
 },
};

export function createSoundMatch() {
 const { section, content } = card('sound-match-module', 'Sound match');
 section.classList.remove('wide'); delete section.dataset.wide;
 const record = el('button', { type: 'button', id: 'match-record', className: 'std-button', textContent: '● Record a note' });
 const status = el('p', { className: 'listen-status', role: 'status', textContent: 'Record one note (or drop a short audio file here), and the synth finds a patch that sounds like it.' });
 const bar = el('div', { className: 'listen-meter' }, el('div', { className: 'listen-meter-fill' }));
 const read = el('p', { className: 'module-hint match-read' }), result = el('p', { className: 'match-result' });
 const a = el('button', { type: 'button', id: 'match-a', textContent: '▶ A: the recording', disabled: true }), b = el('button', { type: 'button', id: 'match-b', textContent: '▶ B: the patch', disabled: true });
 const apply = el('button', { type: 'button', id: 'match-apply', className: 'tp-primary', textContent: 'Apply to the synth', disabled: true }), undo = el('button', { type: 'button', id: 'match-undo', textContent: 'Undo', hidden: true });
 content.append(el('div', { className: 'sequence-toolbar' }, record), status, bar, read, result, el('div', { className: 'sequence-toolbar' }, a, b, apply, undo));
 const fill = bar.firstChild;
 const progress = f => { fill.style.width = `${Math.round(f * 100)}%`; status.textContent = `Finding the patch… ${Math.round(f * 100)}%`; };
 const render = s => {
  a.disabled = !s.take; b.disabled = apply.disabled = !s.result || s.busy; record.disabled = !!s.busy;
  undo.hidden = !s.undo;
  a.textContent = s.playing === 'A' ? '■ A: the recording' : '▶ A: the recording'; b.textContent = s.playing === 'B' ? '■ B: the patch' : '▶ B: the patch';
  const r = s.result;
  if (s.error) { status.textContent = s.error; status.classList.add('error'); return; }
  status.classList.remove('error');
  if (r) {
   const n = r.analysis, ms = v => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
   read.textContent = `Heard ${SCI(n.midi)} (${n.hz.toFixed(1)} Hz) from ${s.take.name}: attack ${ms(n.adsr.attack)}, decay ${ms(n.adsr.decay)}, sustain ${Math.round(n.adsr.sustain * 100)}%, release ${ms(n.adsr.release)}, ${n.brightness > 4 ? 'bright' : n.brightness > 2 ? 'mellow' : 'dark'}${n.noise > 0.25 ? ', breathy' : ''}.`;
   result.textContent = `Match ${r.match}% (the first guess was ${r.guessMatch}%, after ${r.tried} tries). ${describePatch(r.patch)}`;
   status.textContent = 'Compare A and B, then Apply to play it from the keyboard.';
   fill.style.width = '100%';
  }
 };
 soundMatch.listeners.add(render);
 const run = async (samples, sampleRate, name) => {
  read.textContent = ''; result.textContent = '';
  try { await soundMatch.match(samples, sampleRate, name, progress); } catch { /* shown */ }
 };
 record.onclick = async () => {
  record.disabled = true; soundMatch.error = '';
  try { const t = await soundMatch.record({ onState: text => { status.textContent = text; } }); await run(t.samples, t.sampleRate, 'your note'); }
  catch (err) { soundMatch.error = err.message; soundMatch.emit(); }
  finally { record.disabled = false; }
 };
 a.onclick = () => (soundMatch.playing === 'A' ? soundMatch.source?.stop() : soundMatch.play('A'));
 b.onclick = () => (soundMatch.playing === 'B' ? soundMatch.source?.stop() : soundMatch.play('B'));
 apply.onclick = () => { soundMatch.apply(); status.textContent = 'Applied: play the keyboard to hear it. Undo puts the old patch back.'; };
 undo.onclick = () => { soundMatch.undo?.(); status.textContent = 'The old patch is back.'; };
 // A dropped file, or a clip sent from Import / Export (synth:match-sound with { channels, sampleRate, name }).
 const mono = channels => (channels.length > 1 ? Float32Array.from(channels[0], (v, i) => channels.reduce((s, c) => s + c[i], 0) / channels.length) : channels[0]);
 section.addEventListener('dragover', e => { e.preventDefault(); section.classList.add('drop-target'); });
 section.addEventListener('dragleave', () => section.classList.remove('drop-target'));
 section.addEventListener('drop', async e => {
  e.preventDefault(); section.classList.remove('drop-target');
  const file = [...e.dataTransfer.files].find(f => AUDIO_EXTENSIONS.test(f.name) || f.type.startsWith('audio/'));
  if (!file) { status.textContent = 'Drop an audio file of one note.'; return; }
  try { const audio = await decodeAudioFile(new Uint8Array(await file.arrayBuffer()), window.synth.ensureAudio()); await run(mono(audio.channels), audio.sampleRate, file.name.replace(/\.[^.]+$/, '')); }
  catch (err) { status.textContent = `Could not read ${file.name}: ${err.message}`; }
 });
 window.addEventListener('synth:match-sound', ({ detail }) => { section.scrollIntoView({ block: 'nearest' }); run(mono(detail.channels), detail.sampleRate, detail.name); });
 return section;
}
