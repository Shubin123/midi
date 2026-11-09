import { parseGuestFloat, checkGuestRounding } from './native-vst3-float.js';

export const cLocaleImports = new Set(['_newlocale', '_duplocale', '_freelocale', '_strtod_l', '_strtod']);

export class GuestCLocales {
 constructor(memory) { this.memory = memory; this.handles = new Set(); }
 errno(value, result = 0) {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, value, true); this.memory.write(this.memory.errorPointer(), bytes); return result;
 }
 valid(value) { return value === 0n || value === 0xffffffffffffffffn || Number.isSafeInteger(Number(value)) && this.handles.has(Number(value)); }
 create() {
  if (this.handles.size >= 256) return this.errno(12);
  const handle = this.memory.allocate(8); this.memory.write(handle, new Uint8Array(8)); this.handles.add(handle); return handle;
 }
 invoke(name, [first, second]) {
  switch (name) {
   case '_newlocale': {
    const mask = Number(this.memory.argument64(0) & 63n);
    if (mask !== 63 && !this.valid(this.memory.argument64(2))) return this.errno(22);
    const locale = mask && second ? this.memory.string(second, 256) : 'C';
    if (!['C', 'POSIX', ''].includes(locale)) return this.errno(2);
    return this.create();
   }
   case '_duplocale': return this.valid(this.memory.argument64(0)) ? this.create() : this.errno(22);
   case '_freelocale': {
    if (!this.handles.delete(first)) return this.errno(22, -1);
    this.memory.allocations.delete(first); return 0;
   }
   case '_strtod_l': case '_strtod': {
    if (name === '_strtod_l' && !this.valid(this.memory.argument64(2))) throw new Error('Unknown guest C locale');
    checkGuestRounding(this.memory);
    const result = parseGuestFloat(this.memory.string(first, 1 << 20));
    if (second) this.memory.writePointer(second, first + result.consumed);
    if (result.range) this.errno(34);
    return { rax: 0, xmm0Bits: result.bits };
   }
   default: throw new Error(`Unsupported C locale operation ${name}`);
  }
 }
}
