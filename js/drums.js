// A drum kit for pads, made on the spot from oscillators and noise (nothing to download), on the General MIDI
// drum notes: 36 kick, 38 snare, 37 side stick, 39 clap, 42 closed and 46 open hi-hat, 44 pedal hi-hat, the
// toms, 49 crash, 51 ride, 56 cowbell. It plays through the master volume, Air and the plug-ins. A hit is also
// told to the beat clock and the teacher as a synth:note with source 'midi-drum' (silent, so no instrument plays
// it, and as a clap, CLAP: a rhythm without a pitch), so pad drumming is timed and coached like clapping.
import { CLAP } from './listening.js';

const NAMES = { 35: 'Kick 2', 36: 'Kick', 37: 'Side stick', 38: 'Snare', 39: 'Clap', 40: 'Snare 2', 41: 'Low tom 2', 42: 'Closed hat', 43: 'Low tom', 44: 'Pedal hat', 45: 'Mid tom 2', 46: 'Open hat', 47: 'Mid tom', 48: 'High tom 2', 49: 'Crash', 50: 'High tom', 51: 'Ride', 56: 'Cowbell', 57: 'Crash 2', 59: 'Ride 2' };
// The eight a pad bank plays first, in the order most pad controllers lay them out.
export const KIT = [36, 38, 42, 46, 39, 45, 50, 49];
let noise = null;
const noiseFor = ctx => { if (noise?.sampleRate === ctx.sampleRate) return noise; noise = new AudioBuffer({ length: ctx.sampleRate, sampleRate: ctx.sampleRate }); const d = noise.getChannelData(0); let s = 7; for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = s / 1073741823.5 - 1; } return noise; };

function env(ctx, out, when, peak, decay) {
 const g = new GainNode(ctx, { gain: 0 });
 g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(peak, when + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
 g.connect(out); setTimeout(() => g.disconnect(), (when - ctx.currentTime + decay + 0.2) * 1000);
 return g;
}
function tone(ctx, out, when, { from, to = from, type = 'sine', peak, decay, sweep = 0.05 }) {
 const o = new OscillatorNode(ctx, { type, frequency: from });
 o.frequency.setValueAtTime(from, when); if (to !== from) o.frequency.exponentialRampToValueAtTime(to, when + sweep);
 o.connect(env(ctx, out, when, peak, decay)); o.start(when); o.stop(when + decay + 0.05);
}
function hiss(ctx, out, when, { type = 'highpass', frequency, q = 0.7, peak, decay }) {
 const s = new AudioBufferSourceNode(ctx, { buffer: noiseFor(ctx), loop: true }), f = new BiquadFilterNode(ctx, { type, frequency, Q: q });
 s.connect(f).connect(env(ctx, out, when, peak, decay)); s.start(when, Math.random()); s.stop(when + decay + 0.05);
}

const VOICES = {
 kick: (c, o, t, v) => tone(c, o, t, { from: 150, to: 45, peak: v, decay: 0.45, sweep: 0.08 }),
 snare: (c, o, t, v) => { tone(c, o, t, { from: 190, to: 160, peak: v * 0.5, decay: 0.12 }); hiss(c, o, t, { type: 'bandpass', frequency: 1800, q: 0.6, peak: v * 0.8, decay: 0.2 }); },
 stick: (c, o, t, v) => { tone(c, o, t, { from: 1700, type: 'square', peak: v * 0.25, decay: 0.03 }); hiss(c, o, t, { frequency: 3000, peak: v * 0.3, decay: 0.03 }); },
 clap: (c, o, t, v) => [0, 0.011, 0.022].forEach((d, i) => hiss(c, o, t + d, { type: 'bandpass', frequency: 1200, q: 1, peak: v * (i === 2 ? 0.8 : 0.5), decay: i === 2 ? 0.18 : 0.02 })),
 closed: (c, o, t, v) => hiss(c, o, t, { frequency: 7500, peak: v * 0.45, decay: 0.05 }),
 pedal: (c, o, t, v) => hiss(c, o, t, { frequency: 7000, peak: v * 0.3, decay: 0.08 }),
 open: (c, o, t, v) => hiss(c, o, t, { frequency: 7000, peak: v * 0.4, decay: 0.38 }),
 crash: (c, o, t, v) => hiss(c, o, t, { frequency: 5000, peak: v * 0.45, decay: 1.3 }),
 ride: (c, o, t, v) => { hiss(c, o, t, { type: 'bandpass', frequency: 6500, q: 1.2, peak: v * 0.3, decay: 0.8 }); tone(c, o, t, { from: 3200, type: 'triangle', peak: v * 0.06, decay: 0.6 }); },
 cowbell: (c, o, t, v) => { tone(c, o, t, { from: 540, type: 'square', peak: v * 0.15, decay: 0.3 }); tone(c, o, t, { from: 800, type: 'square', peak: v * 0.15, decay: 0.3 }); },
 tom: hz => (c, o, t, v) => tone(c, o, t, { from: hz * 1.6, to: hz, peak: v * 0.8, decay: 0.35, sweep: 0.1 }),
};
const VOICE_OF = { 35: VOICES.kick, 36: VOICES.kick, 37: VOICES.stick, 38: VOICES.snare, 40: VOICES.snare, 39: VOICES.clap, 42: VOICES.closed, 44: VOICES.pedal, 46: VOICES.open, 49: VOICES.crash, 57: VOICES.crash, 51: VOICES.ride, 59: VOICES.ride, 56: VOICES.cowbell, 41: VOICES.tom(80), 43: VOICES.tom(98), 45: VOICES.tom(116), 47: VOICES.tom(138), 48: VOICES.tom(165), 50: VOICES.tom(196) };

export const drums = {
 name: note => NAMES[note] || `Drum ${note}`,
 // Plays drum `note` at velocity 0 to 1, at `time` on the page's clock (now, if not given).
 hit(note, velocity = 0.8, time = null) {
  const ctx = window.synth?.ensureAudio(), voice = VOICE_OF[note];
  if (!ctx || !voice) return false;
  const out = window.synth.instrumentInput, at = performance.now(), when = time === null ? ctx.currentTime : Math.max(ctx.currentTime, ctx.currentTime + (time - at) / 1000);
  voice(ctx, out, when, 0.3 + velocity * 0.7);
  const send = on => window.dispatchEvent(new CustomEvent('synth:note', { detail: { note: '', midi: CLAP, drum: note, velocity: on ? velocity : 0, on, source: 'midi-drum', silent: true, time: on ? time ?? at : performance.now() } }));
  send(true); setTimeout(() => send(false), 90);
  return true;
 },
};
