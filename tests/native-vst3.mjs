import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parseMachO, dyldFixups } from '../js/macho-loader.js';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { readNativeVst3 } from '../js/native-vst3-input.js';
import { writeZip } from '../js/archive.js';
import { nativeFixture, nativePackage, nativeSelectorFixture, nativeObjCFixture, nativeStringFixture, leb } from './support/native-vst3-fixture.js';
import { loadNativeEngine } from '../js/native-vst3-engine.js';

const require = createRequire(import.meta.url), uc = await require('../vendor/unicorn/unicorn.cjs')();
const fixture = nativeFixture(), parsed = parseMachO(fixture);
assert.equal(parsed.symbols.get('_GetPluginFactory'), 0x200);
assert.equal(parsed.segments.length, 2);
for (const bytes of [new Uint8Array(), fixture.slice(0, 100)]) assert.throws(() => parseMachO(bytes), /Mach-O/);
const corrupt = edit => { const bytes = fixture.slice(); edit(new DataView(bytes.buffer)); return bytes; };
assert.throws(() => parseMachO(corrupt(view => view.setUint32(4, 0x0100000c, true))), /x86_64/);
assert.throws(() => parseMachO(corrupt(view => view.setUint32(36, 0, true))), /command size/);
assert.throws(() => parseMachO(corrupt(view => view.setBigUint64(32 + 72 + 24, 0n, true))), /section exceeds segment|overlapping/);
assert.throws(() => parseMachO(corrupt(view => view.setUint32(0x900, 0xffffffff, true))), /symbol name/);
const fat = new Uint8Array(0x1000 + fixture.length), fatView = new DataView(fat.buffer);
fatView.setUint32(0, 0xcafebabe); fatView.setUint32(4, 1); fatView.setUint32(8, 0x01000007); fatView.setUint32(16, 0x1000); fatView.setUint32(20, fixture.length); fat.set(fixture, 0x1000);
assert.equal(parseMachO(fat).symbols.get('_probe'), 0x300);
console.log('Mach-O: thin/universal x86_64 and malformed header checks passed.');

