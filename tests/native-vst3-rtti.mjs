import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture, nativeRTTIFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const kinds = new Map([['class', '__ZTVN10__cxxabiv117__class_type_infoE'], ['single', '__ZTVN10__cxxabiv120__si_class_type_infoE'], ['multiple', '__ZTVN10__cxxabiv121__vmi_class_type_infoE']].map(([kind, name]) => [kind, guest.resolve(name, 0, 'bind') + 16]));
 const signed = (address, value) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true); guest.write(address, bytes); };
 const makeType = (name, bases = [], kind = bases.length ? 'multiple' : 'class') => {
  const address = guest.allocate(kind === 'multiple' ? 24 + bases.length * 16 : kind === 'single' ? 24 : 16);
  guest.write(address, new Uint8Array(kind === 'multiple' ? 24 + bases.length * 16 : kind === 'single' ? 24 : 16));
  guest.writePointer(address, kinds.get(kind)); guest.writePointer(address + 8, guest.objc.cstring(name));
  if (kind === 'single') guest.writePointer(address + 16, bases[0].type);
  if (kind === 'multiple') {
   const count = new Uint8Array(4); new DataView(count.buffer).setUint32(0, bases.length, true); guest.write(address + 20, count);
   bases.forEach((base, index) => { guest.writePointer(address + 24 + index * 16, base.type); signed(address + 32 + index * 16, (base.offset ?? 0) * 256 + (base.public === false ? 0 : 2) + (base.virtual ? 1 : 0)); });
  }
  return address;
 };
 const object = (type, parts = [{ offset: 0 }]) => {
  const address = guest.allocate(128); guest.write(address, new Uint8Array(128));
  for (const { offset, virtualOffset = 0 } of parts) {
   const table = guest.allocate(32); guest.write(table, new Uint8Array(32)); signed(table, virtualOffset); signed(table + 8, -offset);
   guest.writePointer(table + 16, type); guest.writePointer(address + offset, table + 24);
  }
  return address;
 };
 const call = guest.resolve('___dynamic_cast', 0, 'bind');
 const cast = (pointer, source, destination, hint = -1) => guest.call(call, [pointer, source, destination, hint]);
 const base = makeType('Base'), unrelated = makeType('Unrelated');
 const derived = makeType('Derived', [{ type: base }], 'single'), instance = object(derived);
 assert.equal(cast(instance, base, derived, 0), instance); assert.equal(cast(instance, base, unrelated), 0);
 assert.equal(cast(0, 0, 0), 0);
 const duplicateType = makeType('Base'); assert.equal(cast(instance, duplicateType, derived), instance);
 const left = makeType('Left', [{ type: base }], 'single'), right = makeType('Right');
 const multiple = makeType('Multiple', [{ type: left }, { type: right, offset: 16 }]);
 const joined = object(multiple, [{ offset: 0 }, { offset: 16 }]);
 assert.equal(cast(joined + 16, right, left, -2), joined);
 assert.equal(cast(joined, base, right, -2), joined + 16);
 assert.equal(cast(joined + 16, right, multiple, 16), joined);
 const privateType = makeType('Private', [{ type: left, public: false }, { type: right, offset: 16 }]);
 const hidden = object(privateType, [{ offset: 0 }, { offset: 16 }]);
 assert.equal(cast(hidden, base, privateType), 0); assert.equal(cast(hidden, base, right), 0);
 assert.equal(cast(hidden, base, left), hidden);
 const repeatRight = makeType('RepeatRight', [{ type: base }], 'single');
 const repeated = makeType('Repeated', [{ type: left }, { type: repeatRight, offset: 16 }]);
 const repeatedObject = object(repeated, [{ offset: 0 }, { offset: 16 }]);
 assert.equal(cast(repeatedObject + 16, base, repeated, -3), repeatedObject);
 assert.equal(cast(repeatedObject, base, repeatRight), repeatedObject + 16);
 const virtualLeft = makeType('VirtualLeft', [{ type: base, virtual: true, offset: -24 }]);
 const virtualRight = makeType('VirtualRight', [{ type: base, virtual: true, offset: -24 }]);
 const diamond = makeType('Diamond', [{ type: virtualLeft }, { type: virtualRight, offset: 16 }]);
 const diamondObject = object(diamond, [{ offset: 0, virtualOffset: 32 }, { offset: 16, virtualOffset: 16 }, { offset: 32 }]);
 assert.equal(cast(diamondObject + 32, base, diamond), diamondObject);
 assert.equal(cast(diamondObject + 32, base, virtualLeft), diamondObject);
 assert.equal(cast(diamondObject + 16, virtualRight, virtualLeft), diamondObject);
 const privateVirtual = makeType('PrivateVirtual', [{ type: base, virtual: true, offset: -24, public: false }]);
 const mixed = makeType('Mixed', [{ type: privateVirtual }, { type: virtualRight, offset: 16 }]);
 const mixedObject = object(mixed, [{ offset: 0, virtualOffset: 32 }, { offset: 16, virtualOffset: 16 }, { offset: 32 }]);
 assert.equal(cast(mixedObject + 32, base, mixed), mixedObject);
 const wrapperLeft = makeType('WrapperLeft', [{ type: virtualLeft }], 'single'), wrapperRight = makeType('WrapperRight', [{ type: virtualLeft }], 'single');
 const ambiguous = makeType('Ambiguous', [{ type: wrapperLeft }, { type: wrapperRight, offset: 16 }]);
 const ambiguousObject = object(ambiguous, [{ offset: 0, virtualOffset: 32 }, { offset: 16, virtualOffset: 16 }, { offset: 32 }]);
 assert.equal(cast(ambiguousObject + 32, base, virtualLeft), 0);
 assert.equal(cast(ambiguousObject, virtualLeft, wrapperLeft), ambiguousObject);
 const cyclic = makeType('Cyclic', [{ type: base }], 'single'); guest.writePointer(cyclic + 16, cyclic);
 assert.throws(() => cast(object(cyclic), base, cyclic), /Cyclic RTTI/);
 const malformed = makeType('Malformed'); guest.writePointer(malformed, guest.allocate(8));
 assert.throws(() => cast(object(malformed), base, malformed), /Unsupported RTTI/);
 let deep = base; for (let index = 0; index < 66; index++) deep = makeType(`Depth${index}`, [{ type: deep }], 'single');
 assert.throws(() => cast(object(deep), base, deep), /depth exceeds/);
 const oversized = makeType('Oversized', [{ type: base }]); guest.write(oversized + 20, new Uint8Array([129, 0, 0, 0]));
 assert.throws(() => cast(object(oversized), base, oversized), /oversized RTTI/);
 assert.equal(guest.report().playable, false);
 console.log('native RTTI: real x86 dynamic-cast import, single/multiple/virtual inheritance, secondary vtables, ambiguity, public paths, type identity and bounded malformed graphs passed');
} finally { guest.close(); }
const initialized = new NativeVst3Guest(uc, nativeRTTIFixture());
try {
 initialized.initialize(); assert.equal(initialized.factoryInfo().classes[0].cid, '01000000000000000000000000000000');
 assert.equal(initialized.calls.get('___dynamic_cast'), 1);
} finally { initialized.close(); }
