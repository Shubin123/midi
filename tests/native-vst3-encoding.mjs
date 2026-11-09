import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const require = createRequire(import.meta.url), uc = await require('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const call = (name, ...args) => {
  guest.call(guest.resolve(`_${name}`, 0, 'bind'), args);
  return Number(BigInt.asIntN(32, guest.engine.reg_read_i64(uc.X86_REG_RAX)));
 };
 for (const [base, variant, format, expected] of [[256, 0, 0, 0x100], [256, 1, 0, 0x10100], [256, 0, 2, 0x8000100], [0x1234, 0x12, 0x34, 0x10121234], [0xffffffff, 0xffffffff, 0xffffffff, 0x3fffffff]]) {
  const encoding = call('CreateTextEncoding', base, variant, format);
  assert.equal(encoding, expected);
  assert.equal(call('GetTextEncodingBase', encoding), base & 0xffff);
  assert.equal(call('GetTextEncodingVariant', encoding), variant & 0x3ff);
  assert.equal(call('GetTextEncodingFormat', encoding), format & 15);
 }
 const mapping = guest.allocate(12), handleOutput = guest.allocate(8), input = guest.allocate(128), output = guest.allocate(128);
 const consumed = guest.allocate(8), produced = guest.allocate(8), offsetCount = guest.allocate(8);
 const create = encoding => {
  const bytes = new Uint8Array(12), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x100, true); view.setUint32(4, encoding, true); view.setInt32(8, -1, true); guest.write(mapping, bytes);
  return call('CreateUnicodeToTextInfo', mapping, handleOutput);
 };
 const text = value => {
  const bytes = new Uint8Array(value.length * 2), view = new DataView(bytes.buffer);
  for (let index = 0; index < value.length; index++) view.setUint16(index * 2, value.charCodeAt(index), true);
  guest.write(input, bytes); return bytes.length;
 };
 assert.equal(create(0x100), -8738); assert.equal(guest.pointer(handleOutput), 0);
 assert.equal(create(0x30100), 0); const converter = guest.pointer(handleOutput);
 assert.equal(call('ConvertFromUnicodeToText', converter, 0, 0, 0, 0, 0, 0, 0, 0, consumed, produced, 0), 0);
 assert.equal(guest.pointer(consumed), 0); assert.equal(guest.pointer(produced), 0);
 const convert = (length, capacity = 64, flags = 0, offsets = 0) => call('ConvertFromUnicodeToText', converter, length, input, flags, offsets, 0, offsetCount, 0, capacity, consumed, produced, output + 16);
 const length = text('e\u0301 🎹'); assert.equal(length, 10);
 assert.equal(convert(length), 0); assert.equal(guest.pointer(consumed), 10); assert.equal(guest.pointer(produced), 8); assert.equal(guest.pointer(offsetCount), 0);
 assert.equal(new TextDecoder('utf-16le').decode(guest.read(output + 16, 8)), 'é 🎹');
 guest.write(output, new Uint8Array(128).fill(0xa5));
 assert.equal(convert(length, 1), -8785); assert.equal(guest.pointer(consumed), 0); assert.equal(guest.pointer(produced), 0);
 assert.ok(guest.read(output, 128).every(byte => byte === 0xa5));
 assert.equal(convert(length, 2), -8785); assert.equal(guest.pointer(consumed), 4); assert.equal(guest.pointer(produced), 2);
 assert.equal(new TextDecoder('utf-16le').decode(guest.read(output + 16, 2)), 'é');
 assert.ok(guest.read(output, 16).every(byte => byte === 0xa5)); assert.ok(guest.read(output + 18, 110).every(byte => byte === 0xa5));
 assert.equal(convert(1), -50); assert.equal(convert(text('\ud800')), -8753);
 assert.throws(() => convert(text('valid'), 64, 2), /Stateful Unicode/);
 assert.throws(() => convert(10, 64, 0, 1), /offset mapping/);
 assert.equal(call('DisposeUnicodeToTextInfo', handleOutput), 0); assert.equal(guest.pointer(handleOutput), 0); assert.equal(guest.encodings.converters.size, 0);
 assert.throws(() => call('DisposeUnicodeToTextInfo', handleOutput), /Invalid Unicode converter/);
 assert.equal(create(0x20100), 0);
 const decomposer = guest.pointer(handleOutput), nfcLength = text('é 🎹');
 assert.equal(call('ConvertFromUnicodeToText', decomposer, nfcLength, input, 0, 0, 0, 0, 0, 64, consumed, produced, output), 0);
 assert.equal(new TextDecoder('utf-16le').decode(guest.read(output, guest.pointer(produced))), 'e\u0301 🎹');
 call('DisposeUnicodeToTextInfo', handleOutput);
 for (let index = 0; index < 256; index++) assert.equal(create(0x30100), 0);
 assert.throws(() => create(0x30100), /converter limit/);
 for (const handle of guest.encodings.converters.keys()) { guest.writePointer(handleOutput, handle); call('DisposeUnicodeToTextInfo', handleOutput); }
 assert.equal(guest.encodings.converters.size, 0);
 console.log('native text encoding: Darwin packed fields, real NFC/NFD conversion, 64-bit stack arguments/counts, bounded partial writes, malformed UTF-16, ownership and converter limits passed');
} finally { guest.close(); }
