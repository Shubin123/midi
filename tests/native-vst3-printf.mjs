import assert from 'node:assert/strict';
import { formatGuestPrintf } from '../js/native-vst3-printf.js';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const format = (source, values = [], strings = new Map(), floats = []) => {
 let index = 0, floating = 0;
 return decoder.decode(formatGuestPrintf(encoder.encode(source), kind => {
  if (kind === 'float') {
   assert.ok(floating < floats.length, 'format must read a supplied floating argument');
   const value = floats[floating++]; if (typeof value === 'bigint') return value;
   const bytes = new ArrayBuffer(8), view = new DataView(bytes); view.setFloat64(0, value, true); return view.getBigUint64(0, true);
  }
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
assert.equal(format('%.0f %.0f %.0f', [], new Map(), [2.5, 3.5, -2.5]), '2 4 -2');
assert.equal(format('%+08.2f %#.0f %-8.1f', [], new Map(), [-1.25, 1, 2.5]), '-0001.25 1. 2.5     ');
assert.equal(format('%f %f %08f %F', [], new Map(), [-0, -Infinity, Infinity, 0xfff8000000000123n]), '-0.000000 -inf      inf -NAN');
assert.equal(format('%*.*f %d', [8, 2, 7], new Map(), [1.25]), '    1.25 7');
assert.equal(format('%.20lf', [], new Map(), [0.1]), '0.10000000000000000555');
assert.equal(format('%.0f', [], new Map(), [Number.MAX_VALUE]).length, 309);
assert.equal(format('%.4096f', [], new Map(), [0]).length, 4098);
assert.throws(() => format('%.4097f', [], new Map(), [1]), /precision exceeds limit/);
assert.throws(() => format('%llf', [], new Map(), [1]), /floating modifier/);
for (const source of ['%e', '%n', '%ls', '%1$d', '%', '%1048577d', '%.*d']) {
 assert.throws(() => format(source, [1048577, 1]), /Unsupported|exceeds limit/);
}
assert.throws(() => format('%1048576dX', [1]), /output exceeds limit/);
console.log('native printf: integer widths, exact fixed-point ties-to-even, signs, precision, raw bytes and explicit limits passed');
