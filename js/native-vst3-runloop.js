export const runLoopImports = new Set(['_CFRunLoopGetMain', '_CFRunLoopGetCurrent', '_CFRunLoopSourceCreate', '_CFRunLoopAddSource', '_CFRunLoopRemoveSource', '_CFRunLoopContainsSource', '_CFRunLoopSourceSignal', '_CFRunLoopSourceInvalidate', '_CFRunLoopSourceIsValid', '_CFRunLoopWakeUp']);

export class GuestRunLoop {
 constructor(memory) { this.memory = memory; this.handle = 0; this.sources = new Map(); this.woken = false; }
 main() {
  if (!this.handle) this.handle = this.memory.core.create('runloop', { immortal: true });
  return this.handle;
 }
 source(handle) {
  const record = this.memory.core.object(handle, 'runloop-source'); return record;
 }
 mode(handle) {
  const value = this.memory.core.text(handle); if (!value || value.length > 1024) throw new Error('Invalid run-loop mode'); return value;
 }
 invoke(name, [first, second, third]) {
  const core = this.memory.core;
  if (name === '_CFRunLoopGetCurrent' && this.memory.threads && this.memory.threads.current !== this.memory.threads.main) throw new Error('Secondary guest run loops are not implemented');
  if (name === '_CFRunLoopGetMain' || name === '_CFRunLoopGetCurrent') return this.main();
  if (name === '_CFRunLoopSourceCreate') {
   if (first !== 0) throw new Error('Custom run-loop source allocators are unsupported');
   const context = this.memory.read(third, 80), view = new DataView(context.buffer, context.byteOffset, context.byteLength);
   if ([0, 16, 24, 32, 40, 48, 56, 64].some(offset => view.getBigUint64(offset, true))) throw new Error('Only version-zero run-loop sources without custom ownership/schedule callbacks are supported');
   const info = this.memory.pointer(third + 8), perform = this.memory.pointer(third + 72);
   if (!perform || !this.memory.isExecutable(perform)) throw new Error('Invalid run-loop source callback');
   return core.create('runloop-source', { info, perform, order: BigInt.asIntN(64, this.memory.argument64(1)), valid: true, pending: false });
  }
  if (['_CFRunLoopAddSource', '_CFRunLoopRemoveSource', '_CFRunLoopContainsSource', '_CFRunLoopWakeUp'].includes(name)) {
   if (first !== this.main()) throw new Error('Unknown guest run loop');
   if (name === '_CFRunLoopWakeUp') { this.woken = true; return 0; }
   const record = this.source(second), mode = this.mode(third), modes = this.sources.get(second);
   if (name === '_CFRunLoopContainsSource') return record.valid && modes?.has(mode) ? 1 : 0;
   if (name === '_CFRunLoopRemoveSource') {
    if (modes?.delete(mode)) { if (!modes.size) this.sources.delete(second); core.release(second); } return 0;
   }
   if (!record.valid) return 0;
   if (!modes && this.sources.size >= 1024 || modes?.size >= 256) throw new Error('Run-loop source registration limit exceeded');
   const registered = modes || new Set();
   if (!registered.has(mode)) { core.invoke('_CFRetain', [second]); registered.add(mode); this.sources.set(second, registered); }
   return 0;
  }
  const record = this.source(first);
  if (name === '_CFRunLoopSourceIsValid') return record.valid ? 1 : 0;
  if (name === '_CFRunLoopSourceSignal') { if (record.valid) record.pending = true; return 0; }
  if (name === '_CFRunLoopSourceInvalidate') {
   record.valid = false; record.pending = false;
   const modes = this.sources.get(first); this.sources.delete(first);
   if (modes) for (const mode of modes) core.release(first);
   return 0;
  }
  throw new Error('Unsupported run-loop operation');
 }
 drain(mode = 'kCFRunLoopDefaultMode', maximum = 64) {
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 1024) throw new Error('Invalid run-loop dispatch limit');
  const ready = [...this.sources].filter(([handle, modes]) => {
   const record = this.source(handle); return record.valid && record.pending && (modes.has(mode) || modes.has('kCFRunLoopCommonModes') && mode === 'kCFRunLoopDefaultMode');
  }).sort(([left], [right]) => {
   const first = this.source(left).order, second = this.source(right).order; return first < second ? -1 : first > second ? 1 : left - right;
  });
  let count = 0;
  for (const [handle] of ready) {
   if (count === maximum) break;
   const record = this.memory.core.objects.get(handle); if (!record?.valid || !record.pending || !this.sources.has(handle)) continue;
   record.pending = false; this.memory.call(record.perform, [record.info]); count++;
  }
  this.woken = false; return count;
 }
}