const use = (bytes, check, options = {}) => { const guest = new NativeVst3Guest(uc, bytes, options); try { return check(guest); } finally { guest.close(); } };
use(fixture, guest => {
 assert.equal(guest.call(guest.export('_probe')), 42);
 assert.ok(guest.read(guest.slide + 0x1f00, 128).every(byte => byte === 0), 'BSS is zeroed');
 assert.equal(guest.pointer(guest.slide + 0x1100), guest.slide + 0x1000, 'vtable rebased');
 const factory = guest.factoryInfo();
 assert.equal(factory.vendor, 'Fixture vendor'); assert.equal(factory.url, 'fixture.invalid'); assert.equal(factory.classes[0].name, 'Native fixture');
 assert.equal(factory.classes[0].cid, '0102030405060708090a0b0c0d0e0f10');
 assert.equal(guest.report().initialized, false); assert.equal(guest.report().playable, false);
 guest.initialize(); assert.equal(guest.report().initialized, true);
 assert.throws(() => guest.call(guest.export('_probe'), [], { instructionBudget: -1 }), /limits/);
 assert.throws(() => guest.allocate(33 << 20), /allocation/);
});
use(nativeFixture({ initializer: true }), guest => { guest.initialize(); assert.equal(guest.initialized, true); });
for (const constructor of ['C1', 'C2']) use(nativeStringFixture(constructor), guest => {
 guest.initialize(); assert.equal(guest.factoryInfo().classes[0].cid, '0c636f70696564000000000000000000');
});
use(fixture, guest => {
 const source = guest.allocate(24), destination = guest.allocate(24), pointer = guest.allocate(32), representation = new Uint8Array(24), view = new DataView(representation.buffer);
 guest.write(pointer, new TextEncoder().encode('a long string with 25 chars\0!'));
 view.setBigUint64(0, 33n, true); view.setBigUint64(8, 28n, true); view.setBigUint64(16, BigInt(pointer), true);
 guest.write(source, representation); guest.setRegister('RDI', destination); guest.setRegister('RSI', source);
 assert.throws(() => guest.invokeImport({ name: '__ZNSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEC1ERKS5_' }), error => error.details.kind === 'unsupported-libcpp');
 view.setBigUint64(8, 27n, true); guest.write(source, representation);
 assert.equal(guest.invokeImport({ name: '__ZNSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEC1ERKS5_' }), destination);
 const copied = guest.pointer(destination + 16); assert.notEqual(copied, pointer); assert.equal(guest.string(copied), 'a long string with 25 chars');
 guest.setRegister('RDI', 100); assert.equal(guest.invokeImport({ name: '__ZNSt3__112__next_primeEm' }), 101);
 guest.setRegister('RDI', 1n << 63n); assert.throws(() => guest.invokeImport({ name: '__ZNSt3__112__next_primeEm' }), error => error.details.kind === 'unsupported-libcpp');
});
use(nativeFixture({ bundleEntry: true }), guest => assert.throws(() => guest.initialize(), /CFBundle/));
use(nativeFixture({ importName: '_malloc' }), guest => { assert.ok(guest.call(guest.export('_probe')) >= 0x30000000); assert.equal(guest.report().calls._malloc, 1); });
use(nativeSelectorFixture(), guest => {
 assert.equal(guest.image.initializers.length, 0); assert.equal(guest.image.selectors.length, 1);
 assert.equal(guest.pointer(guest.slide + 0x1700), guest.objc.selector('value:'));
 assert.notEqual(guest.pointer(guest.slide + 0x1700), guest.slide + 0x1500, 'selector references are canonicalized after rebasing');
});
use(nativeObjCFixture(), guest => {
 guest.initialize();
 assert.equal(guest.factoryInfo().classes[0].cid, '2a00000005060708090a0b0c0d0e0f10');
 assert.equal(guest.objc.report().dynamicClasses, 1); assert.equal(guest.objc.report().instances, 1);
});
use(nativeFixture({ importName: '_objc_msgSend' }), guest => {
 const send = [...guest.imports].find(([, entry]) => entry.name === '_objc_msgSend')[0];
 const base = guest.objc.rootClass().handle, klass = guest.objc.allocate(base, 'NativeCallback', 0);
 const address = offset => guest.slide + offset, increment = guest.objc.selector('increment:'), nested = guest.objc.selector('nested:'), stackArg = guest.objc.selector('stackArg:');
 guest.write(address(0x400), new Uint8Array([0x48, 0x8d, 0x42, 5, 0xc3]));
 guest.objc.addMethod(klass, 'increment:', address(0x400), 'Q@:Q');
 const code = new Uint8Array([0x48, 0x83, 0xec, 8, 0x48, 0xbe, ...Array(8).fill(0), 0xff, 0x15, 0, 0, 0, 0, 0x48, 0x83, 0xc4, 8, 0x48, 0x83, 0xc0, 7, 0xc3]);
 const codeView = new DataView(code.buffer); codeView.setBigUint64(6, BigInt(increment), true); codeView.setInt32(16, address(0x1600) - address(0x450 + 20), true);
 guest.write(address(0x450), code); guest.objc.addMethod(klass, 'nested:', address(0x450), 'Q@:Q');
 guest.write(address(0x490), new Uint8Array([0x48, 0x8b, 0x44, 0x24, 8, 0xc3])); guest.objc.addMethod(klass, 'stackArg:', address(0x490), 'Q@:QQQQQ');
 guest.objc.register(klass); const object = guest.objc.instance(klass, 0);
 assert.equal(guest.call(send, [object, increment, 37]), 42);
 assert.equal(guest.call(send, [object, nested, 37]), 49, 'nested message callbacks preserve the guest return stack');
 const caller = new Uint8Array([0x48, 0x83, 0xec, 24, 0x48, 0xc7, 0x04, 0x24, 37, 0, 0, 0, 0xff, 0x15, 0, 0, 0, 0, 0x48, 0x83, 0xc4, 24, 0xc3]);
 new DataView(caller.buffer).setInt32(14, address(0x1600) - address(0x500 + 18), true); guest.write(address(0x500), caller);
 assert.equal(guest.call(address(0x500), [object, stackArg]), 37, 'message dispatch preserves arguments passed on the stack');
 guest.engine.reg_write(uc.X86_REG_XMM0, new Uint8Array(16).fill(0x77)); guest.engine.reg_write(uc.X86_REG_XMM1, new Uint8Array(16).fill(0x88));
 guest.setFloatingRegister(0, 123); guest.setFloatingRegister(1, 456);
 assert.equal(guest.call(send, [0, 0]), 0); assert.equal(guest.floatingRegister(0), 0); assert.equal(guest.floatingRegister(1), 0);
 assert.ok(guest.engine.reg_read(uc.X86_REG_XMM0, 16).every(byte => byte === 0)); assert.ok(guest.engine.reg_read(uc.X86_REG_XMM1, 16).every(byte => byte === 0));
});
use(fixture, guest => {
 const invoke = (pointer, size) => { guest.setRegister('RDI', pointer); guest.setRegister('RSI', size); return guest.invokeImport({ name: '_realloc' }); };
 const original = invoke(0, 4); guest.write(original, new Uint8Array([1, 2, 3, 4]));
 const grown = invoke(original, 32); assert.notEqual(grown, original); assert.deepEqual([...guest.read(grown, 4)], [1, 2, 3, 4]); assert.equal(guest.allocations.has(original), false);
 assert.equal(invoke(grown, 2), grown); assert.equal(guest.allocations.get(grown), 2);
 assert.throws(() => invoke(grown, 33 << 20), /size exceeds/); assert.equal(guest.allocations.get(grown), 2, 'failed resize preserves the allocation');
 const empty = invoke(grown, 0); assert.ok(empty); assert.equal(guest.allocations.get(empty), 0); assert.equal(guest.allocations.has(grown), false);
 assert.throws(() => invoke(original, 8), /unknown allocation/);
});
use(fixture, guest => {
 const receiver = guest.resolve('_OBJC_CLASS_$_NSObject', 1, 'bind'), selector = guest.allocate(32);
 guest.write(selector, new TextEncoder().encode('class\0')); guest.setRegister('RDI', receiver); guest.setRegister('RSI', selector);
 assert.equal(guest.invokeImport({ name: '_objc_msgSend' }), receiver);
 guest.setRegister('RDI', 0); assert.deepEqual(guest.invokeImport({ name: '_objc_msgSend' }), { rax: 0, rdx: 0, zeroVectors: true }); guest.setRegister('RDI', receiver);
 guest.write(selector, new TextEncoder().encode('notImplemented\0'));
 guest.setRegister('RSI', selector);
 assert.throws(() => guest.invokeImport({ name: '_objc_msgSend' }), error => error.details.kind === 'unsupported-objc' && error.details.className === 'NSObject' && error.details.selector === 'notImplemented');
});
use(fixture, guest => {
 const buffer = guest.allocate(32), filename = guest.allocate(32);
 guest.write(filename, new TextEncoder().encode('data.bin\0'));
 guest.write(buffer, new Uint8Array(32).fill(0x77));
 const invoke = (name, args = []) => {
  for (const [index, register] of ['RDI', 'RSI', 'RDX'].entries()) guest.setRegister(register, args[index] ?? 0);
  return guest.invokeImport({ name });
 };
 assert.equal(invoke('_getrlimit', [8, buffer]), 0);
 assert.equal(guest.pointer(buffer), 256); assert.equal(guest.pointer(buffer + 8), 256);
 assert.ok(guest.read(buffer + 16, 16).every(byte => byte === 0x77));
 guest.writePointer(buffer, 4); assert.equal(invoke('_setrlimit', [8, buffer]), 0);
 assert.equal(invoke('_getdtablesize'), 4);
 const descriptor = invoke('_open', [filename, 0]); assert.equal(descriptor, 3);
 assert.equal(invoke('_open', [filename, 0]), -1);
 const error = invoke('___error');
 assert.equal(new DataView(guest.read(error, 4).buffer).getInt32(0, true), 24);
 assert.equal(invoke('_read', [descriptor, buffer, 32]), 3); assert.equal(new TextDecoder().decode(guest.read(buffer, 3)), 'abc');
 assert.equal(invoke('_lseek', [descriptor, -1n, 2]), 2n);
 assert.equal(invoke('_read', [descriptor, buffer, 32]), 1); assert.equal(guest.read(buffer, 1)[0], 99);
 assert.equal(invoke('_read', [descriptor, 0, 0]), 0);
 assert.equal(invoke('_close', [descriptor]), 0); assert.equal(invoke('_close', [descriptor]), -1);
 assert.equal(new DataView(guest.read(error, 4).buffer).getInt32(0, true), 9);
 assert.equal(invoke('___error'), error, 'errno storage is stable within one guest');
 assert.equal(invoke('_write', [1, filename, 8]), 8); assert.equal(guest.report().files.stdout, 'data.bin');
 assert.equal(invoke('_getrlimit', [8, 0]), -1);
 assert.equal(new DataView(guest.read(error, 4).buffer).getInt32(0, true), 14);
 assert.equal(invoke('_open', [0, 0]), -1);
 assert.equal(new DataView(guest.read(error, 4).buffer).getInt32(0, true), 14);
 assert.throws(() => invoke('_getrlimit', [3, buffer]), exception => exception.details.kind === 'unsupported-filesystem');
}, { files: new Map([['/plugin/data.bin', new TextEncoder().encode('abc')]]) });
use(fixture, guest => {
 const originalWrite = guest.write;
 guest.write = () => { throw new WebAssembly.RuntimeError('simulated engine API fault'); };
 guest.setRegister('RDI', 8); guest.setRegister('RSI', 0x40000000);
 try {
  assert.throws(() => guest.invokeImport({ name: '_getrlimit' }), error => error.details.kind === 'emulator-fault');
  assert.equal(guest.poisoned, true, 'host-import engine faults cannot be mistaken for an ordinary errno');
 } finally { guest.write = originalWrite; guest.poisoned = false; }
});
const clockSamples = [12.5, 12.25, 13, NaN];
use(fixture, guest => {
 const info = guest.allocate(16); guest.write(info, new Uint8Array(16).fill(0x77)); guest.setRegister('RDI', info);
 assert.equal(guest.invokeImport({ name: '_mach_timebase_info' }), 0);
 const bytes = guest.read(info, 16), view = new DataView(bytes.buffer);
 assert.equal(view.getUint32(0, true), 1); assert.equal(view.getUint32(4, true), 1); assert.equal(bytes[8], 0x77);
 for (const expected of [12500000n, 12500000n, 13000000n]) assert.equal(guest.invokeImport({ name: '_mach_absolute_time' }), expected);
 assert.throws(() => guest.invokeImport({ name: '_mach_absolute_time' }), /Invalid guest monotonic clock/);
}, { monotonicClock: () => clockSamples.shift() });
const wallSamples = [1500.25, -0.25];
use(fixture, guest => {
 const info = guest.allocate(16); guest.write(info, new Uint8Array(16).fill(0x77)); guest.setRegister('RDI', info); guest.setRegister('RSI', 0);
 for (const [seconds, microseconds] of [[1n, 500250], [-1n, 999750]]) {
  assert.equal(guest.invokeImport({ name: '_gettimeofday' }), 0);
  const bytes = guest.read(info, 16), view = new DataView(bytes.buffer);
  assert.equal(view.getBigInt64(0, true), seconds); assert.equal(view.getInt32(8, true), microseconds); assert.equal(bytes[12], 0x77);
 }
 guest.setRegister('RSI', info);
 assert.throws(() => guest.invokeImport({ name: '_gettimeofday' }), exception => exception.details.kind === 'unsupported-time');
}, { wallClock: () => wallSamples.shift() });
use(nativeFixture({ importName: '_exp2' }), guest => {
 guest.engine.reg_write(uc.X86_REG_XMM0, new Uint8Array(16).fill(0x77));
 for (const [input, expected] of [[0, 1], [3, 8], [-2, 0.25], [0.5, Math.SQRT2], [-Infinity, 0]]) {
  guest.setFloatingRegister(0, input); guest.call(guest.export('_probe'));
  assert.equal(guest.floatingRegister(), expected);
 }
 assert.throws(() => guest.floatingRegister(8), /Invalid floating register/);
 assert.deepEqual([...guest.engine.reg_read(uc.X86_REG_XMM0, 16).slice(8)], Array(8).fill(0x77));
});
use(nativeFixture({ importName: '_pow' }), guest => {
 for (const [base, exponent, expected] of [[2, 3, 8], [4, -0.5, 0.5], [-2, 3, -8], [1, NaN, 1], [-1, Infinity, 1], [-2, 0.5, NaN]]) {
  guest.setFloatingRegister(0, base); guest.setFloatingRegister(1, exponent); guest.call(guest.export('_probe'));
  assert.equal(guest.floatingRegister(), expected);
 }
});
for (const [name, input, expected] of [
 ['_tan', 0, 0], ['_sin', Math.PI / 2, 1], ['_cos', 0, 1], ['_asin', 1, Math.PI / 2], ['_acos', 1, 0], ['_atan', 0, 0],
 ['_exp', 0, 1], ['_expm1', 0, 0], ['_log', 1, 0], ['_log2', 8, 3], ['_log10', 100, 2], ['_log1p', 0, 0],
 ['_sqrt', 16, 4], ['_cbrt', 8, 2], ['_floor', -1.5, -2], ['_ceil', -1.5, -1], ['_trunc', -1.5, -1], ['_fabs', -0, 0],
]) {
 use(nativeFixture({ importName: name }), guest => {
  guest.setFloatingRegister(0, input); guest.call(guest.export('_probe'));
  assert.equal(guest.floatingRegister(), expected);
 });
}
use(nativeFixture({ importName: '_not_implemented' }), guest => assert.throws(() => guest.call(guest.export('_probe')), error => error.details.kind === 'unsupported-import' && error.details.name === '_not_implemented'));
use(nativeFixture({ importName: '_unknown_data', dataImport: true }), guest => assert.throws(() => guest.call(guest.export('_probe')), /Unsupported imported data/));
use(nativeFixture({ importName: '___stack_chk_guard', dataImport: true }), guest => { guest.call(guest.export('_probe')); assert.equal(guest.report().calls.___stack_chk_guard, undefined); });
use(nativeFixture({ importName: '_kCFAllocatorDefault', dataImport: true }), guest => assert.equal(guest.call(guest.export('_probe')), 0));
use(fixture, guest => {
 const destination = guest.allocate(128), source = guest.allocate(128);
 guest.write(source, new TextEncoder().encode('copied string\0'));
 guest.setRegister('RDI', destination); guest.setRegister('RSI', source);
 assert.equal(guest.invokeImport({ name: '_strcpy' }), destination);
 assert.equal(guest.string(destination), 'copied string');
 assert.equal(guest.invokeImport({ name: '_strcat' }), destination);
 assert.equal(guest.string(destination), 'copied stringcopied string');
 const format = guest.allocate(128);
 guest.write(format, new TextEncoder().encode('%llX:%X:%X:%X:%X\0'));
 guest.setRegister('RDI', destination); guest.setRegister('RSI', format);
 guest.setRegister('RDX', 0xfedcba9876543210n); guest.setRegister('RCX', 1); guest.setRegister('R8', 2); guest.setRegister('R9', 3);
 const stack = 0x40080000; guest.setRegister('RSP', stack); guest.writePointer(stack + 8, 4);
 assert.equal(guest.invokeImport({ name: '_sprintf' }), 24);
 assert.equal(guest.string(destination), 'FEDCBA9876543210:1:2:3:4');
 guest.write(format, new TextEncoder().encode('%08X\0'));
 guest.setRegister('RDI', destination); guest.setRegister('RSI', 5); guest.setRegister('RDX', format); guest.setRegister('RCX', 42);
 assert.equal(guest.invokeImport({ name: '_snprintf' }), 8); assert.equal(guest.string(destination), '0000');
 guest.setRegister('RDI', 0); guest.setRegister('RSI', 0);
 assert.equal(guest.invokeImport({ name: '_snprintf' }), 8);
});
use(fixture, guest => {
 const input = guest.allocate(128), format = guest.allocate(128), output = guest.allocate(64), stack = 0x40080000;
 guest.write(input, new TextEncoder().encode('FEDCBA9876543210 1 2 3 4\0'));
 guest.write(format, new TextEncoder().encode('%llX %hhX %hX %X %X\0'));
 guest.write(output, new Uint8Array(64).fill(0x77));
 guest.setRegister('RDI', input); guest.setRegister('RSI', format); guest.setRegister('RDX', output);
 guest.setRegister('RCX', output + 8); guest.setRegister('R8', output + 16); guest.setRegister('R9', output + 24);
 guest.setRegister('RSP', stack); guest.writePointer(stack + 8, output + 32);
 assert.equal(guest.invokeImport({ name: '_sscanf' }), 5);
 const bytes = guest.read(output, 64), view = new DataView(bytes.buffer);
 assert.equal(view.getBigUint64(0, true), 0xfedcba9876543210n);
 assert.equal(bytes[8], 1); assert.equal(view.getUint16(16, true), 2); assert.equal(view.getUint32(24, true), 3); assert.equal(view.getUint32(32, true), 4);
 for (const offset of [9, 18, 28, 36]) assert.equal(bytes[offset], 0x77, 'scanf writes only the declared integer size');
 guest.write(input, new TextEncoder().encode('?\0'));
 assert.equal(guest.invokeImport({ name: '_sscanf' }), 0);
 assert.deepEqual(guest.read(output, 64), bytes, 'matching failure does not alter destinations');
 guest.write(format, new TextEncoder().encode('%f\0'));
 assert.throws(() => guest.invokeImport({ name: '_sscanf' }), error => error.details.kind === 'unsupported-scanf');
});
use(fixture, guest => {
 guest.setRegister('RDI', 0);
 const uuid = guest.invokeImport({ name: '_CFUUIDCreate' });
 const bytes = guest.uuids.get(uuid);
 assert.equal(bytes[6] >> 4, 4); assert.equal(bytes[8] >> 6, 2);
 guest.setRegister('RDI', uuid);
 const result = guest.invokeImport({ name: '_CFUUIDGetUUIDBytes' });
 assert.equal(result.rax, new DataView(bytes.buffer).getBigUint64(0, true)); assert.equal(result.rdx, new DataView(bytes.buffer).getBigUint64(8, true));
 guest.invokeImport({ name: '_CFRelease' }); assert.equal(guest.uuids.size, 0);
 assert.throws(() => guest.invokeImport({ name: '_CFRelease' }), /unsupported object/);
});
use(nativeFixture({ code: [0xeb, 0xfe] }), guest => assert.throws(() => guest.call(guest.export('_probe'), [], { instructionBudget: 100 }), /Execution limit/));
use(nativeFixture({ code: [0x0f, 0x05, 0xc3] }), guest => assert.throws(() => guest.call(guest.export('_probe')), /syscall/));
use(nativeFixture({ code: [0x48, 0x31, 0xc0, 0x48, 0x8b, 0, 0xc3] }), guest => assert.throws(() => guest.call(guest.export('_probe')), /CPU stopped/));
use(nativeFixture({ code: [0xf3, 0x0f, 0x10, 7, 0xf3, 0x0f, 0x58, 0xc0, 0xf3, 0x0f, 0x11, 7, 0xc3] }), guest => {
 const address = guest.allocate(4), bytes = new Uint8Array(4); new DataView(bytes.buffer).setFloat32(0, 0.25, true);
 guest.write(address, bytes); guest.call(guest.export('_probe'), [address]);
 assert.equal(new DataView(guest.read(address, 4).buffer).getFloat32(0, true), 0.5, 'SSE processes a float sample');
});
use(nativeFixture({ code: [0xc6, 0x05, 0xf9, 0xfe, 0xff, 0xff, 0, 0xc3] }), guest => assert.throws(() => guest.call(guest.export('_probe')), /CPU stopped/));
console.log('Native execution: real CPU instructions, VST3 virtual calls, rebasing, BSS, imports, limits and faults passed.');

