import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')(), guest = new NativeVst3Guest(uc, nativeFixture());
const call = (name, args = []) => guest.call(guest.resolve(name, 0, 'bind'), args);
try {
 const loop = call('_CFRunLoopGetMain'); assert.equal(call('_CFRunLoopGetCurrent'), loop);
 const mode = guest.pointer(guest.resolve('_kCFRunLoopDefaultMode', 0, 'bind')), common = guest.pointer(guest.resolve('_kCFRunLoopCommonModes', 0, 'bind'));
 const counter = guest.allocate(16), callback = guest.slide + 0x400; guest.write(counter, new Uint8Array(16)); guest.write(callback, new Uint8Array([0xff, 0x07, 0xc3]));
 const context = guest.allocate(80); guest.write(context, new Uint8Array(80)); guest.writePointer(context + 8, counter); guest.writePointer(context + 72, callback);
 const first = call('_CFRunLoopSourceCreate', [0, 5, context]); guest.writePointer(context + 8, counter + 8);
 const second = call('_CFRunLoopSourceCreate', [0, -2, context]);
 call('_CFRunLoopAddSource', [loop, first, mode]); call('_CFRunLoopAddSource', [loop, second, common]); call('_CFRunLoopAddSource', [loop, first, mode]);
 assert.equal(call('_CFGetRetainCount', [first]), 2); assert.equal(call('_CFRunLoopContainsSource', [loop, first, mode]), 1);
 call('_CFRunLoopSourceSignal', [first]); call('_CFRunLoopSourceSignal', [first]); call('_CFRunLoopSourceSignal', [second]); call('_CFRunLoopWakeUp', [loop]);
 assert.equal(guest.runLoop.woken, true); assert.equal(guest.runLoop.drain('kCFRunLoopDefaultMode', 1), 1); assert.equal(guest.pointer(counter), 0); assert.equal(guest.pointer(counter + 8), 1);
 assert.equal(guest.runLoop.drain(), 1); assert.equal(guest.pointer(counter), 1); assert.equal(guest.runLoop.drain(), 0);
 call('_CFRunLoopRemoveSource', [loop, first, mode]); assert.equal(call('_CFGetRetainCount', [first]), 1); assert.equal(call('_CFRunLoopContainsSource', [loop, first, mode]), 0);
 call('_CFRunLoopSourceSignal', [first]); assert.equal(guest.runLoop.drain(), 0);
 call('_CFRunLoopSourceInvalidate', [second]); assert.equal(call('_CFRunLoopSourceIsValid', [second]), 0); assert.equal(call('_CFGetRetainCount', [second]), 1);
 assert.equal(guest.runLoop.sources.size, 0); call('_CFRelease', [first]); call('_CFRelease', [second]);
 guest.writePointer(context + 16, callback); assert.throws(() => call('_CFRunLoopSourceCreate', [0, 0, context]), /custom ownership/);
 assert.throws(() => call('_CFRunLoopWakeUp', [counter]), /Unknown guest run loop/);
 console.log('native run loop: real source ownership, modes, ordered x86 callbacks, signal coalescing, invalidation and dispatch limits passed');
} finally { guest.close(); }
