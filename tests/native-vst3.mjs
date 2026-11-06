import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parseMachO, dyldFixups } from '../js/macho-loader.js';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { readNativeVst3 } from '../js/native-vst3-input.js';
import { writeZip } from '../js/archive.js';
import { nativeFixture, nativePackage, leb } from './support/native-vst3-fixture.js';
import { loadNativeEngine } from '../js/native-vst3-engine.js';

const require = createRequire(import.meta.url), uc = await require('@alexaltea/unicorn-js/x86')();
const fixture = nativeFixture(), parsed = parseMachO(fixture);
assert.equal(parsed.symbols.get('_GetPluginFactory'), 0x200);
assert.equal(parsed.segments.length, 2);
for (const bytes of [new Uint8Array(), fixture.slice(0, 100)]) assert.throws(() => parseMachO(bytes), /Mach-O/);
const corrupt = edit => { const bytes = fixture.slice(); edit(new DataView(bytes.buffer)); return bytes; };
assert.throws(() => parseMachO(corrupt(view => view.setUint32(4, 0x0100000c, true))), /x86_64/);
assert.throws(() => parseMachO(corrupt(view => view.setUint32(36, 0, true))), /command size/);
assert.throws(() => parseMachO(corrupt(view => view.setBigUint64(32 + 72 + 24, 0n, true))), /section exceeds segment|overlapping/);
assert.throws(() => parseMachO(corrupt(view => view.setUint32(0x900, 0xffffffff, true))), /symbol name/);
const fat = new Uint8Array(0x1000 + fixture.length), fatView = new DataView(fat.buffer);
fatView.setUint32(0, 0xcafebabe); fatView.setUint32(4, 1); fatView.setUint32(8, 0x01000007); fatView.setUint32(16, 0x1000); fatView.setUint32(20, fixture.length); fat.set(fixture, 0x1000);
assert.equal(parseMachO(fat).symbols.get('_probe'), 0x300);
console.log('Mach-O: thin/universal x86_64 and malformed header checks passed.');

const use = (bytes, check) => { const guest = new NativeVst3Guest(uc, bytes); try { return check(guest); } finally { guest.close(); } };
use(fixture, guest => {
 assert.equal(guest.call(guest.export('_probe')), 42);
 assert.ok(guest.read(guest.slide + 0x1f00, 128).every(byte => byte === 0), 'BSS is zeroed');
 assert.equal(guest.pointer(guest.slide + 0x1100), guest.slide + 0x1000, 'vtable rebased');
 const factory = guest.factoryInfo();
 assert.equal(factory.vendor, 'Fixture vendor'); assert.equal(factory.url, 'fixture.invalid'); assert.equal(factory.classes[0].name, 'Native fixture');
 assert.equal(factory.classes[0].cid, '0102030405060708090a0b0c0d0e0f10');
 assert.equal(guest.report().initialized, false); assert.equal(guest.report().playable, false);
 guest.initialize(); assert.equal(guest.report().initialized, true);
 assert.throws(() => guest.call(guest.export('_probe'), [], { instructionBudget: -1 }), /limits/);
 assert.throws(() => guest.allocate(33 << 20), /allocation/);
});
use(nativeFixture({ initializer: true }), guest => { guest.initialize(); assert.equal(guest.initialized, true); });
use(nativeFixture({ bundleEntry: true }), guest => assert.throws(() => guest.initialize(), /CFBundle/));
use(nativeFixture({ importName: '_malloc' }), guest => { assert.ok(guest.call(guest.export('_probe')) >= 0x30000000); assert.equal(guest.report().calls._malloc, 1); });
use(nativeFixture({ importName: '_not_implemented' }), guest => assert.throws(() => guest.call(guest.export('_probe')), error => error.details.kind === 'unsupported-import' && error.details.name === '_not_implemented'));
use(nativeFixture({ importName: '_unknown_data', dataImport: true }), guest => assert.throws(() => guest.call(guest.export('_probe')), /Unsupported imported data/));
use(nativeFixture({ importName: '___stack_chk_guard', dataImport: true }), guest => { guest.call(guest.export('_probe')); assert.equal(guest.report().calls.___stack_chk_guard, undefined); });
use(nativeFixture({ importName: '_kCFAllocatorDefault', dataImport: true }), guest => assert.equal(guest.call(guest.export('_probe')), 0));
use(fixture, guest => {
 guest.setRegister('RDI', 0);
 const uuid = guest.invokeImport({ name: '_CFUUIDCreate' });
 const bytes = guest.uuids.get(uuid);
 assert.equal(bytes[6] >> 4, 4); assert.equal(bytes[8] >> 6, 2);
 guest.setRegister('RDI', uuid);
 const result = guest.invokeImport({ name: '_CFUUIDGetUUIDBytes' });
 assert.equal(result.rax, new DataView(bytes.buffer).getBigUint64(0, true)); assert.equal(result.rdx, new DataView(bytes.buffer).getBigUint64(8, true));
 guest.invokeImport({ name: '_CFRelease' }); assert.equal(guest.uuids.size, 0);
 assert.throws(() => guest.invokeImport({ name: '_CFRelease' }), /unsupported object/);
});
use(nativeFixture({ code: [0xeb, 0xfe] }), guest => assert.throws(() => guest.call(guest.export('_probe'), [], { instructionBudget: 100 }), /Execution limit/));
use(nativeFixture({ code: [0x0f, 0x05, 0xc3] }), guest => assert.throws(() => guest.call(guest.export('_probe')), /syscall/));
use(nativeFixture({ code: [0x48, 0x31, 0xc0, 0x48, 0x8b, 0, 0xc3] }), guest => assert.throws(() => guest.call(guest.export('_probe')), /CPU stopped/));
use(nativeFixture({ code: [0xf3, 0x0f, 0x10, 7, 0xf3, 0x0f, 0x58, 0xc0, 0xf3, 0x0f, 0x11, 7, 0xc3] }), guest => {
 const address = guest.allocate(4), bytes = new Uint8Array(4); new DataView(bytes.buffer).setFloat32(0, 0.25, true);
 guest.write(address, bytes); guest.call(guest.export('_probe'), [address]);
 assert.equal(new DataView(guest.read(address, 4).buffer).getFloat32(0, true), 0.5, 'SSE processes a float sample');
});
use(nativeFixture({ code: [0xc6, 0x05, 0xf9, 0xfe, 0xff, 0xff, 0, 0xc3] }), guest => assert.throws(() => guest.call(guest.export('_probe')), /CPU stopped/));
console.log('Native execution: real CPU instructions, VST3 virtual calls, rebasing, BSS, imports, limits and faults passed.');

