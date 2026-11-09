import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const output = guest.allocate(64), length = guest.allocate(8), address = guest.resolve('_sysctlbyname', 0, 'bind');
 const call = (name, destination = output, capacity = 64, input = 0, inputLength = 0) => {
  guest.writePointer(length, capacity); guest.call(address, [guest.objc.cstring(name), destination, length, input, inputLength]);
  return Number(BigInt.asIntN(32, guest.engine.reg_read_i64(uc.X86_REG_RAX)));
 };
 const errno = () => new DataView(guest.read(guest.errorPointer(), 4).buffer).getInt32(0, true);
 const getpid = guest.resolve('_getpid', 0, 'bind'); assert.equal(guest.call(getpid), 1); assert.equal(guest.call(getpid), 1);
 assert.equal(call('hw.ncpu'), 0); assert.equal(guest.pointer(length), 4); assert.equal(new DataView(guest.read(output, 4).buffer).getInt32(0, true), 1);
 assert.equal(call('hw.pagesize'), 0); assert.equal(new DataView(guest.read(output, 4).buffer).getInt32(0, true), 4096);
 assert.equal(call('hw.machine', 0, 0), 0); assert.equal(guest.pointer(length), 7);
 assert.equal(call('hw.machine'), 0); assert.equal(guest.string(output), 'x86_64');
 assert.equal(call('hw.memsize'), 0); assert.equal(guest.pointer(output), (34 << 20) + 0x2000); assert.equal(guest.pointer(length), 8);
 assert.equal(call('hw.memsize', output, 4), 0); assert.equal(guest.pointer(length), 4);
 guest.write(output, new Uint8Array(64).fill(0xa5));
 assert.equal(call('hw.ncpu', output, 3), -1); assert.equal(errno(), 12); assert.equal(guest.pointer(length), 0);
 assert.ok(guest.read(output, 64).every(byte => byte === 0xa5));
 assert.equal(call('hw.ncpu', output, 64, output, 4), -1); assert.equal(errno(), 1);
 assert.equal(call('not.a.node'), -1); assert.equal(errno(), 2);
 assert.equal(call('hw.ncpu', 1), -1); assert.equal(errno(), 14);
 const original = guest.system.nodes.get('hw.memsize'), huge = new Uint8Array(8); new DataView(huge.buffer).setBigUint64(0, 1n << 32n, true); guest.system.nodes.set('hw.memsize', huge);
 assert.equal(call('hw.memsize', output, 4), -1); assert.equal(errno(), 34); assert.equal(guest.pointer(length), 4); guest.system.nodes.set('hw.memsize', original);
 assert.equal(guest.report().playable, false);
 console.log('native system: actual single-CPU emulator profile, mapped memory budget, Darwin sysctl widths/size queries, short buffers, read-only nodes and errno passed');
} finally { guest.close(); }
for (const heapSize of [0, 1, 1 << 19, (1 << 20) + 1, 513 << 20, NaN]) assert.throws(() => new NativeVst3Guest(uc, nativeFixture(), { heapSize }), /heap size/);
const expanded = new NativeVst3Guest(uc, nativeFixture(), { heapSize: 64 << 20 });
try {
 assert.equal(new DataView(expanded.system.nodes.get('hw.memsize').buffer).getBigUint64(0, true), BigInt((66 << 20) + 0x2000));
 const block = expanded.allocate(33 << 20); assert.equal(expanded.allocations.capacity(block), 33 << 20);
 expanded.call(expanded.resolve('_memset', 0, 'bind'), [block, 0x5a, 33 << 20]);
 assert.equal(expanded.read(block, 1)[0], 0x5a); assert.equal(expanded.read(block + (33 << 20) - 1, 1)[0], 0x5a);
 assert.throws(() => expanded.allocate(65 << 20), error => error.details.kind === 'heap-allocation' && error.details.heap.limitBytes === (64 << 20));
 expanded.call(expanded.resolve('_free', 0, 'bind'), [block]); assert.ok(expanded.report().heap.freeBytes > (63 << 20));
} finally { expanded.close(); }
const library = new NativeVst3Guest(uc, nativeFixture());
try {
 const call = (name, ...args) => library.call(library.resolve(name, 0, 'bind'), args);
 const output = library.allocate(8); library.writePointer(output, 0x1234);
 assert.equal(call('_getifaddrs', output), 0); assert.equal(library.pointer(output), 0, 'the guest has no network interfaces');
 assert.equal(call('_freeifaddrs', 0), 0);
 assert.equal(call('__ZNSt3__16thread20hardware_concurrencyEv'), 1);
 for (const [seed, values] of [[0, [520932930, 28925691, 822784415, 890459872]], [1, [16807, 282475249, 1622650073, 984943658]], [42, [705894, 1126542223, 1579310009, 565444343]], [4000000000, [1024430665, 1229788656, 1675322664, 1489918031]]]) {
  call('_srand', seed); for (const value of values) assert.equal(call('_rand'), value, `Darwin rand for seed ${seed}`);
 }
 assert.equal(call('_getenv', library.objc.cstring('HOME')), 0, 'no host environment is exposed');
 assert.equal(call('_geteuid'), 501); assert.equal(call('_getuid'), 501);
 const random = library.allocate(64); library.write(random, new Uint8Array(64)); call('_arc4random_buf', random, 64);
 assert.ok(library.read(random, 64).some(byte => byte !== 0), 'arc4random_buf writes real entropy');
 const real = library.allocate(1024);
 assert.equal(call('_realpath$DARWIN_EXTSN', library.objc.cstring('/plugin/../plugin'), real), real); assert.equal(library.string(real), '/plugin');
 assert.equal(call('_realpath$DARWIN_EXTSN', library.objc.cstring('/no/such/place'), real), 0);
 assert.equal(new DataView(library.read(library.errorPointer(), 4).buffer).getInt32(0, true), 2);
 console.log('native libc: empty interface list, one-CPU hardware_concurrency and Darwin srand/rand sequences passed');
} finally { library.close(); }
const unseeded = new NativeVst3Guest(uc, nativeFixture());
try { assert.equal(unseeded.call(unseeded.resolve('_rand', 0, 'bind')), 16807, 'unseeded rand behaves as seed 1'); } finally { unseeded.close(); }
