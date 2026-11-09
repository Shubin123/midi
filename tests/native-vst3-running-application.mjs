import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture, nativeRunningApplicationFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const call = (name, ...args) => guest.call(guest.resolve(`_${name}`, 0, 'bind'), args);
 const send = (receiver, name, ...args) => call('objc_msgSend', receiver, guest.objc.selector(name), ...args);
 const klass = guest.objc.foundationClass('NSRunningApplication'), current = send(klass, 'currentApplication');
 assert.ok(current); assert.equal(guest.pointer(current), klass); assert.equal(guest.objc.objects.get(current).immortal, true);
 const allocations = guest.allocations.size;
 for (let index = 0; index < 100; index++) assert.equal(send(klass, 'currentApplication'), current);
 assert.equal(guest.allocations.size, allocations);
 assert.equal(send(current, 'processIdentifier'), call('getpid')); assert.equal(send(current, 'executableArchitecture'), 0x01000007);
 assert.equal(send(klass, 'runningApplicationWithProcessIdentifier:', 1), current);
 assert.equal(send(klass, 'runningApplicationWithProcessIdentifier:', 0xfedcba9800000001n), current);
 for (const process of [0, 2, 0xffffffff, 0xffffffffffffffffn]) assert.equal(send(klass, 'runningApplicationWithProcessIdentifier:', process), 0);
 const pool = call('objc_autoreleasePoolPush'), name = send(current, 'localizedName');
 assert.equal(guest.core.text(name), 'MIDI Browser Native Guest'); call('objc_autoreleasePoolPop', pool); assert.equal(guest.objc.objects.has(name), false);
 const beforeName = guest.allocations.size;
 assert.throws(() => send(current, 'localizedName'), /guest pool/); assert.equal(guest.allocations.size, beforeName);
 send(current, 'retain'); send(current, 'release'); assert.equal(send(klass, 'currentApplication'), current);
 assert.throws(() => call('object_dispose', current), /permanent Foundation/);
 for (const selector of ['terminate', 'forceTerminate', 'activateWithOptions:', 'bundleIdentifier']) assert.throws(() => send(current, selector), error => error.details.className === 'NSRunningApplication' && error.details.selector === selector);
 console.log('native running application: permanent guest identity, signed PID lookup, x86 architecture, name ownership and explicit unsupported host actions passed');
} finally { guest.close(); }
const bytes = nativeRunningApplicationFixture(), view = new DataView(bytes.buffer);
bytes.set([0x48, 0x83, 0xec, 8], 0x600);
for (const [offset, prefix, target] of [[0x604, [0x48, 0x8b, 0x3d], 0x1600], [0x60b, [0x48, 0x8d, 0x35], 0x1500], [0x612, [0xff, 0x15], 0x1608]]) {
 bytes.set(prefix, offset); view.setInt32(offset + prefix.length, target - offset - prefix.length - 4, true);
}
bytes.set([0x48, 0x83, 0xc4, 8, 0xc3], 0x618);
const fixture = new NativeVst3Guest(uc, bytes);
try {
 fixture.initialize(); assert.equal(fixture.factoryInfo().classes[0].cid, '01000000000000000000000000000000');
 const thread = fixture.allocate(8), result = fixture.allocate(8), call = (name, ...args) => fixture.call(fixture.resolve(name, 0, 'bind'), args);
 assert.equal(call('_pthread_create', thread, 0, fixture.slide + 0x600, 0), 0);
 assert.equal(call('_pthread_join', fixture.pointer(thread), result), 0);
 assert.equal(fixture.pointer(result), fixture.objc.runningApplication); assert.equal(fixture.threads.report().completed, 1);
} finally { fixture.close(); }
