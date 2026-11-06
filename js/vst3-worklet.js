// AudioWorklet that hosts one VST3 plug-in class from a WebAssembly module built with native/vst3web: the audio
// half (role 1). Its controller's edits arrive as parameter changes; the processor's output parameters (meters)
// go to the page about 30 times a second, and messages between the processor and the controller on the page
// cross through this port.
import { Vst3Module } from './vst3-runtime.js';

const OUTPUT_EVERY = Math.round(sampleRate / 30 / 128); // blocks

class Vst3Processor extends AudioWorkletProcessor {
 constructor({ processorOptions: { module, classIndex, values, tempo } }) {
  super();
  this.out = new Map(); this.blocks = 0;
  try {
   this.plugin = new Vst3Module(module, m => ({ vst3web: { message: (ptr, length) => this.port.postMessage({ message: m.bytes(ptr, length) }) } }));
   this.io = this.plugin.open(classIndex, sampleRate, 128, 1);
   for (const [id, value] of Object.entries(values || {})) this.plugin.set(Number(id), value);
   if (tempo) this.plugin.tempo(tempo);
   this.port.postMessage({ ready: true, io: this.io });
  } catch (e) {
   this.port.postMessage({ error: e.message });
  }
  this.port.onmessage = ({ data }) => {
   if (!this.plugin) return;
   if (data.param !== undefined) this.plugin.set(data.param, data.value);
   if (data.note !== undefined) this.plugin.note(data.on, data.note, data.velocity);
   if (data.tempo) this.plugin.tempo(data.tempo);
   if (data.panic) for (let p = 0; p < 128; p++) this.plugin.note(false, p, 0);
   if (data.message) this.plugin.deliver(data.message);
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
  for (const [id, v] of this.plugin.outputs()) this.out.set(id, v);
  if (this.out.size && ++this.blocks >= OUTPUT_EVERY) { this.port.postMessage({ out: [...this.out] }); this.out.clear(); this.blocks = 0; }
  for (let c = 0; c < out.length; c++) {
   const src = this.plugin.buffer(1, Math.min(c, this.io.outputs - 1), n);
   if (src) out[c].set(src);
  }
  return true;
 }
}
registerProcessor('vst3-wasm', Vst3Processor);
