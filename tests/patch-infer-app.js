// Checks run inside the app (index.html) by node tests/patch-infer.mjs: patches rendered from random known
// settings are inferred back (js/patch-infer.js), each closer than its first guess and close to the original; then
// the Sound match widget used as a student would: a note recorded through the Listening widget's input, compared A
// and B, applied and undone; a clip from Import / Export; and the teacher's agent and voice request.
// Returns { checks: [{ name, ok, problems }] }.
const wait = ms => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);
const until = async (fn, ms = 8000) => { const end = performance.now() + ms; while (!(await fn()) && performance.now() < end) await wait(30); return fn(); };

export async function runPatchInfer() {
 const checks = [];
 const check = async (name, fn) => {
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems });
 };
 const m = await import('../js/patch-infer.js');
 const { listening } = await import('../js/listening.js');
 const { soundMatch } = await import('../js/sound-match.js');
 const bridge = await import('../js/teacher-bridge.js').then(x => x.initTeacher());
 const ctx = window.synth.ensureAudio(); await ctx.resume();
 const OSC = { waveform: 'sawtooth', octave: 0, detune: 0, level: 0.7, delay: 0, pulseWidth: 0.5, on: true };
 let seed = 21; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
 const randomPatch = k => {
  const shape = m.SHAPES[k % 4], oscillators = [{ ...OSC, waveform: shape }];
  if (k === 4) oscillators.push({ ...OSC, waveform: 'square', octave: -1, level: 0.3 });
  if (k === 5) oscillators.push({ ...OSC, waveform: 'white', level: 0.15 });
  return { oscillators, adsr: { enabled: true, attack: 0.005 + rnd() * 0.15, decay: 0.05 + rnd() * 0.3, sustain: 0.35 + rnd() * 0.5, release: 0.1 + rnd() * 0.5 }, filter: { enabled: true, type: 'lowpass', cutoff: 1500 + rnd() * 3000, resonance: 0.7 + rnd() * 3 } };
 };

 await check('the distance: a sound is 0 from itself; a silent recording has no note', async expect => {
  const x = await m.renderPatch(randomPatch(3), { hz: 220, hold: 0.5, sampleRate: 24000 });
  expect(m.spectralDistance(x, x) === 0, `${m.spectralDistance(x, x)}`);
  let said = ''; try { m.analyzeNote(new Float32Array(24000), 24000); } catch (err) { said = err.message; }
  expect(/silent/.test(said), `said "${said}"`);
 });
 await check('six random known patches (each waveform, a sub octave, noise; envelope and resonant lowpass at random) inferred back: closer than the first guess, at least 85% alike, the pitch, envelope and waveform found', async expect => {
  for (let k = 0; k < 6; k++) {
   const patch = randomPatch(k), hz = 196 * 2 ** (Math.floor(rnd() * 12) / 12);
   const x = await m.renderPatch(patch, { hz, hold: 0.7, sampleRate: 24000 }), r = await m.inferPatch(x, 24000);
   const tag = `#${k} ${patch.oscillators.map(o => o.waveform).join('+')}`, e0 = patch.adsr, e1 = r.patch.adsr;
   expect(r.distance <= r.guessDistance, `${tag}: ${r.distance.toFixed(3)} after, ${r.guessDistance.toFixed(3)} at first`);
   expect(r.match >= 85, `${tag}: a ${r.match}% match (${m.describePatch(r.patch)})`);
   // With an oscillator an octave down, the note's period is that oscillator's: it is heard an octave lower.
   const heardAs = k === 4 ? hz / 2 : hz;
   expect(Math.abs(1200 * Math.log2(r.analysis.hz / heardAs)) < 3, `${tag}: pitch ${r.analysis.hz.toFixed(2)} for ${heardAs.toFixed(2)}`);
   const near = (a, b, f) => a / b < f && b / a < f;
   expect(near(e1.attack, e0.attack, 1.8) && Math.abs(e1.sustain - e0.sustain) < 0.15 && near(e1.release, e0.release, 1.8), `${tag}: envelope ${[e1.attack, e1.decay, e1.sustain, e1.release].map(v => v.toFixed(2)).join('/')} for ${[e0.attack, e0.decay, e0.sustain, e0.release].map(v => v.toFixed(2)).join('/')}`);
   if (k < 4) expect(r.patch.oscillators[0].waveform === patch.oscillators[0].waveform, `${tag}: heard as ${r.patch.oscillators[0].waveform}`);
   const wrong = { ...m.guessPatch(r.analysis), oscillators: [{ ...OSC, waveform: patch.oscillators[0].waveform === 'sine' ? 'sawtooth' : 'sine' }] };
   const dWrong = m.spectralDistance(x.subarray(Math.round(r.analysis.onset * 24000)), await m.renderPatch(wrong, { hz: r.analysis.hz, hold: r.analysis.hold, sampleRate: 24000, seconds: (x.length / 24000) - r.analysis.onset }));
   expect(dWrong > r.distance * 1.5, `${tag}: a wrong waveform is ${dWrong.toFixed(3)}, the match ${r.distance.toFixed(3)}`);
  }
 });

 // A note played into the Listening widget's input.
 await listening.listenTo(new GainNode(ctx), 'a test microphone');
 const known = { oscillators: [{ ...OSC, waveform: 'square' }], adsr: { enabled: true, attack: 0.02, decay: 0.2, sustain: 0.5, release: 0.3 }, filter: { enabled: true, type: 'lowpass', cutoff: 2500, resonance: 2 } };
 const note = await m.renderPatch(known, { hz: 261.63, hold: 0.8, sampleRate: ctx.sampleRate });
 const playIn = x => { const b = ctx.createBuffer(1, x.length, ctx.sampleRate); b.copyToChannel(x, 0); const s = new AudioBufferSourceNode(ctx, { buffer: b }); s.connect(listening.nodes.gain); s.start(ctx.currentTime + 0.2); };
 const meter = new AnalyserNode(ctx, { fftSize: 2048 }); window.synth.output.connect(meter);
 const loud = () => { const d = new Float32Array(2048); meter.getFloatTimeDomainData(d); return Math.sqrt(d.reduce((a, v) => a + v * v, 0) / d.length); };

 await check('Sound match, as a student would: record a note, the match and what it heard shown, A and B both play, Apply sets the synth, Undo puts it back', async expect => {
  const before = JSON.stringify(window.synth.params().oscillators.map(({ id, ...o }) => o));
  $('#match-record').click();
  await until(() => /Play or sing one note/.test($('#sound-match-module .listen-status').textContent), 3000);
  playIn(note);
  await until(() => /Match \d+%/.test($('.match-result').textContent), 20000);
  expect(/Match (8|9|10)\d%/.test($('.match-result').textContent), `the result: ${$('.match-result').textContent}`);
  expect(/Heard C4 \(26[12]\.\d Hz\)/.test($('.match-read').textContent), `what it heard: ${$('.match-read').textContent}`);
  $('#match-a').click(); expect(await until(() => loud() > 0.01, 2000), 'A made no sound'); await until(() => soundMatch.playing === null, 4000);
  $('#match-b').click(); expect(await until(() => loud() > 0.01, 2000), 'B made no sound'); await until(() => soundMatch.playing === null, 4000);
  $('#match-apply').click();
  const p = window.synth.params(), got = soundMatch.result.patch;
  expect(p.oscillators[0].waveform === got.oscillators[0].waveform && Math.abs(p.filter.cutoff - got.filter.cutoff) < 2 && Math.abs(p.adsr.attack - got.adsr.attack) < 0.002, `the synth: ${p.oscillators[0].waveform}, ${p.filter.cutoff} Hz, attack ${p.adsr.attack}`);
  expect(!$('#match-undo').hidden, 'no Undo');
  $('#match-undo').click();
  expect(JSON.stringify(window.synth.params().oscillators.map(({ id, ...o }) => o)) === before, 'Undo left a different bank');
 });
 await check('Import / Export › Match this sound sends a clip to Sound match', async expect => {
  const { encodeAudio } = await import('../js/audio-files.js');
  const dt = new DataTransfer(); dt.items.add(new File([encodeAudio([note], ctx.sampleRate, 'wav24')], 'Square C.wav', { type: 'audio/wav' }));
  $('#io-module').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  const clip = await until(() => [...document.querySelectorAll('#io-module .io-clip')].find(c => c.textContent.includes('Square C')), 5000);
  soundMatch.result = null;
  [...clip.querySelectorAll('button')].find(b => b.textContent === 'Match this sound').click();
  await until(() => soundMatch.result && !soundMatch.busy, 20000);
  expect(soundMatch.result?.match >= 85 && /Square C/.test($('.match-read').textContent), `${soundMatch.result?.match}%: ${$('.match-read').textContent}`);
 });
 await check('the teacher: "make it sound like this" records and matches a note; applying the patch asks first', async expect => {
  soundMatch.result = null;
  $('#teacher-panel .question-input').value = 'make it sound like this'; bridge._ask();
  await until(() => /Play or sing one note/.test($('#sound-match-module .listen-status').textContent) || soundMatch.busy === false && listening.nodes, 3000);
  await wait(300); playIn(note);
  await until(() => soundMatch.result && !soundMatch.busy, 20000);
  expect(soundMatch.result?.match >= 80, `matched ${soundMatch.result?.match}%`);
  expect([...document.querySelectorAll('#teacher-panel .teacher-msg')].some(x => /Did: match/.test(x.textContent)), 'not listed in the panel');
  const said = await bridge.agent.call('apply_inferred_patch', {}, 'System 2 · Test');
  expect(/^Waiting for the student to confirm/.test(said), `apply_inferred_patch: "${said}"`);
 });
 listening.stop();
 return { checks };
}
