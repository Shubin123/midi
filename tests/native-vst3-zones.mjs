import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture, nativeZoneFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const call = (name, ...args) => guest.call(guest.resolve(`_${name}`, 0, 'bind'), args);
 const zone = call('malloc_create_zone', 4096, 0), other = call('malloc_create_zone', 0, 0);
 const virtual = (offset, ...args) => guest.call(guest.pointer(zone + offset), [zone, ...args]);
 const errno = () => new DataView(guest.read(guest.errorPointer(), 4).buffer).getInt32(0, true);
 assert.equal(new DataView(guest.read(zone + 104, 4).buffer).getUint32(0, true), 6);
 assert.equal(guest.pointer(zone + 80), 0); assert.equal(guest.pointer(zone + 88), 0); assert.equal(guest.pointer(zone + 96), 0);
 const pointer = virtual(24, 17); guest.write(pointer, new Uint8Array(32).fill(0xa5));
 assert.equal(virtual(16, pointer), 32); assert.equal(call('malloc_size', pointer), 32);
 assert.equal(call('malloc_zone_from_ptr', pointer), zone);
 assert.equal(guest.call(guest.pointer(other + 16), [other, pointer]), 0);
 assert.throws(() => call('malloc_zone_free', other, pointer), /does not belong/);
 const grown = virtual(56, pointer, 64); assert.deepEqual([...guest.read(grown, 32)], Array(32).fill(0xa5));
 assert.equal(call('malloc_zone_from_ptr', pointer), 0); assert.equal(call('malloc_zone_from_ptr', grown), zone);
 assert.equal(virtual(56, grown, 1), grown);
 const globalResize = call('realloc', grown, 128); assert.equal(call('malloc_zone_from_ptr', globalResize), zone);
 call('free', globalResize); assert.equal(guest.zones.owners.has(globalResize), false);
 const cleared = virtual(32, 2, 16); assert.ok(guest.read(cleared, 32).every(byte => byte === 0));
 virtual(48, cleared); const page = virtual(40, 128);
 assert.equal(page % 4096, 0); assert.ok(guest.read(page, 128).every(byte => byte === 0));
 const aligned = virtual(112, 64, 65); assert.equal(aligned % 64, 0);
 assert.equal(virtual(112, 24, 8), 0); assert.equal(errno(), 22);
 assert.equal(virtual(24, 33 << 20), 0); assert.equal(errno(), 12);
 assert.equal(virtual(32, 1 << 30, 1 << 30), 0); assert.equal(errno(), 12);
 assert.equal(virtual(56, aligned, 33 << 20), 0); assert.equal(call('malloc_zone_from_ptr', aligned), zone);
 assert.throws(() => virtual(120, aligned, 65), /definite size/);
 virtual(120, aligned, 80); assert.equal(call('malloc_size', aligned), 0);
 const name = guest.objc.cstring('Guest custom zone'); call('malloc_set_zone_name', zone, name);
 const storedName = call('malloc_get_zone_name', zone); assert.notEqual(storedName, name);
 assert.equal(guest.string(storedName), 'Guest custom zone'); assert.equal(guest.pointer(zone + 72), storedName);
 const original = call('malloc', 7), defaultZone = call('malloc_default_zone');
 assert.equal(call('malloc_default_zone'), defaultZone); assert.equal(call('malloc_zone_from_ptr', original), defaultZone);
 assert.equal(guest.call(guest.pointer(defaultZone + 16), [defaultZone, original]), 16);
 assert.throws(() => call('malloc_destroy_zone', defaultZone), /default malloc zone/);
 const highWater = guest.heapTop;
 for (let index = 0; index < 100; index++) { const block = virtual(24, 1024); virtual(48, block); }
 assert.ok(guest.heapTop <= highWater + 1024);
 const owned = [...guest.zones.record(zone).members]; virtual(64);
 for (const block of [...owned, storedName, zone]) assert.equal(guest.allocations.has(block), false);
 assert.equal(guest.zones.zones.has(zone), false); assert.equal(guest.zones.owners.size, 0);
 assert.throws(() => guest.zones.record(zone), /Unknown malloc zone/);
 call('malloc_destroy_zone', other); call('free', original);
 assert.equal(call('malloc_good_size', 17), 32);
 assert.equal(call('malloc_good_size', 0), 16); assert.equal(call('malloc_good_size', 0xffffffffffffffffn), 0);
 guest.call(guest.resolve('_malloc_good_size', 0, 'bind'), [0x123456789abcdef0n]);
 assert.equal(BigInt.asUintN(64, guest.engine.reg_read_i64(uc.X86_REG_RAX)), 0x123456789abcdef0n);
 assert.throws(() => call('malloc_create_zone', 0, 1), /debug flags/);
 for (let index = guest.zones.zones.size; index < 64; index++) call('malloc_create_zone', 0, 0);
 assert.equal(call('malloc_create_zone', 0, 0), 0); assert.equal(errno(), 12);
 assert.equal(guest.report().playable, false);
 console.log('native malloc zones: x86 ABI callbacks, ownership, reclaim, alignment, sizes, calloc, realloc, errno and bounded lifecycle passed');
} finally { guest.close(); }
const initialized = new NativeVst3Guest(uc, nativeZoneFixture());
try {
 initialized.initialize(); assert.equal(initialized.factoryInfo().classes[0].cid, '20000000000000000100000000000000');
 assert.equal(initialized.zones.zones.size, 1); assert.equal(initialized.calls.get('__midi_zone_size'), 1);
} finally { initialized.close(); }
