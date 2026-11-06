// AudioWorklet that listens: every 5 ms it sends the main thread a frame of what the input sounds like (level,
// pitch and its clarity, spectral flux, brightness), stamped with the audio clock's frame number, from the same
// arithmetic as offline analysis (js/listen-dsp.js). It outputs silence; it is connected only so it is pulled.
import { Analyzer } from './listen-dsp.js';

class ListenProcessor extends AudioWorkletProcessor {
 constructor({ processorOptions = {} }) {
  super();
  this.analyzer = new Analyzer(sampleRate, processorOptions);
  this.running = true;
  this.mono = new Float32Array(128);
  this.port.onmessage = ({ data }) => { if (data === 'stop') this.running = false; };
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
  return true;
 }
}
registerProcessor('listen-tracker', ListenProcessor);
