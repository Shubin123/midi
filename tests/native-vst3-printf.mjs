import assert from 'node:assert/strict';
import { formatGuestPrintf } from '../js/native-vst3-printf.js';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const format = (source, values = [], strings = new Map()) => {
 let index = 0;
 return decoder.decode(formatGuestPrintf(encoder.encode(source), () => {
  assert.ok(index < values.length, 'format must not read extra arguments');
  return BigInt(values[index++]);
 }, (pointer, precision) => {
  const bytes = strings.get(pointer);
  assert.ok(bytes, 'format must read a known string');
  return precision === null ? bytes : bytes.slice(0, precision);
 }));
};
assert.equal(format('%06X', [0x565354]), '565354');
assert.equal(format('%08X-%04X-%02X', [0x12, 0xab, 0xff]), '00000012-00AB-FF');
assert.equal(format('%lld %llu %llX', [-1, 0xffffffffffffffffn, 0xfedcba9876543210n]), '-1 18446744073709551615 FEDCBA9876543210');
assert.equal(format('%d %u %hhd %hhu', [0xffffffff, -1, 255, 257]), '-1 4294967295 -1 1');
assert.equal(format('%+08d %#08x %#o %.0d %#.0o', [-12, 42, 9, 0, 0]), '-0000012 0x00002a 011  0');
assert.equal(format('%*.*d', [-8, 4, 12]), '0012    ');
assert.equal(format('%.*d', [-1, 12]), '12');
assert.equal(format('%.3s|%5c|%%|%p', [1, 65, 0x1234], new Map([[1n, encoder.encode('abcdef')]])), 'abc|    A|%|0x1234');
assert.equal(format('%.0s', [0], new Map([[0n, new Uint8Array()]])), '');
assert.deepEqual(formatGuestPrintf(new Uint8Array([0xff, 0x25, 0x63]), () => 0xfen, () => {}), new Uint8Array([0xff, 0xfe]));
for (const source of ['%f', '%n', '%ls', '%1$d', '%', '%1048577d', '%.*d']) {
 assert.throws(() => format(source, [1048577, 1]), /Unsupported|exceeds limit/);
}
assert.throws(() => format('%1048576dX', [1]), /output exceeds limit/);
console.log('native printf: integer widths, precision, full 64-bit values, raw bytes and explicit limits passed');
