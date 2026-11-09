import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const call = (name, ...args) => guest.call(guest.resolve(`_${name}`, 0, 'bind'), args);
 const errno = () => new DataView(guest.read(guest.errorPointer(), 4).buffer).getInt32(0, true);
 for (const mask of [-1, 0, 1, 63, 64]) for (const name of ['C', 'POSIX', 'missing-guest-locale', '', null]) {
  const locale = call('newlocale', mask, name === null ? 0 : guest.objc.cstring(name), 0);
  if (mask & 63 && name === 'missing-guest-locale') { assert.equal(locale, 0); assert.equal(errno(), 2); }
  else { assert.ok(locale); assert.ok(guest.cLocales.handles.has(locale)); assert.equal(call('freelocale', locale), 0); assert.equal(guest.allocations.has(locale), false); }
 }
 const base = call('newlocale', 63, 0, 0), changed = call('newlocale', 2, guest.objc.cstring('C'), base);
 assert.notEqual(changed, base); assert.ok(guest.cLocales.handles.has(base));
 assert.ok(call('duplocale', base)); assert.ok(call('duplocale', 0)); assert.ok(call('duplocale', -1));
 assert.equal(call('newlocale', 1, 0, 123), 0); assert.equal(errno(), 22);
 assert.ok(call('newlocale', 63, 0, 123));
 assert.equal(call('duplocale', 123), 0); assert.equal(errno(), 22);
 for (const invalid of [0, -1, 123]) { call('freelocale', invalid); assert.equal(BigInt.asIntN(32, guest.engine.reg_read_i64(uc.X86_REG_RAX)), -1n); assert.equal(errno(), 22); }
 for (const handle of guest.cLocales.handles) call('freelocale', handle);
 const top = guest.heapTop;
 for (let index = 0; index < 100; index++) call('freelocale', call('newlocale', 63, 0, 0));
 assert.equal(guest.heapTop, top);
 for (let index = 0; index < 256; index++) assert.ok(call('newlocale', 63, 0, 0));
 assert.equal(call('newlocale', 63, 0, 0), 0); assert.equal(errno(), 12);
 console.log('native C locales: Darwin category masks, C/POSIX/default names, independent base copies, duplication, errno and bounded reclamation passed');
} finally { guest.close(); }
