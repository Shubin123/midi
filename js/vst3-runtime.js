// Runs a VST3 plug-in compiled to WebAssembly with native/vst3web (the plug-in plus a small VST3 host).
// Shared by the page (class list, parameter text) and the audio worklet (processing).

// Standalone Emscripten modules import a few WASI/system calls; plug-ins only touch them for logging and time.
// AudioWorkletGlobalScope has no `performance`, so fall back to Date there.
const now = () => (globalThis.performance ? performance.now() : Date.now());
function imports(module, memoryRef) {
 const table = {};
 for (const { module: ns, name, kind } of WebAssembly.Module.imports(module)) {
  if (kind !== 'function') continue;
  table[ns] ||= {};
  table[ns][name] = (...args) => {
   const view = () => new DataView(memoryRef.memory.buffer);
   if (name === 'fd_write') { // (fd, iovs, iovsLen, nwrittenPtr): report everything as written
    let total = 0; for (let i = 0; i < args[2]; i++) total += view().getUint32(args[1] + i * 8 + 4, true);
    view().setUint32(args[3], total, true); return 0;
   }
   if (name === 'clock_time_get') { view().setBigUint64(args[2], BigInt(Math.round(now() * 1e6)), true); return 0; }
   if (name === 'environ_sizes_get' || name === 'args_sizes_get') { view().setUint32(args[0], 0, true); view().setUint32(args[1], 0, true); return 0; }
   if (name === 'proc_exit' || name === 'abort' || name.startsWith('__cxa_throw')) throw new Error(`VST3 module called ${name}`);
   if (name === 'emscripten_get_now') return now();
   return 0;
  };
 }
 return table;
}

export class Vst3Module {
 constructor(module) {
  const ref = {};
  this.instance = new WebAssembly.Instance(module, imports(module, ref));
  this.x = this.instance.exports;
  ref.memory = this.x.memory;
  this.x._initialize?.();
  if (this.x.vst3web_init() !== 0) throw new Error('The plug-in module failed to initialize.');
 }
 string(ptr) {
  const bytes = new Uint8Array(this.x.memory.buffer, ptr);
  return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
 }
 json(ptr) { return JSON.parse(this.string(ptr)); }
 classes() {
  return Array.from({ length: this.x.vst3web_class_count() }, (_, i) => {
   const c = this.json(this.x.vst3web_class_info(i));
   return { ...c, index: i, instrument: /Instrument|Synth|Generator/.test(c.subCategories) && !/Fx/.test(c.subCategories) };
  });
 }
 open(index, sampleRate, maxBlock = 128) {
  const code = this.x.vst3web_open(index, sampleRate, maxBlock);
  if (code !== 0) throw new Error(`The plug-in could not be started (code ${code}).`);
  return { inputs: this.x.vst3web_channels(0), outputs: this.x.vst3web_channels(1), events: !!this.x.vst3web_has_events() };
 }
 params() {
  const HIDDEN = 2 | 16 | 32768; // read-only, hidden, program change
  return Array.from({ length: this.x.vst3web_param_count() }, (_, i) => this.json(this.x.vst3web_param_info(i))).filter(p => p && !(p.flags & HIDDEN));
 }
 text(id, value) { return this.string(this.x.vst3web_param_text(id, value)); }
 set(id, value) { this.x.vst3web_param_set(id, value); }
 note(on, pitch, velocity) { this.x.vst3web_note(on ? 1 : 0, pitch, velocity); }
 tempo(bpm) { this.x.vst3web_tempo(bpm); }
 buffer(dir, channel, frames) {
  const ptr = this.x.vst3web_buffer(dir, channel);
  return ptr ? new Float32Array(this.x.memory.buffer, ptr, frames) : null;
 }
 process(frames) { return this.x.vst3web_process(frames); }
 close() { this.x.vst3web_close(); }
}
