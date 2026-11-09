import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { parseGuestURL } from '../js/native-vst3-url.js';
import { nativeFixture, nativeURLFixture } from './support/native-vst3-fixture.js';

const cases = [
 ['https://api.rollbar.com/api/1/item/', 'https', 'api.rollbar.com', '/api/1/item', null, null],
 ['HTTPS://EXAMPLE.COM/a/../b/', 'HTTPS', 'EXAMPLE.COM', '/a/../b', null, null],
 ['https://example.com', 'https', 'example.com', '', null, null],
 ['https://example.com/a%20b?q=x%20y#f%20g', 'https', 'example.com', '/a b', 'q=x%20y', 'f%20g'],
 ['https://example.com/?#', 'https', 'example.com', '/', '', ''],
 ['https://[::1]:8443/a', 'https', '::1', '/a', null, null],
 ['https://example.com/a%2Fb/', 'https', 'example.com', '/a/b', null, null],
 ['https://example.com/a//b', 'https', 'example.com', '/a//b', null, null],
 ['https://example.com/a%2F', 'https', 'example.com', '/a', null, null],
 ['https://example.com/a///', 'https', 'example.com', '/a//', null, null],
 ['https://example.com/a%00b', 'https', 'example.com', '/a\0b', null, null],
 ['https://example.com/a%3Bb', 'https', 'example.com', '/a;b', null, null],
 ['https://example.com/a;b', 'https', 'example.com', '/a;b', null, null],
 ['https://example.com/a%FF', 'https', 'example.com', null, null, null],
 ['https://example.com/%F0%9F%8E%B9', 'https', 'example.com', '/🎹', null, null],
 ['https://example.com//', 'https', 'example.com', '/', null, null],
];
const samples = cases.map(([sample]) => sample);
const fields = ['absoluteString', 'relativeString', 'scheme', 'host', 'path', 'query', 'fragment'];
const expected = cases.map(([sample, ...components]) => [sample, sample, ...components]);
if (process.platform === 'darwin') {
 const directory = mkdtempSync(join(tmpdir(), 'midi-url-'));
 try {
  const binary = join(directory, 'native'), source = fileURLToPath(new URL('./support/native-url-fixture.m', import.meta.url)), options = { timeout: 15000, maxBuffer: 1000000 };
  execFileSync('clang', ['-O0', source, '-framework', 'Foundation', '-o', binary], options);
  assert.deepEqual(execFileSync(binary, samples, options).toString().trim().split('\n').map(line => JSON.parse(line)), expected);
 } finally { rmSync(directory, { recursive: true, force: true }); }
}
const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const call = (name, ...args) => guest.call(guest.resolve(`_${name}`, 0, 'bind'), args);
 const send = (receiver, name, ...args) => call('objc_msgSend', receiver, guest.objc.selector(name), ...args);
 const klass = guest.objc.foundationClass('NSURL');
 for (const [index, sample] of samples.entries()) {
  assert.deepEqual(fields.map(field => parseGuestURL(sample)[field]), expected[index]);
  const pool = call('objc_autoreleasePoolPush'), source = guest.objc.foundationString(sample), url = send(klass, 'URLWithString:', source);
  send(source, 'release');
  assert.deepEqual(fields.map(field => { const value = send(url, field); return value ? guest.core.text(value) : null; }), expected[index]);
  assert.equal(send(url, 'isFileURL'), 0); assert.equal(send(url, 'baseURL'), 0); assert.equal(send(url, 'absoluteURL'), url);
  assert.equal(send(url, 'copy'), url); call('objc_autoreleasePoolPop', pool); assert.ok(guest.objc.objects.has(url)); send(url, 'release'); assert.equal(guest.objc.objects.has(url), false);
 }
 const owned = send(klass, 'alloc'), source = guest.objc.foundationString(samples[0]);
 assert.equal(send(owned, 'initWithString:', source), owned); send(source, 'release');
 const beforeGetter = guest.allocations.size;
 assert.throws(() => send(owned, 'absoluteString'), /guest pool/); assert.equal(guest.allocations.size, beforeGetter);
 assert.throws(() => send(owned, 'resourceDataUsingCache:'), error => error.details.selector === 'resourceDataUsingCache:');
 send(owned, 'release'); assert.equal(guest.objc.objects.has(owned), false);
 const sourceWithoutPool = guest.objc.foundationString(samples[0]), allocations = guest.allocations.size;
 assert.throws(() => send(klass, 'URLWithString:', sourceWithoutPool), /guest pool/); assert.equal(guest.allocations.size, allocations); send(sourceWithoutPool, 'release');
 for (const sample of ['file:///tmp/data', 'relative/path', 'https://user:secret@example.com/', 'https://example.com/a b', 'https://example.com/%xy', 'https://[invalid]/', 'https://example.com/{a}', 'https://example.com/?q=[a]']) assert.throws(() => parseGuestURL(sample), /guest|Guest/);
 console.log('native URL: HTTP(S) parsing matches native Foundation, preserved URI spelling, decoded paths, IPv6, absent/empty fields, retained copies and autorelease ownership passed; no network I/O');
} finally { guest.close(); }
const fixture = new NativeVst3Guest(uc, nativeURLFixture());
try {
 fixture.initialize(); assert.equal(fixture.factoryInfo().classes[0].cid, '01000000000000000000000000000000');
 assert.equal(fixture.objc.pools.length, 0); assert.equal([...fixture.objc.objects.values()].some(object => object.url), false);
} finally { fixture.close(); }
