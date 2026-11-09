import { GuestFileError } from './native-vst3-files.js';

export class GuestSystem {
 constructor(memory, memoryBytes) {
  this.memory = memory; this.nodes = new Map(); this.pid = 1;
  const number = (value, width = 4) => {
   const bytes = new Uint8Array(width), view = new DataView(bytes.buffer);
   if (width === 8) view.setBigUint64(0, BigInt(value), true); else view.setUint32(0, value, true);
   return bytes;
  };
  for (const name of ['hw.ncpu', 'hw.activecpu', 'hw.logicalcpu', 'hw.logicalcpu_max', 'hw.physicalcpu', 'hw.physicalcpu_max', 'hw.optional.x86_64', 'hw.optional.sse2']) this.nodes.set(name, number(1));
  this.nodes.set('hw.optional.arm64', number(0)); this.nodes.set('hw.pagesize', number(4096)); this.nodes.set('hw.byteorder', number(1234));
  this.nodes.set('hw.memsize', number(memoryBytes, 8)); this.nodes.set('hw.machine', new TextEncoder().encode('x86_64\0'));
 }
 sysctlbyname([name, output, outputLength, input, inputLength]) {
  const requested = this.memory.string(name);
  if (input || inputLength) throw new GuestFileError(1, 'Guest system nodes are read-only');
  const value = this.nodes.get(requested);
  if (!value) throw new GuestFileError(2, `Unknown guest system node: ${requested}`);
  if (!outputLength) { if (output) throw new GuestFileError(14, 'Missing guest sysctl output length'); return 0; }
  const bytes = this.memory.read(outputLength, 8), capacity = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
  if (!output) { this.memory.writePointer(outputLength, value.length); return 0; }
  let result = value;
  if (requested === 'hw.memsize' && capacity === 4n) {
   if (new DataView(value.buffer).getBigUint64(0, true) > 0xffffffffn) throw new GuestFileError(34, 'Guest memory size exceeds a 32-bit sysctl result');
   result = value.subarray(0, 4);
  }
  if (capacity < BigInt(result.length)) { this.memory.writePointer(outputLength, 0); throw new GuestFileError(12, 'Guest sysctl output buffer is too small'); }
  this.memory.read(output, result.length); this.memory.write(output, result); this.memory.writePointer(outputLength, result.length); return 0;
 }
}
