// Checks run inside the app (index.html) by node tests/listening-panel.mjs: a melody rendered through the
// app's own oscillators is played into the Listening widget's input (through the real AudioWorklet), and comes
// out as notes the way MIDI does: every note, on time, lighting its key, falling, reaching the teacher and the
// beat clock, and silent on speakers. The tuner, latency calibration on a loopback with a known delay, the
// app's own notes heard back on speakers, snapping to the sequencer's scale, a microphone that is refused, and
// the settings being kept. Returns { checks: [{ name, ok, problems }] }.
import { sing, melody, claps, strum, chordsAt } from './support/signals.js';
import { noteF1 } from '../js/listen-dsp.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);

// The melody rendered offline through the synth's own voices (two sawtooths, as the default bank starts, through a
// lowpass and a short envelope), at the live context's rate.
async function renderSynth(notes, rate) {
 const end = Math.max(...notes.map(n => n.end)) / 1000 + 0.4, ctx = new OfflineAudioContext(1, Math.ceil(end * rate), rate);
 const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3000, Q: 0.7 });
 filter.connect(ctx.destination);
 const bank = window.synth.params().oscillators.filter(o => o.waveform === 'sawtooth').slice(0, 2);
 for (const n of notes) {
  const amp = new GainNode(ctx, { gain: 0 }), t0 = n.start / 1000, t1 = n.end / 1000;
  amp.gain.setValueAtTime(0, t0); amp.gain.linearRampToValueAtTime(0.35, t0 + 0.008); amp.gain.setValueAtTime(0.35, t1); amp.gain.linearRampToValueAtTime(0, t1 + 0.03);
  amp.connect(filter);
  window.oscillatorBank.buildVoice(ctx, bank, { frequency: 440 * 2 ** ((n.midi - 69) / 12), when: t0, out: amp }).forEach(l => l.source.stop(t1 + 0.05));
 }
 return ctx.startRendering();
}
const buffer = (ctx, samples) => { const b = ctx.createBuffer(1, samples.length, ctx.sampleRate); b.copyToChannel(samples, 0); return b; };

