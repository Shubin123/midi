// AudioWorklet that hosts one VST3 plug-in class from a WebAssembly module built with native/vst3web.
import { Vst3Module } from './vst3-runtime.js';

class Vst3Processor extends AudioWorkletProcessor {
 constructor({ processorOptions: { module, classIndex, values } }) {
  super();
  try {
   this.plugin = new Vst3Module(module);
   this.io = this.plugin.open(classIndex, sampleRate, 128);
   for (const [id, value] of Object.entries(values || {})) this.plugin.set(Number(id), value);
   this.port.postMessage({ ready: true, io: this.io });
  } catch (e) {
   this.port.postMessage({ error: e.message });
  }
  this.port.onmessage = ({ data }) => {
   if (!this.plugin) return;
   if (data.param !== undefined) this.plugin.set(data.param, data.value);
   if (data.note !== undefined) this.plugin.note(data.on, data.note, data.velocity);
   if (data.panic) for (let p = 0; p < 128; p++) this.plugin.note(false, p, 0);
  };
 }
 process(inputs, outputs) {
  const out = outputs[0], n = out[0].length;
  if (!this.plugin || !this.io) return true;
  const input = inputs[0];
  for (let c = 0; c < this.io.inputs; c++) {
   const dest = this.plugin.buffer(0, c, n), src = input[c] || input[0];
   if (dest) src ? dest.set(src) : dest.fill(0);
  }
  if (this.plugin.process(n) !== 0) return true;
  for (let c = 0; c < out.length; c++) {
   const src = this.plugin.buffer(1, Math.min(c, this.io.outputs - 1), n);
   if (src) out[c].set(src);
  }
  return true;
 }
}
registerProcessor('vst3-wasm', Vst3Processor);
