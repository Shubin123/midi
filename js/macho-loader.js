const text = new TextDecoder();
const PAGE = 4096, MAX_IMAGE = 256 << 20;
const fail = message => { throw new Error(`Mach-O: ${message}`); };
const safe = value => {
 const number = Number(value);
 if (!Number.isSafeInteger(number) || number < 0) fail('unsupported 64-bit address');
 return number;
};

export function parseMachO(input) {
 let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
 let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
 const range = (offset, size, end = bytes.length) => {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > end - size) fail('truncated or out-of-range data');
 };
 range(0, 4);
 if (view.getUint32(0) === 0xcafebabe) {
  range(0, 8);
  const count = view.getUint32(4);
  range(8, count * 20);
  let slice;
  for (let index = 0; index < count; index++) {
   const offset = 8 + index * 20;
   if (view.getUint32(offset) === 0x01000007) slice = [view.getUint32(offset + 8), view.getUint32(offset + 12)];
  }
  if (!slice) fail('universal binary has no x86_64 slice');
  range(...slice);
  bytes = bytes.subarray(slice[0], slice[0] + slice[1]);
  view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
 }
 range(0, 32);
 if (view.getUint32(0, true) !== 0xfeedfacf) fail('expected a little-endian 64-bit Mach-O binary');
 if (view.getUint32(4, true) !== 0x01000007) fail('only Intel x86_64 is supported');
 if (![6, 8].includes(view.getUint32(12, true))) fail('expected a dylib or bundle');
 const count = view.getUint32(16, true), commandEnd = 32 + view.getUint32(20, true);
 range(32, commandEnd - 32);
 if (count > 65536 || !count) fail('invalid command count');
 const u64 = offset => safe(view.getBigUint64(offset, true));
 const fixedName = offset => text.decode(bytes.subarray(offset, offset + 16)).replace(/\0.*$/, '');
 const string = (offset, end) => {
  range(offset, end - offset);
  let stop = offset;
  while (stop < end && bytes[stop]) stop++;
  if (stop === end) fail('unterminated string');
  return text.decode(bytes.subarray(offset, stop));
 };
 const segments = [], libraries = [], streams = {}, symbols = new Map(), initializers = [];
 let symtab, offset = 32;
 for (let index = 0; index < count; index++) {
  range(offset, 8, commandEnd);
  const command = view.getUint32(offset, true), size = view.getUint32(offset + 4, true);
  if (size < 8 || size % 8) fail('invalid command size');
  range(offset, size, commandEnd);
  if (command === 0x19) {
   if (size < 72) fail('short segment command');
   const segment = { name: fixedName(offset + 8), address: u64(offset + 24), size: u64(offset + 32), offset: u64(offset + 40), fileSize: u64(offset + 48), protection: view.getUint32(offset + 60, true) };
   range(segment.offset, segment.fileSize);
   if (segment.fileSize > segment.size || segment.size > MAX_IMAGE || segment.address % PAGE) fail('invalid segment size or alignment');
   const sections = view.getUint32(offset + 64, true);
   if (72 + sections * 80 > size) fail('sections exceed command');
   for (let sectionIndex = 0; sectionIndex < sections; sectionIndex++) {
    const sectionOffset = offset + 72 + sectionIndex * 80;
    const address = u64(sectionOffset + 32), length = u64(sectionOffset + 40);
    if (!Number.isSafeInteger(address + length) || address < segment.address || address + length > segment.address + segment.size) fail('section exceeds segment');
    if ((view.getUint32(sectionOffset + 64, true) & 255) === 9) {
     if (length % 8) fail('misaligned initializer section');
     initializers.push({ address, size: length });
    }
   }
   segments.push(segment);
   if (segments.length > 256) fail('too many segments');
  } else if (command === 2) {
   if (size < 24) fail('short symbol table command');
   symtab = { offset: view.getUint32(offset + 8, true), count: view.getUint32(offset + 12, true), strings: view.getUint32(offset + 16, true), size: view.getUint32(offset + 20, true) };
  } else if ([0x22, 0x80000022].includes(command)) {
   if (size < 48) fail('short dyld info command');
   for (const [streamIndex, name] of ['rebase', 'bind', 'weak', 'lazy', 'exports'].entries()) {
    const start = view.getUint32(offset + 8 + streamIndex * 8, true), length = view.getUint32(offset + 12 + streamIndex * 8, true);
    range(start, length);
    streams[name] = bytes.subarray(start, start + length);
   }
  } else if ([0xc, 0x80000018, 0x8000001f, 0x80000023].includes(command)) {
   if (size < 24) fail('short library command');
   const nameOffset = view.getUint32(offset + 8, true);
   if (nameOffset < 24 || nameOffset >= size) fail('invalid library name');
   libraries.push(string(offset + nameOffset, offset + size));
  } else if (command === 0x80000034) fail('chained fixups are not implemented');
  else if (command === 0x2c) {
   if (size < 24) fail('short encryption command');
   if (view.getUint32(offset + 16, true)) fail('encrypted images are not supported');
  } else if (command === 0x1a) {
   if (size < 72) fail('short routines command');
   if (u64(offset + 8)) fail('LC_ROUTINES_64 initialization is not implemented');
  }
  offset += size;
 }
 if (offset !== commandEnd) fail('load command size mismatch');
 const mapped = segments.filter(segment => segment.size && segment.name !== '__PAGEZERO');
 if (!mapped.length) fail('no loadable segments');
 const minimum = Math.min(...mapped.map(segment => segment.address)), maximum = Math.max(...mapped.map(segment => segment.address + segment.size));
 if (!Number.isSafeInteger(maximum) || maximum - minimum > MAX_IMAGE) fail('image exceeds 256 MiB');
 for (const [index, segment] of mapped.entries()) {
  const end = segment.address + Math.ceil(segment.size / PAGE) * PAGE;
  if (mapped.slice(index + 1).some(other => other.address < end && other.address + other.size > segment.address)) fail('overlapping segments');
 }
 if (symtab) {
  if (symtab.count > 1000000) fail('too many symbols');
  range(symtab.offset, symtab.count * 16); range(symtab.strings, symtab.size);
  for (let index = 0; index < symtab.count; index++) {
   const symbolOffset = symtab.offset + index * 16, type = bytes[symbolOffset + 4], name = view.getUint32(symbolOffset, true);
   if ((type & 0xe0) || (type & 14) !== 14 || !name) continue;
   if (name >= symtab.size) fail('symbol name exceeds string table');
   symbols.set(string(symtab.strings + name, symtab.strings + symtab.size), u64(symbolOffset + 8));
  }
 }
 return { bytes, segments: mapped, dyldSegments: segments, libraries, streams, symbols, initializers, minimum, maximum };
}

