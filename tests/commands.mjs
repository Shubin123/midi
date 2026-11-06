// node tests/commands.mjs: requests to change a setting (js/commands.js), read without a model, against the
// controls the app really has (as js/workspace.js lists them), a plug-in and the Settings menu.
import assert from 'node:assert/strict';
import { readCommand, normalize } from '../js/commands.js';

const opts = (...texts) => texts.map(t => (typeof t === 'string' ? { value: t.toLowerCase().replace(/\s+/g, '-'), text: t } : t));
const num = (widget, label, id, value, min, max, step = 0.01) => ({ name: `${widget} › ${label}`, widget, label, id, kind: 'number', value, min, max, step });
const sel = (widget, label, id, value, options) => ({ name: `${widget} › ${label}`, widget, label, id, kind: 'select', value, options });
const box = (widget, label, id, value) => ({ name: `${widget} › ${label}`, widget, label, id, kind: 'checkbox', value });
const widget = (title, value = 'shown') => ({ name: title, widget: title, label: title, id: '', kind: 'widget', value });
const WAVES = opts('Sine', 'Square', 'Sawtooth', 'Triangle', 'Pulse', 'White noise', 'Pink noise');
const osc = n => [box('Oscillators', `Oscillator ${n} on`, `enableOsc${n}`, true), sel('Oscillators', `Oscillator ${n} waveform`, `waveformOsc${n}`, n === 3 ? 'square' : 'sawtooth', WAVES),
 sel('Oscillators', `Oscillator ${n} octave`, `octaveOsc${n}`, n === 3 ? '-2' : '0', ['-2', '-1', '0', '1', '2'].map(v => ({ value: v, text: v }))),
 num('Oscillators', `Oscillator ${n} detune`, `detuneOsc${n}`, 0, -100, 100, 1), num('Oscillators', `Oscillator ${n} level`, `levelOsc${n}`, 0.7, 0, 1), num('Oscillators', `Oscillator ${n} start delay`, `delayOsc${n}`, 0, 0, 50, 1)];

