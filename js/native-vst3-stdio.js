import { formatGuestPrintf } from './native-vst3-printf.js';
import { GuestFileError } from './native-vst3-files.js';
import { guestVariadicArguments } from './native-vst3-varargs.js';

export const stdioGlobals = new Map([['___stdinp', 0], ['___stdoutp', 1], ['___stderrp', 2]]);
export const stdioImports = new Set(['_vsnprintf', '_vswprintf', '_fprintf', '_printf', '_vfprintf', '_vprintf', '_fwrite', '_fread', '_fputs', '_puts', '_fflush', '_fileno', '_fclose', '_ferror', '_feof', '_clearerr', '_fputc', '_putc', '_fgetc', '_getc', '___swbuf', '___srget']);

export class GuestStdio {
 constructor(memory) { this.memory = memory; this.streams = new Map(); this.standard = new Map(); }
 stream(descriptor) {
  if (this.standard.has(descriptor)) return this.standard.get(descriptor);
  const handle = this.memory.allocate(152), bytes = new Uint8Array(152), view = new DataView(bytes.buffer);
  view.setInt16(16, descriptor ? 8 | (descriptor === 2 ? 2 : 0) : 4, true); view.setInt16(18, descriptor, true); this.memory.write(handle, bytes);
  this.memory.writePointer(handle + 48, handle);
  for (const [index, operation] of ['close', 'read', 'seek', 'write'].entries()) this.memory.writePointer(handle + 56 + index * 8, this.memory.resolve(`__midi_stdio_${operation}`, 0, 'bind'));
  this.streams.set(handle, { descriptor, error: false, eof: false, closed: false }); this.standard.set(descriptor, handle); return handle;
 }
 global(name) { const address = this.memory.allocate(8); this.memory.writePointer(address, this.stream(stdioGlobals.get(name))); return address; }
 record(handle) {
  const record = this.streams.get(handle); if (!record || record.closed) throw new GuestFileError(9, 'Invalid guest FILE stream'); return record;
 }
 status(handle, record) {
  const bytes = this.memory.read(handle + 16, 2), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setInt16(0, view.getInt16(0, true) & ~0x60 | (record.error ? 0x40 : 0) | (record.eof ? 0x20 : 0), true); this.memory.write(handle + 16, bytes);
 }
 write(handle, bytes) {
  const record = this.record(handle); let length;
  try { length = this.memory.files.write(record.descriptor, bytes); }
  catch (error) { record.error = true; this.status(handle, record); throw error; }
  if (length < bytes.length) { record.error = true; this.status(handle, record); }
  return length;
 }
 read(handle, pointer, length) {
  const record = this.record(handle); let bytes;
  try { bytes = this.memory.files.read(record.descriptor, length); }
  catch (error) { record.error = true; this.status(handle, record); throw error; }
  if (bytes.length) this.memory.write(pointer, bytes);
  if (bytes.length < length) { record.eof = true; this.status(handle, record); }
  return bytes.length;
 }
 wideFormat(pointer) {
  const memory = this.memory, bytes = [];
  for (let offset = 0; ; offset += 4) {
   if (offset >= 1 << 16) throw new Error('Guest wide format exceeds limit');
   const part = memory.read(pointer + offset, 4), unit = new DataView(part.buffer, part.byteOffset, part.byteLength).getUint32(0, true);
   if (!unit) return new Uint8Array(bytes);
   if (unit > 127) throw new Error('Non-ASCII wide printf formats are not implemented');
   bytes.push(unit);
  }
 }
 format(pointer, index, vaList = 0, formatBytes = null) {
  const next = guestVariadicArguments(this.memory, index, vaList);
  return formatGuestPrintf(formatBytes ?? this.memory.stringBytes(pointer), next, (address, precision) => {
   address = Number(address); if (!Number.isSafeInteger(address)) throw new Error('Invalid printf pointer');
   if (precision === null) return this.memory.stringBytes(address, 1 << 20);
   const bytes = [];
   for (let offset = 0; offset < precision; offset++) { const byte = this.memory.read(address + offset, 1)[0]; if (!byte) break; bytes.push(byte); }
   return new Uint8Array(bytes);
  });
 }
 invoke(name, [first, second, third, fourth]) {
  switch (name) {
   case '_vsnprintf': {
    if (!fourth) throw new Error('Null va_list is not supported');
    const bytes = this.format(third, 0, fourth);
    if (second) { const output = new Uint8Array(Math.min(bytes.length, second - 1) + 1); output.set(bytes.subarray(0, output.length - 1)); this.memory.write(first, output); }
    return bytes.length;
   }
   case '_vswprintf': {
    if (!fourth) throw new Error('Null va_list is not supported');
    const bytes = new TextDecoder().decode(this.format(third, 0, fourth, this.wideFormat(third))), units = Array.from(bytes, character => character.codePointAt(0));
    if (units.length >= second) {
     if (second) this.memory.write(first, new Uint8Array(4));
     const code = new Uint8Array(4); new DataView(code.buffer).setInt32(0, 84, true); this.memory.write(this.memory.errorPointer(), code);
     return -1;
    }
    const output = new Uint8Array((units.length + 1) * 4), view = new DataView(output.buffer);
    units.forEach((unit, index) => view.setUint32(index * 4, unit, true));
    this.memory.write(first, output); return units.length;
   }
   case '_fprintf': case '_printf': case '_vfprintf': case '_vprintf': {
    const standard = name === '_printf' || name === '_vprintf', handle = standard ? this.stream(1) : first;
    if (name === '_vfprintf' && !third || name === '_vprintf' && !second) throw new Error('Null va_list is not supported');
    const bytes = this.format(standard ? first : second, standard ? 1 : 2, name === '_vfprintf' ? third : name === '_vprintf' ? second : 0);
    return this.write(handle, bytes) === bytes.length ? bytes.length : -1;
   }
   case '_fwrite': case '_fread': {
    const length = second * third; if (!Number.isSafeInteger(length) || length < 0 || length > 1 << 20) throw new Error('Guest stdio transfer exceeds limit');
    if (!length) return 0;
    const count = name === '_fwrite' ? this.write(fourth, this.memory.read(first, length)) : this.read(fourth, first, length); return Math.floor(count / second);
   }
   case '_fputs': case '_puts': {
    let bytes = this.memory.stringBytes(first, 1 << 20);
    if (name === '_puts') { const line = new Uint8Array(bytes.length + 1); line.set(bytes); line[bytes.length] = 10; bytes = line; }
    return this.write(name === '_puts' ? this.stream(1) : second, bytes) === bytes.length ? 0 : -1;
   }
   case '_fflush': if (first) this.record(first); return 0;
   case '_fileno': return this.record(first).descriptor;
   case '_fclose': case '__midi_stdio_close': { const record = this.record(first); this.memory.files.close(record.descriptor); record.closed = true; return 0; }
   case '_ferror': return this.record(first).error ? 1 : 0;
   case '_feof': return this.record(first).eof ? 1 : 0;
   case '_clearerr': { const record = this.record(first); record.error = false; record.eof = false; this.status(first, record); return 0; }
   case '_fputc': case '_putc': case '___swbuf': return this.write(second, new Uint8Array([first & 255])) === 1 ? first & 255 : -1;
   case '_fgetc': case '_getc': case '___srget': {
    const record = this.record(first), bytes = this.memory.files.read(record.descriptor, 1);
    if (bytes.length) return bytes[0]; record.eof = true; this.status(first, record); return -1;
   }
   case '__midi_stdio_write': return this.write(first, this.memory.read(second, third));
   case '__midi_stdio_read': return this.read(first, second, third);
   case '__midi_stdio_seek': return this.memory.files.seek(this.record(first).descriptor, BigInt.asIntN(64, this.memory.argument64(1)), third);
  }
 }
}