const segment = { address: 0, size: 4096 }, memory = new Map(), model = { segments: [segment], dyldSegments: [segment], streams: {} };
const io = { readPointer: address => memory.get(address) || 0, writePointer: (address, value) => memory.set(address, value), resolve: () => 123 };
const symbol = [...new TextEncoder().encode('_test'), 0];
model.streams.bind = new Uint8Array([0x40, ...symbol, 0x51, 0x70, ...leb(32), 0x90, 0x80, ...leb((1n << 64n) - 24n), 0x90, 0]);
dyldFixups(model, 0, io); assert.equal(memory.get(32), 123); assert.equal(memory.get(16), 123, 'unsigned backward bind delta wraps correctly');
model.streams.bind = new Uint8Array([0x40, ...symbol, 0x70, ...leb(4096), 0x90]);
assert.throws(() => dyldFixups(model, 0, io), /fixup exceeds segment/);
model.streams.bind = new Uint8Array([0x40, ...symbol, 0x70, 0, 0xc0, ...leb(1000001), 0]);
assert.throws(() => dyldFixups(model, 0, { ...io, writePointer: () => {} }), /fixup exceeds segment|too many dyld/);
model.streams.bind = new Uint8Array([0x40, ...symbol, 0x70, 0x80]);
assert.throws(() => dyldFixups(model, 0, io), /truncated dyld/);
console.log('dyld: backward deltas, malformed streams and segment bounds passed.');

assert.deepEqual((await readNativeVst3(new Blob([fixture]), 'fixture')).bytes, fixture);
const zip = writeZip(new Map([['Test.vst3/Contents/MacOS/Test', fixture], ['Test.vst3/Contents/Resources/skip', new Uint8Array([1])]]));
assert.deepEqual((await readNativeVst3(zip)).bytes, fixture);
await assert.rejects(readNativeVst3(writeZip(new Map([['not-a-plugin', fixture]]))), /expected one/);
await assert.rejects(readNativeVst3(new Blob(['xar!'])), /truncated xar/);
for (const modern of [false, true]) {
 const result = await readNativeVst3(await nativePackage(fixture, { modern }));
 assert.deepEqual(result.bytes, fixture); assert.equal(result.source, 'Test-VST3.pkg/Payload');
}
await assert.rejects(readNativeVst3(await nativePackage(fixture, { truncated: true })), /truncated payload/);
console.log('Package input: xar and both cpio layouts, skipped sample data, truncation and ZIP checks passed.');
const originalFetch = globalThis.fetch, originalScripts = globalThis.importScripts, originalFactory = globalThis.MUnicorn;
try {
 globalThis.fetch = async () => new Response('corrupted engine');
 await assert.rejects(loadNativeEngine(), /SHA-256/);
 const requested = [], engineBytes = readFileSync(require.resolve('@alexaltea/unicorn-js/x86'));
 globalThis.fetch = async url => { requested.push(String(url)); return requested.length === 1 ? new Response('', { status: 404 }) : new Response(engineBytes); };
 globalThis.importScripts = url => { assert.match(url, /^blob:/); globalThis.MUnicorn = async () => 'verified-engine'; };
 assert.equal(await loadNativeEngine(), 'verified-engine');
 assert.match(requested[1], /unicorn-js@2\.1\.4\/dist\/unicorn_x86\.js$/);
} finally {
 globalThis.fetch = originalFetch;
 if (originalScripts === undefined) delete globalThis.importScripts; else globalThis.importScripts = originalScripts;
 if (originalFactory === undefined) delete globalThis.MUnicorn; else globalThis.MUnicorn = originalFactory;
}
console.log('Engine dependency: corrupted bytes rejected and pinned fallback verified.');
console.log('native VST3 experiment: all checks passed');
