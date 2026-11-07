import assert from 'node:assert/strict';
import { copyGuestString, nextGuestPrime } from '../js/native-vst3-libcpp.js';

const bytes = new Uint8Array(1 << 20), view = new DataView(bytes.buffer);
let next = 4096;
const memory = {
 read(address, size) { assert.ok(address >= 0 && address + size <= bytes.length); return bytes.slice(address, address + size); },
 write(address, data) { bytes.set(data, address); },
 allocate(size) { const address = next; next += size; assert.ok(next <= bytes.length); return address; },
};
for (const length of [0, 1, 22]) {
 bytes.fill(0, 64, 88); bytes[64] = length * 2; bytes.fill(65, 65, 65 + length);
 copyGuestString(memory, 128, 64); assert.deepEqual(bytes.slice(128, 152), bytes.slice(64, 88));
}
for (const length of [0, 22, 23, 31, 32, 255]) {
 const pointer = memory.allocate(length + 1); bytes.fill(66, pointer, pointer + length); bytes[pointer + length] = 0;
 if (length > 1) bytes[pointer + 1] = 0;
 view.setBigUint64(64, BigInt(Math.ceil((length + 1) / 16) * 16) | 1n, true);
 view.setBigUint64(72, BigInt(length), true); view.setBigUint64(80, BigInt(pointer), true);
 const original = bytes.slice(64, 88); copyGuestString(memory, 128, 64);
 assert.deepEqual(bytes.slice(64, 88), original);
 if (length < 23) { assert.equal(bytes[128], length * 2); assert.deepEqual(bytes.slice(129, 130 + length), bytes.slice(pointer, pointer + length + 1)); }
 else {
  const copied = Number(view.getBigUint64(144, true)); assert.notEqual(copied, pointer);
  assert.equal(view.getBigUint64(136, true), BigInt(length));
  assert.equal(view.getBigUint64(128, true), BigInt(Math.ceil((length + 1) / 16) * 16) | 1n);
  assert.deepEqual(bytes.slice(copied, copied + length + 1), bytes.slice(pointer, pointer + length + 1));
  bytes[pointer] = 67; assert.equal(bytes[copied], 66);
 }
}
bytes[64] = 46; assert.throws(() => copyGuestString(memory, 128, 64), /short string/);
bytes.fill(65, 64, 88); bytes[64] = 2; assert.throws(() => copyGuestString(memory, 128, 64), /short string/);
const invalid = (capacity, length, pointer) => { view.setBigUint64(64, capacity | 1n, true); view.setBigUint64(72, length, true); view.setBigUint64(80, pointer, true); };
for (const values of [[16n, 16n, 4096n], [32n, 23n, 0n], [1n << 63n, 23n, 4096n], [1n << 22n, (1n << 20n) + 1n, 4096n]]) {
 invalid(...values); assert.throws(() => copyGuestString(memory, 128, 64), /long string/);
}
invalid(32n, 23n, 4096n); bytes[4119] = 1; assert.throws(() => copyGuestString(memory, 128, 64), /Unterminated/);
assert.throws(() => copyGuestString(memory, 64, 64), /alias/);
const composites = new Uint8Array(2048);
for (let prime = 2; prime < composites.length; prime++) if (!composites[prime]) for (let multiple = prime * 2; multiple < composites.length; multiple += prime) composites[multiple] = 1;
assert.equal(nextGuestPrime(0n), 0);
for (let value = 1; value <= 1000; value++) {
 let expected = Math.max(2, value); while (composites[expected]) expected++;
 assert.equal(nextGuestPrime(BigInt(value)), expected);
}
assert.equal(nextGuestPrime(16777216n), 16777259);
for (const value of [-1n, 16777217n, 1n << 63n, 42]) assert.throws(() => nextGuestPrime(value), /guest limit/);
console.log('libc++ strings: bounded short/long copy construction, independent storage, embedded NULs and malformed inputs passed');
