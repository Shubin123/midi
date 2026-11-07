const MAX_STRING = 1 << 20;

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
