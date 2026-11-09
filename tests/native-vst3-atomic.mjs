import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { atomicImports } from '../js/native-vst3-atomic.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const pointer = guest.allocate(16);
 const write = value => { const bytes = new Uint8Array(16).fill(0xa5); new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, value), true); guest.write(pointer, bytes); };
 const call = (name, ...args) => {
  guest.call(guest.resolve(name, 0, 'bind'), args); return guest.engine.reg_read_i64(uc.X86_REG_RAX);
 };
 for (const [name, { operation, bits, original }] of atomicImports) {
  write(0xfedcba9876543210n);
  if (operation === 'barrier') { assert.equal(call(name), 0n); continue; }
  const previous = BigInt.asUintN(bits, 0xfedcba9876543210n);
  if (operation === 'compare') {
   assert.equal(call(name, 0, 77, pointer), 0n); assert.equal(new DataView(guest.read(pointer, 8).buffer).getBigUint64(0, true), 0xfedcba9876543210n);
   assert.equal(call(name, previous, 0x8123456789abcdefn, pointer), 1n);
   const expected = bits === 64 ? 0x8123456789abcdefn : 0xfedcba9889abcdefn;
   assert.equal(new DataView(guest.read(pointer, 8).buffer).getBigUint64(0, true), expected);
  } else {
   const unary = ['increment', 'decrement'].includes(operation);
   const result = call(name, ...(unary ? [pointer] : [7, pointer]));
   const expected = BigInt.asUintN(bits, operation === 'increment' ? previous + 1n : operation === 'decrement' ? previous - 1n : operation === 'add' ? previous + 7n : operation === 'and' ? previous & 7n : operation === 'or' ? previous | 7n : previous ^ 7n);
   assert.equal(BigInt.asIntN(bits, result), BigInt.asIntN(bits, original ? previous : expected), name);
   const data = new DataView(guest.read(pointer, 8).buffer);
   assert.equal(bits === 64 ? data.getBigUint64(0, true) : BigInt(data.getUint32(0, true)), expected, name);
   if (bits === 32) assert.equal(data.getUint32(4, true), 0xfedcba98);
  }
  assert.ok(guest.read(pointer + 8, 8).every(byte => byte === 0xa5));
 }
 write(0x7fffffffffffffffn); assert.equal(BigInt.asIntN(64, call('_OSAtomicIncrement64Barrier', pointer)), -(1n << 63n));
 write(0xffffffffn); assert.equal(call('_OSAtomicIncrement32', pointer), 0n);
 assert.throws(() => call('_OSAtomicCompareAndSwap64', 0, 1, pointer + 1), /unaligned/);
 assert.throws(() => call('_OSAtomicAdd32', 1, 0), /atomic pointer/);
 console.log('native atomics: single-thread x86 imports, exact 32/64-bit CAS, barriers, signed wraparound and original/new bitwise values passed');
} finally { guest.close(); }
