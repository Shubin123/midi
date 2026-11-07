import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture, nativeLocaleFixture } from './support/native-vst3-fixture.js';
import { readGuestString, writeGuestString } from '../js/native-vst3-libcpp.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
const call = (name, args = []) => guest.call(guest.resolve(name, 0, 'bind'), args);
const text = value => { const bytes = new TextEncoder().encode(`${value}\0`), address = guest.allocate(bytes.length); guest.write(address, bytes); return address; };
const decode = address => new TextDecoder().decode(readGuestString(guest, address).bytes);
try {
 const first = guest.allocate(8), second = guest.allocate(8), output = guest.allocate(24);
 call('__ZNSt3__16localeC1Ev', [first]); call('__ZNSt3__16localeC1ERKS0_', [second, first]);
 assert.equal(guest.locales.references, 2); assert.equal(guest.pointer(first), guest.pointer(second));
 assert.equal(call('__ZNKSt3__16localeeqERKS0_', [first, second]), 1);
 assert.throws(() => call('__ZNSt3__16localeC1Ev', [first]), /live locale/);
 call('__ZNKSt3__16locale4nameEv', [output, first]); assert.equal(decode(output), 'C');
 const classic = call('__ZNSt3__16locale7classicEv'); assert.equal(call('__ZNSt3__16locale7classicEv'), classic);
 assert.equal(guest.locales.references, 3);
 const ctype = call('__ZNKSt3__16locale9use_facetERNS0_2idE', [first, guest.resolve('__ZNSt3__15ctypeIcE2idE', 0, 'bind')]);
 const collate = call('__ZNKSt3__16locale9use_facetERNS0_2idE', [first, guest.resolve('__ZNSt3__17collateIcE2idE', 0, 'bind')]);
 assert.equal(guest.virtual(ctype, 2, [97]), 65); assert.equal(guest.virtual(ctype, 4, [90]), 122);
 assert.equal(guest.virtual(ctype, 2, [255]), 255); assert.equal(guest.virtual(ctype, 6, [255]), 255);
 assert.equal(guest.virtual(ctype, 8, [255, 63]), 63); assert.equal(guest.virtual(ctype, 8, [65, 63]), 65);
 const range = text('aBcZ'), end = range + 4, destination = guest.allocate(8);
 assert.equal(guest.virtual(ctype, 3, [range, end]), end); assert.equal(guest.string(range), 'ABCZ');
 assert.equal(guest.virtual(ctype, 5, [range, end]), end); assert.equal(guest.string(range), 'abcz');
 guest.write(range, new Uint8Array([65, 255, 0]));
 assert.equal(guest.virtual(ctype, 7, [range, range + 2, destination]), range + 2); assert.deepEqual(Array.from(guest.read(destination, 2)), [65, 255]);
 assert.equal(guest.virtual(ctype, 9, [range, range + 2, 63, destination]), range + 2); assert.deepEqual(Array.from(guest.read(destination, 2)), [65, 63]);
 const table = guest.pointer(ctype + 16), mask = code => new DataView(guest.read(table + code * 4, 4).buffer).getUint32(0, true);
 assert.ok(mask(65) & 0x100); assert.ok(mask(65) & 0x8000); assert.equal(mask(65) & 0x1000, 0);
 assert.ok(mask(97) & 0x1000); assert.ok(mask(48) & 0x400); assert.ok(mask(32) & 0x4000); assert.ok(mask(9) & 0x20000);
 assert.ok(mask(95) & 0x2000); assert.equal(mask(255), 0);
 const rune = guest.resolve('__DefaultRuneLocale', 0, 'bind');
 assert.equal(new TextDecoder().decode(guest.read(rune, 12)), 'RuneMagANONE');
 const runeWord = offset => new DataView(guest.read(rune + offset, 4).buffer).getUint32(0, true);
 assert.equal(runeWord(56), 65533); assert.equal(runeWord(60 + 65 * 4), 0x5890a);
 assert.equal(runeWord(60 + 255 * 4), 0); assert.equal(runeWord(1084 + 65 * 4), 97); assert.equal(runeWord(2108 + 97 * 4), 65);
 assert.equal(table, rune + 60);
 for (const [name, input, expected] of [['_sinf', 0.5, Math.fround(Math.sin(0.5))], ['___exp10f', -2, Math.fround(0.01)], ['_exp2f', 3, 8]]) {
  guest.setFloatingRegister(0, input, 32); call(name); assert.equal(guest.floatingRegister(0, 32), expected);
 }
 guest.setFloatingRegister(0, 3, 32); guest.setFloatingRegister(1, 2, 32); call('_powf'); assert.equal(guest.floatingRegister(0, 32), 9);
 assert.throws(() => guest.floatingRegister(0, 16), /Invalid floating register/);
 const left = text('abc'), right = text('abd');
 assert.equal(guest.virtual(collate, 2, [left, left + 3, right, right + 3]), Number(0xffffffffffffffffn));
 assert.equal(guest.virtual(collate, 2, [left, left + 2, left, left + 3]), Number(0xffffffffffffffffn));
 assert.equal(guest.virtual(collate, 2, [left, left + 3, left, left + 3]), 0);
 const transform = guest.pointer(guest.pointer(collate) + 24);
 call('__ZNSt3__16localeaSERKS0_', [second, first]);
 assert.equal(guest.call(transform, [output, collate, left, left + 3]), output); assert.equal(decode(output), 'abc');
 assert.equal(guest.virtual(collate, 4, [left, left + 3]), 26499);
 assert.throws(() => guest.virtual(ctype, 0), /permanent/);
 assert.throws(() => guest.virtual(ctype, 3, [end, range]), /range/);
 assert.throws(() => call('__ZNKSt3__16locale9use_facetERNS0_2idE', [first, 0]), /Unsupported/);
 call('__ZNSt3__16localeD1Ev', [second]); assert.equal(guest.locales.references, 2);
 assert.throws(() => call('__ZNSt3__16localeD1Ev', [second]), /Unknown/);
 assert.throws(() => call('__ZNSt3__16localeD1Ev', [classic]), /permanent/);
 const string = guest.allocate(24); writeGuestString(guest, string, new TextEncoder().encode('abcdef'));
 const prefix = '__ZNSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE';
 call(prefix + '6appendEPKc', [string, text('ghijklmnopqrstuvwxyz')]); assert.equal(decode(string), 'abcdefghijklmnopqrstuvwxyz');
 const pointer = guest.pointer(string + 16); call(prefix + '5eraseEmm', [string, 2, 22]); assert.equal(decode(string), 'abyz'); assert.equal(guest.pointer(string + 16), pointer);
 call(prefix + '6insertEmPKc', [string, 2, text('cd')]); assert.equal(decode(string), 'abcdyz');
 call(prefix + '6resizeEmc', [string, 8, 33]); assert.equal(decode(string), 'abcdyz!!');
 call(prefix + '9push_backEc', [string, 63]); assert.equal(decode(string), 'abcdyz!!?');
 call(prefix + '6appendEmc', [string, 2, 120]); assert.equal(decode(string), 'abcdyz!!?xx');
 call(prefix + '7reserveEm', [string, 128]); assert.ok(readGuestString(guest, string).capacity >= 129);
 call(prefix + '6assignEPKc', [string, text('assigned')]); assert.equal(decode(string), 'assigned');
 call(prefix + 'aSEc', [string, 65]); assert.equal(decode(string), 'A');
 const copied = guest.allocate(24); call(prefix + 'C1ERKS5_mmRKS4_', [copied, string, 0, 0xffffffffffffffffn, 0]); assert.equal(decode(copied), 'A');
 call(prefix + 'aSERKS5_', [string, copied]); assert.equal(decode(string), 'A');
 assert.throws(() => call(prefix + '5eraseEmm', [string, 2, 1]), /position/);
 const compare = prefix.replace('__ZN', '__ZNK') + '7compareEmmPKcm';
 assert.equal(call(compare, [string, 0, 0xffffffffffffffffn, text('A'), 1]), 0);
 call(prefix + 'D1Ev', [string]); call(prefix + 'D1Ev', [copied]);
 const bytes = text('abcabc'), other = text('abcabd');
 assert.equal(call('_memcmp', [bytes, other, 5]), 0); assert.equal(call('_memcmp', [bytes, other, 6]), Number(0xffffffffffffffffn));
 assert.equal(call('_memcmp', [0, 0, 0]), 0); assert.equal(call('_strncmp', [0, 0, 0]), 0);
 assert.equal(call('_strcmp', [bytes, bytes]), 0); assert.equal(call('_strncmp', [bytes, other, 5]), 0);
 assert.equal(call('_memchr', [bytes, 98, 6]), bytes + 1); assert.equal(call('_strrchr', [bytes, 98]), bytes + 4);
 assert.equal(call('_strchr', [bytes, 0]), bytes + 6);
 for (const [input, expected] of [['123abc', 123n], [' \t-42', -42n], ['+2147483647', 2147483647n], ['-2147483648', -2147483648n], ['no digits', 0n]]) {
  assert.equal(call('_atoi', [text(input)]), Number(BigInt.asUintN(64, expected)));
 }
 assert.throws(() => call('_atoi', [text('2147483648')]), /32-bit/);
 console.log('native locale: classic ownership, real facet vtables, character masks, collation, string mutation and byte comparisons passed');
} finally { guest.close(); }
const native = new NativeVst3Guest(uc, nativeLocaleFixture());
try {
 native.initialize(); assert.equal(native.factoryInfo().classes[0].cid, '0a89050041060708090a0b0c0d0e0f10');
 assert.equal(native.locales.references, 0);
} finally { native.close(); }
