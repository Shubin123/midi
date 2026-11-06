import assert from 'node:assert/strict';
import { GuestMutexes } from '../js/native-vst3-mutex.js';

const bytes = new Uint8Array(512), view = new DataView(bytes.buffer);
const memory = {
 pointer: address => Number(view.getBigUint64(address, true)),
 writePointer: (address, value) => view.setBigUint64(address, BigInt(value), true),
 write: (address, source) => bytes.set(source, address),
};
const mutexes = new GuestMutexes(memory), attribute = 16, mutex = 64;
const invoke = (name, address = mutex, argument = 0) => mutexes.invoke(`_pthread_mutex${name}`, address, argument);
assert.equal(invoke('attr_settype', attribute, 2), 22);
assert.equal(invoke('attr_init', attribute), 0);
assert.equal(invoke('attr_settype', attribute, 9), 22);
assert.equal(invoke('attr_settype', attribute, 2), 0);
assert.equal(invoke('attr_setprotocol', attribute, 1), 0);
assert.equal(invoke('attr_getprotocol', attribute, 260), 0); assert.equal(view.getUint32(260, true), 1);
assert.equal(invoke('attr_setprotocol', attribute, 9), 22);
assert.throws(() => invoke('attr_setprotocol', attribute, 2), /priority scheduler/);
assert.equal(invoke('attr_gettype', attribute, 256), 0); assert.equal(view.getUint32(256, true), 2);
assert.equal(invoke('_init', mutex, attribute), 0);
assert.equal(invoke('attr_destroy', attribute), 0);
assert.equal(invoke('attr_destroy', attribute), 22);
assert.equal(invoke('_init', 128, attribute), 22);
assert.equal(invoke('_lock'), 0); assert.equal(invoke('_trylock'), 0);
assert.equal(invoke('_destroy'), 16);
assert.equal(invoke('_unlock'), 0); assert.equal(invoke('_destroy'), 16);
assert.equal(invoke('_unlock'), 0); assert.equal(invoke('_unlock'), 1);
assert.equal(invoke('_destroy'), 0); assert.equal(invoke('_lock'), 22);
for (const [signature, recursive] of [[0x32aaaba7, false], [0x32aaaba1, false], [0x32aaaba2, true]]) {
 memory.writePointer(mutex, signature);
 assert.equal(invoke('_lock'), 0);
 if (recursive) { assert.equal(invoke('_trylock'), 0); assert.equal(invoke('_unlock'), 0); }
 else {
  assert.equal(invoke('_trylock'), 16);
  if (signature === 0x32aaaba1) assert.equal(invoke('_lock'), 11);
  else assert.throws(() => invoke('_lock'), /would deadlock/);
 }
 assert.equal(invoke('_unlock'), 0); assert.equal(invoke('_destroy'), 0);
}
assert.equal(invoke('_init'), 0); assert.equal(invoke('_init'), 16);
assert.equal(invoke('_destroy'), 0);
assert.equal(invoke('_not_implemented'), undefined);
memory.writePointer(mutex, 0x32aaaba2); assert.equal(invoke('_lock'), 0);
mutexes.mutexes.get(mutex).depth = 65535;
assert.equal(invoke('_lock'), 35);
console.log('native mutex: recursive depth, trylock, destruction, static signatures, invalid attributes and deadlocks passed');
