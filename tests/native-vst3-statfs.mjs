import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { GuestFileError, GuestFiles } from '../js/native-vst3-files.js';
import { nativeFixture, nativeStatfsFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
for (const existing of ['/plugin/regular/executable', '/plugin/regular/executable/child', '/plugin/regular']) {
 const files = new GuestFiles(new Map([[existing, new Uint8Array([1])]]));
 assert.throws(() => files.mountImage('/plugin/regular/executable', new Uint8Array([2])), /conflict|traverses/);
}
const home = new GuestFiles(); home.mountImage('/Users/plugin/Owned.vst3/Contents/MacOS/Owned', new Uint8Array([1]));
assert.throws(() => home.remove('/Users/plugin/Owned.vst3'), error => error.errno === 30);
const source = nativeFixture(), size = source.length;
const guest = new NativeVst3Guest(uc, source, { bundlePath: '/plugin/Owned é.vst3', executableName: 'Actual binary' });
try {
 const output = guest.allocate(2200), path = guest.objc.cstring(guest.bundles.executablePath);
 const call = (name, ...args) => { guest.call(guest.resolve(name, 0, 'bind'), args); return Number(BigInt.asIntN(64, guest.engine.reg_read_i64(uc.X86_REG_RAX))); };
 const errno = () => new DataView(guest.read(guest.errorPointer(), 4).buffer).getInt32(0, true);
 source[0] = 0;
 const descriptor = call('_open', path, 0);
 assert.equal(call('_read', descriptor, output, 4), 4); assert.equal(new DataView(guest.read(output, 4).buffer).getUint32(0, true), 0xfeedfacf);
 assert.equal(guest.files.resourceBytes, 0); assert.equal(guest.files.imageBytes, size);
 for (const name of ['_statfs$INODE64', '_statfs64']) {
  guest.write(output, new Uint8Array(2200).fill(0xa5)); assert.equal(call(name, path, output), 0);
  const bytes = guest.read(output, 2200), view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 4096); assert.equal(view.getInt32(4, true), 4096);
  assert.equal(view.getBigUint64(8, true), BigInt(Math.ceil(((64 << 20) + size) / 4096)));
  assert.equal(view.getBigUint64(16, true), 16384n); assert.equal(view.getBigUint64(24, true), 16384n);
  assert.equal(view.getBigUint64(32, true) - view.getBigUint64(40, true), 9n);
  assert.equal(view.getInt32(48, true), 1); assert.equal(view.getInt32(52, true), 0); assert.equal(view.getUint32(56, true), 501); assert.equal(view.getUint32(60, true), 0);
  assert.equal(view.getUint32(64, true), 0x1000); assert.equal(view.getUint32(68, true), 0);
  assert.equal(guest.string(output + 72), 'guest-vfs'); assert.equal(guest.string(output + 88), '/'); assert.equal(guest.string(output + 1112), 'guest-memory');
  assert.ok(bytes.slice(2136, 2168).every(byte => byte === 0)); assert.ok(bytes.slice(2168).every(byte => byte === 0xa5));
  for (const alias of ['_fstatfs$INODE64', '_fstatfs64']) {
   const other = guest.allocate(2168); assert.equal(call(alias, descriptor, other), 0); assert.deepEqual(guest.read(other, 2168), bytes.slice(0, 2168)); guest.allocations.delete(other);
  }
 }
 assert.equal(call('_open', path, 1), -1); assert.equal(errno(), 30);
 assert.throws(() => guest.files.remove(guest.bundles.path), error => error instanceof GuestFileError && error.errno === 30);
 const scratch = guest.files.open('/tmp/data', 0x202, 0o600); guest.files.write(scratch, new Uint8Array(4097));
 const before = new DataView(guest.files.statfs('/tmp/data').buffer); assert.equal(before.getBigUint64(16, true), 16382n);
 const duplicate = guest.files.duplicate(scratch); guest.files.remove('/tmp/data');
 assert.equal(new DataView(guest.files.fstatfs(duplicate).buffer).getBigUint64(16, true), 16382n);
 guest.files.close(scratch); guest.files.close(duplicate); assert.equal(new DataView(guest.files.statfs('/').buffer).getBigUint64(16, true), 16384n);
 for (const [name, input, expected] of [['_statfs$INODE64', guest.objc.cstring('/missing'), 2], ['_statfs$INODE64', guest.objc.cstring(`${guest.bundles.executablePath}/child`), 20], ['_statfs$INODE64', 1, 14], ['_fstatfs$INODE64', 999, 9], ['_fstatfs$INODE64', 1, 45]]) {
  guest.write(output, new Uint8Array(2200).fill(0x7b)); assert.equal(call(name, input, output), -1); assert.equal(errno(), expected); assert.ok(guest.read(output, 2200).every(byte => byte === 0x7b));
 }
 assert.equal(call('_statfs$INODE64', path, 1), -1); assert.equal(errno(), 14); call('_close', descriptor);
 assert.throws(() => call('_statfs', path, output), error => error.details.kind === 'unsupported-import');
 const allocations = guest.allocations.size, objects = guest.core.objects.size;
 for (let index = 0; index < 100; index++) assert.equal(call('_DASessionCreate', 0), 0);
 assert.equal(guest.allocations.size, allocations); assert.equal(guest.core.objects.size, objects);
 assert.equal(guest.report().services.diskArbitration, 'unavailable');
 assert.throws(() => call('_DASessionCreate', output), error => error.details.kind === 'unsupported-disk-arbitration');
 console.log('native statfs: Darwin64 layout, real executable snapshot, read-only ownership, virtual quota accounting, unlinked descriptors, aliases, canaries and errno passed');
} finally { guest.close(); }
const fixture = new NativeVst3Guest(uc, nativeStatfsFixture());
try { fixture.initialize(); assert.equal(fixture.factoryInfo().classes[0].cid, '01000000000000000000000000000000'); } finally { fixture.close(); }
