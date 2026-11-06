// Checks run inside the app itself (index.html), by node tests/waveforms.mjs: the Oscillators widget built,
// used and saved as a student would, then every waveform and a layered stack played through the real synth
// (envelope, filter, master and limiter) and measured at its output. Returns { checks: [{ name, ok, problems }] }.
import { DEFAULT_STACK, WAVEFORMS, MAX_OSCILLATORS } from '../js/oscillators.js';
import { frequency, cents, moved } from './waveforms.js';
import { widgets, controls } from '../js/workspace.js';
import { apply } from '../js/automation.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const $ = id => document.getElementById(id);
const plain = list => list.map(({ id, ...o }) => o);
// Changes a control the way the page sees a person change it.
const setUI = (id, value) => {
 const el = $(id);
 if (el.type === 'checkbox') el.checked = value; else el.value = value;
 el.dispatchEvent(new Event('input', { bubbles: true }));
 el.dispatchEvent(new Event('change', { bubbles: true }));
};

// Plays `note` through the synth for `ms` and returns what the output carried at the end (8192 samples).
async function playAndListen(note, ms = 300) {
 const ctx = window.synth.ensureAudio();
 if (ctx.state !== 'running') await ctx.resume();
 const tap = new AnalyserNode(ctx, { fftSize: 8192 });
 window.synth.output.connect(tap);
 window.synth.noteOn(note);
 await wait(ms);
 const x = new Float32Array(tap.fftSize);
 tap.getFloatTimeDomainData(x);
 window.synth.noteOff(note);
 window.synth.output.disconnect(tap);
 await wait(120);
 return { x, rate: ctx.sampleRate };
}
const rmsOf = x => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
// The amplitude at `hz`, Hann-windowed.
const amplitudeAt = (x, hz, rate) => { let re = 0, im = 0; const w = (2 * Math.PI * hz) / rate; for (let i = 0; i < x.length; i++) { const v = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / x.length)); re += v * Math.cos(w * i); im += v * Math.sin(w * i); } return (4 * Math.hypot(re, im)) / x.length; };

const CHECKS = [];
const check = (name, fn) => CHECKS.push({ name, fn });
const bank = () => window.oscillatorBank;

