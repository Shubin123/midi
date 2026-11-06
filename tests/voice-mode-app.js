// Checks run inside the app (index.html) by node tests/voice-mode-panel.mjs: the teacher's voice mode, with speech
// recognition stubbed (so the words are known) and sounds played into the Listening widget's input: talk sends no
// notes and its words are taken; singing sends notes and words made of it are left; Hold to talk; spoken
// requests meet actions at once; the teacher's own voice isn't heard as notes; a sing-back round is marked
// note by note; and the privacy switches decide whether speech may go online and the provider hear a take.
// Returns { checks: [{ name, ok, problems }] }.
import { sing, speak } from './support/signals.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);
const until = async (fn, ms = 6000) => { const end = performance.now() + ms; while (!(await fn()) && performance.now() < end) await wait(20); return fn(); };

// A speech recogniser that says what the test tells it to.
class FakeRecognition {
 constructor() { FakeRecognition.last = this; this.processLocally = false; }
 start() { this.running = true; } stop() { this.running = false; } abort() { this.running = false; }
 static say(text) { FakeRecognition.last?.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }); }
}
FakeRecognition.local = 'available';
FakeRecognition.available = async () => FakeRecognition.local;
FakeRecognition.install = async () => true;

export async function runVoiceMode() {
 const checks = [];
 const check = async (name, fn) => {
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems });
 };
 window.SpeechRecognition = window.webkitSpeechRecognition = FakeRecognition;
 // Headless Chrome's speech synthesis may never say it has finished: here it finishes at once.
 if (window.speechSynthesis) window.speechSynthesis.speak = u => setTimeout(() => u.onend?.(), 20);
 const { listening } = await import('../js/listening.js');
 const bridge = await import('../js/teacher-bridge.js').then(m => m.initTeacher());
 const ctx = window.synth.ensureAudio(); await ctx.resume();
 const rate = ctx.sampleRate, messages = () => [...document.querySelectorAll('#teacher-panel .tp-messages .teacher-msg')];
 const heard = [];
 window.addEventListener('synth:note', ({ detail }) => { if (detail.source === 'audio' && detail.on) heard.push(detail); });
 // Sound into the input already open (as a microphone would go on).
 const play = async samples => {
  const b = ctx.createBuffer(1, samples.length, rate); b.copyToChannel(samples, 0);
  const src = new AudioBufferSourceNode(ctx, { buffer: b }); src.connect(listening.nodes.gain); src.start();
  await new Promise(r => { src.onended = r; }); await wait(150);
 };
 listening.set({ latencyMs: null, headphones: true, playThrough: false, snap: false, mode: 'melody' });
 await listening.listenTo(new GainNode(ctx), 'a test microphone');
 bridge.voiceChoice = { engine: 'browser', voice: '' };
 const from = () => { const n = messages().length; return () => messages().slice(n); };

 await check('Talk is voice mode: speech recognition on, the Listening widget hands-free, and Hold to talk shown', async expect => {
  $('#teacher-panel .tp-talk').click();
  await until(() => bridge.talking && listening.voice);
  expect(bridge.talking && listening.voice, `talking ${bridge.talking}, voice mode ${!!listening.voice}`);
  expect(FakeRecognition.last?.running && FakeRecognition.last.processLocally, 'recognition isn\'t running on the device');
  expect(!$('#teacher-panel .tp-ptt').hidden, 'Hold to talk is hidden');
  expect(/Sing or play too: it tells talk from singing/.test($('#teacher-panel .tp-talk-note').textContent), `the note says: ${$('#teacher-panel .tp-talk-note').textContent}`);
 });
 await check('talking: no notes are sent, and what was said is taken as a question', async expect => {
  heard.length = 0;
  const news = from();
  await play(speak(14, { sampleRate: rate, seed: 2 }));
  expect(heard.length <= 1, `talk sent ${heard.length} notes: ${heard.map(e => e.midi).join(' ')}`);
  FakeRecognition.say('what is a perfect fifth?');
  await wait(100);
  expect(news().some(m => m.classList.contains('user') && /perfect fifth/.test(m.textContent)), 'the question wasn\'t taken');
 });
 await check('singing: the notes go through, on time, and words made of the singing are left', async expect => {
  heard.length = 0;
  const news = from(), t0 = performance.now();
  await play(sing([{ midi: 60, start: 100, end: 600 }, { midi: 64, start: 700, end: 1200 }, { midi: 67, start: 1300, end: 1800 }], { sampleRate: rate, vibrato: 30 }));
  expect(heard.map(e => e.midi).join(' ') === '60 64 67', `sang C E G, sent ${heard.map(e => e.midi).join(' ')}`);
  FakeRecognition.say('la la la');
  await wait(100);
  expect(!news().some(m => m.classList.contains('user')) && news().some(m => /Heard "la la la" while you were singing/.test(m.textContent)), `the panel: ${news().map(m => m.textContent.slice(0, 60)).join(' / ')}`);
  void t0;
 });
 await check('Hold to talk: while it is held, nothing heard is a note, and what is said is taken even after singing', async expect => {
  const ptt = $('#teacher-panel .tp-ptt'), news = from();
  heard.length = 0;
  ptt.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await play(sing([{ midi: 62, start: 50, end: 700 }], { sampleRate: rate }));
  expect(!heard.length, `${heard.length} notes went through while Hold to talk was held`);
  ptt.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  FakeRecognition.say('which chord was that?');
  await wait(100);
  expect(news().some(m => m.classList.contains('user') && /which chord was that/.test(m.textContent)), 'the question wasn\'t taken');
 });
 await check('spoken requests meet actions at once: record what I sing into slot 2, stop recording, slow it down to 80, a jazz rhythm to practise', async expect => {
  const m = $('#metronomeToggle'); if (m.checked) m.click();
  FakeRecognition.say('record what I sing into slot 2');
  await until(() => window.synth.loops()[1].recording, 2000);
  expect(window.synth.loops()[1].recording, 'slot 2 isn\'t recording');
  await play(sing([{ midi: 65, start: 50, end: 500 }], { sampleRate: rate }));
  await play(speak(4, { sampleRate: rate, seed: 7 })); // they talk again before saying it
  FakeRecognition.say('stop recording');
  await wait(100);
  const slot = window.synth.loops()[1];
  expect(!slot.recording && slot.events.some(e => e.type === 'noteon' && e.note === 'F5'), `slot 2: recording ${slot.recording}, ${slot.events.map(e => e.note).join(' ')}`);
  FakeRecognition.say('slow it down to 80');
  await wait(100);
  expect(window.synth.tempo === 80, `the tempo is ${window.synth.tempo}`);
  FakeRecognition.say('give me a jazz rhythm to practice');
  await wait(300);
  expect(bridge.exercise?.pattern === 'x..x..x.x..x..x.' && bridge.exercise.bpm === 100, `the exercise is ${JSON.stringify(bridge.exercise)}`);
  expect(messages().some(m => /System 1 · done at once/.test(m.textContent) && /Undo/.test(m.textContent)), 'not listed with Undo');
  bridge._setExercise(null); if (m.checked) m.click(); window.synth.setLoop(1, [], 0); window.synth.tempo = 100;
 });
 await check('while the teacher speaks on speakers, its voice in the microphone isn\'t taken for notes', async expect => {
  heard.length = 0;
  listening.set({ headphones: false }); // with headphones the microphone can't hear the teacher
  bridge._talkState('speaking');
  expect(listening.hush, 'the listener wasn\'t told');
  await play(sing([{ midi: 69, start: 50, end: 700 }], { sampleRate: rate }));
  expect(!heard.length, `${heard.length} notes went through while the teacher spoke`);
  bridge._talkState('listening');
  listening.set({ headphones: true });
 });
 await check('sing it back: a phrase plays from the next bar, the reply is marked note by note (one 35 cents flat, one 80 ms late)', async expect => {
  window.synth.tempo = 100;
  const news = from();
  const round = bridge._singBack({ phrase: [60, 62, 64, 65] });
  await until(() => bridge.singBackTarget?.length === 4 && bridge._singing, 3000);
  const target = bridge.singBackTarget, T0 = target[0].time - 300, ts = ctx.getOutputTimestamp();
  const reply = sing(target.map((t, i) => ({ midi: t.midi, start: 300 + (t.time - target[0].time) + (i === 2 ? 80 : 0), end: 300 + (t.time - target[0].time) + 400, bend: i === 1 ? -0.35 : 0 })), { sampleRate: rate, vibrato: 0 });
  const b = ctx.createBuffer(1, reply.length, rate); b.copyToChannel(reply, 0);
  const src = new AudioBufferSourceNode(ctx, { buffer: b }); src.connect(listening.nodes.gain); src.start(ts.contextTime + (T0 - ts.performanceTime) / 1000);
  const score = await round;
  const card = news().find(m => m.classList.contains('singback'));
  expect(card, 'no sing-back card');
  expect(score?.notes.map(n => n.inTune).join() === 'true,false,true,true', `in tune: ${score?.notes.map(n => n.cents).join(', ')} cents`);
  expect(score?.notes[2] && !score.notes[2].onTime && Math.abs(score.notes[2].ms - 80) < 20, `the third: ${score?.notes[2]?.ms} ms`);
  expect(/3 of 4 notes in tune, 3 on time\. The second \(D\) was 3\d cents flat\. The third came [78]\d ms late\./.test(card?.textContent || ''), `the card says: ${card?.textContent}`);
  expect(['Again', 'New phrase'].every(t => [...card.querySelectorAll('button')].some(b => b.textContent === t)), 'no Again / New phrase');
  if ($('#metronomeToggle').checked) $('#metronomeToggle').click();
 });
 await check('privacy: the switches are in Settings, not the teacher\'s; the provider hears the take only once allowed', async expect => {
  const local = $('#settings-speech-local'), audio = $('#settings-audio-provider');
  expect(local?.checked === true && audio?.checked === false, `defaults: speech on the device ${local?.checked}, recordings to the provider ${audio?.checked}`);
  expect(local.closest('[data-not-for-teacher]') && audio.closest('[data-not-for-teacher]'), 'the teacher could change them');
  const asked = [];
  bridge.teacher.setEngine({ generate: async msgs => { asked.push(msgs.at(-1).content); return 'Aim the D a little higher.'; } });
  bridge._active = { id: 'openai', model: 'test' };
  const round = async () => {
   const p = bridge._singBack({ phrase: [60, 62, 64] });
   await until(() => bridge._singing && bridge.singBackTarget?.length === 3, 3000);
   return p;
  };
  await round();
  let card = messages().filter(m => m.classList.contains('singback')).at(-1), ask = [...card.querySelectorAll('button')].find(b => /^Ask/.test(b.textContent));
  expect(ask && !/with the recording/.test(ask.textContent), `the button: ${ask?.textContent}`);
  const sangBack = () => asked.filter(c => /I sang back/.test(typeof c === 'string' ? c : c.find(p => p.type === 'text')?.text || '')); // the phrase itself is coached too
  ask.click(); await until(() => sangBack().length);
  expect(typeof sangBack()[0] === 'string', 'a recording was sent without being allowed');
  audio.click();
  await round();
  card = messages().filter(m => m.classList.contains('singback')).at(-1); ask = [...card.querySelectorAll('button')].find(b => /^Ask/.test(b.textContent));
  expect(/with the recording/.test(ask?.textContent || ''), `allowed, the button: ${ask?.textContent}`);
  ask.click(); await until(() => sangBack().length > 1);
  const parts = sangBack()[1];
  expect(Array.isArray(parts) && parts.some(p => p.type === 'input_audio' && p.input_audio.format === 'wav' && p.input_audio.data.length > 1000) && parts.some(p => p.type === 'text'), `sent: ${JSON.stringify(parts).slice(0, 120)}`);
  expect(!bridge.teacher.conversationHistory.some(h => Array.isArray(h.content)), 'the recording was kept in the history');
  audio.click();
  bridge.teacher.setEngine(null); bridge._active = null;
  if ($('#metronomeToggle').checked) $('#metronomeToggle').click();
 });
 await check('speech on the device only: where the browser can recognise speech only online, voice mode hears singing and reads replies, and says why', async expect => {
  $('#teacher-panel .tp-talk').click(); await until(() => !bridge.talking);
  FakeRecognition.local = 'unavailable';
  $('#teacher-panel .tp-talk').click(); await until(() => bridge.talking);
  expect(bridge.voice.cannotListen && !FakeRecognition.last?.running, `cannot listen ${bridge.voice.cannotListen}, running ${FakeRecognition.last?.running}`);
  expect(/recognises speech only online/.test($('#teacher-panel .tp-talk-note').textContent), `the note: ${$('#teacher-panel .tp-talk-note').textContent}`);
  $('#teacher-panel .tp-talk').click(); await until(() => !bridge.talking);
  $('#settings-speech-local').click();
  $('#teacher-panel .tp-talk').click(); await until(() => bridge.talking);
  expect(!bridge.voice.cannotListen && FakeRecognition.last?.running, 'with online allowed it still doesn\'t listen');
  $('#teacher-panel .tp-talk').click(); await until(() => !bridge.talking);
  expect(!listening.voice, 'voice mode stayed on after Talk was switched off');
  $('#settings-speech-local').click(); FakeRecognition.local = 'available';
 });
 await check('Listening › Speech: choosing it switches the teacher\'s Talk on, and nothing heard is a note; switching Talk off keeps it off', async expect => {
  if (!listening.active) await listening.listenTo(new GainNode(ctx), 'a test microphone');
  const mode = $('#listen-mode'); mode.value = 'speech'; mode.dispatchEvent(new Event('change'));
  await until(() => bridge.talking);
  expect(bridge.talking && listening.voice, 'Talk didn\'t come on');
  heard.length = 0;
  await play(sing([{ midi: 67, start: 50, end: 800 }], { sampleRate: rate }));
  expect(!heard.length, `${heard.length} notes went through in Speech`);
  $('#teacher-panel .tp-talk').click(); await until(() => !bridge.talking); await wait(200);
  expect(!bridge.talking, 'Talk came back on by itself');
  mode.value = 'melody'; mode.dispatchEvent(new Event('change'));
 });
 listening.stop();
 return { checks };
}