export async function runListening() {
 const checks = [];
 const check = async (name, fn) => {
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems });
 };
 const { listening } = await import('../js/listening.js');
 const { timing } = await import('../js/timing-widget.js');
 const bridge = await import('../js/teacher-bridge.js').then(m => m.initTeacher());
 const ctx = window.synth.ensureAudio();
 await ctx.resume();
 const heard = [];
 window.addEventListener('synth:note', ({ detail }) => { if (detail.source === 'audio') heard.push({ ...detail }); });
 // Plays samples into the listener from `at` seconds ahead; returns the audio-clock time it starts.
 const play = async (audio, { into = null, lead = 0.15 } = {}) => {
  const src = new AudioBufferSourceNode(ctx, { buffer: audio instanceof AudioBuffer ? audio : buffer(ctx, audio) });
  if (into) src.connect(into); else await listening.listenTo(src, 'a test clip');
  const at = ctx.currentTime + lead;
  src.start(at);
  return { at, src, done: new Promise(r => { src.onended = r; }) };
 };
 // Notes from the heard events: { midi, start, end } on the page's clock.
 const notesFrom = events => { const out = [], open = new Map(); for (const e of events) { if (e.on) open.set(e.midi, { midi: e.midi, start: e.time, velocity: e.velocity }); else if (open.has(e.midi)) { out.push({ ...open.get(e.midi), end: e.time }); open.delete(e.midi); } } return out; };
 const meter = new AnalyserNode(ctx, { fftSize: 2048 });
 window.synth.output.connect(meter);
 const outputLevel = () => { const d = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(d); return Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length); };

 await check('the Listening widget is in the workspace, with its input, mode, meter, tuner and switches, and isn\'t listening', async expect => {
  for (const id of ['listen-toggle', 'listen-device', 'listen-mode', 'listen-snap', 'listen-headphones', 'listen-play', 'listen-gate', 'listen-calibrate']) expect(document.getElementById(id), `no #${id}`);
  expect($('#listening-module.widget'), 'not a widget');
  expect(/Not listening/.test($('.listen-status').textContent), `status: ${$('.listen-status').textContent}`);
  expect($('.mic-indicator').hidden, 'the mic pill shows while nothing is open');
  expect($('#listen-play').disabled, 'Play through the synth can be ticked without headphones');
 });

 await check('a melody from the app\'s own oscillators, played into the listener: every note, each within 20 ms, lighting its key and falling, silent on speakers', async expect => {
  listening.set({ latencyMs: null, headphones: false, playThrough: false, snap: false });
  const ref = melody(150), audio = await renderSynth(ref, ctx.sampleRate);
  heard.length = 0;
  const lit = new Map(), falling = new Set();
  let loud = 0;
  const watch = setInterval(() => {
   document.querySelectorAll('#keyboard .active').forEach(k => lit.set(Number(k.dataset.midi), true));
   document.querySelectorAll('#synthesiaContainer .falling-note').forEach(f => falling.add(f.dataset.noteString));
   loud = Math.max(loud, outputLevel());
  }, 25);
  const { at, done } = await play(audio);
  await done; await wait(250);
  clearInterval(watch);
  const want = ref.map(n => ({ ...n, start: window.synth.perfTimeOf(at + n.start / 1000) }));
  const got = notesFrom(heard), s = noteF1(want, got);
  expect(s.f1 === 1, `F1 ${s.f1.toFixed(2)}: heard ${got.map(n => n.midi).join(' ')}, wanted ${ref.map(n => n.midi).join(' ')}`);
  const worst = Math.max(...s.onsetErrors.map(Math.abs));
  expect(worst < 20, `onsets off by ${s.onsetErrors.map(e => Math.round(e)).join(', ')} ms`);
  expect(ref.every(n => lit.has(n.midi)), `keys lit: ${[...lit.keys()].join(', ')}`);
  expect(falling.size >= 5, `falling notes: ${[...falling].join(', ')}`);
  expect(heard.every(e => e.silent), 'a note was sent to sound on speakers');
  expect(loud < 1e-3, `the synth sounded (${loud.toFixed(4)}) while on speakers`);
  expect(!document.querySelector('#keyboard .active'), 'a key is still lit after the clip');
 });

 await check('the teacher hears it as played notes: the live strip, the phrase\'s key, and the beat clock\'s onsets', async expect => {
  await wait(900); // the phrase ends after 800 ms of quiet
  const live = $('#teacher-panel .tp-live-detail')?.textContent || '';
  expect(/MIDI 60/.test(live), `the live strip says "${live}"`);
  const local = [...document.querySelectorAll('#teacher-panel .teacher-msg.local, #teacher-panel .teacher-msg')].map(m => m.textContent).join(' | ');
  expect(/C (Ionian|Major|major)|C Major Pentatonic|F Lydian|G Mixolydian/i.test(local), `the phrase was analysed as: ${local.slice(-200)}`);
  const audioOnsets = timing.onsets.filter(o => heard.some(h => h.on && Math.abs(h.time - o.time) < 1));
  expect(audioOnsets.length >= 10, `${audioOnsets.length} of the notes reached the beat clock`);
 });

 await check('with headphones on and Play through the synth ticked, what is sung sounds', async expect => {
  $('#listen-headphones').click();
  expect(!$('#listen-play').disabled, 'Play through the synth is still disabled with headphones');
  $('#listen-play').click();
  heard.length = 0;
  let loud = 0;
  const watch = setInterval(() => { loud = Math.max(loud, outputLevel()); }, 20);
  const { done } = await play(sing([{ midi: 64, start: 50, end: 600 }], { sampleRate: ctx.sampleRate }));
  await done; await wait(150); clearInterval(watch);
  expect(heard.some(e => e.on && e.midi === 64 && !e.silent), `heard ${heard.map(e => `${e.midi}${e.on ? '+' : '-'}${e.silent ? ' silent' : ''}`).join(' ')}`);
  expect(loud > 0.01, `the synth stayed quiet (${loud.toFixed(4)})`);
  $('#listen-play').click(); $('#listen-headphones').click();
 });

 await check('the tuner: 445 Hz reads as A4, 20 cents sharp, with the level on the meter', async expect => {
  const tone = new Float32Array(ctx.sampleRate); for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 445 * i) / ctx.sampleRate);
  const { done } = await play(tone);
  await wait(500);
  expect($('.listen-note').textContent === 'A4', `the note says ${$('.listen-note').textContent}`);
  const c = Number($('.listen-cents').textContent.replace('−', '-').replace('¢', ''));
  expect(Math.abs(c - 20) <= 2, `cents: ${$('.listen-cents').textContent}`);
  expect(/^44[45]\./.test($('.listen-hz').textContent), `Hz: ${$('.listen-hz').textContent}`);
  expect(parseFloat($('.listen-meter-fill').style.width) > 50, `meter at ${$('.listen-meter-fill').style.width}`);
  await done;
 });

 await check('a pitch trail is drawn over the falling notes while singing', async expect => {
  const { done } = await play(sing([{ midi: 62, start: 0, end: 700 }], { sampleRate: ctx.sampleRate }));
  await wait(450);
  const trail = $('#synthesiaContainer .listen-trail');
  expect(trail && Number(trail.dataset.points) > 20, `trail points: ${trail?.dataset.points}`);
  await done;
 });

 await check('latency: calibration on a loopback 40 ms long measures 40 ms, and then a note through it is stamped on time', async expect => {
  const loop = new DelayNode(ctx, { delayTime: 0.04, maxDelayTime: 1 });
  listening.clickOut(ctx).connect(loop);
  await listening.listenTo(loop, 'a loopback');
  const r = await listening.calibrate();
  listening.clickOut(ctx).disconnect(loop);
  expect(r && Math.abs(r.ms - 40) <= 3, `measured ${r ? r.ms.toFixed(1) : 'nothing'} ms`);
  expect(/Latency (3[7-9]|4[0-3]) ms \(measured\)/.test($('#listen-latency').textContent), `the widget says ${$('#listen-latency').textContent}`);
  heard.length = 0;
  const { at, done } = await play(sing([{ midi: 67, start: 100, end: 500 }], { sampleRate: ctx.sampleRate }), { into: loop });
  await done; await wait(200);
  const on = heard.find(e => e.on && e.midi === 67), err = on ? on.time - window.synth.perfTimeOf(at + 0.1) : NaN;
  expect(Math.abs(err) < 20, `the note was ${Number.isFinite(err) ? err.toFixed(1) + ' ms' : 'not heard'} out after compensation`);
  listening.set({ latencyMs: null });
 });

 await check('on speakers, the app\'s own notes heard back are ignored, and a note sung over them still comes through; with headphones they would count', async expect => {
  const back = new GainNode(ctx, { gain: 1 });
  window.synth.output.connect(back);
  await listening.listenTo(back, 'the speakers');
  heard.length = 0;
  window.synth.noteOn('C5'); await wait(500); window.synth.noteOff('C5'); await wait(700);
  expect(!heard.some(e => e.on), `heard the app's own note: ${heard.map(e => e.midi).join(' ')}`);
  listening.set({ headphones: true });
  window.synth.noteOn('E5'); await wait(500); window.synth.noteOff('E5'); await wait(700);
  expect(heard.some(e => e.on && e.midi % 12 === 4), 'with the gate off (headphones), the loopback wasn\'t heard: the test proves nothing'); // in whichever octave the bank's sub makes it
  listening.set({ headphones: false });
  window.synth.output.disconnect(back);
 });

 await check('Snap to the sequencer\'s key and scale: notes sung off the scale land on it, and the widget names the scale', async expect => {
  const key = $('#seq-key'), scale = $('#seq-scale');
  key.value = '0'; key.dispatchEvent(new Event('change', { bubbles: true }));
  scale.value = 'Major Pentatonic'; scale.dispatchEvent(new Event('change', { bubbles: true }));
  $('#listen-snap').click();
  expect(/C Major Pentatonic/.test($('.listen-key').textContent), `the widget says ${$('.listen-key').textContent}`);
  heard.length = 0;
  const { done } = await play(sing([{ midi: 61, start: 50, end: 450, bend: 0.4 }, { midi: 66, start: 550, end: 950, bend: 0.4 }], { sampleRate: ctx.sampleRate }));
  await done; await wait(200);
  expect(heard.filter(e => e.on).map(e => e.midi).join(' ') === '62 67', `heard ${heard.filter(e => e.on).map(e => e.midi).join(' ')}`);
  $('#listen-snap').click();
 });

 await check('a refused microphone: a clear message, and the keyboard still plays', async expect => {
  listening.stop();
  const real = navigator.mediaDevices?.getUserMedia;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')), enumerateDevices: async () => [], addEventListener() {} } });
  $('#listen-toggle').click();
  await wait(100);
  expect(/denied.*MIDI and the keyboard still work/.test($('.listen-status').textContent), `status: ${$('.listen-status').textContent}`);
  expect($('.listen-status').classList.contains('error'), 'not shown as an error');
  expect($('#listen-toggle').getAttribute('aria-pressed') === 'false', 'it says it is listening');
  let played = false;
  const on = ({ detail }) => { if (detail.source === 'computer') played = true; };
  window.addEventListener('synth:note', on);
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));
  document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true }));
  window.removeEventListener('synth:note', on);
  expect(played, 'the computer keyboard didn\'t play');
  if (real) delete navigator.mediaDevices;
 });

 await check('its settings are kept', async expect => {
  $('#listen-headphones').click();
  const kept = JSON.parse(localStorage.getItem('listening-v1'));
  expect(kept.headphones === true && kept.mode === 'melody' && kept.gateDb === listening.settings.gateDb, `kept ${JSON.stringify(kept)}`);
  $('#listen-headphones').click();
 });
 listening.stop();
 return { checks };
}