const segment = { address: 0, size: 4096 }, memory = new Map(), model = { segments: [segment], dyldSegments: [segment], streams: {} };
const io = { readPointer: address => memory.get(address) || 0, writePointer: (address, value) => memory.set(address, value), resolve: () => 123 };
const symbol = [...new TextEncoder().encode('_test'), 0];
model.streams.bind = new Uint8Array([0x40, ...symbol, 0x51, 0x70, ...leb(32), 0x90, 0x80, ...leb((1n << 64n) - 24n), 0x90, 0]);
dyldFixups(model, 0, io); assert.equal(memory.get(32), 123); assert.equal(memory.get(16), 123, 'unsigned backward bind delta wraps correctly');
model.streams.bind = new Uint8Array([0x40, ...symbol, 0x70, ...leb(4096), 0x90]);
assert.throws(() => dyldFixups(model, 0, io), /fixup exceeds segment/);
model.streams.bind = new Uint8Array([0x40, ...symbol, 0x70, 0, 0xc0, ...leb(1000001), 0]);
assert.throws(() => dyldFixups(model, 0, { ...io, writePointer: () => {} }), /fixup exceeds segment|too many dyld/);
model.streams.bind = new Uint8Array([0x40, ...symbol, 0x70, 0x80]);
assert.throws(() => dyldFixups(model, 0, io), /truncated dyld/);
console.log('dyld: backward deltas, malformed streams and segment bounds passed.');

