import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const call = (name, ...args) => guest.call(guest.resolve(`_${name}`, 0, 'bind'), args), text = value => guest.objc.cstring(value);
 const root = call('objc_getClass', text('NSObject')), parent = call('objc_allocateClassPair', root, text('PointerParent'), 0);
 assert.equal(call('class_addIvar', parent, text('byte'), 1, 0, text('c')), 1);
 assert.equal(call('class_addIvar', parent, text('pointer'), 8, 3, text('^v')), 1); call('objc_registerClassPair', parent);
 const child = call('objc_allocateClassPair', parent, text('PointerChild'), 0); call('objc_registerClassPair', child);
 const object = call('class_createInstance', child, 16), variable = call('class_getInstanceVariable', parent, text('pointer')), offset = call('ivar_getOffset', variable), output = guest.allocate(16);
 guest.write(object + 8, new Uint8Array(32).fill(0x5a));
 for (const value of [0n, 0xfedcba9876543210n, 0xffffffffffffffffn]) {
  assert.equal(call('object_setInstanceVariable', object, text('pointer'), value), variable);
  guest.write(output, new Uint8Array(16).fill(0xa5)); assert.equal(call('object_getInstanceVariable', object, text('pointer'), output), variable);
  assert.equal(new DataView(guest.read(output, 8).buffer).getBigUint64(0, true), value); assert.ok(guest.read(output + 8, 8).every(byte => byte === 0xa5));
  assert.equal(new DataView(guest.read(object + offset, 8).buffer).getBigUint64(0, true), value); assert.equal(call('object_getInstanceVariable', object, text('pointer'), 0), variable);
 }
 assert.ok(guest.read(object + 8, 8).every(byte => byte === 0x5a)); assert.ok(guest.read(object + offset + 8, 16).every(byte => byte === 0x5a));
 for (const receiver of [0, object]) {
  const name = text(receiver ? 'missing' : 'pointer'); guest.write(output, new Uint8Array(16).fill(0xa5));
  assert.equal(call('object_getInstanceVariable', receiver, name, output), 0); assert.ok(guest.read(output, 8).every(byte => byte === 0)); assert.ok(guest.read(output + 8, 8).every(byte => byte === 0xa5));
  assert.equal(call('object_setInstanceVariable', receiver, name, 0), 0);
 }
 assert.throws(() => call('object_setInstanceVariable', object, text('byte'), 1), /pointer-sized/); assert.equal(guest.read(object + 8, 1)[0], 0x5a);
 assert.throws(() => call('object_getInstanceVariable', 1, text('pointer'), output), /Unknown Objective-C instance/);
 call('object_dispose', object); call('objc_disposeClassPair', child); call('objc_disposeClassPair', parent);
 console.log('native ivars: inherited named pointer access, exact 64-bit payloads, nil/missing output semantics, untouched canaries, narrow-ivar rejection and class cleanup passed');
} finally { guest.close(); }