check('one Oscillators widget replaces Oscillator 1, Oscillator 2 and the Sub', async expect => {
 const w = $('oscillators-group');
 expect(w?.classList.contains('widget'), 'no Oscillators widget');
 expect(!$('osc2-group') && !$('sub-noise-group'), 'an old oscillator widget is still there');
 expect(w.querySelectorAll('.osc-row').length === 3, `${w.querySelectorAll('.osc-row').length} rows, not 3`);
 expect(JSON.stringify(plain(bank().list())) === JSON.stringify(DEFAULT_STACK), 'not the default stack');
 expect([...$('visualizerSourceSelect').options].map(o => o.value).join() === 'master,osc1,osc2,osc3,input', 'the oscilloscope does not list each oscillator (then the Listening input)');
 const seen = widgets().find(x => x.id === 'oscillators-group');
 expect(seen?.title === 'Oscillators', 'the teacher does not see it as Oscillators');
 expect(controls(seen).some(c => c.label === 'Oscillator 1 waveform') && controls(seen).some(c => c.label === 'Oscillator 3 level'), 'the teacher can\'t tell the rows\' controls apart');
});
check(`+ Add oscillator, up to ${MAX_OSCILLATORS}; × removes one and the rest renumber`, async expect => {
 const add = $('addOscillator');
 while (!add.disabled) add.click();
 const rows = () => $('oscillators-group').querySelectorAll('.osc-row');
 expect(bank().list().length === MAX_OSCILLATORS && rows().length === MAX_OSCILLATORS, `${rows().length} rows`);
 expect($(`waveformOsc${MAX_OSCILLATORS}`) && $('visualizerSourceSelect').options.length === MAX_OSCILLATORS + 2, 'the last row or its oscilloscope source is missing');
 const second = bank().list()[1].id;
 rows()[1].querySelector('.osc-remove').click();
 expect(bank().list().length === MAX_OSCILLATORS - 1 && !bank().list().some(o => o.id === second), 'the second oscillator was not removed');
 expect(!$(`waveformOsc${MAX_OSCILLATORS}`) && !add.disabled, 'rows did not renumber, or Add stayed disabled');
 bank().set([{ waveform: 'sine' }]);
 expect(rows()[0].querySelector('.osc-remove').disabled, 'the last oscillator can be removed');
});
check('each row\'s controls set its oscillator, and the bank is saved', async expect => {
 bank().set(Object.keys(WAVEFORMS).map(() => ({ waveform: 'sine', level: 0.5 })));
 Object.keys(WAVEFORMS).forEach((w, i) => setUI(`waveformOsc${i + 1}`, w));
 setUI('octaveOsc1', -1); setUI('detuneOsc1', 12); setUI('levelOsc1', 0.25); setUI('delayOsc1', 3); setUI('enableOsc2', false); setUI('pulseWidthOsc5', 0.2);
 const list = bank().list();
 expect(list.map(o => o.waveform).join() === Object.keys(WAVEFORMS).join(), `waveforms are ${list.map(o => o.waveform).join()}`);
 expect(list[0].octave === -1 && list[0].detune === 12 && list[0].level === 0.25 && list[0].delay === 3 && list[1].on === false && list[4].pulseWidth === 0.2, 'a control did not reach its oscillator');
 const row = n => $('oscillators-group').querySelectorAll('.osc-row')[n - 1];
 expect(!row(5).querySelector('#pulseWidthOsc5').closest('label').hidden && row(1).querySelector('#pulseWidthOsc1').closest('label').hidden, 'Pulse width shows on the wrong rows');
 expect(row(6).querySelector('#octaveOsc6').closest('label').hidden && !row(1).querySelector('#octaveOsc1').closest('label').hidden, 'noise rows still show octave and detune');
 const saved = JSON.parse(localStorage.getItem('synth-oscillators-v1'));
 expect(saved.length === 7 && saved[0].detune === 12 && saved[1].on === false && !('id' in saved[0]), 'the bank is not saved');
});
check('an automation lane still moves the first oscillator\'s detune', async expect => {
 bank().set([{ waveform: 'sine' }]);
 apply('detuneOsc1', 33);
 expect(bank().list()[0].detune === 33, `detune is ${bank().list()[0].detune}`);
});

