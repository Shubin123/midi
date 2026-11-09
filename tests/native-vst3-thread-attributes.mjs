import assert from 'node:assert/strict';
import { GuestThreadAttributes } from '../js/native-vst3-thread-attributes.js';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';
import { createRequire } from 'node:module';

const bytes = new Uint8Array(512), view = new DataView(bytes.buffer);
const memory = {
 pointer: address => Number(view.getBigUint64(address, true)),
 writePointer: (address, value) => view.setBigUint64(address, BigInt(value), true),
 read: (address, length) => bytes.slice(address, address + length),
 write: (address, source) => bytes.set(source, address),
};
const attributes = new GuestThreadAttributes(memory);
const invoke = (name, argument = 256, address = 64) => attributes.invoke(`_pthread_attr_${name}`, address, argument);
assert.equal(invoke('getstacksize'), 22);
assert.equal(invoke('init'), 0); assert.equal(view.getBigUint64(64, true), 0x54484441n);
for (const [field, initial, valid, invalid] of [
 ['detachstate', 1, 2, 0], ['inheritsched', 1, 2, 3], ['schedpolicy', 1, 4, 3],
 ['stacksize', 524288, 8192, 4096], ['guardsize', 4096, 0, 1],
]) {
 const wide = field.endsWith('size');
 assert.equal(invoke(`get${field}`), 0);
 assert.equal(wide ? Number(view.getBigUint64(256, true)) : view.getInt32(256, true), initial);
 assert.equal(invoke(`set${field}`, invalid), 22);
 assert.equal(invoke(`set${field}`, valid), 0);
 assert.equal(invoke(`get${field}`), 0);
 assert.equal(wide ? Number(view.getBigUint64(256, true)) : view.getInt32(256, true), valid);
}
assert.equal(invoke('setscope', 2), 45); assert.equal(invoke('setscope', 0), 22);
assert.equal(invoke('setscope', 1), 0); assert.equal(invoke('getscope'), 0); assert.equal(view.getInt32(256, true), 1);
assert.equal(invoke('setstacksize', Number.MAX_SAFE_INTEGER + 1), 22);
bytes.set(bytes.slice(64, 128), 128);
assert.equal(invoke('getstacksize', 256, 128), 0); assert.equal(view.getBigUint64(256, true), 8192n);
assert.equal(invoke('destroy'), 0); assert.equal(invoke('destroy'), 22);
assert.equal(invoke('getstacksize', 256, 128), 0);
assert.equal(invoke('setschedparam', 256, 128), undefined);
const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const attribute = guest.allocate(64), output = guest.allocate(8);
 const call = (name, ...args) => guest.call(guest.resolve(`_pthread_attr_${name}`, 0, 'bind'), args);
 assert.equal(call('init', attribute), 0);
 assert.equal(call('setdetachstate', attribute, 2), 0);
 assert.equal(call('getdetachstate', attribute, output), 0);
 assert.equal(new DataView(guest.read(output, 4).buffer).getInt32(0, true), 2);
 assert.equal(call('destroy', attribute), 0);
} finally { guest.close(); }
console.log('native thread attributes: Darwin defaults, validation, copied opaque state, lifecycle and x86 import dispatch passed');
