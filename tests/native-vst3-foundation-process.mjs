import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture(), { monotonicClock: () => 12345 });
try {
 const call = (name, ...args) => guest.call(guest.resolve(`_${name}`, 0, 'bind'), args);
 const send = (receiver, name, ...args) => call('objc_msgSend', receiver, guest.objc.selector(name), ...args);
 const klass = guest.objc.foundationClass('NSProcessInfo'), process = send(klass, 'processInfo');
 assert.ok(process); assert.equal(guest.pointer(process), klass); assert.equal(guest.objc.objects.get(process).immortal, true);
 const allocations = guest.allocations.size;
 for (let index = 0; index < 100; index++) assert.equal(send(klass, 'processInfo'), process);
 assert.equal(guest.allocations.size, allocations);
 assert.equal(send(process, 'processIdentifier'), call('getpid'));
 assert.equal(send(process, 'processorCount'), 1); assert.equal(send(process, 'activeProcessorCount'), 1);
 assert.equal(send(process, 'physicalMemory'), (34 << 20) + 0x2000);
 send(process, 'systemUptime'); assert.equal(guest.floatingRegister(), 12.345);
 const pool = call('objc_autoreleasePoolPush'), name = send(process, 'processName');
 assert.equal(guest.core.text(name), 'MIDI Browser Native Guest'); call('objc_autoreleasePoolPop', pool);
 assert.equal(guest.objc.objects.has(name), false);
 send(process, 'retain'); send(process, 'release'); assert.equal(send(klass, 'processInfo'), process);
 assert.throws(() => call('object_dispose', process), /permanent Foundation/);
 assert.throws(() => send(process, 'operatingSystemVersion'), error => error.details.className === 'NSProcessInfo' && error.details.selector === 'operatingSystemVersion');
 console.log('native process info: persistent guest singleton, coherent virtual PID/CPU/memory, guest clock, autoreleased name and explicit unsupported version passed');
} finally { guest.close(); }
