// Checks run inside the app (index.html) by node tests/listening-panel.mjs: a melody rendered through the
// app's own oscillators is played into the Listening widget's input (through the real AudioWorklet), and comes
// out as notes the way MIDI does: every note, on time, lighting its key, falling, reaching the teacher and the
// beat clock, and silent on speakers. The tuner, latency calibration on a loopback with a known delay, the
// app's own notes heard back on speakers, snapping to the sequencer's scale, a microphone that is refused, and
// the settings being kept. Returns { checks: [{ name, ok, problems }] }.
import { sing, melody } from './support/signals.js';
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
