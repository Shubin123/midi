// Checks run inside the app (index.html) by node tests/teacher-panel.mjs: the AI teacher's panel used as a
// student would, by typing into its ask box. Settings are changed when asked, with no model loaded, and each
// change can be undone; words that fit several controls ask which; questions change nothing; a System 2 model's
// own changes go through the same path. Returns { checks: [{ name, ok, problems }] }.

const wait = ms => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);
const panel = () => $('#teacher-panel');
const messages = () => [...panel().querySelectorAll('.tp-messages .teacher-msg')];
// Types into the ask box and presses Ask, then waits for the teacher.
async function ask(text, ms = 150) {
 const input = panel().querySelector('.question-input');
 input.value = text;
 panel().querySelector('.tp-ask').requestSubmit();
 await wait(ms);
}
const lastChange = () => messages().filter(m => m.classList.contains('change')).at(-1);
const buttonIn = (node, text) => [...(node?.querySelectorAll('button') || [])].find(b => b.textContent.trim() === text);

export async function runTeacherPanel() {
 const checks = [];
 const check = async (name, fn) => {
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems });
 };
 const bridge = await import('../js/teacher-bridge.js').then(m => m.initTeacher());
 const ws = await import('../js/workspace.js');

 /* ---- The live strip ---- */
 await check('the live strip shows until the conversation starts, then makes way; a new conversation brings it back', async expect => {
  const live = panel().querySelector('.tp-live'), shown = () => live.getClientRects().length > 0;
  expect(shown() && /Play something/.test(live.textContent), 'the empty conversation has no live strip');
  window.dispatchEvent(new CustomEvent('synth:note', { detail: { midi: 60, velocity: 0.7, on: true, source: 'computer' } }));
  window.dispatchEvent(new CustomEvent('synth:note', { detail: { midi: 60, velocity: 0.7, on: false, source: 'computer' } }));
  expect(shown() && /MIDI 60/.test(live.textContent), 'a note played before the chat does not show in it');
  await ask('louder');
  expect(!shown(), 'the strip still shows once the chat has started');
  buttonIn(lastChange(), 'Undo')?.click();
  panel().querySelector('.clear-btn').click();
  expect(shown(), 'a new conversation did not bring the strip back');
  await ask('set the tempo to 120');
  bridge._loadConversation();
  expect(!shown(), 'reopened with messages in it, the strip shows again');
 });

 /* ---- Changing settings when asked (System 1, no model) ---- */
 await check('"set the cutoff to 800" changes the filter, says so, and Undo puts it back', async expect => {
  await ask('set the cutoff to 800');
  expect($('#filterCutoff').value === '800', `the cutoff is ${$('#filterCutoff').value}`);
  expect(window.synth.params().filter.cutoff === 800, `the synth plays with a cutoff of ${window.synth.params().filter.cutoff}`);
  const m = lastChange();
  expect(/Changed Filter › Cutoff \(Hz\) from 5000 to 800/.test(m?.textContent || ''), `the change reads "${m?.textContent}"`);
  expect(/System 1/.test(m?.querySelector('.tp-who')?.textContent || ''), 'the change does not say System 1 made it');
  buttonIn(m, 'Undo')?.click();
  expect($('#filterCutoff').value === '5000', `after Undo the cutoff is ${$('#filterCutoff').value}`);
 });
 await check('switches, choices and steps: oscillator 2 off, a square wave, louder, highpass, a longer attack', async expect => {
  await ask('turn off oscillator 2');
  expect(!$('#enableOsc2').checked && window.synth.params().oscillators[1].on === false, 'oscillator 2 is still on');
  await ask('set oscillator 1 to square');
  expect($('#waveformOsc1').value === 'square' && window.synth.params().oscillators[0].waveform === 'square', `oscillator 1 plays ${window.synth.params().oscillators[0].waveform}`);
  await ask('louder');
  expect(Math.abs(Number($('#masterVolume').value) - 0.8) < 1e-6, `the volume is ${$('#masterVolume').value}`);
  await ask('switch the filter to highpass');
  expect($('#filterType').value === 'highpass', `the filter is ${$('#filterType').value}`);
  await ask('make the attack longer');
  expect(Math.abs(Number($('#attack').value) - 0.075) < 1e-6, `the attack is ${$('#attack').value}`);
  // Undo every change, newest first.
  messages().filter(m => m.classList.contains('change')).reverse().forEach(m => buttonIn(m, 'Undo')?.click());
  expect($('#enableOsc2').checked && $('#waveformOsc1').value === 'sawtooth' && $('#masterVolume').value === '0.7' && $('#filterType').value === 'lowpass' && $('#attack').value === '0.05', 'Undo did not put everything back');
 });
 await check('"set the tempo to 90" sets the session tempo the metronome shows', async expect => {
  await ask('set the tempo to 90');
  expect(window.synth.tempo === 90, `the tempo is ${window.synth.tempo}`);
  expect($('#bpmDisplay').textContent === '90', `the metronome shows ${$('#bpmDisplay').textContent}`);
  await ask('set the tempo to 120');
 });
 await check('widgets are hidden and shown again, and the Settings menu\'s switches change', async expect => {
  await ask('hide the oscilloscope');
  expect($('#scope-module').hidden, 'the oscilloscope still shows');
  buttonIn(lastChange(), 'Undo')?.click();
  expect(!$('#scope-module').hidden, 'Undo did not bring it back');
  await ask('turn on the panic button');
  expect($('#settings-panic-button').checked && document.documentElement.classList.contains('panic-button-on'), 'the PANIC button switch is off');
  await ask('turn the panic button off');
  expect(!$('#settings-panic-button').checked, 'it did not switch off again');
  await ask('turn off the ai teacher');
  expect($('#settings-teacher').checked && bridge.enabled, 'the teacher switched itself off');
 });
 await check('words that fit three controls ask which, and the one pressed is changed', async expect => {
  const levels = () => ['levelOsc1', 'levelOsc2', 'levelOsc3'].map(id => $(`#${id}`).value).join();
  const before = levels();
  await ask('set the level to 0.5');
  const pick = messages().at(-1), buttons = [...pick.querySelectorAll('button')].map(b => b.textContent);
  expect(buttons.join() === 'Oscillator 1 level,Oscillator 2 level,Oscillator 3 level', `it offered ${buttons.join(', ')}`);
  expect(levels() === before, `levels went from ${before} to ${levels()} before one was chosen`);
  buttonIn(pick, 'Oscillator 2 level')?.click();
  expect($('#levelOsc2').value === '0.5' && $('#levelOsc1').value === '0.7', `levels are ${$('#levelOsc1').value}, ${$('#levelOsc2').value}`);
  buttonIn(lastChange(), 'Undo')?.click();
 });
 await check('a question changes nothing', async expect => {
  const before = messages().filter(m => m.classList.contains('change')).length;
  await ask('how do I turn off the filter?');
  expect($('#enableFilter').checked, 'the filter was switched off');
  expect(messages().filter(m => m.classList.contains('change')).length === before, 'a change was made');
 });
 await check('a System 2 model\'s {"set": …} changes the control the same way', async expect => {
  const replies = ['Resonance makes the filter sing at the cutoff.\n{"set": {"Filter › Resonance (Q)": 12}}'];
  bridge.teacher.setEngine({ generate: async () => replies.shift() || 'OK' });
  await ask('could the filter sound more vocal?', 300);
  expect(Math.abs(Number($('#filterResonance').value) - 12) < 0.01, /* the slider's steps run from 0.001 */ `the resonance is ${$('#filterResonance').value}`);
  expect(/Changed Filter › Resonance/.test(lastChange()?.textContent || ''), 'no change was listed');
  buttonIn(lastChange(), 'Undo')?.click();
  bridge.teacher.setEngine(null);
 });
 /* ---- Two layers: System 1 is always Laya, System 2 the student's choice ---- */
 await check('the Provider tab has Laya as System 1, above a System 2 choice that doesn\'t include it', async expect => {
  panel().querySelector('#tp-tab-provider').click();
  const one = panel().querySelector('.tp-system-one'), two = panel().querySelector('.tp-providers');
  expect(/Laya/.test(one?.textContent || '') && !one.querySelector('input[type=radio]'), 'System 1 is not Laya on its own, or is a choice');
  const choices = [...two.querySelectorAll('input[type=radio]')].map(r => r.value);
  expect(!choices.includes('laya'), 'Laya is one of the System 2 choices');
  for (const id of ['none', 'local', 'openrouter', 'groq', 'gemini', 'custom']) expect(choices.includes(id), `System 2 has no ${id}`);
  expect(two.getAttribute('aria-label') === 'System 2', 'the choice is not labelled System 2');
  panel().querySelector('#tp-tab-lesson').click();
 });
 await check('Laya with a hosted System 2: Laya coaches each phrase, the hosted model thinks it through, the header names both', async expect => {
  const thought = [];
  bridge.laya = { decide: async () => ({ move: 'scale_run', confidence: 0.9, explain: 0, ms: 4 }), pick: async (_, __, o) => ({ choice: Object.keys(o)[0], confidence: 1, ms: 1 }) };
  bridge.teacher.setEngine({ generate: async messages => { thought.push(messages.at(-1).content); return 'You played the C major scale. Try it in thirds next.'; } });
  bridge._active = { id: 'groq', model: 'llama-3.3-70b-versatile' };
  bridge.mode = 'slow'; bridge.autoAnalyze = true;
  bridge._renderProviders(); bridge._renderState();
  const summary = panel().querySelector('.tp-summary-text').textContent;
  expect(summary === 'Laya + Groq · llama-3.3-70b-versatile', `the header says "${summary}"`);
  for (const midi of [60, 62, 64, 65, 67]) { for (const on of [true, false]) window.dispatchEvent(new CustomEvent('synth:note', { detail: { midi, velocity: 0.7, on, source: 'computer' } })); await wait(40); }
  await wait(1200);
  const who = messages().map(m => m.querySelector('.tp-who')?.textContent || '').filter(Boolean);
  expect(who.some(w => /^System 1 · Laya/.test(w)), `no step from Laya (${who.join(' | ')})`);
  expect(thought.some(t => /\[PLAYED\]/.test(t)), 'the hosted model was not asked to think the phrase through');
  expect(who.some(w => /^System 2 · Groq/.test(w)), `no answer from System 2 · Groq (${who.join(' | ')})`);
  expect(panel().querySelector('.tp-providers .tp-card[data-id="groq"] .tp-badge.on'), 'Groq is not marked connected');
  expect(/Loaded/.test(panel().querySelector('.tp-system-one').textContent), 'Laya is not marked loaded');
 });
 await check('"Use Laya alone" disconnects System 2 and keeps Laya', async expect => {
  bridge._selected = 'none'; bridge._renderProviders();
  [...panel().querySelectorAll('.tp-providers .tp-card[data-id="none"] button')].find(b => /Laya alone/.test(b.textContent))?.click();
  expect(!bridge.teacher.isConfigured && bridge.laya, 'System 2 is still connected, or Laya went');
  const summary = panel().querySelector('.tp-summary-text').textContent;
  expect(summary === 'Laya · alone', `the header says "${summary}"`);
  expect(panel().querySelector('.tp-providers .tp-card[data-id="none"] .tp-badge.on'), 'None is not marked as the choice in use');
  bridge.laya = null; bridge.mode = 'fast'; bridge._renderProviders(); bridge._renderState();
 });
 /* ---- How fast the teacher talks ---- */
 await check('the voice\'s Speed slider is kept and reaches the voice; "talk slower" moves it; the browser voice reads at it', async expect => {
  panel().querySelector('#tp-tab-provider').click();
  await wait(300); // the voice list is made as the tab opens
  const slider = panel().querySelector('.tp-voice-speed');
  expect(slider && slider.value === '1', `the slider is at ${slider?.value}`);
  slider.value = '1.5'; slider.dispatchEvent(new Event('input'));
  expect(JSON.parse(localStorage.getItem('teacher-voice-speed-v1')) === 1.5, 'the speed was not kept');
  expect(/1\.50×/.test(slider.closest('label').textContent), 'the slider does not say 1.50×');
  panel().querySelector('#tp-tab-lesson').click();
  await ask('talk a little slower');
  expect(bridge.voiceSpeed === 1.4 && slider.value === '1.4', `asked to talk a little slower, the speed is ${bridge.voiceSpeed} (slider ${slider.value})`);
  expect(/1\.4× slower|1\.4× faster/.test(messages().at(-1).textContent), `the reply was "${messages().at(-1).textContent}"`);
  const rates = [], speak = speechSynthesis.speak.bind(speechSynthesis);
  speechSynthesis.speak = u => { rates.push(u.rate); setTimeout(() => u.onend?.(), 0); };
  const v = bridge._makeVoice(); v.setVoice({ engine: 'browser', voice: '' });
  await v.speak('Testing the speed.');
  speechSynthesis.speak = speak;
  expect(Math.abs(rates[0] - 1.4) < 1e-6, `the browser voice read at ${rates[0]}`); // the rate is a float32
  await ask('talk at normal speed');
  expect(bridge.voiceSpeed === 1, `back to normal is ${bridge.voiceSpeed}`);
 });
 /* ---- Plug-ins: changed by name and by what the teacher learned they do ---- */
 const host = $('#plugin-host-module'), pick = host.querySelector('select[aria-label="Built-in effect"]');
 const addEffect = async re => { pick.value = [...pick.options].find(o => re.test(o.textContent)).value; [...host.querySelectorAll('button')].find(b => b.textContent === 'Add built-in').click(); for (let i = 0; i < 40 && !ws.widgets().some(w => w.plugin && re.test(w.title)); i++) await wait(50); };
 await addEffect(/^delay$/i); await addEffect(/^reverb$/i);
 const param = name => ws.find(name)?.control?.el;
 await check('plug-ins: "set the delay feedback to 60", "more reverb", "the delay to 500 ms", "turn off the delay"', async expect => {
  await ask('set the delay feedback to 60');
  expect(param('Delay › Feedback')?.value === '60', `the delay's feedback is ${param('Delay › Feedback')?.value}`);
  await ask('more reverb');
  expect(param('Reverb › Mix')?.value === '35', `asked for more reverb, its mix is ${param('Reverb › Mix')?.value} (was 25)`);
  await ask('set the delay to 500 ms');
  expect(param('Delay › Time')?.value === '500', `the delay time is ${param('Delay › Time')?.value}`);
  await ask('turn off the delay');
  expect(param('Delay › Bypass')?.checked === true, 'the delay is not bypassed');
  messages().filter(m => m.classList.contains('change')).reverse().forEach(m => buttonIn(m, 'Undo')?.click());
  expect(param('Delay › Feedback').value === '35' && param('Reverb › Mix').value === '25' && param('Delay › Time').value === '375' && !param('Delay › Bypass').checked, 'Undo did not put the plug-ins back');
 });

 /* ---- Tools: a hosted System 2 reads and changes the workspace by calling them ---- */
 await check('a hosted model\'s tool calls: it reads a plug-in, sets a control and hides a widget, each listed with Undo', async expect => {
  const results = {};
  bridge.teacher.setEngine({ generate: async (messages, opts) => {
   expect(opts.tools?.definitions.map(d => d.function.name).join() === 'list_widgets,get_controls,describe_plugin,set_control,arrange_widget,show_control', 'the tools were not offered');
   results.describe = await opts.tools.run('describe_plugin', { plugin: 'Reverb' });
   results.controls = await opts.tools.run('get_controls', { widget: 'Filter' });
   results.set = await opts.tools.run('set_control', { control: 'Reverb › Decay', value: 6 });
   results.bad = await opts.tools.run('set_control', { control: 'Reverb › Size of the moon', value: 3 });
   results.hide = await opts.tools.run('arrange_widget', { widget: 'Oscilloscope', state: 'hidden' });
   return 'A long decay is what a cathedral sounds like, so I made it six seconds.';
  } });
  bridge._active = { id: 'groq', model: 'test' };
  await ask('could the reverb feel like a cathedral?', 300);
  expect(/a reverb/.test(results.describe) && /Mix: how much of the effect/.test(results.describe), `describe_plugin said: ${results.describe}`);
  expect(/Cutoff \(Hz\) = 5000 \(20 to 20000\)/.test(results.controls), `get_controls said: ${results.controls}`);
  expect(param('Reverb › Decay')?.value === '6' && /^Done/.test(results.set), `set_control: decay ${param('Reverb › Decay')?.value}, said "${results.set}"`);
  expect(/^Not changed/.test(results.bad), `a control that isn't there: "${results.bad}"`);
  expect($('#scope-module').hidden && /^Done/.test(results.hide), 'arrange_widget did not hide the oscilloscope');
  const changes = messages().filter(m => m.classList.contains('change')).slice(-2);
  expect(changes.length === 2 && changes.every(m => /System 2 · Groq/.test(m.textContent) && buttonIn(m, 'Undo')), 'the changes are not listed as System 2\'s, with Undo');
  changes.reverse().forEach(m => buttonIn(m, 'Undo')?.click());
  expect(param('Reverb › Decay').value === '2.2' && !$('#scope-module').hidden, 'Undo did not put them back');
  bridge.teacher.setEngine(null); bridge._active = null;
 });

 await check('a name with a slash in it is one widget: Import / Export › Audio export format', async expect => {
  const hit = ws.find('Import / Export › Audio export format');
  expect(hit?.widget.title === 'Import / Export' && hit?.control?.label === 'Audio export format', `found ${hit && ws.nameOf(hit)}`);
 });
 return { checks };
}
