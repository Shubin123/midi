// Checks run inside the app (index.html) by node tests/timing-panel.mjs: the beat clock as the metronome, the
// sequencer and a MIDI clock keep it; each note's offset and grade, the hit line and the timing strip; the
// tempo nudges; and the teacher's rhythm card, exercise and System 2's explanation of a phrase. Notes are sent
// as the synth sends them (synth:note), stamped with the exact time they were played, so every offset is known.
// Returns { checks: [{ name, ok, problems }] }.

const wait = ms => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);
const note = (midi, time, on = true) => window.dispatchEvent(new CustomEvent('synth:note', { detail: { midi, velocity: 0.8, on, source: 'computer', time } }));
const tap = (midi, time, len = 120) => { note(midi, time); note(midi, time + len, false); };
const tick = (type, time) => window.dispatchEvent(new CustomEvent('synth:midi-clock', { detail: { type, time } }));

export async function runTimingPanel() {
 const checks = [];
 const check = async (name, fn) => {
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems });
 };
 const { timing } = await import('../js/timing-widget.js');
 const bridge = await import('../js/teacher-bridge.js').then(m => m.initTeacher());
 const clock = timing.clock, last = () => timing.onsets.at(-1);
 // Each check starts on its own: no phrase left open, no exercise, the tempo it needs, and the next bar's first beat.
 const fresh = async (bpm = 120) => { bridge.tracker.reset(); bridge._setExercise(null); timing.watch.reset(); if (window.synth.tempo !== bpm) { window.synth.tempo = bpm; await wait(150); } };
 const nextBar = () => Math.ceil(clock.beatAt(performance.now()) / 4 + 0.1) * 4;
 const messages = () => [...document.querySelectorAll('#teacher-panel .tp-messages .teacher-msg')];

 await check('the metronome keeps the beat: its first click is beat 0, notes get exact offsets and grades, the hit line and strip show them', async expect => {
  $('#metronomeToggle').click();
  await wait(150);
  expect(clock.source === 'metronome' && clock.bpm === 120, `the clock is kept by ${clock.source} at ${clock.bpm}`);
  const b = Math.floor(clock.beatAt(performance.now()));
  const plan = [[b - 3, 4], [b - 2.5, -22], [b - 2, 45], [b - 1, 95]];
  for (const [beat, off] of plan) tap(60, clock.timeOf(beat) + off);
  const got = timing.onsets.slice(-4).map(o => `${Math.round(o.offsetMs)} ${o.grade}`);
  expect(got.join(', ') === '4 good, -22 good, 45 ok, 95 off', `offsets and grades: ${got.join(', ')}`);
  const line = $('#keyboard-module .synthesia-hit-line');
  expect(line.classList.contains('hit-off'), `the hit line is ${line.className}`);
  await wait(80);
  expect(timing.drawn >= 4, `the strip drew ${timing.drawn} dots`);
  expect(/♩ 120 · metronome/.test($('.timing-readout').textContent), `the readout says "${$('.timing-readout').textContent}"`);
 });
 await check('difficulty: Hard grades the same 25 ms late as amber; kept', async expect => {
  const level = $('#timingLevel');
  level.value = 'hard'; level.dispatchEvent(new Event('change'));
  tap(62, clock.timeOf(Math.floor(clock.beatAt(performance.now())) - 1) + 25);
  expect(last().grade === 'ok', `graded ${last().grade}`);
  expect(JSON.parse(localStorage.getItem('timing-level-v1')) === 'hard', 'not kept');
  level.value = 'normal'; level.dispatchEvent(new Event('change'));
 });
 await check('the sequencer keeps the beat while it plays, and the metronome takes it back', async expect => {
  const step = $('#step-sequencer [data-step]'); if (step.getAttribute('aria-pressed') !== 'true') step.click();
  $('#seq-play').click();
  await wait(150);
  expect(clock.source === 'sequencer', `while the sequencer plays the clock is kept by ${clock.source}`);
  $('#seq-stop').click();
  await wait(100);
  expect(clock.source === 'metronome', `after it stops the clock is kept by ${clock.source}`);
 });
 await check('a MIDI clock at 100 BPM, with Sync on: the beat and the session tempo follow it, within 3 ms; Stop hands back', async expect => {
  tick('tick', performance.now()); // ignored while Sync is off
  expect(clock.source !== 'midi', 'followed a MIDI clock with Sync off');
  $('#midiClockSync').click();
  const tickMs = 600 / 24, t0 = performance.now() - 24 * 8 * tickMs;
  tick('start', t0 - 5);
  for (let k = 0; k < 24 * 8; k++) tick('tick', t0 + k * tickMs + Math.sin(k * 7.3) * 1.5);
  expect(clock.source === 'midi' && Math.abs(clock.bpm - 100) < 0.3, `the clock is ${clock.source} at ${clock.bpm.toFixed(2)}`);
  expect(Math.abs(window.synth.tempo - 100) < 0.11, `the session tempo is ${window.synth.tempo}`);
  tap(64, t0 + 7 * 600 + 30);
  expect(Math.abs(last().offsetMs - 30) < 3, `a note 30 ms late measured ${last().offsetMs.toFixed(1)} ms`);
  tick('stop', performance.now());
  expect(clock.source === 'metronome', `after Stop the clock is kept by ${clock.source}`);
  $('#midiClockSync').click();
  window.synth.tempo = 120;
 });
 await check('rushing to 107 against 100: one nudge under the keys, at once, then none for a while', async expect => {
  await fresh(100);
  bridge._nudgedAt = -Infinity;
  const start = clock.timeOf(Math.floor(clock.beatAt(performance.now())) - 40); // all of it in the past
  for (let i = 0; i < 10; i++) tap(60, start + i * 600);
  for (let i = 0; i < 10; i++) tap(60, start + 6000 + i * 560);
  await wait(50);
  const nudge = $('.timing-nudge');
  expect(!nudge.hidden && nudge.textContent === 'Easy, you\'re speeding up: 107 against 100.', `the nudge is "${nudge.hidden ? '' : nudge.textContent}"`);
  expect(/you 10[67] ↑/.test($('.timing-readout').textContent), `the readout says "${$('.timing-readout').textContent}"`);
  nudge.hidden = true;
  timing.watch.reset();
  for (let i = 0; i < 10; i++) tap(60, start + 12000 + i * 650); // dragging, straight after
  expect(nudge.hidden, 'a second nudge came within four seconds');
 });
 await check('a phrase played to the click gets a rhythm card; Try this next sets the exercise, and the next phrase is marked against it', async expect => {
  await fresh(120);
  const before = messages().length, b = nextBar();
  // On the beat, the "and" of 2, beat 3 (35 ms late), beat 4: x...x.x.x...x...
  for (const [beat, off] of [[0, 0], [1, 5], [1.5, -8], [2, 35], [3, 4]]) { const t = clock.timeOf(b + beat) + off; await wait(Math.max(0, t - performance.now())); tap(48 + beat * 2, t, 100); }
  await wait(2300); // the phrase ends on a rest of about a bar
  const card = messages().slice(before).find(m => m.classList.contains('rhythm'));
  expect(card, 'no rhythm card');
  if (!card) return;
  const cells = [...card.querySelectorAll('.tp-bar span')].map(c => (c.classList.contains('hit') ? 'x' : '.')).join('');
  expect(cells === 'x...x.x.x...x...', `the grid is ${cells}`);
  expect(/5 notes over 1 bar at 120 BPM/.test(card.textContent), `the card says "${card.textContent}"`);
  const go = [...card.querySelectorAll('button')].find(x => /^Try this next/.test(x.textContent));
  expect(go, 'no Try this next');
  go.click();
  await wait(50);
  const ex = bridge.exercise;
  expect(ex && !$('.tp-exercise-bar').hidden && window.synth.tempo === ex.bpm && $('#metronomeToggle').checked, `the exercise was not set up (${JSON.stringify(ex)}, tempo ${window.synth.tempo})`);
  if (!ex) return;
  await wait(2600); // the example plays from the next bar
  const n = messages().length, b2 = nextBar();
  for (const [i, c] of [...ex.pattern].entries()) { if (c !== 'x') continue; const t = clock.timeOf(b2 + i / 4); await wait(Math.max(0, t - performance.now())); tap(60, t, 60); }
  await wait(60000 / ex.bpm * 4 + 600);
  const marked = messages().slice(n).find(m => m.classList.contains('rhythm'));
  const hits = [...ex.pattern].filter(c => c === 'x').length;
  expect(marked && new RegExp(`${hits} of ${hits} hits of the pattern`).test(marked.textContent), `the next phrase was marked "${marked?.textContent}"`);
  $('.tp-exercise-end').click();
  expect(!bridge.exercise && $('.tp-exercise-bar').hidden, 'End exercise did not end it');
 });
 await check('System 2 reads the phrase with its [RHYTHM] summary and its exercise becomes Try this next', async expect => {
  const asked = [];
  bridge.teacher.setEngine({ generate: async messages => { asked.push(messages.at(-1).content); return 'Beat 3 came late. Count it out loud.\n{"exercise": {"pattern": "x...x...x.x.x...", "bpm": 96}}'; } });
  bridge._active = { id: 'groq', model: 'test' };
  await fresh(120);
  const b = nextBar();
  for (const beat of [0, 1, 2, 3]) { const t = clock.timeOf(b + beat) + (beat === 2 ? 40 : 0); await wait(Math.max(0, t - performance.now())); tap(60 + beat, t, 100); }
  await wait(2600);
  expect(asked.some(m => /\[PLAYED\]/.test(m) && /\[RHYTHM\] 4 notes, 1 bar at 120 BPM \(metronome\)/.test(m) && /x\.\.\.x\.\.\.x\.\.\.x\.\.\./.test(m)), `System 2 was asked: ${asked.map(m => m.slice(0, 200)).join(' || ')}`);
  const reply = messages().filter(m => /Beat 3 came late/.test(m.textContent)).at(-1);
  const go = [...(reply?.querySelectorAll('button') || [])].find(x => /^Try this next/.test(x.textContent));
  expect(go, 'the model\'s exercise has no Try this next');
  go?.click();
  expect(bridge.exercise?.pattern === 'x...x...x.x.x...' && bridge.exercise.bpm === 96, `the exercise is ${JSON.stringify(bridge.exercise)}`);
  $('.tp-exercise-end').click();
  bridge.teacher.setEngine(null); bridge._active = null;
 });
 await check('late on beat 3 phrase after phrase: the Course tab says so, and the next exercise leans on beat 3', async expect => {
  await fresh(120);
  for (let k = 0; k < 4; k++) {
   const b = Math.floor(clock.beatAt(performance.now()) / 4) * 4 - 40 + k * 8;
   const ts = [0, 1, 2, 3].map(i => clock.timeOf(b + i) + (i === 2 ? 60 : 0));
   ts.forEach((t, i) => tap(60 + i, t, 80));
   bridge._rhythm({ noteOns: [{ time: ts[0] }, { time: ts[3] }] });
  }
  document.querySelector('#tp-tab-course').click();
  const habits = $('.tp-habits')?.textContent || '';
  expect(/consistently late on beat 3/.test(habits), `the Course tab says "${habits}"`);
  document.querySelector('#tp-tab-lesson').click();
  const card = messages().filter(m => m.classList.contains('rhythm')).at(-1);
  expect(/This keeps happening: consistently late on beat 3/.test(card?.textContent || '') && /beat 3\)/.test(card?.textContent || ''), `the last card says "${card?.textContent}"`);
 });
 await check('Timing off: no offsets kept, no strip, no hit line colour', async expect => {
  $('#timingToggle').click();
  const n = timing.onsets.length;
  tap(60, performance.now());
  expect(timing.onsets.length === n && $('.timing-strip').hidden, 'notes still kept, or the strip still shows');
  $('#timingToggle').click();
  $('#metronomeToggle').click();
 });
 return { checks };
}
