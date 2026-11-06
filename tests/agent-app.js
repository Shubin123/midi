// Checks run inside the app (index.html) by node tests/agent.mjs: every action of the teacher's agent
// (js/agent-actions.js) called as a model would, each changing what it says, refusing wrong arguments with a
// clear reason, and put back by its Undo; then what the agent decides (acting, suggesting while it may not act,
// asking first before anything destructive, too many changes, PANIC), its entries in the panel, Undo all for an
// answer, and a lesson run end to end by a scripted model: set up, sung back through the microphone, coached,
// and the next exercise adjusted. Returns { checks: [{ name, ok, problems }] }.
import { sing } from './support/signals.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);
const until = async (fn, ms = 6000) => { const end = performance.now() + ms; while (!(await fn()) && performance.now() < end) await wait(20); return fn(); };

export async function runAgent(only = '') {
 const checks = [];
 const check = async (name, fn) => {
  if (only && !new RegExp(only).test(name)) return;
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems });
 };
 const { ACTIONS, check: argsProblem, definitions } = await import('../js/agent-actions.js');
 const { listening } = await import('../js/listening.js');
 const { timing } = await import('../js/timing-widget.js');
 const bridge = await import('../js/teacher-bridge.js').then(m => m.initTeacher());
 const env = bridge.agent.env, seq = window.workspaceApi.sequencer;
 const ctx = window.synth.ensureAudio(); await ctx.resume();
 const run = (name, args = {}) => ACTIONS[name].run(args, env);
 const pattern = () => JSON.stringify(seq.pattern);
 const value = id => { const e = document.getElementById(id); return e.type === 'checkbox' ? e.checked : e.value; };
 const plugins = () => [...document.querySelectorAll('#plugin-host-module .plugin-row strong')].map(s => s.textContent.trim());
 const messages = () => [...document.querySelectorAll('#teacher-panel .tp-messages .teacher-msg')];
 const buttonIn = (m, text) => [...(m?.querySelectorAll('button') || [])].find(b => b.textContent === text);

 // Every action: [name, valid args, how to read what it changes, bad args and the reason expected, set up first].
 const TABLE = [
  ['set_tempo', { bpm: 87 }, () => window.synth.tempo, [{ bpm: 500 }, /bpm must be from 30 to 300, not 500/]],
  ['start_metronome', { bpm: 100 }, () => `${window.synth.metronome} ${window.synth.tempo}`, [{ bpm: 'fast' }, /bpm must be number/]],
  ['stop_metronome', {}, () => window.synth.metronome, [{ now: true }, /has no argument now/], () => { if (!$('#metronomeToggle').checked) $('#metronomeToggle').click(); }],
  ['set_key_scale', { key: 'D', scale: 'Dorian', octave: 4 }, () => `${value('seq-key')} ${value('seq-scale')} ${value('seq-octave')} ${pattern()}`, [{ key: 'H', scale: 'Dorian' }, /"H" isn't a key/]],
  ['write_sequencer_pattern', { notes: [{ note: 'C4', step: 0 }, { note: 'E3', step: 4 }, { note: 'G3', step: 8 }] }, pattern, [{ notes: [{ note: 'C4', step: 20 }] }, /step must be from 0 to 15, not 20/]],
  ['clear_sequencer', {}, pattern, [{ all: 1 }, /has no argument all/]],
  ['play_sequencer', { bars: 1 }, () => seq.running, [{ bars: 0 }, /bars must be from 1 to 32/]],
  ['set_param', { control: 'Filter › Cutoff (Hz)', value: 900 }, () => value('filterCutoff'), [{ control: 'Filter › Cutoff (Hz)' }, /set_param needs value/]],
  ['set_oscillator', { index: 1, waveform: 'square', detune: 12 }, () => `${value('waveformOsc1')} ${value('detuneOsc1')}`, [{ index: 9, level: 1 }, /index must be from 1 to 8/]],
  ['add_automation_lane', { target: 'filterCutoff' }, () => [...document.querySelectorAll('#automation .automation-lane label')].map(l => l.textContent.trim()).join(), [{ target: 'moon' }, /target must be one of/]],
  ['write_automation', { target: 'masterVolume', from: 0.2, to: 0.8 }, () => JSON.stringify(seq.lanes.find(l => l.target === 'masterVolume') || null), [{ target: 'masterVolume', from: 0, to: 5 }, /goes from 0 to 1; a ramp to 5 is outside it/]],
  ['arm_loop_slot', { slot: 2, record: true }, () => window.synth.loops()[1].recording, [{ slot: 5 }, /slot must be from 1 to 4/]],
  ['play_loop_slot', { slot: 1 }, () => window.synth.loops()[0].playing, [{ slot: 3 }, /slot 3 is empty/], () => window.synth.setLoop(0, [{ type: 'noteon', note: 'C5', velocity: 0.7, time: 0, synthParams: window.synth.params() }, { type: 'noteoff', note: 'C5', velocity: 0, time: 200 }], 1000)],
  ['clear_loop_slot', { slot: 1 }, () => window.synth.loops()[0].events.length, [{ slot: 'one' }, /slot must be integer/]],
  ['load_plugin', { name: 'Delay' }, () => plugins().join(), [{ name: 'Moon' }, /no built-in plug-in called Moon/]],
  ['set_plugin_param', { plugin: 'Delay', param: 'Feedback', value: 60 }, () => document.querySelector('.plugin-window input[aria-label="Feedback"]')?.value, [{ plugin: 'Delay', param: 'Size of the moon', value: 1 }, /no control called/], async () => { if (!plugins().includes('Delay')) await run('load_plugin', { name: 'Delay' }); }],
  ['bypass_plugin', { plugin: 'Delay', on: true }, () => document.querySelector('#plugin-host-module .plugin-row input[type=checkbox]')?.checked, [{ plugin: 'Moon' }, /no plug-in called Moon is loaded/]],
  ['hide_widget', { widget: 'Oscilloscope' }, () => $('#scope-module').hidden, [{ widget: 'Moon' }, /can't be hidden/]],
  ['show_widget', { widget: 'Oscilloscope' }, () => $('#scope-module').hidden, [{}, /show_widget needs widget/], () => ACTIONS.hide_widget.run({ widget: 'Oscilloscope' })],
  ['start_listening', { mode: 'melody' }, () => listening.active, [{ mode: 'jazz' }, /mode must be one of/]],
  ['set_listening_mode', { mode: 'rhythm' }, () => listening.settings.mode, [{ mode: 'jazz' }, /mode must be one of melody, chords, rhythm/]],
  ['stop_listening', {}, () => listening.active, [{ x: 1 }, /has no argument x/], () => listening.active || listening.listenTo(new GainNode(ctx))],
  ['set_exercise', { pattern: 'x...x...x.x.x...', bpm: 80 }, () => `${bridge.exercise?.pattern} ${window.synth.tempo}`, [{ pattern: 'abc' }, /"abc" isn't a pattern/]],
 ];
 await check(`every action that changes something (${TABLE.length}): a call changes it, wrong arguments are refused with the reason, and Undo puts it back`, async expect => {
  for (const [name, args, read, [bad, why], setup] of TABLE) {
   await setup?.();
   const before = await read();
   const problem = argsProblem(name, bad);
   let reason = problem;
   if (!problem) { try { await run(name, bad); reason = 'it ran'; } catch (err) { reason = err.message; } }
   expect(why.test(reason), `${name}: ${JSON.stringify(bad)} was answered "${reason}"`);
   expect(String(await read()) === String(before), `${name}: the refused call changed it`);
   let r;
   try { r = await run(name, args); } catch (err) { expect(false, `${name}: ${err.message}`); continue; }
   // Loops start on the next beat while the metronome runs.
   await until(async () => String(await read()) !== String(before), 1500);
   const after = await read();
   expect(String(after) !== String(before), `${name}: still ${before}`);
   expect(typeof r.text === 'string' && r.text.length > 3, `${name}: said "${r.text}"`);
   if (r.undo) { await r.undo(); await wait(80); expect(String(await read()) === String(before), `${name}: Undo left ${await read()}, was ${before}`); }
   else expect(['stop_sequencer', 'stop_listening'].includes(name), `${name}: no Undo`);
  }
  if (seq.running) seq.stop();
  listening.stop();
 });

 await check('the actions that only read or play: get_state, focus_widget, import_file, play_example_phrase, export_midi and render_audio', async expect => {
  const st = JSON.parse((await run('get_state')).text);
  expect(['patch', 'tempo', 'sequencer', 'automation', 'loops', 'plugins', 'widgets', 'listening', 'performance'].every(k => k in st), `get_state has ${Object.keys(st)}`);
  expect(st.patch.oscillators.length >= 1 && st.sequencer.rows && Array.isArray(st.loops), 'get_state is missing the patch, the rows or the loops');
  expect(/part must be one of/.test(argsProblem('get_state', { part: 'moon' })), 'a wrong part isn\'t refused');
  expect(/pointing at Filter/.test((await run('focus_widget', { widget: 'Filter' })).text), 'focus_widget');
  expect(/the student chooses the file/.test((await run('import_file')).text), 'import_file');
  const heard = []; const on = ({ detail }) => { if (detail.on && detail.source === 'sequencer') heard.push(detail.midi); };
  window.addEventListener('synth:note', on);
  await run('play_example_phrase', { chords: ['Dm7', 'G7', 'Cmaj7'], bpm: 240 });
  await wait(900); window.removeEventListener('synth:note', on);
  expect(heard.length >= 10, `play_example_phrase played ${heard.length} notes`);
  let blob = null; const make = URL.createObjectURL; URL.createObjectURL = x => { blob = x; return make.call(URL, x); };
  await run('write_sequencer_pattern', { notes: [{ note: 'C4', step: 0 }] });
  await run('export_midi', { source: 'sequencer' });
  URL.createObjectURL = make;
  expect(blob?.type === 'audio/midi', 'export_midi saved no .mid');
  const clips = document.querySelectorAll('#io-module .io-clip').length;
  await run('render_audio', { source: 'sequencer', repeats: 1 });
  expect(await until(() => document.querySelectorAll('#io-module .io-clip').length > clips, 8000), 'render_audio made no clip');
  expect(definitions().length === Object.keys(ACTIONS).length && definitions().every(d => d.function.description && d.function.parameters.type === 'object'), 'the tool definitions');
 });

 /* ---- What the agent decides ---- */
 const agent = bridge.agent, acts = $('#teacher-panel .agent-check');
 await check('Agent can act: each change is made at once and listed with Undo, which puts it back', async expect => {
  if (!acts.checked) acts.click();
  agent.begin();
  window.synth.tempo = 120;
  const said = await agent.call('set_tempo', { bpm: 96 }, 'System 2 · Test');
  expect(/^Done: tempo 96/.test(said) && window.synth.tempo === 96, `said "${said}", tempo ${window.synth.tempo}`);
  const m = messages().at(-1);
  expect(/Did: tempo 96 BPM/.test(m?.textContent) && /System 2 · Test/.test(m.textContent), `the panel shows "${m?.textContent}"`);
  buttonIn(m, 'Undo')?.click(); await wait(50);
  expect(window.synth.tempo === 120, `Undo left the tempo at ${window.synth.tempo}`);
  agent.end();
 });
 await check('suggest only (Agent can act off): nothing changes until the student presses Apply; Dismiss leaves it', async expect => {
  acts.click();
  expect(!bridge.agentActs && JSON.parse(localStorage.getItem('teacher-agent-acts-v1')) === false, 'the switch isn\'t kept');
  agent.begin();
  const said = await agent.call('set_tempo', { bpm: 72 }, 'System 2 · Test');
  expect(/^Suggested/.test(said) && window.synth.tempo === 120, `said "${said}", tempo ${window.synth.tempo}`);
  const m = messages().at(-1);
  expect(/Suggests: set tempo/.test(m?.textContent), `the panel shows "${m?.textContent}"`);
  buttonIn(m, 'Apply')?.click(); await wait(50);
  expect(window.synth.tempo === 72, `Apply left the tempo at ${window.synth.tempo}`);
  await agent.call('set_param', { control: 'Filter › Cutoff (Hz)', value: 1234 }, 'System 2 · Test');
  buttonIn(messages().at(-1), 'Dismiss')?.click();
  expect(value('filterCutoff') !== '1234', 'Dismiss applied it');
  acts.click(); window.synth.tempo = 120; agent.end();
 });
 await check('destructive actions ask first: clearing the pattern, writing over it, a loop, a file, the microphone; Cancel keeps it', async expect => {
  agent.begin();
  await run('write_sequencer_pattern', { notes: [{ note: 'C4', step: 0 }, { note: 'C4', step: 8 }] });
  const kept = pattern();
  let said = await agent.call('clear_sequencer', {}, 'System 2 · Test');
  expect(/^Waiting for the student to confirm/.test(said) && pattern() === kept, `said "${said}"`);
  let m = messages().at(-1);
  expect(/Asks first: clear sequencer\?/.test(m?.textContent), `the panel shows "${m?.textContent}"`);
  buttonIn(m, 'Cancel')?.click();
  expect(pattern() === kept, 'Cancel cleared it');
  said = await agent.call('write_sequencer_pattern', { notes: [{ note: 'E3', step: 2 }] }, 'System 2 · Test');
  expect(/^Waiting/.test(said) && pattern() === kept, `writing over a pattern: "${said}"`);
  buttonIn(messages().at(-1), 'Do it')?.click(); await wait(50);
  expect(pattern() !== kept, 'Do it didn\'t write the pattern');
  for (const [name, args] of [['clear_loop_slot', { slot: 1 }], ['export_midi', { source: 'sequencer' }], ['start_listening', {}]]) {
   said = await agent.call(name, args, 'System 2 · Test');
   expect(/^Waiting for the student to confirm/.test(said), `${name}: "${said}"`);
  }
  expect(!listening.active, 'the microphone opened without the student');
  agent.end();
 });
 await check('limits: eight changes in a turn at most; a wrong call says why in the panel', async expect => {
  agent.begin(); agent.times = [];
  const said = [];
  for (let i = 0; i < 9; i++) said.push(await agent.call('set_tempo', { bpm: 100 + i }, 'System 2 · Test'));
  expect(said.slice(0, 8).every(s => /^Done/.test(s)) && /^Not done: too many changes/.test(said[8]), `the ninth: "${said[8]}"`);
  agent.end().reverse().forEach(r => r.undo?.());
  agent.begin();
  const bad = await agent.call('set_tempo', { bpm: 999 }, 'System 2 · Test');
  expect(/^Not done: bpm must be from 30 to 300/.test(bad), `said "${bad}"`);
  expect(/Couldn't set tempo: bpm must be/.test(messages().at(-1)?.textContent), `the panel shows "${messages().at(-1)?.textContent}"`);
  expect(/^Not done: there is no action called fly/.test(await agent.call('fly', {})), 'an unknown action');
  agent.end();
 });
 await check('PANIC stops the agent: nothing more changes this turn', async expect => {
  agent.begin(); agent.times = [];
  bridge._agentBusy = true;
  await agent.call('set_tempo', { bpm: 101 }, 'System 2 · Test');
  window.synth.panic();
  const said = await agent.call('set_tempo', { bpm: 140 }, 'System 2 · Test');
  expect(/^Stopped: the student pressed PANIC/.test(said) && window.synth.tempo === 101, `said "${said}", tempo ${window.synth.tempo}`);
  bridge._agentBusy = false; agent.end(); window.synth.tempo = 120;
 });

 await check('a model that answers with several tool calls: each listed as it happens, and Undo all puts every one back', async expect => {
  const before = { tempo: window.synth.tempo, cutoff: value('filterCutoff'), osc: value('waveformOsc1') };
  bridge.teacher.setEngine({ generate: async (msgs, opts) => {
   await opts.tools.run('set_tempo', { bpm: 84 });
   await opts.tools.run('set_param', { control: 'Filter › Cutoff (Hz)', value: 700 });
   await opts.tools.run('set_oscillator', { index: 1, waveform: 'triangle' });
   return 'A softer, slower sound: tempo 84, the filter down to 700 Hz and a triangle wave.';
  } });
  bridge._active = { id: 'groq', model: 'test' };
  $('#teacher-panel .question-input').value = 'could the sound feel like an old ballad?'; bridge._ask();
  await until(() => messages().some(m => /3 changes in this answer/.test(m.textContent)));
  expect(window.synth.tempo === 84 && value('filterCutoff') === '700' && value('waveformOsc1') === 'triangle', 'the changes weren\'t made');
  const all = messages().find(m => /3 changes in this answer/.test(m.textContent));
  buttonIn(all, 'Undo all 3')?.click(); await wait(80);
  expect(window.synth.tempo === before.tempo && value('filterCutoff') === before.cutoff && value('waveformOsc1') === before.osc, `Undo all left ${window.synth.tempo}, ${value('filterCutoff')}, ${value('waveformOsc1')}`);
  bridge.teacher.setEngine(null); bridge._active = null;
 });
 await check('a model with no tools writes its actions as a JSON line, and they go through the agent (suggested while it may not act)', async expect => {
  bridge.teacher.setEngine({ generate: async () => 'Slower is easier.\n{"do": [{"action": "set_tempo", "bpm": 70}]}' });
  bridge._active = { id: 'local', model: 'test' };
  acts.click(); // off
  $('#teacher-panel .question-input').value = 'what tempo suits a lullaby?'; bridge._ask();
  await until(() => /Suggests: set tempo/.test(messages().at(-1)?.textContent || ''));
  expect(window.synth.tempo !== 70, 'it changed the tempo while it may not act');
  buttonIn(messages().at(-1), 'Apply')?.click(); await wait(50);
  expect(window.synth.tempo === 70, `Apply: tempo ${window.synth.tempo}`);
  acts.click(); window.synth.tempo = 120;
  bridge.teacher.setEngine(null); bridge._active = null;
 });

 await check('a lesson end to end: the model sets it up, the student sings it back into the microphone, it is coached, and the next exercise is adjusted', async expect => {
  if (seq.running) seq.stop();
  const seen = {};
  const script = {
   'set up a lesson': async (opts) => {
    seen.setup = [
     await opts.tools.run('set_tempo', { bpm: 90 }),
     await opts.tools.run('set_key_scale', { key: 'C', scale: 'Major Pentatonic', octave: 5 }),
     await opts.tools.run('start_metronome', {}),
     await opts.tools.run('set_listening_mode', { mode: 'melody' }),
    ];
    seen.write = await opts.tools.run('write_sequencer_pattern', { notes: [{ note: 'C4', step: 0 }, { note: 'D4', step: 4 }, { note: 'E4', step: 8 }, { note: 'G4', step: 12 }] });
    return 'Here is your exercise: four notes, one a beat. Listen once, then sing it back.';
   },
   'how did i do': async (opts) => {
    seen.performance = await opts.tools.run('get_state', { part: 'performance' });
    seen.exercise = await opts.tools.run('set_exercise', { pattern: 'x...x...x...x...', bpm: 80 });
    return 'Your second note came late, so here it is slower, at 80.';
   },
  };
  seen.calls = [];
  bridge.teacher.setEngine({ generate: async (msgs, opts) => {
   const q = msgs.at(-1).content.toLowerCase(), key = Object.keys(script).find(k => q.includes(k));
   seen.calls.push(`${key || '-'}:${!!opts?.tools}:${q.slice(-60)}`);
   return key && opts?.tools ? script[key](opts) : 'Nice phrase.';
  } });
  bridge._active = { id: 'groq', model: 'test' };
  const from = messages().length, fresh = () => messages().slice(from); // only what this lesson adds
  $('#teacher-panel .question-input').value = 'Set up a lesson for me: something to sing back at 90.'; bridge._ask();
  await until(() => fresh().some(m => /Asks first: write sequencer pattern/.test(m.textContent)));
  expect(seen.setup?.every(s => /^Done/.test(s)), `setting up: ${seen.setup?.join(' | ')} (the model was asked: ${seen.calls.join(' / ')})`);
  expect(/^Waiting/.test(seen.write), `writing the exercise: ${seen.write}`);
  buttonIn(fresh().find(m => /Asks first: write sequencer pattern/.test(m.textContent)), 'Do it')?.click();
  await wait(100);
  expect(window.synth.tempo === 90 && window.synth.metronome && $('#seq-key').value === '0' && $('#seq-octave').value === '5', `tempo ${window.synth.tempo}, metronome ${window.synth.metronome}, key ${$('#seq-key').value}, octave ${$('#seq-octave').value}`);
  const on = [...document.querySelectorAll('#step-sequencer .step[aria-pressed=true]')].map(c => c.getAttribute('aria-label'));
  expect(on.join('; ') === 'C5, step 1; D5, step 5; E5, step 9; G5, step 13', `the exercise: ${on.join('; ')}`);
  // The student sings it back, the second note 70 ms late, from the next bar.
  await listening.listenTo(new GainNode(ctx), 'a test recording');
  const clock = timing.clock, b = Math.ceil(clock.beatAt(performance.now()) / 4 + 1) * 4, T0 = clock.timeOf(b) - 200, beat = clock.period;
  const tune = [[0, 60, 0], [1, 62, 70], [2, 64, 0], [3, 67, 0]].map(([k, midi, late]) => ({ midi, start: 200 + k * beat + late, end: 200 + k * beat + late + beat * 0.6 }));
  const buf = ctx.createBuffer(1, 1, ctx.sampleRate), samples = sing(tune, { sampleRate: ctx.sampleRate, vibrato: 0 }), clip = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  clip.copyToChannel(samples, 0); void buf;
  const src = new AudioBufferSourceNode(ctx, { buffer: clip }); src.connect(listening.nodes.gain);
  const ts = ctx.getOutputTimestamp(); src.start(ts.contextTime + (T0 - ts.performanceTime) / 1000);
  await new Promise(r => { src.onended = r; });
  await until(() => fresh().some(m => m.classList.contains('rhythm')), clock.period * 4 + 3000);
  const card = fresh().filter(m => m.classList.contains('rhythm')).at(-1);
  expect(card, 'the sung phrase got no rhythm card');
  $('#teacher-panel .question-input').value = 'How did I do? Adjust the next exercise.'; bridge._ask();
  await until(() => seen.exercise, 8000);
  expect(/rhythm: x/.test(seen.performance || '') && /phrase: C/.test(seen.performance || ''), `the model read: ${seen.performance}`);
  expect(/^Done: exercise x\.\.\.x\.\.\.x\.\.\.x\.\.\. at 80 BPM/.test(seen.exercise || ''), `set_exercise: ${seen.exercise}`);
  await wait(100);
  expect(bridge.exercise?.bpm === 80 && window.synth.tempo === 80 && !$('#teacher-panel .tp-exercise-bar').hidden, `the exercise ${JSON.stringify(bridge.exercise)}, tempo ${window.synth.tempo}`);
  bridge._setExercise(null); listening.stop();
  if ($('#metronomeToggle').checked) $('#metronomeToggle').click();
  bridge.teacher.setEngine(null); bridge._active = null;
 });
 await check('with no model and no tools the teacher still works: a request it can meet changes the setting at once', async expect => {
  $('#teacher-panel .question-input').value = 'set the cutoff to 800'; bridge._ask();
  await until(() => value('filterCutoff') === '800', 3000);
  expect(value('filterCutoff') === '800', `the cutoff is ${value('filterCutoff')}`);
 });
 return { checks };
}