assert.deepEqual((await readNativeVst3(new Blob([fixture]), 'fixture')).bytes, fixture);
const zip = writeZip(new Map([['Test.vst3/Contents/MacOS/Test', fixture], ['Test.vst3/Contents/Resources/skip', new Uint8Array([1])]]));
assert.deepEqual((await readNativeVst3(zip)).bytes, fixture);
await assert.rejects(readNativeVst3(writeZip(new Map([['not-a-plugin', fixture]]))), /expected one/);
await assert.rejects(readNativeVst3(new Blob(['xar!'])), /truncated xar/);
for (const modern of [false, true]) {
 const result = await readNativeVst3(await nativePackage(fixture, { modern }));
 assert.deepEqual(result.bytes, fixture); assert.equal(result.source, 'Test-VST3.pkg/Payload');
}
await assert.rejects(readNativeVst3(await nativePackage(fixture, { truncated: true })), /truncated payload/);
console.log('Package input: xar and both cpio layouts, skipped sample data, truncation and ZIP checks passed.');
const originalFetch = globalThis.fetch, originalScripts = globalThis.importScripts, originalFactory = globalThis.MUnicorn;
try {
 globalThis.fetch = async () => new Response('corrupted engine');
 await assert.rejects(loadNativeEngine(), /SHA-256/);
 const requested = [], engineBytes = readFileSync(require.resolve('../vendor/unicorn/unicorn.cjs'));
 globalThis.fetch = async url => { requested.push(String(url)); return new Response(engineBytes); };
 globalThis.importScripts = url => { assert.match(url, /^blob:/); globalThis.MUnicorn = async () => 'verified-engine'; };
 assert.equal(await loadNativeEngine(), 'verified-engine');
 assert.equal(requested.length, 1); assert.match(requested[0], /vendor\/unicorn\/unicorn\.cjs$/);
 globalThis.fetch = async () => new Response('', { status: 404 });
 await assert.rejects(loadNativeEngine(), /patched Unicorn/);
} finally {
 globalThis.fetch = originalFetch;
 if (originalScripts === undefined) delete globalThis.importScripts; else globalThis.importScripts = originalScripts;
 if (originalFactory === undefined) delete globalThis.MUnicorn; else globalThis.MUnicorn = originalFactory;
}
console.log('Engine dependency: corrupted bytes rejected, patched local engine verified, no buggy CDN fallback.');
console.log('native VST3 experiment: all checks passed');
