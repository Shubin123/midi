// Runs a VST3 plug-in compiled to WebAssembly with native/vst3web (the plug-in plus a small VST3 host).
// Shared by the page (class list, parameter text, the plug-in's editor) and the audio worklet (processing).
// `hooks(module)` gives functions for the module's own imports: "vst3web" (edits, messages and resize requests
// from the plug-in) and, for an editor, "vstgui" (js/vstgui-web.js); anything not given does nothing.

// Standalone Emscripten modules import a few WASI/system calls; plug-ins only touch them for logging and time.
// AudioWorkletGlobalScope has no `performance`, so fall back to Date there.
const now = () => (globalThis.performance ? performance.now() : Date.now());
function imports(module, memoryRef, hooks = {}) {
 const table = {};
 for (const { module: ns, name, kind } of WebAssembly.Module.imports(module)) {
  if (kind !== 'function') continue;
  table[ns] ||= {};
  if (hooks[ns]?.[name]) { table[ns][name] = hooks[ns][name]; continue; }
  if (ns === 'vstgui' || ns === 'vst3web') { table[ns][name] = () => 0; continue; } // no editor here: nothing to draw or tell
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
 constructor(module, hooks = null) {
  const ref = {};
  this.instance = new WebAssembly.Instance(module, imports(module, ref, hooks ? hooks(this) : {}));
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
 // role: 0 the whole plug-in here, 1 the audio half (in the worklet), 2 the controller and editor half.
 open(index, sampleRate, maxBlock = 128, role = 0) {
  this.x.vst3web_set_role?.(role);
  const code = this.x.vst3web_open(index, sampleRate, maxBlock);
  if (code !== 0) throw new Error(`The plug-in could not be started (code ${code}).`);
  return { inputs: this.x.vst3web_channels(0), outputs: this.x.vst3web_channels(1), events: !!this.x.vst3web_has_events() };
 }
 params() {
  const HIDDEN = 2 | 16 | 32768; // read-only, hidden, program change
  return Array.from({ length: this.x.vst3web_param_count() }, (_, i) => this.json(this.x.vst3web_param_info(i))).filter(p => p && !(p.flags & HIDDEN));
 }
 // Every parameter's current normalized value, hidden ones too: what another instance's controller is set to.
 values() { return Array.from({ length: this.x.vst3web_param_count() }, (_, i) => this.json(this.x.vst3web_param_info(i))).filter(Boolean).map(({ id, value }) => ({ id, value })); }
 text(id, value) { return this.string(this.x.vst3web_param_text(id, value)); }
 set(id, value) { this.x.vst3web_param_set(id, value); }
 // For the controller (and its editor) only: a value the processor reported, or another instance set.
 controllerSet(id, value) { this.x.vst3web_controller_set?.(id, value); }
 // The processor's output parameters from the last block: [[id, value], ...].
 outputs() { const n = this.x.vst3web_out_count?.() || 0; return Array.from({ length: n }, (_, i) => [this.x.vst3web_out_id(i), this.x.vst3web_out_value(i)]); }
 bytes(ptr, length) { return new Uint8Array(this.x.memory.buffer, ptr, length).slice(); }
 // A message from the other instance's half (its bytes, as the plug-in's "message" import gave them).
 deliver(bytes) {
  if (!this.x.vst3web_message_deliver || !bytes?.length) return;
  const ptr = this.x.malloc(bytes.length);
  new Uint8Array(this.x.memory.buffer, ptr, bytes.length).set(bytes);
  this.x.vst3web_message_deliver(ptr, bytes.length);
  this.x.free(ptr);
 }
 note(on, pitch, velocity) { this.x.vst3web_note(on ? 1 : 0, pitch, velocity); }
 tempo(bpm) { this.x.vst3web_tempo(bpm); }
 buffer(dir, channel, frames) {
  const ptr = this.x.vst3web_buffer(dir, channel);
  return ptr ? new Float32Array(this.x.memory.buffer, ptr, frames) : null;
 }
 process(frames) { return this.x.vst3web_process(frames); }
 close() { this.x.vst3web_close(); }
}
