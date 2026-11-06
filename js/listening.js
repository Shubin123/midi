// Audio In: the microphone, an audio interface or a clip, listened to and played into the app as a MIDI keyboard
// would play it. The worklet (js/listen-worklet.js) sends a frame of level and pitch every 5 ms; here the
// frames become notes (NoteTracker, js/listen-dsp.js), stamped with when they were sung, and go to the synth's
// input (window.synth.input) as note-ons and note-offs from the source 'audio'. From there they light the keys,
// fall, are recorded by an armed loop slot, and reach the teacher and the beat clock like any played note.
//
// Timing: a sound reaches the worklet some time after it was made (the round trip from the speakers through
// the room and the interface back into the page). Calibrate measures it by playing clicks and hearing them
// back; until then it is estimated from what the browser reports. Every note is stamped that much earlier,
// so it lands on the beat it was sung on.
//
// Feedback: on speakers, the microphone hears the app too. Notes the app is sounding itself (the keyboard, the
// sequencer, a loop, the teacher's examples) are followed but not sent, and what you sing stays silent. With
// headphones on there is nothing to hear back, so what you sing can also play through the synth.
import { NoteTracker, OnsetDetector, frameSizes, timed, snapToScale, roundTrip } from './listen-dsp.js';
import { SCALES } from './sequencer.js';
import { timing } from './timing-widget.js';
import { read, save } from './storage.js';

const KEY = 'listening-v1';
// Melody: notes, as a keyboard sends them. Rhythm only: every clap, tap or hit is an onset with no pitch (source
// 'audio-clap'), for rhythm exercises: the beat clock grades it and the teacher reads the phrase's rhythm.
export const MODES = { melody: 'Melody (one note at a time)', rhythm: 'Rhythm only (claps and taps)' };
export const CLAP = 0; // the note number a clap is sent as: nothing plays it, and the teacher reads it as a clap
const DEFAULTS = { deviceId: '', mode: 'melody', snap: false, headphones: false, playThrough: false, gateDb: -50, latencyMs: null, inputGain: 1, clapTempo: false, clickDb: null };
const listeners = new Set();
const emit = (type, detail) => listeners.forEach(fn => { try { fn(type, detail); } catch (err) { console.error(err); } });

// The step sequencer's key and scale, which snapping follows.
export function keyAndScale() {
 const key = Number(document.getElementById('seq-key')?.value ?? 0), scale = document.getElementById('seq-scale')?.value || 'Chromatic';
 return { key, scale, intervals: SCALES[scale] || SCALES.Chromatic };
}