export function dyldFixups(image, slide, { readPointer, writePointer, resolve }) {
 let operations = 0;
 const tick = () => { if (++operations > 1000000) fail('too many dyld operations'); };
 const readerFor = bytes => ({
  offset: 0,
  get done() { return this.offset >= bytes.length; },
  byte() { if (this.done) fail('truncated dyld stream'); return bytes[this.offset++]; },
  leb(signed = false, delta = false) {
   let value = 0n, shift = 0n;
   for (let index = 0; index < 10; index++) {
    const next = this.byte(); value |= BigInt(next & 127) << shift; shift += 7n;
    if (!(next & 128)) {
     if (signed && (next & 64)) value -= 1n << shift;
     if (delta && value >= 1n << 63n && value < 1n << 64n) value -= 1n << 64n;
     const result = Number(value);
     if (!Number.isSafeInteger(result)) fail(`oversized LEB128 ${value} at stream offset ${this.offset}`);
     return result;
    }
   }
   fail('oversized LEB128');
  },
  string() {
   const start = this.offset;
   while (this.byte()) {}
   return text.decode(bytes.subarray(start, this.offset - 1));
  },
 });
 const location = (segmentIndex, offset) => {
  const segment = image.dyldSegments[segmentIndex];
  if (!segment || !image.segments.includes(segment) || !Number.isSafeInteger(offset) || offset < 0 || offset > segment.size - 8) fail('fixup exceeds segment');
  return segment.address + slide + offset;
 };
 if (image.streams.rebase?.length) {
  const reader = readerFor(image.streams.rebase);
  let segment = 0, offset = 0, type = 1;
  const apply = () => {
   tick(); if (type !== 1) fail(`unsupported rebase type ${type}`);
   const address = location(segment, offset);
   writePointer(address, readPointer(address) + slide); offset += 8;
  };
  while (!reader.done) {
   tick(); const byte = reader.byte(), opcode = byte & 0xf0, immediate = byte & 15;
   if (!opcode) break;
   if (opcode === 0x10) type = immediate;
   else if (opcode === 0x20) { segment = immediate; offset = reader.leb(); }
   else if (opcode === 0x30) offset += reader.leb(false, true);
   else if (opcode === 0x40) offset += immediate * 8;
   else if (opcode === 0x50) { for (let index = 0; index < immediate; index++) apply(); }
   else if (opcode === 0x60) { const count = reader.leb(); for (let index = 0; index < count; index++) apply(); }
   else if (opcode === 0x70) { apply(); offset += reader.leb(false, true); }
   else if (opcode === 0x80) { const count = reader.leb(), skip = reader.leb(false, true); for (let index = 0; index < count; index++) { apply(); offset += skip; } }
   else fail(`unsupported rebase opcode ${opcode}`);
  }
 }
 for (const name of ['bind', 'weak', 'lazy']) {
  if (!image.streams[name]?.length) continue;
  const reader = readerFor(image.streams[name]);
  let segment = 0, offset = 0, type = 1, symbol = '', ordinal = 0, addend = 0;
  const apply = () => {
   tick(); if (type !== 1 || !symbol) fail('unsupported bind type or missing symbol');
   writePointer(location(segment, offset), resolve(symbol, ordinal, name) + addend); offset += 8;
  };
  while (!reader.done) {
   tick(); const byte = reader.byte(), opcode = byte & 0xf0, immediate = byte & 15;
   if (!opcode) {
    if (name !== 'lazy') break;
    segment = 0; offset = 0; type = 1; symbol = ''; ordinal = 0; addend = 0;
   } else if (opcode === 0x10) ordinal = immediate;
   else if (opcode === 0x20) ordinal = reader.leb();
   else if (opcode === 0x30) ordinal = immediate ? immediate - 16 : 0;
   else if (opcode === 0x40) symbol = reader.string();
   else if (opcode === 0x50) type = immediate;
   else if (opcode === 0x60) addend = reader.leb(true);
   else if (opcode === 0x70) { segment = immediate; offset = reader.leb(); }
   else if (opcode === 0x80) offset += reader.leb(false, true);
   else if (opcode === 0x90) apply();
   else if (opcode === 0xa0) { apply(); offset += reader.leb(false, true); }
   else if (opcode === 0xb0) { apply(); offset += immediate * 8; }
   else if (opcode === 0xc0) { const count = reader.leb(), skip = reader.leb(false, true); for (let index = 0; index < count; index++) { apply(); offset += skip; } }
   else fail(`unsupported bind opcode ${opcode}`);
  }
 }
 return operations;
}