// Through the whole synth: one oscillator at a time, then a layered stack. Slop and the filter are switched off
// so the pitch is exact and nothing is taken away.
const A5 = 440; // the synth names MIDI 69 "A5"
for (const waveform of Object.keys(WAVEFORMS)) {
 check(`${WAVEFORMS[waveform]} plays through the synth${waveform in { white: 1, pink: 1 } ? '' : ' at its pitch'}`, async expect => {
  setUI('oscSlop', 0); setUI('enableFilter', false);
  bank().set([{ waveform, level: 0.7 }]);
  const { x, rate } = await playAndListen('A5');
  expect(rmsOf(x) > 0.02, `silent (RMS ${rmsOf(x).toFixed(4)})`);
  if (!/white|pink/.test(waveform)) { const f = frequency(x, rate, 0); expect(Math.abs(cents(f, A5)) < 5, `pitch ${f.toFixed(2)} Hz, not ${A5}`); }
 });
}
check('a stack of oscillators plays as layers: an octave up comes through at its level', async expect => {
 setUI('oscSlop', 0); setUI('enableFilter', false);
 bank().set([{ waveform: 'sine', level: 0.6 }, { waveform: 'sine', octave: 1, level: 0.3 }, { waveform: 'sine', octave: -1, level: 0.6, on: false }]);
 const { x, rate } = await playAndListen('A5');
 const a = amplitudeAt(x, A5, rate), b = amplitudeAt(x, 2 * A5, rate), off = amplitudeAt(x, A5 / 2, rate);
 expect(Math.abs(b / a - 0.5) < 0.05, `the octave is ${(b / a).toFixed(3)} of the root, not 0.5`);
 expect(off < a / 100, 'the switched-off oscillator sounds');
});
check('a held note follows its oscillator\'s level as it changes', async expect => {
 setUI('oscSlop', 0); setUI('enableFilter', false);
 bank().set([{ waveform: 'sine', level: 0.6 }]);
 const ctx = window.synth.ensureAudio(), tap = new AnalyserNode(ctx, { fftSize: 4096 });
 window.synth.output.connect(tap); window.synth.noteOn('A5');
 await wait(250);
 const x = new Float32Array(4096), loud = (tap.getFloatTimeDomainData(x), rmsOf(x));
 setUI('levelOsc1', 0.15);
 await wait(200);
 tap.getFloatTimeDomainData(x);
 const quiet = rmsOf(x);
 window.synth.noteOff('A5'); window.synth.output.disconnect(tap);
 expect(Math.abs(quiet / loud - 0.25) < 0.05, `a quarter of the level gave ${(quiet / loud).toFixed(3)} of the RMS`);
});
check('a held pulse follows its pulse width as it changes', async expect => {
 setUI('oscSlop', 0); setUI('enableFilter', false);
 bank().set([{ waveform: 'pulse', level: 0.6, pulseWidth: 0.5 }]);
 const ctx = window.synth.ensureAudio(), tap = new AnalyserNode(ctx, { fftSize: 8192 });
 window.synth.output.connect(tap); window.synth.noteOn('A5');
 await wait(250);
 setUI('pulseWidthOsc1', 0.25);
 await wait(300); // longer than the 8192 samples the analyser holds, so none of the old width is left
 const x = new Float32Array(8192);
 tap.getFloatTimeDomainData(x);
 window.synth.noteOff('A5'); window.synth.output.disconnect(tap);
 const high = x.filter(v => v > 0).length / x.length;
 expect(Math.abs(high - 0.25) < 0.04, `high ${high.toFixed(3)} of the time after changing the width to 0.25`);
});
check('the oscilloscope can watch any one oscillator', async expect => {
 bank().set([{ waveform: 'sine' }, { waveform: 'square' }, { waveform: 'triangle' }]);
 setUI('visualizerSourceSelect', 'osc3');
 window.synth.noteOn('A5'); await wait(150); window.synth.noteOff('A5');
 expect($('visualizerSourceSelect').value === 'osc3', 'the third oscillator is not a source');
 bank().set([{ waveform: 'sine' }]);
 expect($('visualizerSourceSelect').value === 'master', 'a removed oscillator stays selected');
});
check('a loop slot plays with the sound it was recorded with', async expect => {
 setUI('oscSlop', 0); setUI('enableFilter', false);
 bank().set([{ waveform: 'sine', level: 0.7 }]);
 const params = window.synth.params();
 window.synth.setLoop(0, [{ type: 'noteon', note: 'A5', velocity: 0.7, time: 0, synthParams: params }, { type: 'noteoff', note: 'A5', velocity: 0, time: 900 }], 1000);
 bank().set([{ waveform: 'sawtooth', level: 0.7 }, { waveform: 'white', level: 0.7 }]); // changed after recording
 const ctx = window.synth.ensureAudio(), tap = new AnalyserNode(ctx, { fftSize: 8192 });
 window.synth.output.connect(tap);
 expect(window.synth.playLoop(0), 'the loop did not start');
 await wait(400);
 const x = new Float32Array(8192);
 tap.getFloatTimeDomainData(x);
 window.synth.stopLoop(0); window.synth.output.disconnect(tap);
 window.synth.setLoop(0, [], 0);
 const f = frequency(x, ctx.sampleRate, 0), pure = amplitudeAt(x, 2 * A5, ctx.sampleRate) < amplitudeAt(x, A5, ctx.sampleRate) / 50;
 expect(rmsOf(x) > 0.02 && Math.abs(cents(f, A5)) < 5, `the loop played ${f.toFixed(1)} Hz at RMS ${rmsOf(x).toFixed(3)}`);
 expect(pure, 'the loop took the new oscillators instead of its own sine');
});

