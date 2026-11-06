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
 await check('a name with a slash in it is one widget: Import / Export › Audio export format', async expect => {
  const hit = ws.find('Import / Export › Audio export format');
  expect(hit?.widget.title === 'Import / Export' && hit?.control?.label === 'Audio export format', `found ${hit && ws.nameOf(hit)}`);
 });
 return { checks };
}
