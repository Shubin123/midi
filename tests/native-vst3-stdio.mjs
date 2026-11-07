import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')(), guest = new NativeVst3Guest(uc, nativeFixture());
const call = (name, args = []) => guest.call(guest.resolve(name, 0, 'bind'), args);
const text = value => { const bytes = new TextEncoder().encode(`${value}\0`), address = guest.allocate(bytes.length); guest.write(address, bytes); return address; };
try {
 const stdout = guest.pointer(guest.resolve('___stdoutp', 0, 'bind')), stderr = guest.pointer(guest.resolve('___stderrp', 0, 'bind')), stdin = guest.pointer(guest.resolve('___stdinp', 0, 'bind'));
 assert.equal(call('_fileno', [stderr]), 2); assert.equal(call('_fileno', [stdout]), 1);
 assert.equal(call('_fprintf', [stderr, text('hello %d %s\n'), 7, text('world')]), 14);
 assert.equal(guest.files.report().stderr, 'hello 7 world\n');
 assert.equal(call('_printf', [text('%d%d%d%d%d%d%d%d'), 1, 2, 3, 4, 5, 6, 7, 8]), 8);
 assert.equal(guest.files.report().stdout, '12345678');
 const vaList = guest.allocate(24), save = guest.allocate(48), overflow = guest.allocate(16), header = new Uint8Array(24);
 new DataView(header.buffer).setUint32(0, 40, true); guest.write(vaList, header); guest.writePointer(vaList + 8, overflow); guest.writePointer(vaList + 16, save);
 guest.writePointer(save + 40, 7); guest.writePointer(overflow, 8); guest.writePointer(overflow + 8, 9);
 assert.equal(call('_vfprintf', [stderr, text('%d%d%d'), vaList]), 3); assert.equal(guest.files.report().stderr, 'hello 7 world\n789');
 assert.equal(guest.pointer(vaList + 8), overflow + 16);
 assert.equal(call('_fwrite', [text('abcdef'), 2, 3, stdout]), 3);
 assert.equal(call('_fread', [0, 0, 123, stdin]), 0); assert.equal(call('_fread', [save, 1, 3, stdin]), 0);
 assert.equal(call('_feof', [stdin]), 1); call('_clearerr', [stdin]); assert.equal(call('_feof', [stdin]), 0);
 assert.equal(call('_fputs', [text('line'), stderr]), 0); assert.equal(call('_puts', [text('end')]), 0);
 assert.equal(call('_fputc', [65, stdout]), 65); assert.equal(call('_fflush', [0]), 0);
 const writer = guest.pointer(stdout + 80); assert.equal(guest.call(writer, [stdout, text('cb'), 2]), 2);
 assert.equal(call('_fread', [save, 1, 1, stdout]), 0); assert.equal(call('_ferror', [stdout]), 1);
 call('_clearerr', [stdout]); assert.equal(call('_ferror', [stdout]), 0);
 const large = guest.allocate(100000); guest.write(large, new Uint8Array(100000).fill(65));
 assert.ok(call('_fwrite', [large, 1, 100000, stdout]) < 100000); assert.equal(call('_ferror', [stdout]), 1); assert.equal(guest.files.stdout.data.length, 65536);
 assert.throws(() => call('_vfprintf', [stderr, text('%d'), 0]), /Null va_list/);
 assert.throws(() => call('_fprintf', [stderr, text('%f')]), /floating|format|conversion/i);
 assert.equal(call('_fclose', [stdin]), 0); assert.equal(call('_fileno', [stdin]), Number(0xffffffffffffffffn));
 assert.throws(() => guest.call(writer, Array(65).fill(0)), /arguments/);
 console.log('native stdio: Darwin FILE globals/callbacks, bounded real output, register/stack/va_list formatting, EOF, errors and close passed');
} finally { guest.close(); }