// The whole sound path, fingerprinted: the default sound, the filter and the envelope, measured at the
// synth's output as harmonic amplitudes of a steady note (Hann-windowed, so timing doesn't matter) and RMS.
// A fingerprint may move by 5% (or 0.003) before it fails: a live capture is close to, but not exactly,
// the same twice, and a regression moves it much further.
// The synth's settings as the session started, recorded before any check changes them: the checks go back to
// these (not to values written here), so a changed default changes what they hear.
const SETTINGS = ['baseOctave', 'oscSlop', 'enableAdsr', 'attack', 'decay', 'sustain', 'release', 'enableFilter', 'filterType', 'filterCutoff', 'filterResonance', 'masterVolume', 'numOctavesSelect'];
const snapshot = () => ({ ...Object.fromEntries(SETTINGS.map(id => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value])), oscillators: JSON.stringify(plain(bank().list())) });
let initial = null;
const defaults = () => { SETTINGS.forEach(id => setUI(id, initial[id])); bank().set(JSON.parse(initial.oscillators)); setUI('oscSlop', 0); };
const print = (x, rate, f0, n) => ({ h: Array.from({ length: n }, (_, k) => +amplitudeAt(x, f0 * (k + 1), rate).toFixed(4)), rms: +rmsOf(x).toFixed(4) });
check('app: the settings a session starts with', async () => ({ settings: initial }));
check('app: the default sound, through the whole synth', async () => {
 defaults();
 const { x, rate } = await playAndListen('A5', 400);
 return print(x, rate, A5 / 4, 32); // the sub, two octaves down, is the fundamental; up to 3.5 kHz
});
check('app: a resonant lowpass at 800 Hz', async () => {
 defaults(); bank().set([{ waveform: 'sawtooth', level: 0.7 }]); setUI('filterCutoff', 800); setUI('filterResonance', 10);
 const { x, rate } = await playAndListen('A5', 400);
 return print(x, rate, A5, 8);
});
check('app: a highpass at 2 kHz', async () => {
 defaults(); bank().set([{ waveform: 'sawtooth', level: 0.7 }]); setUI('filterType', 'highpass'); setUI('filterCutoff', 2000); setUI('filterResonance', 1);
 const { x, rate } = await playAndListen('A5', 400);
 return print(x, rate, A5, 8);
});
check('app: the envelope holds a note at its sustain level', async expect => {
 defaults(); bank().set([{ waveform: 'sine', level: 0.5 }]); setUI('enableFilter', false);
 const held = rmsOf((await playAndListen('A5', 400)).x);
 setUI('enableAdsr', false);
 const full = rmsOf((await playAndListen('A5', 400)).x);
 const sustain = Number($('sustain').value);
 expect(Math.abs(held / full - sustain) < 0.03, `held at ${(held / full).toFixed(3)} of full level, not the sustain ${sustain}`);
});

// Runs every check; fingerprints are compared with `golden` (see tests/waveforms.js runLab).
export async function runApp({ golden = null, update = false } = {}) {
 const checks = [];
 initial = snapshot();
 for (const { name, fn } of CHECKS) {
  const problems = [];
  let fingerprint = null;
  try {
   fingerprint = (await fn((ok, why) => { if (!ok) problems.push(why); })) || null;
   const was = golden?.[name];
   if (fingerprint?.settings && was && !update) Object.keys({ ...was.settings, ...fingerprint.settings }).forEach(k => { if (was.settings[k] !== fingerprint.settings[k]) problems.push(`${k} starts at ${fingerprint.settings[k]}, was ${was.settings[k]} (tests/waveforms.golden.json)`); });
   else if (fingerprint && was && !update) problems.push(...moved(was, fingerprint, v => Math.max(0.003, Math.abs(v) * 0.05)));
   else if (fingerprint && golden && !was && !update) problems.push('no fingerprint in tests/waveforms.golden.json yet: run node tests/waveforms.mjs --update');
  } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems, fingerprint });
 }
 defaults(); setUI('oscSlop', initial.oscSlop);
 return { checks };
}