export const listening = {
 settings: { ...DEFAULTS, ...read(KEY, {}) },
 active: false, kind: null, label: '', error: '',
 nodes: null, stream: null,
 tracker: null, sizes: null,
 last: null, // the latest frame, with the tracker's pitch: for the meter, the tuner and the pitch trail
 trail: [], // { t, semis, cents, clarity } for the last few seconds
 held: new Set(), // notes sent on and not yet off
 take: [], // the performance so far: { midi, velocity, start, end } (ms, the page's clock), the latest 2000 notes
 // fn(type, detail): 'state', 'frame', 'note' ({ type, midi, velocity, time }).
 subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
 set(changes) { Object.assign(this.settings, changes); save(KEY, this.settings); this._configure(); emit('state', this.state()); },
 state() { return { active: this.active, kind: this.kind, label: this.label, error: this.error, latencyMs: this.latencyMs, measured: this.settings.latencyMs !== null, ...this.settings }; },

 // The round trip in ms: measured, or what the browser reports (output, plus the input's own latency or 10 ms).
 get latencyMs() {
  if (this.settings.latencyMs !== null) return this.settings.latencyMs;
  const ctx = window.synth?.context, track = this.stream?.getAudioTracks()[0];
  const out = ctx ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0, input = track?.getSettings?.().latency;
  return this.kind === 'mic' ? Math.round((out + (Number.isFinite(input) ? input : 0.01)) * 1000) : 0;
 },
 get silent() { return !(this.settings.headphones && this.settings.playThrough); },

 async devices() {
  const all = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) || [];
  return all.filter(d => d.kind === 'audioinput');
 },

 // Opens the microphone (or the chosen input) and listens. Echo cancellation, noise suppression and automatic
 // gain are off: they are made for speech and smear or duck music.
 async start({ deviceId = this.settings.deviceId } = {}) {
  this.error = '';
  if (!navigator.mediaDevices?.getUserMedia) return this._fail('This browser can\'t open a microphone here (it needs a secure page, https or localhost). MIDI and the keyboard still work.');
  let stream;
  try {
   stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (err) {
   const why = err.name === 'NotAllowedError' || err.name === 'SecurityError' ? 'Microphone access was denied.' : err.name === 'NotFoundError' || err.name === 'OverconstrainedError' ? 'That input isn\'t connected.' : `The microphone didn't open (${err.message || err.name}).`;
   return this._fail(`${why} MIDI and the keyboard still work.`);
  }
  const ctx = window.synth.ensureAudio();
  const ok = await this._open(ctx.createMediaStreamSource(stream), 'mic', stream.getAudioTracks()[0]?.label || 'Microphone');
  if (!ok) { stream.getTracks().forEach(t => t.stop()); return false; }
  this.stream = stream;
  stream.getAudioTracks()[0]?.addEventListener('ended', () => this.stop());
  emit('state', this.state());
  return true;
 },
 // Listens to any audio node instead: a clip playing, or a test's signal.
 async listenTo(node, label = 'a clip', kind = 'clip') { return this._open(node, kind, label); },

 async _open(source, kind, label) {
  this.stop(false);
  const ctx = window.synth.ensureAudio();
  try {
   await ctx.resume();
   if (!ctx.audioWorklet) throw new Error('This browser has no AudioWorklet.');
   if (!this._loaded?.has(ctx)) { await ctx.audioWorklet.addModule(new URL('./listen-worklet.js', import.meta.url)); (this._loaded ||= new WeakSet()).add(ctx); }
  } catch (err) { this._fail(`Listening can't start: ${err.message}. MIDI and the keyboard still work.`); return false; }
  const gain = new GainNode(ctx, { gain: this.settings.inputGain });
  const scope = new AnalyserNode(ctx, { fftSize: 2048 });
  const worklet = new AudioWorkletNode(ctx, 'listen-tracker', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const sink = new GainNode(ctx, { gain: 0 });
  source.connect(gain); gain.connect(scope); gain.connect(worklet); worklet.connect(sink).connect(ctx.destination);
  this.nodes = { ctx, source, gain, scope, worklet, sink };
  window.synth.inputScope = scope; // the oscilloscope's Input (Listening)
  this.sizes = frameSizes(ctx.sampleRate);
  this.tracker = new NoteTracker({ gateDb: this.settings.gateDb });
  this.claps = new OnsetDetector({ gateDb: this.settings.gateDb, minGapMs: 70 });
  this._configure();
  worklet.port.onmessage = ({ data }) => this._frames(data);
  Object.assign(this, { active: true, kind, label, error: '' });
  emit('state', this.state());
  return true;
 },

 stop(announce = true) {
  this._releaseAll(performance.now());
  if (this.nodes) {
   const { source, gain, worklet, sink } = this.nodes;
   worklet.port.postMessage('stop'); worklet.port.onmessage = null;
   [source, gain, worklet, sink].forEach(n => { try { n.disconnect(); } catch { /* already */ } });
  }
  this.stream?.getTracks().forEach(t => t.stop());
  Object.assign(this, { nodes: null, stream: null, active: false, kind: null, label: '' });
  if (window.synth) window.synth.inputScope = null;
  this.last = null;
  if (announce) emit('state', this.state());
 },

 _fail(message) { this.error = message; emit('state', this.state()); return false; },

 _configure() {
  const s = this.settings;
  if (this.nodes) this.nodes.gain.gain.value = s.inputGain;
  if (!this.tracker) return;
  this.tracker.gateDb = this.tracker.onsets.gateDb = this.claps.gateDb = s.gateDb;
  this.tracker.snap = s.snap ? semis => { const { key, intervals } = keyAndScale(); return snapToScale(semis, key, intervals); } : null;
  this.tracker.ignore = midi => !s.headphones && this._sounding(midi);
 },

 // Notes the app itself is sounding, or let go of within its release: on speakers the mic hears those, in any
 // octave (an oscillator an octave or two down makes the whole sound read that low).
 _app: new Map(),
 _sounding(midi) {
  const now = performance.now();
  for (const [m, until] of this._app) if (until >= now && (m - midi) % 12 === 0) return true;
  return false;
 },

 _frames(frames) {
  const ctx = this.nodes?.ctx;
  if (!ctx || !frames.length) return;
  // Frame numbers to the page's clock at the moment the sound was made: when it would have been heard, less
  // the round trip.
  const ref = frames[0].end, rate = ctx.sampleRate, refMs = window.synth.perfTimeOf(ref / rate - this.latencyMs / 1000);
  const toMs = frame => refMs + ((frame - ref) / rate) * 1000;
  const rhythm = this.settings.mode === 'rhythm';
  for (const raw of frames) {
   const f = timed(raw, this.sizes, toMs);
   let onset = null;
   if (rhythm) { onset = this.claps.push(f); if (onset !== null) this._clap(onset, f); this.tracker.pitch = { semis: null, midi: null, cents: 0, clarity: f.clarity, voiced: false, hz: 0, db: f.db }; }
   else { for (const e of this.tracker.push(f)) this._send(e); onset = this.tracker.onset; }
   if (onset !== null && this.settings.clapTempo && !this._isClick(onset, f)) window.synth.tap(onset);
   const p = this.tracker.pitch;
   this.last = { ...f, pitch: p };
   if (p.voiced) this.trail.push({ t: f.tPitch, semis: p.semis, cents: p.cents, midi: p.midi });
  }
  while (this.trail.length && this.trail.at(-1).t - this.trail[0].t > 4000) this.trail.shift();
  emit('frame', this.last);
 },

 _send(e) {
  if (e.type === 'on') { if (this.held.has(e.midi)) window.synth.input(e.midi, false, { time: e.time }); this.held.add(e.midi); }
  else if (!this.held.delete(e.midi)) return;
  window.synth.input(e.midi, e.type === 'on', { velocity: e.velocity, time: e.time, silent: this.silent });
  if (e.type === 'on') { this.take.push({ midi: e.midi, velocity: e.velocity, start: e.time, end: null }); if (this.take.length > 2000) this.take.shift(); }
  else { const n = this.take.findLast(x => x.midi === e.midi && x.end === null); if (n) n.end = e.time; }
  emit('note', e);
 },
 _releaseAll(time) {
  if (this.tracker) for (const e of this.tracker.flush(time)) this._send(e);
  for (const midi of [...this.held]) this._send({ type: 'off', midi, velocity: 0, time });
  this.tracker?.reset(); this.claps?.reset();
 },

 // A clap (rhythm only): sent as a note the synth doesn't play or show, held for 80 ms, from the time it was
 // made. On speakers a metronome click heard back isn't one.
 _clap(time, f) {
  if (this._isClick(time, f)) return;
  const velocity = Math.max(0.1, Math.min(1, 0.2 + ((f.db - this.settings.gateDb) / 45) * 0.8));
  const send = (on, t) => window.dispatchEvent(new CustomEvent('synth:note', { detail: { note: '', midi: CLAP, velocity: on ? velocity : 0, on, source: 'audio-clap', silent: true, time: t } }));
  send(true, time);
  setTimeout(() => send(false, time + 80), 80);
  emit('clap', { time, velocity });
 },
 // On speakers, with the metronome clicking, an onset within 30 ms of a beat no louder than a click sounds here
 // is the click coming back. How loud that is comes from calibration; until then nothing is taken for a click.
 _isClick(time, f) {
  if (this.settings.headphones || this.settings.clickDb === null || !window.synth?.metronome || !timing.clock.external) return false;
  return Math.abs(timing.clock.nearest(time, 1).offsetMs) <= 30 && f.db < this.settings.clickDb + 6;
 },

 // Plays clicks and hears them back: the round trip, in ms. On speakers, keep quiet while it listens; on
 // headphones the mic can't hear the clicks, so clap along with them instead (your own reaction is then
 // part of what is measured, as rhythm games do). Returns { ms, spread, heard } or null.
 async calibrate({ clicks = 8, gapMs = 400 } = {}) {
  if (!this.nodes) throw new Error('Start listening first.');
  const { ctx } = this.nodes, detector = new OnsetDetector({ gateDb: Math.min(this.settings.gateDb, -55), minGapMs: 120 }), heard = [];
  const rate = ctx.sampleRate, sizes = this.sizes;
  const ctxMs = frame => (frame / rate) * 1000; // on the audio clock, with no latency taken off
  const levels = [];
  const tap = ({ data }) => { for (const raw of data) { const t = detector.push(timed(raw, sizes, ctxMs)); if (t !== null) { heard.push(t); levels.push(raw.db); } } };
  this.nodes.worklet.port.addEventListener('message', tap);
  const out = this.clickOut(ctx), start = ctx.currentTime + 0.3, times = [];
  const buffer = ctx.createBuffer(1, Math.round(rate * 0.02), rate), d = buffer.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (i < 2 ? 0.8 : Math.random() * 0.2 - 0.1) * (1 - i / d.length); // the metronome's click
  for (let k = 0; k < clicks; k++) {
   const s = new AudioBufferSourceNode(ctx, { buffer }), at = start + (k * gapMs) / 1000;
   s.connect(out); s.start(at); times.push(at * 1000);
  }
  await new Promise(r => setTimeout(r, 300 + clicks * gapMs + 400));
  this.nodes?.worklet.port.removeEventListener('message', tap);
  const result = roundTrip(times, heard, gapMs * 0.9);
  if (result) this.set({ latencyMs: Math.round(result.ms), clickDb: this.settings.headphones ? this.settings.clickDb : Math.round(levels.sort((a, b) => a - b)[levels.length >> 1]) });
  return result;
 },
 // What has been sung or played since the last pause of `gapMs` or more: the notes, each with an end.
 performance(gapMs = 10000) {
  const done = this.take.map(n => ({ ...n, end: n.end ?? performance.now() }));
  let k = done.length - 1;
  while (k > 0 && done[k].start - done[k - 1].end < gapMs) k--;
  return done.slice(Math.max(0, k));
 },
 // Records what the listener hears (after the input gain) until stop(), which resolves to { samples (mono),
 // sampleRate, at (the page's time when the first sample was made, the round trip taken off) }.
 async record() {
  if (!this.nodes) throw new Error('Start listening first.');
  const { ctx, gain } = this.nodes;
  if (!this._recorderLoaded?.has(ctx)) { await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url)); (this._recorderLoaded ||= new WeakSet()).add(ctx); }
  const node = new AudioWorkletNode(ctx, 'master-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' }), mute = new GainNode(ctx, { gain: 0 });
  gain.connect(node); node.connect(mute).connect(ctx.destination);
  const blocks = [];
  let first = null, stopped = null;
  node.port.onmessage = ({ data }) => { if (data.started !== undefined) first = data.started; if (data.data) blocks.push(data); if (data.stopped) stopped?.(); };
  node.port.postMessage('start');
  const latency = this.latencyMs;
  return {
   stop: async () => {
    await new Promise(r => { stopped = r; node.port.postMessage('stop'); });
    try { gain.disconnect(node); } catch { /* listening stopped */ }
    node.disconnect(); mute.disconnect();
    const length = blocks.reduce((n, b) => n + b.data[0].length, 0), samples = new Float32Array(length);
    let at = 0; for (const b of blocks) { samples.set(b.data[0], at); at += b.data[0].length; }
    const start = first ?? blocks[0]?.frame ?? 0;
    return { samples, sampleRate: ctx.sampleRate, at: window.synth.perfTimeOf(start / ctx.sampleRate - latency / 1000) };
   },
  };
 },
 // Where calibration clicks go: straight to the speakers, past the effects and the limiter.
 clickOut(ctx) { if (this._clickOut?.context !== ctx) { this._clickOut = new GainNode(ctx, { gain: 0.25 }); this._clickOut.connect(ctx.destination); } return this._clickOut; },
};

// Every note the app sounds that it didn't hear: kept so the listener can tell it from the player on speakers.
window.addEventListener('synth:note', ({ detail: { midi, on, source = '', silent } }) => {
 if (source === 'audio' || silent) return;
 const release = (window.synth?.params?.().adsr.release ?? 0.5) * 1000;
 listening._app.set(midi, on ? Infinity : performance.now() + release + 150 + listening.latencyMs);
});
window.addEventListener('synth:panic', () => listening._releaseAll(performance.now()));
