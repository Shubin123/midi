const MAX_STRING = 1 << 20;
const STRING_PREFIX = /^__ZN(K?)St3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE/;
const STRING_CONCATENATE = '__ZNSt3__1plIcNS_11char_traitsIcEENS_9allocatorIcEEEENS_12basic_stringIT_T0_T1_EEPKS6_RKS9_';
export const guestStringImport = name => STRING_PREFIX.test(name) || name === STRING_CONCATENATE;

export function readGuestString(memory, address) {
 const representation = memory.read(address, 24), view = new DataView(representation.buffer, representation.byteOffset, representation.byteLength);
 if (!(representation[0] & 1)) {
  const length = representation[0] >>> 1;
  if (length > 22 || representation[length + 1]) throw new Error('Invalid libc++ short string');
  return { bytes: representation.slice(1, 1 + length), capacity: 23, pointer: 0 };
 }
 const capacity = view.getBigUint64(0, true) & ~1n, length = view.getBigUint64(8, true), pointer = view.getBigUint64(16, true);
 if (length > BigInt(MAX_STRING) || capacity <= length || capacity > 32n << 20n || !pointer || pointer > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid or oversized libc++ long string');
 const bytes = memory.read(Number(pointer), Number(length) + 1);
 if (bytes[Number(length)]) throw new Error('Unterminated libc++ long string');
 return { bytes: bytes.slice(0, -1), capacity: Number(capacity), pointer: Number(pointer) };
}

export class GuestStrings {
 constructor(memory) { this.memory = memory; }
 update(destination, bytes, reserve = 0) {
  const previous = readGuestString(this.memory, destination);
  if (bytes.length > MAX_STRING || reserve > MAX_STRING) throw new Error('libc++ string exceeds supported limit');
  if (previous.pointer && Math.max(bytes.length + 1, reserve + 1) <= previous.capacity) {
   const contents = new Uint8Array(bytes.length + 1); contents.set(bytes); this.memory.write(previous.pointer, contents);
   this.memory.writePointer(destination + 8, bytes.length); return destination;
  }
  if (reserve > bytes.length && reserve >= 23) {
   const capacity = Math.ceil((reserve + 1) / 16) * 16, pointer = this.memory.allocate(capacity), contents = new Uint8Array(bytes.length + 1), representation = new Uint8Array(24), view = new DataView(representation.buffer);
   contents.set(bytes); this.memory.write(pointer, contents); view.setBigUint64(0, BigInt(capacity) | 1n, true); view.setBigUint64(8, BigInt(bytes.length), true); view.setBigUint64(16, BigInt(pointer), true); this.memory.write(destination, representation);
  } else writeGuestString(this.memory, destination, bytes);
  if (previous.pointer) this.memory.allocations.delete(previous.pointer);
  return destination;
 }
 invoke(name, args) {
  const [destination, source, third, fourth, fifth] = args, suffix = name.replace(STRING_PREFIX, ''), memory = this.memory;
  const unsigned = index => memory.argument64(index), count = (value, maximum) => Number(value > BigInt(maximum) ? BigInt(maximum) : value);
  if (name === STRING_CONCATENATE) {
   if (destination === third) throw new Error('libc++ string concatenation result cannot alias its source');
   const left = memory.stringBytes(source, MAX_STRING + 1), right = readGuestString(memory, third).bytes;
   if (left.length + right.length > MAX_STRING) throw new Error('libc++ string exceeds supported limit');
   const contents = new Uint8Array(left.length + right.length); contents.set(left); contents.set(right, left.length);
   return writeGuestString(memory, destination, contents);
  }
  if (suffix === 'C1ERKS5_' || suffix === 'C2ERKS5_') return copyGuestString(memory, destination, source);
  const record = suffix.startsWith('C') ? null : readGuestString(memory, destination), contents = record?.bytes;
  const position = value => { if (value > BigInt(contents.length)) throw new Error('libc++ string position out of range'); return Number(value); };
  const bytesAt = (pointer, length) => { if (length > BigInt(MAX_STRING)) throw new Error('libc++ byte range exceeds limit'); return memory.read(pointer, Number(length)); };
  const join = (left, right) => { if (left.length + right.length > MAX_STRING) throw new Error('libc++ string exceeds supported limit'); const bytes = new Uint8Array(left.length + right.length); bytes.set(left); bytes.set(right, left.length); return bytes; };
  switch (suffix) {
   case 'D1Ev': case 'D2Ev': if (record.pointer) memory.allocations.delete(record.pointer); return 0;
   case 'C1ERKS5_mmRKS4_': case 'C2ERKS5_mmRKS4_': {
    const bytes = readGuestString(memory, source).bytes, start = unsigned(2);
    if (start > BigInt(bytes.length)) throw new Error('libc++ substring position out of range');
    return writeGuestString(memory, destination, bytes.slice(Number(start), Number(start) + count(unsigned(3), bytes.length - Number(start))));
   }
   case 'aSERKS5_': return this.update(destination, readGuestString(memory, source).bytes);
   case 'aSEc': return this.update(destination, new Uint8Array([source & 255]));
   case '6assignEPKc': return this.update(destination, memory.stringBytes(source, MAX_STRING));
   case '6appendEPKc': return this.update(destination, join(contents, memory.stringBytes(source, MAX_STRING)));
   case '6appendEPKcm': return this.update(destination, join(contents, bytesAt(source, unsigned(2))));
   case '6appendEmc': {
    if (unsigned(1) > BigInt(MAX_STRING - contents.length)) throw new Error('libc++ append exceeds limit');
    return this.update(destination, join(contents, new Uint8Array(source).fill(third & 255)));
   }
   case '9push_backEc': return this.update(destination, join(contents, new Uint8Array([source & 255])));
   case '6resizeEmc': {
    if (unsigned(1) > BigInt(MAX_STRING)) throw new Error('libc++ resize exceeds limit');
    const bytes = new Uint8Array(source).fill(third & 255); bytes.set(contents.slice(0, source)); return this.update(destination, bytes);
   }
   case '7reserveEm': {
    if (unsigned(1) > BigInt(MAX_STRING)) throw new Error('libc++ reserve exceeds limit');
    return this.update(destination, contents, Math.max(source, contents.length));
   }
   case '5eraseEmm': {
    const start = position(unsigned(1)), length = count(unsigned(2), contents.length - start);
    return this.update(destination, join(contents.slice(0, start), contents.slice(start + length)));
   }
   case '6insertEmPKc': {
    const start = position(unsigned(1)); return this.update(destination, join(join(contents.slice(0, start), memory.stringBytes(third, MAX_STRING)), contents.slice(start)));
   }
   case '7compareEPKc': case '7compareEmmPKcm': {
    const start = suffix === '7compareEPKc' ? 0 : position(unsigned(1)), length = suffix === '7compareEPKc' ? contents.length : count(unsigned(2), contents.length - start);
    const left = contents.slice(start, start + length), right = suffix === '7compareEPKc' ? memory.stringBytes(source, MAX_STRING) : bytesAt(fourth, unsigned(4));
    for (let index = 0; index < Math.min(left.length, right.length); index++) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
    return Math.sign(left.length - right.length);
   }
   case '4findEcm': {
    const start = unsigned(2); if (start >= BigInt(contents.length)) return 0xffffffffffffffffn;
    const index = contents.indexOf(source & 255, Number(start)); return index < 0 ? 0xffffffffffffffffn : index;
   }
   case '5rfindEcm': {
    if (!contents.length) return 0xffffffffffffffffn;
    const index = contents.lastIndexOf(source & 255, count(unsigned(2), contents.length - 1)); return index < 0 ? 0xffffffffffffffffn : index;
   }
   case '12find_last_ofEPKcmm': {
    const search = bytesAt(source, unsigned(3));
    for (let index = count(unsigned(2), contents.length - 1); contents.length && index >= 0; index--) if (search.includes(contents[index])) return index;
    return 0xffffffffffffffffn;
   }
   default: throw new Error(`Unsupported libc++ string operation: ${suffix}`);
  }
 }
}

export function writeGuestString(memory, destination, contents) {
 if (contents.length > MAX_STRING) throw new Error('libc++ string exceeds supported limit');
 const result = new Uint8Array(24), view = new DataView(result.buffer);
 memory.read(destination, 24);
 if (contents.length < 23) { result[0] = contents.length * 2; result.set(contents, 1); }
 else {
  const capacity = Math.ceil((contents.length + 1) / 16) * 16, pointer = memory.allocate(capacity), bytes = new Uint8Array(contents.length + 1);
  bytes.set(contents); memory.write(pointer, bytes); view.setBigUint64(0, BigInt(capacity) | 1n, true);
  view.setBigUint64(8, BigInt(contents.length), true); view.setBigUint64(16, BigInt(pointer), true);
 }
 memory.write(destination, result); return destination;
}

export function nextGuestPrime(value) {
 if (typeof value !== 'bigint' || value < 0n || value > 1n << 24n) throw new Error('libc++ prime request exceeds supported guest limit');
 if (value === 0n) return 0;
 if (value <= 2n) return 2;
 let candidate = Number(value) | 1;
 for (let attempts = 0; attempts < 4096; attempts++, candidate += 2) {
  let prime = true;
  for (let divisor = 3; divisor * divisor <= candidate; divisor += 2) if (candidate % divisor === 0) { prime = false; break; }
  if (prime) return candidate;
 }
 throw new Error('libc++ prime search limit exceeded');
}

export function copyGuestString(memory, destination, source) {
 const representation = memory.read(source, 24), view = new DataView(representation.buffer, representation.byteOffset, representation.byteLength);
 memory.read(destination, 24);
 if (destination === source) throw new Error('libc++ string copy constructor cannot alias its source');
 if (!(representation[0] & 1)) {
  const length = representation[0] >>> 1;
  if (length > 22 || representation[length + 1] !== 0) throw new Error('Invalid libc++ short string');
  memory.write(destination, representation); return destination;
 }
 const capacity = view.getBigUint64(0, true) & ~1n, length = view.getBigUint64(8, true), pointer = view.getBigUint64(16, true);
 if (length > BigInt(MAX_STRING) || capacity <= length || capacity > 32n << 20n || pointer === 0n || pointer > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid or oversized libc++ long string');
 const size = Number(length), contents = memory.read(Number(pointer), size + 1);
 if (contents[size] !== 0) throw new Error('Unterminated libc++ long string');
 const result = new Uint8Array(24), output = new DataView(result.buffer);
 if (size < 23) { result[0] = size * 2; result.set(contents, 1); }
 else {
  const allocation = Math.ceil((size + 1) / 16) * 16, address = memory.allocate(allocation);
  memory.write(address, contents); output.setBigUint64(0, BigInt(allocation) | 1n, true);
  output.setBigUint64(8, length, true); output.setBigUint64(16, BigInt(address), true);
 }
 memory.write(destination, result); return destination;
}