// With Chrome's fake microphone playing a file of the melody: Listen opens it, the red pill shows, the notes come
// through in order, and Stop closes it.
export async function runMicrophone() {
 const checks = [], problems = [];
 const heard = [];
 window.addEventListener('synth:note', ({ detail }) => { if (detail.source === 'audio' && detail.on) heard.push(detail.midi); });
 $('#listen-toggle').click();
 await wait(400);
 if ($('.mic-indicator').hidden) problems.push('the Mic on pill isn\'t showing');
 if (!/Listening to/.test($('.listen-status').textContent)) problems.push(`status: ${$('.listen-status').textContent}`);
 await wait(9000); // the file is 4.6 s and loops
 const want = melody().map(n => n.midi).join(' '), got = heard.join(' ');
 if (!got.includes(want)) problems.push(`heard ${got}, wanted ${want} in it`);
 $('.mic-indicator').click();
 await wait(100);
 if (!$('.mic-indicator').hidden || $('#listen-toggle').getAttribute('aria-pressed') !== 'false') problems.push('Stop didn\'t close the microphone');
 checks.push({ name: 'the microphone: Listen opens it (the Mic on pill shows), a sung melody comes through note for note, and the pill stops it', ok: !problems.length, problems });
 return { checks };
}

// The timing layers fed from the microphone (node tests/listening-panel.mjs, in a page of its own): the same
// rhythm against the metronome played as MIDI, clapped and sung gives the same rhythm card and offsets; claps
// rushing get the same nudge; free claps make the player's pulse; claps set the tempo, or the metronome
// follows them; and on speakers a click heard back is told from a clap.
export async function runTiming() {
 const checks = [];
 const check = async (name, fn) => {
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems });
 };
 const { listening } = await import('../js/listening.js');
 const { timing } = await import('../js/timing-widget.js');
 const bridge = await import('../js/teacher-bridge.js').then(m => m.initTeacher());
 const ctx = window.synth.ensureAudio();
 await ctx.resume();
 const clock = timing.clock, rate = ctx.sampleRate;
 listening.set({ latencyMs: null, headphones: false, playThrough: false, snap: false, clapTempo: false });
 // The audio clock's time for a time on the page's clock, as the listener maps it back.
 const ctxOf = T => { const ts = ctx.getOutputTimestamp(); return ts.contextTime + (T - ts.performanceTime) / 1000; };
 // Plays samples into the listener so that their start is at T0 on the page's clock.
 const playAt = async (samples, T0) => {
  const b = ctx.createBuffer(1, samples.length, rate); b.copyToChannel(samples, 0);
  const src = new AudioBufferSourceNode(ctx, { buffer: b });
  await listening.listenTo(src, 'a test clip');
  src.start(Math.max(ctx.currentTime, ctxOf(T0)));
  return new Promise(r => { src.onended = r; });
 };
 const metronome = on => { const m = $('#metronomeToggle'); if (m.checked !== on) m.click(); };
 const cards = [];
 const add = bridge._add.bind(bridge);
 bridge._add = e => { if (e.kind === 'rhythm') cards.push(e); return add(e); };
 const fresh = async (bpm = 100) => { bridge.tracker.reset(); bridge._setExercise(null); timing.watch.reset(); window.synth.tempo = bpm; await wait(200); };
 const mode = m => { if (listening.settings.mode !== m) { $('#listen-mode').value = m; $('#listen-mode').dispatchEvent(new Event('change')); } };
 const phraseEnd = () => wait(clock.period * clock.beatsPerBar + 500);

 // Two bars: beats and offsets (ms) from them.
 const PLAN = [[0, 5], [1, -10], [2, 12], [2.5, 0], [3, -12], [4, 8], [5, -4], [6, -5], [6.5, 10], [7, 0]]; // well inside the green, so a shift can't change a grade
 const offsetsOf = from => timing.onsets.filter(o => o.time >= from - 1).map(o => Math.round(o.offsetMs));

 await check('the same rhythm against the metronome: played as MIDI, clapped, and sung, the rhythm cards match and each offset is within 6 ms of MIDI\'s (less one shift for all)', async expect => {
  await fresh(100); metronome(true); await wait(300);
  const results = {};
  // As MIDI, stamped with the exact times (in the past, as a controller's time stamps can be).
  const b0 = Math.floor(clock.beatAt(performance.now())) - 12, from0 = clock.timeOf(b0) - 50;
  cards.length = 0;
  for (const [beat, off] of PLAN) { const t = clock.timeOf(b0 + beat) + off; window.dispatchEvent(new CustomEvent('synth:note', { detail: { midi: 60, velocity: 0.8, on: true, source: 'midi', time: t } })); window.dispatchEvent(new CustomEvent('synth:note', { detail: { midi: 60, velocity: 0, on: false, source: 'midi', time: t + 120 } })); }
  results.midi = { offsets: offsetsOf(from0), card: await phraseEnd().then(() => cards.at(-1)) };
  for (const [kind, render] of [['claps', rel => claps(rel, { sampleRate: rate })], ['sung', rel => sing(rel.map((t, i) => ({ midi: [60, 62, 64, 65, 67][i % 5], start: t, end: t + 240 })), { sampleRate: rate, vibrato: 0, tail: 400 })]]) {
   mode(kind === 'claps' ? 'rhythm' : 'melody');
   await fresh(100);
   const b1 = Math.ceil(clock.beatAt(performance.now()) / 4 + 1) * 4, T0 = clock.timeOf(b1) - 300;
   const rel = PLAN.map(([beat, off]) => clock.timeOf(b1 + beat) + off - T0);
   cards.length = 0;
   await playAt(render(rel), T0);
   results[kind] = { offsets: offsetsOf(T0), card: await phraseEnd().then(() => cards.at(-1)) };
  }
  mode('melody');
  const m = results.midi;
  expect(m.card, 'the MIDI phrase got no rhythm card');
  for (const kind of ['claps', 'sung']) {
   const r = results[kind];
   expect(r.card, `the ${kind} phrase got no rhythm card`);
   if (!r.card || !m.card) continue;
   expect(r.card.bars.join('|') === m.card.bars.join('|'), `${kind}: ${r.card.bars.join(' | ')}, MIDI: ${m.card.bars.join(' | ')}`);
   expect(r.card.grades.map(g => g.grade).join() === m.card.grades.map(g => g.grade).join(), `${kind} grades ${r.card.grades.map(g => g.grade).join()} vs ${m.card.grades.map(g => g.grade).join()}`);
   // The same offsets, up to one shift for them all: what calibration takes off (here, how the test's own clock
   // and the page's line up, which moves by a few ms on a busy machine).
   const diffs = r.offsets.map((o, i) => o - m.offsets[i]), shift = [...diffs].sort((a, b) => a - b)[diffs.length >> 1];
   expect(r.offsets.length === m.offsets.length && Math.abs(shift) <= 15 && diffs.every(d => Math.abs(d - shift) <= 6), `${kind} offsets ${r.offsets.join(' ')}, MIDI ${m.offsets.join(' ')}`);
  }
  expect(results.claps?.card && !document.querySelector('#keyboard .active'), 'a clap lit a key');
  metronome(false);
 });

 await check('the tempo layer: claps rushing to 107 against 100 are said once, as for notes', async expect => {
  mode('rhythm'); await fresh(100); metronome(true); await wait(300);
  const flags = [], off = timing.subscribe((type, d) => { if (type === 'flag') flags.push(d); });
  const T0 = clock.timeOf(Math.ceil(clock.beatAt(performance.now())) + 1) - 200, beat = 60000 / 107;
  await playAt(claps(Array.from({ length: 12 }, (_, i) => 200 + i * beat), { sampleRate: rate }), T0);
  off();
  expect(flags.length === 1 && flags[0].kind === 'rushing' && Math.abs(flags[0].actual - 107) <= 2, `flags: ${JSON.stringify(flags)}`);
  metronome(false);
 });

 await check('free play from claps alone: 96 BPM, one missed and one stray, becomes your pulse, and the claps land on its beats', async expect => {
  mode('rhythm'); await fresh(120); metronome(false); clock.stop('free'); await wait(100);
  const beat = 625, times = []; for (let i = 0; i < 12; i++) if (i !== 6) times.push(200 + i * beat); times.push(200 + 3.4 * beat);
  await playAt(claps(times.sort((a, b) => a - b), { sampleRate: rate }), performance.now() + 150);
  expect(clock.source === 'free' && Math.abs(clock.bpm - 96) < 1, `the clock is ${clock.source} at ${clock.bpm.toFixed(2)}`);
  const late = timing.onsets.slice(-3).filter(o => o.offsetMs !== null).map(o => Math.abs(o.offsetMs)); // once the pulse has settled
  expect(late.length === 3 && late.every(o => o < 10), `the last claps are ${late.map(Math.round).join(', ')} ms off their beat`);
 });

 await check('Clap to set the tempo (Metronome & Tempo): four claps 600 ms apart set 100 BPM', async expect => {
  mode('rhythm'); await fresh(140);
  const box = $('#clapTempo'); expect(box, 'no Clap to set the tempo switch'); box.click();
  await playAt(claps([200, 800, 1400, 2000], { sampleRate: rate }), performance.now() + 150);
  expect(window.synth.tempo === 100, `the tempo is ${window.synth.tempo}`);
  expect($('#bpmDisplay').textContent === '100', `the display says ${$('#bpmDisplay').textContent}`);
  box.click();
 });

 await check('Follow my tempo: clapping at 110 against a metronome at 100, the metronome moves to 110 without stopping', async expect => {
  mode('rhythm'); await fresh(100); metronome(true); await wait(300);
  $('#followTempo').click();
  const T0 = clock.timeOf(Math.ceil(clock.beatAt(performance.now())) + 1) - 200, beat = 60000 / 110;
  await playAt(claps(Array.from({ length: 14 }, (_, i) => 200 + i * beat), { sampleRate: rate }), T0);
  expect(Math.abs(window.synth.tempo - 110) <= 2, `the tempo is ${window.synth.tempo}`);
  expect(window.synth.metronome && clock.source === 'metronome', `metronome ${window.synth.metronome}, the clock kept by ${clock.source}`);
  $('#followTempo').click(); metronome(false);
 });

 await check('on speakers, a metronome click heard back on the beat isn\'t a clap, a clap on the beat is; with headphones the clicks count too', async expect => {
  mode('rhythm'); await fresh(100); metronome(true); await wait(300);
  listening.set({ clickDb: -40 });
  const run = async () => {
   const heard = [], on = ({ detail }) => { if (detail.source === 'audio-clap' && detail.on) heard.push(detail.time); };
   window.addEventListener('synth:note', on);
   const b = Math.ceil(clock.beatAt(performance.now())) + 1, T0 = clock.timeOf(b) - 200;
   const times = [0, 1, 2, 3].map(k => clock.timeOf(b + k) - T0), offBeat = clock.timeOf(b + 1.5) - T0;
   await playAt(claps([...times, offBeat].sort((x, y) => x - y), { sampleRate: rate, amp: [...times, offBeat].sort((x, y) => x - y).map(t => (t === times[2] ? 0.5 : 0.05)), decayMs: 25 }), T0);
   await wait(150); window.removeEventListener('synth:note', on);
   return heard.length;
  };
  const speakers = await run();
  expect(speakers === 2, `on speakers ${speakers} claps were heard, not 2 (the loud one on the beat, the soft one off it)`);
  listening.set({ headphones: true });
  const phones = await run();
  expect(phones === 5, `with headphones ${phones} were heard, not 5`);
  listening.set({ headphones: false, clickDb: null }); metronome(false);
 });
 mode('melody');
 listening.stop();
 return { checks };
}

