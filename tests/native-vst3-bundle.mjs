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
console.log('native bundle: actual x86 entry, retained handles, UTF-8 paths, owned URLs, bounded writes and non-repeating startup failures passed');
