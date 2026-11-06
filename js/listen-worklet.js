// AudioWorklet that listens: every 5 ms it sends the main thread a frame of what the input sounds like (level,
// pitch and its clarity, spectral flux, brightness), stamped with the audio clock's frame number, from the same
// arithmetic as offline analysis (js/listen-dsp.js); for chords ({ chords: true }) also, every 21 ms, the
// notes sounding together. It outputs silence; it is connected only so it is pulled.
import { Analyzer, PolyAnalyzer } from './listen-dsp.js';

class ListenProcessor extends AudioWorkletProcessor {
 constructor({ processorOptions = {} }) {
  super();
  this.analyzer = new Analyzer(sampleRate, processorOptions);
  this.running = true;
  this.mono = new Float32Array(128);
  this.poly = null;
  this.port.onmessage = ({ data }) => { if (data === 'stop') this.running = false; if (data?.chords !== undefined) this.poly = data.chords ? this.poly || new PolyAnalyzer(sampleRate) : null; };
 }
 process([input]) {
  if (!this.running) return false;
  if (!input?.length) return true;
  let x = input[0];
  if (input.length > 1) { // an interface's inputs, mixed down
   if (this.mono.length !== x.length) this.mono = new Float32Array(x.length);
   for (let i = 0; i < x.length; i++) { let s = 0; for (const c of input) s += c[i]; this.mono[i] = s / input.length; }
   x = this.mono;
  }
  const frames = this.analyzer.push(x, currentFrame);
  if (frames.length) this.port.postMessage(frames);
  const chords = this.poly?.push(x, currentFrame);
  if (chords?.length) this.port.postMessage({ chords });
  return true;
 }
}
registerProcessor('listen-tracker', ListenProcessor);
