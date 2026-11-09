import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { parseGuestFloat } from '../js/native-vst3-float.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const cases = [
 [' \t-12.5e+2tail', 'c093880000000000', 10, false],
 ['0x1.8p+1x', '4008000000000000', 8, false], ['0x1.8', '3ff8000000000000', 5, false],
 ['0x1p-1074', '0000000000000001', 9, false], ['0x1p-1022', '0010000000000000', 9, false],
 ['0x0.8p-1022', '0008000000000000', 11, false], ['0x1.0000000000001p-1074', '0000000000000001', 23, true],
 ['0x1p-1075', '0000000000000000', 9, true], ['2.2250738585072014e-308', '0010000000000000', 23, false],
 ['2.225073858507201e-308', '000fffffffffffff', 22, true], ['4.9406564584124654e-324', '0000000000000001', 23, true],
 ['0e-99999', '0000000000000000', 8, false], ['1e-99999', '0000000000000000', 8, true],
 ['-0', '8000000000000000', 2, false], ['no digits', '0000000000000000', 0, false], [' \t+', '0000000000000000', 0, false],
 ['infinitude', '7ff0000000000000', 3, false], ['nan(abc)tail', '7ff8000000000000', 8, false],
 ['nan(0x123)', '7ff8000000000123', 10, false], ['-nan', 'fff8000000000000', 4, false],
 ['1e+', '3ff0000000000000', 1, false], ['0x1p', '3ff0000000000000', 3, false],
 ['0x.p1', '0000000000000000', 1, false], ['.', '0000000000000000', 0, false], ['0x0p-999999', '0000000000000000', 11, false],
 ['0x0.fffffffffffff8p-1022', '0010000000000000', 24, false], ['2.2250738585072012e-308', '0010000000000000', 23, false],
 ['nan(123)', '7ff800000000007b', 8, false], ['1e309', '7ff0000000000000', 5, true], ['-1e-99999', '8000000000000000', 9, true],
];
for (const [input, expected, consumed, range] of cases) assert.deepEqual(parseGuestFloat(input), { bits: BigInt(`0x${expected}`), consumed, range }, input);
for (const [input, expected, range] of [
 ['0x1.00000000000008p0', 0x3ff0000000000000n, false], ['0x1.00000000000018p0', 0x3ff0000000000002n, false],
 ['0x1.fffffffffffff8p1023', 0x7ff0000000000000n, true], ['0x3p-1075', 2n, true],
 ['0x0.fffffffffffff7p-1022', 0x000fffffffffffffn, true],
]) assert.deepEqual(parseGuestFloat(input), { bits: expected, consumed: input.length, range }, input);
assert.equal(parseGuestFloat('\u00a01').consumed, 0);
assert.throws(() => parseGuestFloat('1'.repeat(4097)), /4096/);
assert.equal(parseGuestFloat('0'.repeat(4096)).bits, 0n);

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const call = (name, ...args) => guest.call(guest.resolve(name, 0, 'bind'), args);
 const locale = call('_newlocale', 63, guest.objc.cstring('C'), 0), end = guest.allocate(16);
 const errno = () => new DataView(guest.read(guest.errorPointer(), 4).buffer).getInt32(0, true);
 for (const name of ['_strtod_l', '_strtod']) for (const [input, expected, consumed, range] of cases) {
  const text = guest.objc.cstring(input), error = new Uint8Array(4); new DataView(error.buffer).setInt32(0, 91, true); guest.write(guest.errorPointer(), error);
  guest.write(end, new Uint8Array(16).fill(0xa5));
  guest.engine.reg_write(uc.X86_REG_XMM0, new Uint8Array(16).fill(0x77));
  call(name, text, end, locale);
  const bits = guest.engine.reg_read(uc.X86_REG_XMM0, 16);
  assert.equal(new DataView(bits.buffer, bits.byteOffset, bits.byteLength).getBigUint64(0, true), BigInt(`0x${expected}`), input);
  assert.ok(bits.slice(8).every(byte => byte === 0x77));
  assert.equal(guest.pointer(end), text + consumed); assert.ok(guest.read(end + 8, 8).every(byte => byte === 0xa5));
  assert.equal(errno(), range ? 34 : 91, input);
 }
 call('_strtod_l', guest.objc.cstring('12.5'), 0, locale); assert.equal(guest.floatingRegister(), 12.5);
 for (const [register, size, mask] of [[uc.X86_REG_MXCSR, 4, 0x20], [uc.X86_REG_FPCW, 2, 4]]) {
  const control = new Uint8Array(size); control[1] = mask; guest.engine.reg_write(register, control);
  assert.throws(() => call('_strtod_l', guest.objc.cstring('1'), 0, locale), /rounding mode/);
  guest.engine.reg_write(register, new Uint8Array(size));
 }
 assert.throws(() => call('_strtod_l', guest.objc.cstring('1'), 0, 123), /Unknown guest C locale/);
 call('_freelocale', locale);
 assert.throws(() => call('_strtod_l', guest.objc.cstring('1'), 0, locale), /Unknown guest C locale/);
 console.log('native floats: Darwin numeric goldens, exact hexadecimal rounding, decimal/subnormal ranges, NaN payloads, end pointers, errno and full-width XMM return passed');
} finally { guest.close(); }