// The widgets that take the Listening widget's input (node tests/listening-tools.mjs): the step sequencer's
// Record from audio, the loop recorder keeping notes or audio, and the oscilloscope's Input view.
export async function runTools() {
 const checks = [];
 const check = async (name, fn) => {
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems });
 };
 const { listening } = await import('../js/listening.js');
 const { timing } = await import('../js/timing-widget.js');
 const ctx = window.synth.ensureAudio();
 await ctx.resume();
 const rate = ctx.sampleRate;
 listening.set({ latencyMs: null, headphones: false, playThrough: false, snap: false, clapTempo: false, mode: 'melody' });
 const ctxOf = T => { const ts = ctx.getOutputTimestamp(); return ts.contextTime + (T - ts.performanceTime) / 1000; };
 // Plays samples into the listener so that their start is at T0 on the page's clock (now, when left out): into
 // the input it already has, as a microphone would go on, or (`fresh`) as a clip of its own.
 const playAt = async (samples, T0 = performance.now() + 100, fresh = false) => {
  const b = ctx.createBuffer(1, samples.length, rate); b.copyToChannel(samples, 0);
  const src = new AudioBufferSourceNode(ctx, { buffer: b });
  if (fresh || !listening.nodes) await listening.listenTo(src, 'a test clip'); else src.connect(listening.nodes.gain);
  src.start(Math.max(ctx.currentTime, ctxOf(T0)));
  return { T0, done: new Promise(r => { src.onended = r; }) };
 };
 const meter = new AnalyserNode(ctx, { fftSize: 2048 });
 window.synth.output.connect(meter);
 const level = () => { const d = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(d); return Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length); };
 const until = async (fn, ms = 8000) => { const end = performance.now() + ms; while (!fn() && performance.now() < end) await wait(20); return fn(); };
 // Listening is on a test clip (no microphone): Record from audio uses it as it is.
 await listening.listenTo(new GainNode(ctx), 'a test clip');

 await check('Step sequencer › Record from audio: a bar of count-in, then each sung note on its sixteenth and its row of the key and scale; Undo puts the old pattern back', async expect => {
  const set = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
  set('#seq-key', '0'); set('#seq-scale', 'Major Pentatonic'); set('#seq-octave', '5'); // rows C5..C6 (MIDI 60..72)
  window.synth.tempo = 100;
  const old = JSON.stringify(window.__seq?.pattern ?? null);
  const m = $('#metronomeToggle'); if (m.checked) m.click();
  await wait(200);
  $('#seq-record').click();
  await until(() => $('#seq-record').dataset.barStart);
  const barStart = Number($('#seq-record').dataset.barStart), six = timing.clock.period / 4;
  expect(m.checked, 'the metronome didn\'t start for the count-in');
  expect(barStart - performance.now() > timing.clock.period * 2, `the bar starts ${Math.round(barStart - performance.now())} ms from now: no count-in`);
  const plan = [[0, 60], [4, 62], [6, 64], [8, 67], [12, 69], [14, 72]], T0 = barStart - 200;
  const { done } = await playAt(sing(plan.map(([step, midi]) => ({ midi, start: 200 + step * six, end: 200 + step * six + six * 1.6 })), { sampleRate: rate, vibrato: 0, tail: 200 }), T0);
  await done;
  await until(() => /Recorded/.test($('.seq-record-status').textContent), 4000);
  expect(/Recorded 6 notes/.test($('.seq-record-status').textContent), `status: ${$('.seq-record-status').textContent}`);
  const on = [...document.querySelectorAll('#step-sequencer .step')].filter(c => c.getAttribute('aria-pressed') === 'true').map(c => `${c.getAttribute('aria-label')}`);
  const want = ['C5, step 1', 'D5, step 5', 'E5, step 7', 'G5, step 9', 'A5, step 13', 'C6, step 15'];
  expect(want.every(w => on.includes(w)) && on.length === 6, `steps on: ${on.join('; ')}`);
  $('#seq-record-undo').click();
  const after = [...document.querySelectorAll('#step-sequencer .step')].filter(c => c.getAttribute('aria-pressed') === 'true').map(c => c.getAttribute('aria-label'));
  expect(!want.every(w => after.includes(w)), `Undo left ${after.join('; ')}`);
  if (m.checked) m.click();
  set('#seq-octave', '4');
 });

 await check('Loop recorder › Record: Notes: what is sung is kept as notes, at the times they were sung, and plays back through the synth', async expect => {
  $('#looper-record-kind').value = 'notes'; $('#looper-record-kind').dispatchEvent(new Event('change'));
  const m = $('#metronomeToggle'); if (m.checked) m.click();
  await wait(100);
  $('#loop-slot-arm-0').click(); $('#loop-slot-arm-0').click(); // arm, then record (at once, with no metronome)
  const startedAt = performance.now();
  const notes = [{ midi: 64, start: 200, end: 500 }, { midi: 67, start: 600, end: 900 }, { midi: 72, start: 1000, end: 1400 }];
  const { T0, done } = await playAt(sing(notes, { sampleRate: rate, vibrato: 20 }));
  await done; await wait(150);
  $('#loop-slot-arm-0').click(); // stop
  const slot = window.synth.loops()[0], ons = slot.events.filter(e => e.type === 'noteon');
  expect(ons.map(e => e.note).join(' ') === 'E5 G5 C6', `the slot has ${ons.map(e => e.note).join(' ')}`);
  const errs = ons.map((e, i) => e.time - (T0 + notes[i].start - startedAt));
  expect(errs.every(e => Math.abs(e) < 25), `kept ${errs.map(Math.round).join(', ')} ms from when they were sung`);
  listening.stop();
  $('#loop-slot-play-0').click();
  const loud = await until(() => level() > 0.01, 3000);
  expect(loud, 'the loop made no sound');
  $('#loop-slot-play-0').click();
  $('#loop-slot-clear-0').click();
 });

 await check('Loop recorder › Record: Audio: the sound itself is kept for the loop\'s length, lined up with when it was made, and plays back', async expect => {
  await listening.listenTo(new GainNode(ctx), 'a test clip');
  $('#looper-record-kind').value = 'audio'; $('#looper-record-kind').dispatchEvent(new Event('change'));
  $('#loop-slot-arm-1').click(); $('#loop-slot-arm-1').click();
  const startedAt = performance.now();
  const { T0, done } = await playAt(sing([{ midi: 62, start: 300, end: 900 }], { sampleRate: rate, vibrato: 0 }));
  await done; await wait(100);
  $('#loop-slot-arm-1').click();
  const ok = await until(() => window.synth.loops()[1].audio, 3000);
  expect(ok, 'no audio was kept');
  const slot = window.synth.loops()[1];
  if (ok) {
   expect(Math.abs(slot.audio.duration * 1000 - slot.duration) < 5, `the audio is ${(slot.audio.duration * 1000).toFixed(0)} ms for a ${slot.duration.toFixed(0)} ms loop`);
   const d = slot.audio.getChannelData(0), first = d.findIndex(v => Math.abs(v) > 0.02) / rate * 1000, want = T0 + 300 - startedAt;
   expect(Math.abs(first - want) < 15, `the sound starts ${first.toFixed(0)} ms in, not ${want.toFixed(0)}`);
   expect(slot.events.length === 0, `notes were kept too: ${slot.events.length}`);
  }
  listening.stop();
  $('#loop-slot-play-1').click();
  expect(await until(() => level() > 0.01, 3000), 'the audio loop made no sound');
  $('#loop-slot-play-1').click(); $('#loop-slot-clear-1').click();
  $('#looper-record-kind').value = 'notes'; $('#looper-record-kind').dispatchEvent(new Event('change'));
 });

 await check('Oscilloscope › Input (Listening): the input\'s wave with the note it hears', async expect => {
  const sel = $('#visualizerSourceSelect');
  expect([...sel.options].some(o => o.value === 'input'), 'no Input (Listening) source');
  sel.value = 'input'; sel.dispatchEvent(new Event('change', { bubbles: true }));
  const texts = [], g = $('#visualizerCanvas').getContext('2d'), fill = g.fillText;
  g.fillText = function (t, ...a) { texts.push(t); return fill.call(this, t, ...a); };
  await wait(100);
  expect(texts.some(t => /not listening/.test(t)), `with nothing heard it says ${texts.at(-1)}`);
  const tone = new Float32Array(rate); for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate);
  texts.length = 0;
  const { done } = await playAt(tone);
  await wait(500);
  expect(texts.some(t => /^Input · A4 [+−]\d¢ · 44\d\.\d Hz$/.test(t)), `it drew ${[...new Set(texts)].slice(-3).join(' | ')}`);
  await done;
  g.fillText = fill;
  sel.value = 'master'; sel.dispatchEvent(new Event('change', { bubbles: true }));
 });
 await check('Import / Export › Transcribe to MIDI: a sung clip\'s notes go into the chosen loop slot, or the step sequencer\'s first bar, and a .mid is offered', async expect => {
  const { encodeAudio } = await import('../js/audio-files.js');
  const ref = melody(100), wav = encodeAudio([sing(ref, { sampleRate: 48000 })], 48000, 'wav24');
  const dt = new DataTransfer(); dt.items.add(new File([wav], 'Twinkle.wav', { type: 'audio/wav' }));
  $('#io-module').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  const clip = await until(() => [...document.querySelectorAll('#io-module .io-clip')].find(c => /Twinkle/.test(c.textContent)), 5000);
  expect(clip, 'the clip didn\'t arrive');
  if (!clip) return;
  const target = $('#io-module select[aria-label="MIDI import destination"]');
  target.value = 'loop2'; target.dispatchEvent(new Event('change'));
  [...clip.querySelectorAll('button')].find(b => b.textContent === 'Transcribe to MIDI').click();
  await until(() => clip.dataset.transcribed, 5000);
  expect(clip.dataset.transcribed === ref.map(n => n.midi).join(' '), `heard ${clip.dataset.transcribed}`);
  const toNote = m => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][m % 12] + Math.floor(m / 12);
  const ons = window.synth.loops()[2].events.filter(e => e.type === 'noteon');
  expect(ons.map(e => e.note).join(' ') === ref.map(n => toNote(n.midi)).join(' '), `loop slot 3 has ${ons.map(e => e.note).join(' ')}`);
  const gaps = ons.slice(1).map((e, i) => e.time - ons[i].time), want = ref.slice(1).map((n, i) => n.start - ref[i].start);
  expect(gaps.every((g, i) => Math.abs(g - want[i]) < 25), `the notes are ${gaps.map(Math.round).join(' ')} ms apart, not ${want.join(' ')}`);
  expect(![...clip.querySelectorAll('button')].find(b => b.textContent === 'Download .mid').hidden, 'no Download .mid');
  target.value = 'seq'; target.dispatchEvent(new Event('change'));
  [...clip.querySelectorAll('button')].find(b => b.textContent === 'Transcribe to MIDI').click();
  await until(() => /step sequencer/.test($('#io-module [role=status]').textContent), 5000);
  expect(/Placed \d+ of 12 notes/.test($('#io-module [role=status]').textContent), `status: ${$('#io-module [role=status]').textContent}`);
  window.synth.setLoop(2, [], 0);
 });

 await check('Import / Export › Export MIDI of the Performance heard by Listening: the notes sung, on the metronome\'s beats', async expect => {
  const { readMidi } = await import('../js/midi-file.js');
  window.synth.tempo = 90;
  const m = $('#metronomeToggle'); if (!m.checked) m.click();
  await wait(300);
  const clock = timing.clock, b = Math.ceil(clock.beatAt(performance.now()) / 4 + 1) * 4, T0 = clock.timeOf(b) - 200, beat = clock.period;
  const plan = [[0, 60], [1, 62], [2, 64], [2.5, 65], [3, 67]];
  await listening.listenTo(new GainNode(ctx), 'a test clip');
  listening.take.length = 0;
  const { done } = await playAt(sing(plan.map(([k, midi]) => ({ midi, start: 200 + k * beat, end: 200 + k * beat + beat * 0.4 })), { sampleRate: rate, vibrato: 0 }), T0);
  await done; await wait(200);
  let blob = null; const make = URL.createObjectURL; URL.createObjectURL = x => { blob = x; return make.call(URL, x); };
  const src = $('#io-module select[aria-label="Bounce source"]'); src.value = 'listen'; src.dispatchEvent(new Event('change'));
  [...document.querySelectorAll('#io-module button')].find(x => x.textContent === 'Export MIDI').click();
  URL.createObjectURL = make;
  expect(blob, `nothing was exported: ${$('#io-module [role=status]').textContent}`);
  if (blob) {
   const song = readMidi(new Uint8Array(await blob.arrayBuffer()));
   expect(song.notes.map(n => n.midi).join(' ') === plan.map(p => p[1]).join(' '), `the file has ${song.notes.map(n => n.midi).join(' ')}`);
   expect(Math.abs(song.bpm - 90) < 0.2, `at ${song.bpm} BPM`);
   const starts = song.notes.map(n => n.start), errs = starts.map((s0, i) => (s0 - plan[i][0]) * beat);
   expect(errs.every(e => Math.abs(e) < 20), `the notes are ${errs.map(Math.round).join(', ')} ms off their beats in the file`);
  }
  src.value = 'seq'; src.dispatchEvent(new Event('change'));
  if (m.checked) m.click();
 });

 await check('the plug-in capture measures through the same FFT: a 10 ms delay at half gain is heard as 10 ms of latency, almost exactly', async expect => {
  const { testSignal, analyze } = await import('../js/capture.js');
  const x = testSignal(48000), d = 480, y = new Float32Array(x.length);
  for (let i = d; i < x.length; i++) y[i] = 0.5 * x[i - d];
  const r = await analyze([y, y], 48000);
  expect(Math.abs(r.report.latencyMs - 10) < 0.1, `latency ${r.report.latencyMs.toFixed(2)} ms`);
  expect(r.report.accuracy > 0.99, `accuracy ${r.report.accuracy.toFixed(4)}`);
 });
 listening.stop();
 return { checks };
}

