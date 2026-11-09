import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { NativeVst3Processor, renderNativeNote } from '../js/native-vst3-audio.js';
import { nativeAudioFixture } from './support/native-audio-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeAudioFixture()), processor = new NativeVst3Processor(guest);
try {
 assert.throws(() => processor.open({ sampleRate: 0 }), /configuration/);
 const info = processor.open({ sampleRate: 48000, maxBlock: 32 });
 assert.deepEqual(info, { name: 'Native fixture', sampleRate: 48000, maxBlock: 32, inputs: [2], outputs: [2], eventInputs: 1 });
 assert.equal(new TextDecoder('utf-16le').decode(guest.read(guest.slide + 0x1b00, 24)), 'MIDI Browser');
 const setup = new DataView(guest.read(guest.slide + 0x1c10, 24).buffer); assert.equal(setup.getInt32(0, true), 2); assert.equal(setup.getInt32(8, true), 32); assert.equal(setup.getFloat64(16, true), 48000);
 const left = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.25, -0.25, 0]), right = Float32Array.from(left, value => -value);
 const initialHeap = guest.heapTop;
 const block = processor.process(8, { inputs: [[left, right]], events: [{ type: 'on', pitch: 60, velocity: 0.5 }] });
 assert.deepEqual(block[0][0], Float32Array.from(left, value => value * 0.5)); assert.deepEqual(block[0][1], Float32Array.from(right, value => value * 0.5));
 assert.equal(guest.report().calls.__midi_vst3_eventCount, 1); assert.equal(guest.report().calls.__midi_vst3_event, 1);
 const off = processor.process(8, { inputs: [[left, right]], events: [{ type: 'off', pitch: 60 }] }); assert.ok(off[0].every(channel => channel.every(value => value === 0)));
 for (let index = 0; index < 100; index++) processor.process(8);
 assert.equal(guest.heapTop, initialHeap); assert.equal(processor.blocksProcessed, 102); assert.equal(processor.framesProcessed, 816);
 assert.throws(() => processor.process(33), /block/); assert.throws(() => processor.process(8, { events: [{ type: 'on', pitch: 128 }] }), /note/);
 assert.throws(() => processor.process(8, { inputs: [[new Float32Array(8).fill(NaN), right]] }), /samples/);
 assert.throws(() => processor.process(8, { inputs: [[null, right]] }), /samples/);
 assert.throws(() => processor.process(8, { events: [{ type: 'on', pitch: 60, offset: 8 }] }), /note/);
 assert.throws(() => processor.open(), /already/); assert.throws(() => new NativeVst3Processor(guest), /only one/);
 const unknownId = guest.allocate(16), unknownOutput = guest.allocate(8); guest.write(unknownId, new Uint8Array(16).fill(255)); guest.writePointer(unknownOutput, 123);
 guest.virtual(processor.host, 0, [unknownId, unknownOutput]); assert.equal(BigInt.asIntN(32, guest.engine.reg_read_i64(uc.X86_REG_RAX)), -1n); assert.equal(guest.pointer(unknownOutput), 0);
 guest.writePointer(unknownOutput, 123); guest.virtual(processor.host, 4, [unknownId, unknownId, unknownOutput]); assert.equal(BigInt.asIntN(32, guest.engine.reg_read_i64(uc.X86_REG_RAX)), -1n); assert.equal(guest.pointer(unknownOutput), 0);
 const event = new DataView(processor.note({ type: 'off', pitch: 64, velocity: 0.25, offset: 3, noteId: 91 }, 8).buffer);
 assert.equal(event.getInt32(4, true), 3); assert.equal(event.getInt16(26, true), 64); assert.equal(event.getFloat32(28, true), 0.25); assert.equal(event.getInt32(36, true), 91);
 processor.close(); processor.close(); assert.equal(processor.stage, 'closed'); assert.equal(processor.objects.size, 0); assert.throws(() => processor.process(8), /not available/);
 console.log('native audio: real factory/component/processor vtables, host callbacks, stereo float32 processing, MIDI note events, fixed allocations and lifecycle checks passed');
} finally { guest.close(); }
const rendered = new NativeVst3Guest(uc, nativeAudioFixture());
try {
 const audio = renderNativeNote(rendered, { frames: 16, maxBlock: 4, velocity: 0.5, inputs: [[new Float32Array(16).fill(1), new Float32Array(16).fill(-1)]] });
 assert.equal(audio.blocksProcessed, 4); assert.equal(audio.peak, 0.5); assert.equal(audio.silent, false); assert.equal(audio.realtime, false);
 assert.deepEqual(Array.from(audio.buses[0][0]), [...Array(12).fill(0.5), ...Array(4).fill(0)]);
 assert.equal(rendered.audioHost.stage, 'closed');
} finally { rendered.close(); }
const rejected = new NativeVst3Guest(uc, nativeAudioFixture()), rejectedProcessor = new NativeVst3Processor(rejected);
try {
 rejectedProcessor.open(); rejected.write(rejected.slide + 0x600, new Uint8Array([0x48, 0xc7, 0xc0, 255, 255, 255, 255, 0xc3]));
 assert.throws(() => rejectedProcessor.process(8), /process failed \(-1\)/); assert.equal(rejectedProcessor.blocksProcessed, 0);
 assert.throws(() => rejectedProcessor.process(8), /not available/); rejectedProcessor.close();
} finally { rejected.close(); }
const creationBytes = nativeAudioFixture(); creationBytes.set([0x48, 0xc7, 0xc0, 255, 255, 255, 255, 0xc3], 0x400);
const creation = new NativeVst3Guest(uc, creationBytes);
try {
 assert.throws(() => renderNativeNote(creation, { frames: 16 }), /createInstance failed \(-1\)/);
 assert.equal(creation.audioHost.report().stage, 'creating-component'); assert.equal(creation.audioHost.blocksProcessed, 0);
} finally { creation.close(); }
const pooled = new NativeVst3Guest(uc, nativeAudioFixture()), pooledProcessor = new NativeVst3Processor(pooled);
try {
 pooledProcessor.open();
 const text = pooled.objc.cstring('temporary'), klass = pooled.objc.foundationClass('NSString'), selector = pooled.objc.selector('stringWithUTF8String:'), message = pooled.resolve('_objc_msgSend', 0, 'bind');
 const code = new Uint8Array(64), view = new DataView(code.buffer); let offset = 0;
 for (const [operation, value] of [[0xbf, klass], [0xbe, selector], [0xba, text], [0xb8, message]]) {
  code.set([0x48, operation], offset); view.setBigUint64(offset + 2, BigInt(value), true); offset += 10;
 }
 code.set([0x48, 0x83, 0xec, 0x08, 0xff, 0xd0, 0x48, 0x83, 0xc4, 0x08, 0x31, 0xc0, 0xc3], offset);
 pooled.write(pooled.slide + 0x600, code);
 const allocations = pooled.allocations.size, instances = pooled.objc.objects.size;
 for (let index = 0; index < 20; index++) {
  pooledProcessor.process(8); assert.equal(pooled.objc.pools.length, 0); assert.equal(pooled.allocations.size, allocations); assert.equal(pooled.objc.objects.size, instances);
 }
 assert.ok(pooled.objc.freePoolTokens.length <= 256); pooledProcessor.close();
} finally { pooled.close(); }
const constructorBytes = nativeAudioFixture(), constructorView = new DataView(constructorBytes.buffer);
const finiteLoop = [0x41, 0xb8, 0x60, 0xe3, 0x16, 0, 0x41, 0xff, 0xc8, 0x75, 0xfb];
constructorBytes.set([...finiteLoop, 0x48, 0x8d, 0x05, 0, 0, 0, 0, 0x48, 0x89, 0x01, 0x31, 0xc0, 0xc3], 0x400);
constructorView.setInt32(0x40e, 0x1a00 - 0x412, true);
const heavy = new NativeVst3Guest(uc, constructorBytes), heavyProcessor = new NativeVst3Processor(heavy, { blockLimits: { instructionBudget: 2000000, milliseconds: 30000 } });
try {
 assert.equal(heavyProcessor.open().name, 'Native fixture');
 heavy.write(heavy.slide + 0x600, new Uint8Array([...finiteLoop, 0x31, 0xc0, 0xc3]));
 assert.throws(() => heavyProcessor.process(8), error => error.details.kind === 'execution-limit' && error.details.reason === 'instruction-budget');
 assert.equal(heavyProcessor.blocksProcessed, 0); assert.equal(heavy.objc.pools.length, 0); heavyProcessor.close();
} finally { heavy.close(); }
{
 const closing = new NativeVst3Guest(uc, nativeAudioFixture()), close = NativeVst3Processor.prototype.close;
 NativeVst3Processor.prototype.close = function () { close.call(this); throw new Error('teardown failed'); };
 try {
  const audio = renderNativeNote(closing, { frames: 256 });
  assert.equal(audio.closeError, 'teardown failed'); assert.equal(audio.blocksProcessed, 2);
 } finally { NativeVst3Processor.prototype.close = close; closing.close(); }
}
