import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
const call = (name, args = []) => guest.call(guest.resolve(name, 0, 'bind'), args);
try {
 const thread = call('_pthread_self'); assert.ok(thread); assert.equal(call('_pthread_self'), thread);
 assert.equal(call('_pthread_equal', [thread, thread]), 1); assert.throws(() => call('_pthread_equal', [thread, 0]), /identity/);
 const output = guest.allocate(16), destructor = guest.export('_GetPluginFactory');
 assert.equal(call('_pthread_key_create', [output, destructor]), 0);
 const key = guest.pointer(output); assert.equal(guest.threadStorage.keys.get(key).destructor, destructor);
 assert.equal(call('_pthread_getspecific', [key]), 0);
 assert.equal(call('_pthread_setspecific', [key, 0xfedcba9876543210n]), 0);
 assert.equal(call('_pthread_getspecific', [key]), Number(0xfedcba9876543210n));
 assert.equal(call('_pthread_key_create', [output + 8, 0]), 0);
 const other = guest.pointer(output + 8); assert.notEqual(key, other); assert.equal(call('_pthread_getspecific', [other]), 0);
 assert.equal(call('_pthread_key_delete', [key]), 0); assert.equal(call('_pthread_key_delete', [key]), 22);
 assert.equal(call('_pthread_getspecific', [key]), 0); assert.equal(call('_pthread_setspecific', [key, 123]), 22);
 assert.equal(call('_pthread_key_create', [output, 0]), 0); assert.equal(guest.pointer(output), key);
 assert.equal(call('_pthread_getspecific', [key]), 0);
 assert.throws(() => call('_pthread_key_create', [output, output]), /destructor/);
 for (let index = guest.threadStorage.keys.size; index < 512; index++) assert.equal(call('_pthread_key_create', [output, 0]), 0);
 guest.writePointer(output, 0x12345678); assert.equal(call('_pthread_key_create', [output, 0]), 35); assert.equal(guest.pointer(output), 0x12345678);
 assert.equal(guest.threadStorage.keys.size, 512);
 console.log('native TLS: single-thread values, full-width pointers, destructor registration, key reuse, invalid keys and exhaustion passed');
} finally { guest.close(); }