const items = () => [
 widget('Keyboard'), box('Keyboard', 'Falling notes', 'synthesiaToggle', true),
 widget('Step sequencer'), num('Step sequencer', 'Base BPM', 'seq-bpm', 120, 30, 300, 1),
 sel('Step sequencer', 'Key', 'seq-key', '0', ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'].map((t, i) => ({ value: String(i), text: t }))),
 sel('Step sequencer', 'Scale', 'seq-scale', 'major-pentatonic', opts('Major', 'Minor', 'Dorian', 'Major Pentatonic', 'Minor Pentatonic', 'Blues')),
 widget('Automation'), box('Automation', 'Tempo · BPM', '', false),
 widget('Oscillators'), ...osc(1), ...osc(2), ...osc(3),
 sel('Oscillators', 'Keyboard Octave', 'baseOctave', '4', ['2', '3', '4', '5', '6'].map(v => ({ value: v, text: v }))), num('Oscillators', 'Oscillator Slop', 'oscSlop', 0.005, 0, 0.1, 0.001),
 widget('Envelope (ADSR)'), box('Envelope (ADSR)', 'On', 'enableAdsr', true), num('Envelope (ADSR)', 'Attack (s)', 'attack', 0.05, 0.001, 2, 0.001), num('Envelope (ADSR)', 'Decay (s)', 'decay', 0.1, 0.001, 2, 0.001), num('Envelope (ADSR)', 'Sustain (level)', 'sustain', 0.6, 0, 1), num('Envelope (ADSR)', 'Release (s)', 'release', 0.5, 0.001, 5, 0.001),
 widget('Metronome & Tempo'), box('Metronome & Tempo', 'Metronome', 'metronomeToggle', false),
 widget('Filter'), box('Filter', 'On', 'enableFilter', true), sel('Filter', 'Type', 'filterType', 'lowpass', ['Lowpass', 'Highpass', 'Bandpass', 'Notch', 'Allpass (Bypass)'].map(t => ({ value: t.split(' ')[0].toLowerCase(), text: t }))),
 num('Filter', 'Cutoff (Hz)', 'filterCutoff', 5000, 20, 20000, 1), num('Filter', 'Resonance (Q)', 'filterResonance', 2, 0.001, 30),
 widget('Master & Settings'), sel('Master & Settings', 'Keyboard Octaves', 'numOctavesSelect', '2', ['1', '2', '3', '4'].map(v => ({ value: v, text: `${v} Octave${v === '1' ? '' : 's'}` }))), num('Master & Settings', 'Volume', 'masterVolume', 0.7, 0, 1),
 sel('Master & Settings', 'Visualizer Source', 'visualizerSourceSelect', 'master', [{ value: 'master', text: 'Master Output' }, { value: '0', text: 'Oscillator 1' }, { value: '1', text: 'Oscillator 2' }]),
 sel('Master & Settings', 'UI Theme', 'uiTheme', 'midnight-drive', opts('Midnight Drive', 'Forest Calm', 'Ocean Depth', 'Pastel Dream')), num('Master & Settings', 'UI Scale (%)', 'uiScale', 100, 75, 150, 5),
 widget('Loop recorder'), widget('Oscilloscope'), widget('Air'), box('Air', 'Enabled', '', false), num('Air', 'Mid Air', '', 0, 0, 10, 0.1),
 widget('Import / Export'), box('Import / Export', 'Release tail', '', true),
 widget('Delay'), num('Delay', 'Time', '', 0.3, 0, 2), num('Delay', 'Feedback', '', 0.4, 0, 0.95), num('Delay', 'Mix', '', 0.3, 0, 1), box('Delay', 'Bypass', '', false),
 box('Settings', 'PANIC button on the page', 'settings-panic-button', false), box('Settings', '🎓 buttons on widgets, each opening its guide', 'settings-teach-buttons', false),
];

let failed = 0;
const check = (name, fn) => { try { fn(); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message.split('\n')[0]}`); } };
// The changes a request makes, as "name = value", in order.
const did = text => { const r = readCommand(text, items()); return r?.changes?.map(c => `${c.item.name} = ${c.value}`) ?? null; };
const expect = (text, ...want) => check(text, () => assert.deepEqual(did(text), want, `"${text}"`));
const none = text => check(`${text} is not a request to change anything`, () => assert.equal(readCommand(text, items()), null, `"${text}" was read as ${JSON.stringify(did(text))}`));
const asks = (text, ...names) => check(`${text} asks which`, () => { const r = readCommand(text, items()); assert.ok(r?.ask, `"${text}" did not ask: ${JSON.stringify(did(text))}`); assert.deepEqual(r.ask.choices.map(c => c.label).sort(), names.sort()); });

/* ---- The words ---- */
check('spellings are made one', () => {
 assert.equal(normalize('Turn the 2nd OSC to a saw'), 'turn the oscillator 2 to a sawtooth');
 assert.equal(normalize('osc3 high-pass 2k please!'), 'oscillator 3 highpass 2000 hz please');
 assert.equal(normalize('oscillator two'), 'oscillator 2');
});

/* ---- Numbers, in the control's own unit ---- */
expect('set the cutoff to 800', 'Filter › Cutoff (Hz) = 800');
expect('Cutoff 800 Hz', 'Filter › Cutoff (Hz) = 800');
expect('change the filter cutoff to 2k', 'Filter › Cutoff (Hz) = 2000');
expect('set attack to 200 ms', 'Envelope (ADSR) › Attack (s) = 0.2');
expect('release 2 seconds', 'Envelope (ADSR) › Release (s) = 2');
expect('set the volume to 50%', 'Master & Settings › Volume = 0.5');
expect('volume 80', 'Master & Settings › Volume = 0.8');
expect('resonance to 10', 'Filter › Resonance (Q) = 10');
expect('set the tempo to 90', 'Step sequencer › Base BPM = 90');
expect('bpm 140', 'Step sequencer › Base BPM = 140');
expect('set the metronome to 100', 'Step sequencer › Base BPM = 100');
expect('set oscillator 3 detune to -12', 'Oscillators › Oscillator 3 detune = -12');
expect('detune the second osc by 7 cents', 'Oscillators › Oscillator 2 detune = 7');
expect('ui scale 120', 'Master & Settings › UI Scale (%) = 120');
expect('set the delay feedback to 0.6', 'Delay › Feedback = 0.6');
// Out of range: held to the control's range.
expect('set the cutoff to 50000', 'Filter › Cutoff (Hz) = 20000');
expect('cutoff to max', 'Filter › Cutoff (Hz) = 20000');

/* ---- Up and down ---- */
expect('lower the cutoff', 'Filter › Cutoff (Hz) = 3333');
expect('make it brighter', 'Filter › Cutoff (Hz) = 7500');
expect('darker', 'Filter › Cutoff (Hz) = 3333');
expect('louder', 'Master & Settings › Volume = 0.8');
expect('turn it up', 'Master & Settings › Volume = 0.8');
expect('turn the volume down a little', 'Master & Settings › Volume = 0.65');
expect('make the attack longer', 'Envelope (ADSR) › Attack (s) = 0.075');
expect('shorter release', 'Envelope (ADSR) › Release (s) = 0.333');
expect('more resonance', 'Filter › Resonance (Q) = 5');
expect('speed up the tempo', 'Step sequencer › Base BPM = 130');
expect('raise the cutoff by 500', 'Filter › Cutoff (Hz) = 5500');
expect('lower the tempo by 20 bpm', 'Step sequencer › Base BPM = 100');
expect('more octaves on the keyboard', 'Master & Settings › Keyboard Octaves = 3');
expect('raise the keyboard octave', 'Oscillators › Keyboard Octave = 5');
expect('make the attack longer and the release shorter', 'Envelope (ADSR) › Attack (s) = 0.075', 'Envelope (ADSR) › Release (s) = 0.333');

/* ---- Choices by name ---- */
expect('set oscillator 2 to square', 'Oscillators › Oscillator 2 waveform = square');
expect('change the third oscillator\'s waveform to sine', 'Oscillators › Oscillator 3 waveform = sine');
expect('osc 1 triangle', 'Oscillators › Oscillator 1 waveform = triangle');
expect('osc 3 saw', 'Oscillators › Oscillator 3 waveform = sawtooth');
expect('switch the filter to highpass', 'Filter › Type = highpass');
expect('filter type band pass', 'Filter › Type = bandpass');
expect('use a highpass filter', 'Filter › Type = highpass');
expect('change the theme to forest calm', 'Master & Settings › UI Theme = forest-calm');
expect('use the ocean theme', 'Master & Settings › UI Theme = ocean-depth');
expect('set the sequencer key to D', 'Step sequencer › Key = 2');
expect('set the scale to dorian', 'Step sequencer › Scale = dorian');
expect('change the key to D minor', 'Step sequencer › Key = 2', 'Step sequencer › Scale = minor');
expect('3 octaves on the keyboard', 'Master & Settings › Keyboard Octaves = 3');
expect('set the oscilloscope source to oscillator 2', 'Master & Settings › Visualizer Source = 1');

/* ---- On and off ---- */
expect('turn off the filter', 'Filter › On = false');
expect('turn the envelope off', 'Envelope (ADSR) › On = false');
expect('turn on the metronome', 'Metronome & Tempo › Metronome = true');
expect('metronome on', 'Metronome & Tempo › Metronome = true');
expect('mute oscillator 3', 'Oscillators › Oscillator 3 on = false');
expect('turn off the second oscillator', 'Oscillators › Oscillator 2 on = false');
expect('turn off falling notes', 'Keyboard › Falling notes = false');
expect('hide the falling notes', 'Keyboard › Falling notes = false');
expect('enable air', 'Air › Enabled = true');
expect('bypass the delay', 'Delay › Bypass = true');
expect('turn the delay off', 'Delay › Bypass = true');
expect('turn on the panic button', 'Settings › PANIC button on the page = true');
expect('switch on the guide buttons', 'Settings › 🎓 buttons on widgets, each opening its guide = true');
expect('turn off the filter and the envelope', 'Filter › On = false', 'Envelope (ADSR) › On = false');
expect('turn on the metronome at 90 bpm', 'Metronome & Tempo › Metronome = true', 'Step sequencer › Base BPM = 90');
expect('set attack and release to 0.2', 'Envelope (ADSR) › Attack (s) = 0.2', 'Envelope (ADSR) › Release (s) = 0.2');
expect('could you please set the cutoff to 1200 for me', 'Filter › Cutoff (Hz) = 1200');

/* ---- Widgets ---- */
expect('hide the oscilloscope', 'Oscilloscope = hidden');
expect('minimise the sequencer', 'Step sequencer = minimised');
expect('hide the filter', 'Filter = hidden');
check('expand a minimised widget', () => { const list = items().map(i => (i.name === 'Air' ? { ...i, value: 'minimised' } : i)); assert.deepEqual(readCommand('expand air', list).changes.map(c => `${c.item.name} = ${c.value}`), ['Air = shown']); });

/* ---- Already so ---- */
check('a setting already as asked says so', () => {
 const r = readCommand('turn on the filter', items());
 assert.deepEqual(r.changes, []);
 assert.match(r.already[0].say, /Filter › On is already on/);
});

/* ---- Asks which ---- */
asks('set the level to 0.5', 'Oscillators › Oscillator 1 level', 'Oscillators › Oscillator 2 level', 'Oscillators › Oscillator 3 level');
asks('use a sine wave', 'Oscillators › Oscillator 1 waveform', 'Oscillators › Oscillator 2 waveform', 'Oscillators › Oscillator 3 waveform');
asks('set the detune to 10', 'Oscillators › Oscillator 1 detune', 'Oscillators › Oscillator 2 detune', 'Oscillators › Oscillator 3 detune');
check('each choice carries its value', () => assert.deepEqual(readCommand('set the level to 0.5', items()).ask.choices.map(c => c.value), [0.5, 0.5, 0.5]));

/* ---- Not requests to change anything ---- */
none('how do I turn off the filter?');
none('what does the cutoff do');
none('is the metronome on?');
none('why does the filter sound dark');
none('dorian');
none('play a sad progression in D minor');
none('play it again');
none('make a lick in a minor');
none('play it an octave lower');
none('play the scale higher');
none('slower');
none('make the chords longer');
none('show me the cutoff');
none('tell me about the envelope');
none('the filter');
none('thanks');
check('a named control with nothing it can take is a problem, not a guess', () => assert.ok(readCommand('set the filter cutoff to bright', items())?.problem));

console.log(failed ? `\n${failed} failed` : 'commands: all checks passed');
process.exit(failed ? 1 : 0);
