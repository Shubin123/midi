import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { utcTimeFields } from '../js/native-vst3-time.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const samples = [0n, -1n, 951782400n, 2147483648n, 4107542400n, -62167219200n, 253402300799n, -8640000000000n, 8640000000000n];
let seed = 42;
for (let index = 0; index < 300; index++) { seed = Math.imul(seed, 1664525) + 1013904223 | 0; samples.push(BigInt(seed) * 3000n); }
for (const seconds of samples) {
 const date = new Date(Number(seconds * 1000n)), year = date.getUTCFullYear(), leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
 const yearDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].slice(0, date.getUTCMonth()).reduce((sum, days) => sum + days, date.getUTCDate() - 1);
 assert.deepEqual(utcTimeFields(seconds), [date.getUTCSeconds(), date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth(), year - 1900, date.getUTCDay(), yearDay, 0]);
}
const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const input = guest.allocate(64), output = guest.allocate(80), bytes = new Uint8Array(8), value = new DataView(bytes.buffer);
 const call = (name, source = input, destination = output) => guest.call(guest.resolve(name, 0, 'bind'), [source, destination]);
 for (const name of ['_localtime_r', '_gmtime_r']) {
  for (const seconds of samples.slice(0, 9)) {
   value.setBigInt64(0, seconds, true); guest.write(input, bytes); guest.write(output, new Uint8Array(80).fill(0xa5));
   assert.equal(call(name), output);
   const converted = guest.read(output, 80), view = new DataView(converted.buffer);
   assert.deepEqual(Array.from({ length: 9 }, (_, index) => view.getInt32(index * 4, true)), utcTimeFields(seconds));
   assert.equal(view.getBigInt64(40, true), 0n); assert.equal(guest.string(Number(view.getBigUint64(48, true))), name === '_gmtime_r' ? 'GMT' : 'UTC');
   assert.ok(converted.slice(56).every(byte => byte === 0xa5));
  }
 }
 const allocations = guest.allocations.size;
 for (let index = 0; index < 100; index++) assert.equal(call('_localtime_r'), output);
 assert.equal(guest.allocations.size, allocations); assert.equal(guest.report().time.timeZone, 'UTC');
 for (const seconds of [0x7fffffffffffffffn, -0x8000000000000000n]) {
  value.setBigInt64(0, seconds, true); guest.write(input, bytes); guest.write(output, new Uint8Array(80).fill(0x7b));
  assert.equal(call('_localtime_r'), 0); assert.equal(new DataView(guest.read(guest.errorPointer(), 4).buffer).getInt32(0, true), 84); assert.ok(guest.read(output, 80).every(byte => byte === 0x7b));
 }
 value.setBigInt64(0, 0n, true); guest.write(input, bytes);
 for (const [source, destination] of [[0, output], [input, 0], [1, output], [input, 1]]) {
  assert.equal(call('_gmtime_r', source, destination), 0); assert.equal(new DataView(guest.read(guest.errorPointer(), 4).buffer).getInt32(0, true), 14);
 }
 assert.equal(call('_localtime_r', input, input), input); assert.equal(new DataView(guest.read(input, 4).buffer).getInt32(0, true), 0);
 {
  const wall = new NativeVst3Guest(uc, nativeFixture(), { wallClock: () => 1700000000999 }), address = wall.allocate(8);
  try {
   assert.equal(wall.call(wall.resolve('_time', 0, 'bind'), [0]), 1700000000);
   assert.equal(wall.call(wall.resolve('_time', 0, 'bind'), [address]), 1700000000); assert.equal(new DataView(wall.read(address, 8).buffer).getBigInt64(0, true), 1700000000n);
  } finally { wall.close(); }
 }
 for (const [name, fields, expected, normalized] of [
  ['_mktime', [30, 0, 12, 10, 2, 124], 1710072030, [30, 0, 12, 10, 2, 124, 0, 69, 0]],
  ['_timegm', [90, 59, 23, 31, 11, 99], 946684830, [30, 0, 0, 1, 0, 100, 6, 0, 0]],
  ['_mktime', [0, 0, 0, 0, 12, 124], 1735603200, [0, 0, 0, 31, 11, 124, 2, 365, 0]],
 ]) {
  const tm = guest.allocate(56), buffer = new Uint8Array(56), fieldsView = new DataView(buffer.buffer);
  fields.forEach((value, index) => fieldsView.setInt32(index * 4, value, true)); guest.write(tm, buffer);
  assert.equal(guest.call(guest.resolve(name, 0, 'bind'), [tm]), expected, name);
  const written = guest.read(tm, 36), writtenView = new DataView(written.buffer, written.byteOffset, 36);
  assert.deepEqual(normalized.map((_, index) => writtenView.getInt32(index * 4, true)), normalized, `${name} normalizes its fields`);
 }
 console.log('native calendar: signed 64-bit epochs, Gregorian leap/century/negative-year dates, Darwin tm layout, UTC/GMT zones, bounded years, canaries, aliasing and errno passed');
} finally { guest.close(); }