// Chords (node tests/listening-chords.mjs): heard live through the worklet from the app's own oscillators, each
// note lit and sent, the chord named in the tuner and by the teacher, said to be approximate; and a clip
// transcribed by Basic Pitch, or, when it can't be downloaded (`phase` 'offline': the runner blocks the CDN),
// by the built-in ear with a message saying so.
export async function runChords(phase) {
 const checks = [];
 const check = async (name, fn) => {
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems });
 };
 const { listening } = await import('../js/listening.js');
 const ctx = window.synth.ensureAudio();
 await ctx.resume();
 const rate = ctx.sampleRate, until = async (fn, ms = 8000) => { const end = performance.now() + ms; while (!fn() && performance.now() < end) await wait(20); return fn(); };
 const mode = m => { $('#listen-mode').value = m; $('#listen-mode').dispatchEvent(new Event('change')); };
 const engine = e => { $('#listen-chord-engine').value = e; $('#listen-chord-engine').dispatchEvent(new Event('change')); };
 listening.set({ latencyMs: null, headphones: false, playThrough: false, snap: false });
 const chords = chordsAt([[60, 64, 67], [57, 60, 64], [53, 57, 60, 65], [55, 59, 62, 67]], 300, 800, 700);
 const ref = chords.flatMap(c => c.notes.map(midi => ({ midi, start: c.start, end: c.end })));
 // A clip in Import / Export, transcribed into loop slot 4; returns its notes (ms from the start).
 const transcribeClip = async (name, samples) => {
  const { encodeAudio } = await import('../js/audio-files.js');
  const dt = new DataTransfer(); dt.items.add(new File([encodeAudio([samples], 48000, 'wav24')], `${name}.wav`, { type: 'audio/wav' }));
  $('#io-module').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  const clip = await until(() => [...document.querySelectorAll('#io-module .io-clip')].find(c => c.textContent.includes(name)), 5000);
  const target = $('#io-module select[aria-label="MIDI import destination"]'); target.value = 'loop3'; target.dispatchEvent(new Event('change'));
  const said = [], status = $('#io-module [role=status]'), watch = new MutationObserver(() => said.push(status.textContent));
  watch.observe(status, { childList: true, characterData: true, subtree: true });
  [...clip.querySelectorAll('button')].find(b => b.textContent === 'Transcribe to MIDI').click();
  await until(() => clip.dataset.transcribed || status.classList.contains('error') && !/instead/.test(status.textContent), 90000);
  await until(() => clip.dataset.transcribed, 3000);
  watch.disconnect();
  const loop = window.synth.loops()[3], names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const midiOf = n => Number(n.match(/\d+$/)[0]) * 12 + names.indexOf(n.replace(/\d+$/, ''));
  const ons = loop.events.filter(e => e.type === 'noteon'), first = ons[0]?.time ?? 0;
  return { said, notes: ons.map(e => ({ midi: midiOf(e.note), start: e.time - first + 300 })) };
 };

 if (phase === 'live') {
  await check('Chords, live: the app\'s own oscillators playing C, Am, F, G are heard (every note name, F1 at least 0.8 with octaves), several keys lit at once, each chord named in the tuner and by the teacher, as approximate', async expect => {
   mode('chords');
   expect(!$('.listen-engine').hidden, 'the clip engine choice is hidden in Chords');
   const heard = [], names = new Set(), chips = new Set();
   const on = ({ detail: d }) => { if (d.source === 'audio') heard.push({ ...d }); };
   window.addEventListener('synth:note', on);
   let most = 0;
   const watch = setInterval(() => {
    most = Math.max(most, document.querySelectorAll('#keyboard .active').length);
    names.add($('.listen-note').textContent);
    const chip = $('#teacher-panel .tp-chip'); if (chip && !chip.hidden) chips.add(chip.textContent);
   }, 30);
   const audio = await renderChordsSynth(chords, rate), src = new AudioBufferSourceNode(ctx, { buffer: audio });
   await listening.listenTo(src, 'a test clip');
   const at = ctx.currentTime + 0.15; src.start(at);
   await new Promise(r => { src.onended = r; }); await wait(400);
   clearInterval(watch); window.removeEventListener('synth:note', on);
   const notes = [], open = new Map();
   for (const e of heard) { if (e.on) open.set(e.midi, { midi: e.midi, start: e.time }); else if (open.has(e.midi)) { notes.push({ ...open.get(e.midi), end: e.time }); open.delete(e.midi); } }
   const want = ref.map(n => ({ ...n, start: window.synth.perfTimeOf(at + n.start / 1000) })), sc = noteF1(want, notes);
   // The synth's sawtooths have exact harmonics, so F3 under F4 can hide the F4 (its fundamental is the F3's
   // second harmonic) and an F5 be heard for it: the octave can be out, the note names are right.
   const pc = list => list.map(n => ({ ...n, midi: n.midi % 12 })), byName = noteF1(pc(want), pc(notes));
   expect(sc.f1 >= 0.8 && byName.f1 === 1, `F1 ${sc.f1.toFixed(2)}, by note name ${byName.f1.toFixed(2)}: heard ${notes.map(n => n.midi).join(' ')}`);
   expect(Math.max(...sc.onsetErrors.map(Math.abs)) < 30, `onsets ${sc.onsetErrors.map(Math.round).join(' ')} ms`);
   expect(most >= 3, `at most ${most} keys were lit at once`);
   expect(['Cmaj', 'Amin', 'Fmaj', 'Gmaj'].every(n => names.has(n)), `the tuner named ${[...names].join(', ')}`);
   expect(['Cmaj', 'Amin', 'Fmaj', 'Gmaj'].every(n => chips.has(n)), `the teacher named ${[...chips].join(', ')}`);
   expect(/heard, approximate/.test($('#teacher-panel .tp-live-detail').textContent), `the live strip says ${$('#teacher-panel .tp-live-detail').textContent}`);
   expect(heard.every(e => e.silent), 'a chord sounded through the synth on speakers');
   mode('melody');
  });
 }
 if (phase === 'offline') {
  await check('Basic Pitch can\'t be downloaded: a clear message, the built-in ear transcribes the clip instead, and the keyboard still plays', async expect => {
   mode('chords'); engine('basic-pitch');
   const { said, notes } = await transcribeClip('Chords offline', strum(chords, { sampleRate: 48000 }));
   expect(said.some(t => /Basic Pitch couldn't load \(couldn't download .*\), so the built-in ear transcribed/.test(t)), `said: ${said.join(' / ')}`);
   const sc = noteF1(ref, notes);
   expect(sc.f1 >= 0.9, `the built-in ear: F1 ${sc.f1.toFixed(2)}, ${notes.map(n => n.midi).join(' ')}`);
   let played = false; const on = ({ detail }) => { if (detail.source === 'computer') played = true; };
   window.addEventListener('synth:note', on);
   document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true })); document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true }));
   window.removeEventListener('synth:note', on);
   expect(played, 'the keyboard didn\'t play');
   engine('builtin'); mode('melody');
  });
 }
 if (phase === 'online') {
  await check('Basic Pitch, downloaded on demand: a clip of piano chords transcribed into a loop slot, F1 at least 0.9', async expect => {
   mode('chords'); engine('basic-pitch');
   const { said, notes } = await transcribeClip('Chords online', strum(chords, { sampleRate: 48000 }));
   expect(said.some(t => /Downloading the Basic Pitch model \(on (webgpu|wasm|webgl|cpu)\)/.test(t)), `said: ${said.join(' / ')}`);
   const sc = noteF1(ref, notes);
   expect(sc.f1 >= 0.9, `F1 ${sc.f1.toFixed(2)}: ${notes.map(n => `${n.midi}@${Math.round(n.start)}`).join(' ')}`);
   engine('builtin'); mode('melody');
  });
 }
 listening.stop();
 return { checks };
}

// Chords rendered through the app's own oscillators (the bank's sawtooths, a lowpass and a short envelope).
async function renderChordsSynth(chords, rate) { return renderSynth(chords.flatMap(c => c.notes.map(midi => ({ midi, start: c.start, end: c.end }))), rate); }
