import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const fixture = nativeFixture(); fixture.set([0x48, 0x89, 0xf8, 0xc3], 0x500); fixture.set([0xeb, 0xfe], 0x520);
const guest = new NativeVst3Guest(uc, fixture);
const call = (name, ...args) => guest.call(guest.resolve(name, 0, 'bind'), args);
try {
 const parent = call('_pthread_self'), output = guest.allocate(16), attribute = guest.allocate(64), token = 0xfedcba9876543210n;
 assert.equal(call('_pthread_join', parent, 0), 11);
 assert.equal(call('_pthread_getschedparam', parent, output, output + 8), 0);
 assert.equal(new DataView(guest.read(output, 4).buffer).getInt32(0, true), 1);
 assert.equal(new DataView(guest.read(output + 8, 8).buffer).getInt32(0, true), 31);
 assert.equal(call('_pthread_getschedparam', parent, 0, 0), 0);
 assert.equal(call('_pthread_getschedparam', 0x12345678, 0, 0), 3);
 assert.equal(call('_sched_get_priority_min', 2), 15); assert.equal(call('_sched_get_priority_max', 2), 47);
 assert.equal(call('_pthread_setschedparam', parent, 1, output + 8), 0);
 assert.equal(call('_pthread_setschedparam', parent, 2, output + 8), 45);
 assert.equal(call('_pthread_setschedparam', parent, 3, output + 8), 22);
 guest.writePointer(output + 8, 48); assert.equal(call('_pthread_setschedparam', parent, 1, output + 8), 22);
 assert.equal(call('_pthread_getschedparam', parent, 0, output + 8), 0);
 assert.equal(new DataView(guest.read(output + 8, 8).buffer).getInt32(0, true), 31);
 assert.equal(call('_pthread_create', output, 0, guest.slide + 0x500, token), 0);
 const child = guest.pointer(output), childRecord = Array.from(guest.threads.records).find(thread => thread.handle === child);
 assert.notEqual(child, parent); assert.equal(call('_pthread_equal', parent, child), 0);
 assert.throws(() => guest.read(childRecord.stackBase - 1, 1), /failed/);
 assert.equal(call('_pthread_join', child, output + 8), 0);
 assert.equal(new DataView(guest.read(output + 8, 8).buffer).getBigUint64(0, true), token);
 assert.equal(call('_pthread_join', child, 0), 3);
 assert.equal(guest.threads.report().active, 0); assert.equal(guest.threads.report().stackBytes, 0);
 assert.throws(() => guest.read(childRecord.stackBase, 1), /failed/);
 assert.equal(call('_pthread_self'), parent);
 assert.equal(call('_pthread_attr_init', attribute), 0);
 assert.equal(call('_pthread_attr_setdetachstate', attribute, 2), 0);
 assert.equal(call('_pthread_create', output, attribute, guest.slide + 0x500, 123), 0);
 const detached = guest.pointer(output);
 assert.equal(call('_pthread_join', detached, 0), 22);
 assert.equal(call('_pthread_detach', detached), 22);
 assert.equal(call('_pthread_attr_setstacksize', attribute, 16 << 20), 0);
 guest.writePointer(output, 0x12345678);
 assert.equal(call('_pthread_create', output, attribute, guest.slide + 0x500, 0), 35);
 assert.equal(guest.pointer(output), 0x12345678);
 assert.equal(call('_pthread_attr_destroy', attribute), 0);
 assert.equal(call('_pthread_create', output, attribute, guest.slide + 0x500, 0), 22);
 assert.throws(() => call('_pthread_create', output, 0, output, 0), /entry point/);
 assert.equal(call('_pthread_create', output, 0, guest.slide + 0x500, 99), 0);
 assert.equal(call('_pthread_join', guest.pointer(output), output + 8), 0);
 assert.equal(guest.pointer(output + 8), 99);
 assert.equal(guest.threads.report().completed, 3); assert.equal(guest.threads.report().active, 0);
 assert.ok(guest.threads.report().switches >= 4);
 const guard = guest.allocate(8); guest.write(guard, new Uint8Array(8));
 assert.equal(call('___cxa_guard_acquire', guard), 1);
 assert.throws(() => call('___cxa_guard_acquire', guard), /Recursive static/);
 assert.equal(call('___cxa_guard_abort', guard), 0);
 assert.equal(call('___cxa_guard_acquire', guard), 1);
 assert.equal(call('___cxa_guard_release', guard), 0);
 assert.equal(call('___cxa_guard_acquire', guard), 0);
 assert.throws(() => call('___cxa_guard_release', guard), /not owned/);
 const cppMutex = guest.allocate(64); guest.write(cppMutex, new Uint8Array(64)); guest.writePointer(cppMutex, 0x32aaaba7);
 assert.equal(call('__ZNSt3__15mutex4lockEv', cppMutex), 0);
 assert.equal(call('__ZNSt3__15mutex8try_lockEv', cppMutex), 0);
 assert.equal(call('__ZNSt3__15mutex6unlockEv', cppMutex), 0);
 assert.equal(call('__ZNSt3__15mutex8try_lockEv', cppMutex), 1);
 assert.equal(call('__ZNSt3__15mutex6unlockEv', cppMutex), 0);
 assert.equal(call('__ZNSt3__15mutexD1Ev', cppMutex), 0);
} finally { guest.close(); }
const bounded = new NativeVst3Guest(uc, fixture);
try {
 const output = bounded.allocate(8);
 bounded.call(bounded.resolve('_pthread_create', 0, 'bind'), [output, 0, bounded.slide + 0x520, 0]);
 assert.throws(() => bounded.call(bounded.resolve('_pthread_join', 0, 'bind'), [bounded.pointer(output), 0], { instructionBudget: 2048 }), error => error.details.kind === 'execution-limit');
 assert.equal(bounded.threads.current, bounded.threads.main);
 assert.equal(bounded.threadStorage.current, bounded.threads.main.handle);
} finally { bounded.close(); }
const limited = new NativeVst3Guest(uc, fixture);
try {
 const output = limited.allocate(8), create = limited.resolve('_pthread_create', 0, 'bind');
 for (let index = 0; index < 32; index++) assert.equal(limited.call(create, [output, 0, limited.slide + 0x520, 0]), 0);
 limited.writePointer(output, 0x12345678);
 assert.equal(limited.call(create, [output, 0, limited.slide + 0x520, 0]), 35);
 assert.equal(limited.pointer(output), 0x12345678);
 assert.equal(limited.threads.records.size, 33);
} finally { limited.close(); }
const rejected = new NativeVst3Guest(uc, nativeFixture({ importName: '_CFRunLoopGetCurrent' }));
try {
 const output = rejected.allocate(8);
 rejected.call(rejected.resolve('_pthread_create', 0, 'bind'), [output, 0, rejected.export('_probe'), 0]);
 assert.throws(() => rejected.call(rejected.resolve('_pthread_join', 0, 'bind'), [rejected.pointer(output), 0]), /Secondary guest run loops/);
 assert.equal(rejected.threads.current, rejected.threads.main);
 assert.equal(rejected.threads.failure.details.thread, rejected.pointer(output));
 assert.throws(() => rejected.call(rejected.resolve('_pthread_self', 0, 'bind')), error => error === rejected.threads.failure);
} finally { rejected.close(); }
console.log('native threads: real x86 entry, full-width joins, identity, detach, stack guards/reclamation, validation, bounded scheduling and owner restoration passed');
