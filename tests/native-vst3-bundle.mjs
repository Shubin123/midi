import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeBundleFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const bytes = nativeBundleFixture(), path = '/plugin/Owned é.vst3';
const guest = new NativeVst3Guest(uc, bytes, { bundlePath: path });
const call = (name, args = []) => guest.call(guest.resolve(name, 0, 'bind'), args);
try {
 guest.initialize(); assert.equal(guest.initialized, true); assert.equal(guest.startupStage, 'ready'); assert.equal(guest.initializersCompleted, 1);
 assert.equal(guest.string(guest.slide + 0x1500), path); assert.equal(guest.factoryInfo().classes[0].cid, '0102030405060708090a0b0c0d0e0f10');
 const bundle = guest.bundles.main(); assert.equal(call('_CFGetRetainCount', [bundle]), 2);
 const url = call('_CFBundleCopyBundleURL', [bundle]), output = guest.allocate(128);
 guest.write(output, new Uint8Array(128).fill(0xa5)); assert.equal(call('_CFURLGetFileSystemRepresentation', [url, 1, output, 2]), 0); assert.equal(guest.read(output, 1)[0], 0xa5);
 assert.equal(call('_CFURLGetFileSystemRepresentation', [url, 1, output, 128]), 1); assert.equal(guest.string(output), path);
 const string = call('_CFURLCopyFileSystemPath', [url, 0]); assert.equal(guest.core.text(string), path); call('_CFRelease', [string]);
 assert.throws(() => call('_CFURLCopyFileSystemPath', [url, 1]), /POSIX/);
 assert.throws(() => call('_CFBundleCopyBundleURL', [url]), /bundle/);
 call('_CFRelease', [url]); assert.equal(guest.core.objects.has(url), false);
 const calls = { ...guest.report().calls }; guest.initialize(); assert.deepEqual(guest.report().calls, calls);
 const information = guest.allocate(40);
 guest.write(information, new Uint8Array(40).fill(0xa5));
 assert.equal(call('_dladdr', [guest.export('_GetPluginFactory') + 2, information]), 1);
 assert.equal(guest.string(guest.pointer(information)), `${path}/Contents/MacOS/Owned é`);
 assert.equal(guest.pointer(information + 8), guest.slide);
 assert.equal(guest.string(guest.pointer(information + 16)), 'GetPluginFactory'); assert.equal(guest.pointer(information + 24), guest.export('_GetPluginFactory'));
 assert.ok(guest.read(information + 32, 8).every(byte => byte === 0xa5));
 const allocations = guest.allocations.size;
 for (let index = 0; index < 100; index++) assert.equal(call('_dladdr', [guest.export('_GetPluginFactory'), information]), 1);
 assert.equal(guest.allocations.size, allocations);
 assert.equal(call('_dladdr', [guest.slide + 1, information]), 1); assert.equal(guest.pointer(information + 16), 0); assert.equal(guest.pointer(information + 24), 0);
 assert.equal(call('_dladdr', [guest.slide, information]), 1); assert.equal(guest.string(guest.pointer(information + 16)), '__dso_handle'); assert.equal(guest.pointer(information + 24), guest.slide);
 for (const unknown of [0, guest.allocate(8), guest.resolve('_malloc', 0, 'bind'), guest.slide + 0x2000]) {
  guest.write(information, new Uint8Array(32).fill(0x7b)); assert.equal(call('_dladdr', [unknown, information]), 0); assert.ok(guest.read(information, 32).every(byte => byte === 0x7b));
 }
 assert.equal(call('_dladdr', [guest.slide, 0]), 0);
 assert.throws(() => call('_dladdr', [guest.slide, 1]), /memory|READ|Read/);
 const capacity = guest.allocate(8), required = new TextEncoder().encode(`${guest.bundles.executablePath}\0`).length;
 const setCapacity = value => { const bytes = new Uint8Array(8).fill(0xa5); new DataView(bytes.buffer).setUint32(0, value, true); guest.write(capacity, bytes); };
 setCapacity(0); call('__NSGetExecutablePath', [0, capacity]); assert.equal(BigInt.asIntN(64, guest.engine.reg_read_i64(uc.X86_REG_RAX)), -1n);
 assert.equal(new DataView(guest.read(capacity, 4).buffer).getUint32(0, true), required); assert.ok(guest.read(capacity + 4, 4).every(byte => byte === 0xa5));
 guest.write(output, new Uint8Array(128).fill(0xa5)); setCapacity(required - 1);
 call('__NSGetExecutablePath', [output, capacity]); assert.equal(BigInt.asIntN(64, guest.engine.reg_read_i64(uc.X86_REG_RAX)), -1n); assert.ok(guest.read(output, 128).every(byte => byte === 0xa5));
 for (const available of [required, 128, 0xffffffff]) {
  setCapacity(available); assert.equal(call('__NSGetExecutablePath', [output, capacity]), 0); assert.equal(guest.string(output), guest.bundles.executablePath);
  assert.equal(new DataView(guest.read(capacity, 4).buffer).getUint32(0, true), available); assert.ok(guest.read(output + required, 128 - required).every(byte => byte === 0xa5));
 }
 assert.throws(() => call('__NSGetExecutablePath', [output, 1]), /memory|READ|Read/);
} finally { guest.close(); }
const rejected = bytes.slice(); rejected.set([0x31, 0xc0, 0xc3], 0x700);
const failure = new NativeVst3Guest(uc, rejected);
try {
 let first;
 assert.throws(() => failure.initialize(), error => { first = error; return error.details.kind === 'bundle-entry-failed'; });
 assert.equal(failure.startupStage, 'bundle-entry'); assert.equal(failure.initialized, false); assert.equal(failure.initializersCompleted, 1);
 assert.throws(() => failure.initialize(), error => error === first); assert.equal(failure.initializersCompleted, 1);
} finally { failure.close(); }
const upperBits = bytes.slice(); upperBits.set([0x48, 0xb8, 1, 0, 0, 0, 0xef, 0xbe, 0xad, 0xde, 0xc3], 0x700);
const boolean = new NativeVst3Guest(uc, upperBits);
try { boolean.initialize(); assert.equal(boolean.initialized, true); } finally { boolean.close(); }
assert.throws(() => new NativeVst3Guest(uc, bytes, { bundlePath: '../Owned.vst3' }), /bundle path/);
for (const executableName of ['', '..', '/host/binary', 'nul\0name']) assert.throws(() => new NativeVst3Guest(uc, bytes, { executableName }), /executable name/);
const named = new NativeVst3Guest(uc, bytes, { bundlePath: path, executableName: 'Different executable' });
try { assert.equal(named.bundles.executablePath, `${path}/Contents/MacOS/Different executable`); } finally { named.close(); }
console.log('native bundle: x86 entry, retained URLs, UTF-8 executable paths, real mapped-image/symbol dladdr, bounded writes, cached strings and non-repeating startup failures passed');
