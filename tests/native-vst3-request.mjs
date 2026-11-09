import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture, nativeRequestFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const call = (name, ...args) => guest.call(guest.resolve(`_${name}`, 0, 'bind'), args);
 const send = (receiver, selector, ...args) => call('objc_msgSend', receiver, guest.objc.selector(selector), ...args);
 for (const name of ['objc_retain', 'objc_release', 'objc_autorelease']) assert.equal(call(name, 0), 0);
 const text = (value, operation) => { const handle = guest.objc.foundationString(value); try { return operation(handle); } finally { send(handle, 'release'); } };
 const pool = call('objc_autoreleasePoolPush'), klass = guest.objc.foundationClass('NSMutableURLRequest'), parent = guest.objc.foundationClass('NSURLRequest');
 assert.equal(call('class_getSuperclass', klass), parent); assert.equal(call('class_getSuperclass', call('object_getClass', klass)), call('object_getClass', parent));
 const url = text('https://example.invalid/api/', source => send(guest.objc.foundationClass('NSURL'), 'URLWithString:', source));
 guest.setFloatingRegister(0, 2.75);
 const request = send(klass, 'requestWithURL:cachePolicy:timeoutInterval:', url, 1);
 assert.throws(() => call('object_dispose', request), /managed Foundation/);
 assert.equal(send(request, 'URL'), url); assert.equal(send(request, 'cachePolicy'), 1);
 send(request, 'timeoutInterval'); assert.equal(guest.floatingRegister(), 2.75);
 assert.equal(guest.core.text(send(request, 'HTTPMethod')), 'GET');
 assert.equal(send(request, 'HTTPBody'), 0); assert.equal(send(request, 'HTTPBodyStream'), 0);
 assert.equal(send(request, 'HTTPShouldHandleCookies'), 1); assert.equal(send(request, 'HTTPShouldUsePipelining'), 0); assert.equal(send(request, 'allowsCellularAccess'), 1);
 send(request, 'retain'); call('objc_autoreleasePoolPop', pool); assert.ok(guest.objc.objects.has(url));
 guest.objc.selector('requestWithURL:'); const allocations = guest.allocations.size;
 assert.throws(() => send(klass, 'requestWithURL:', url), /guest pool/); assert.equal(guest.allocations.size, allocations);
 const nextPool = call('objc_autoreleasePoolPush'), header = (value, field, method = 'setValue:forHTTPHeaderField:', target = request) => text(field, key => value === null ? send(target, method, 0, key) : text(value, data => send(target, method, data, key)));
 const readHeader = (target, field) => text(field, key => { const value = send(target, 'valueForHTTPHeaderField:', key); return value ? guest.core.text(value) : null; });
 header('one', 'x-Test'); header('two', 'X-TEST', 'addValue:forHTTPHeaderField:'); assert.equal(readHeader(request, 'X-test'), 'one,two');
 const copy = send(request, 'copy'); assert.notEqual(copy, request); assert.equal(guest.pointer(copy), parent); assert.equal(send(copy, 'copy'), copy); send(copy, 'release');
 header('three', 'X-test'); assert.equal(readHeader(copy, 'x-test'), 'one,two');
 const mutable = send(copy, 'mutableCopy'); assert.notEqual(mutable, copy); assert.equal(guest.pointer(mutable), klass);
 header(null, 'X-test', 'setValue:forHTTPHeaderField:', mutable); assert.equal(readHeader(mutable, 'X-test'), null); assert.equal(readHeader(copy, 'X-test'), 'one,two');
 for (const [source, expected] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'patch'], ['head', 'HEAD'], ['delete', 'DELETE'], ['options', 'OPTIONS'], ['trace', 'trace'], ['connect', 'CONNECT'], ['CuStOm', 'CuStOm']]) {
  text(source, value => send(request, 'setHTTPMethod:', value)); assert.equal(guest.core.text(send(request, 'HTTPMethod')), expected);
 }
 guest.setFloatingRegister(0, 7.125); send(mutable, 'setTimeoutInterval:'); send(mutable, 'timeoutInterval'); assert.equal(guest.floatingRegister(), 7.125);
 send(copy, 'timeoutInterval'); assert.equal(guest.floatingRegister(), 2.75);
 guest.setFloatingRegister(0, 0); send(mutable, 'setTimeoutInterval:'); send(mutable, 'timeoutInterval'); assert.equal(guest.floatingRegister(), 0);
 for (const value of [-1, NaN, Infinity]) { guest.setFloatingRegister(0, value); assert.throws(() => send(mutable, 'setTimeoutInterval:'), /timeout/); send(mutable, 'timeoutInterval'); assert.equal(guest.floatingRegister(), 0); }
 for (let policy = 0; policy <= 5; policy++) { send(mutable, 'setCachePolicy:', policy); assert.equal(send(mutable, 'cachePolicy'), policy); }
 assert.throws(() => send(mutable, 'setCachePolicy:', 6), /cache policy/); assert.equal(send(mutable, 'cachePolicy'), 5);
 for (const name of ['setHTTPShouldHandleCookies:', 'setAllowsCellularAccess:']) send(request, name, 0);
 send(request, 'setHTTPShouldUsePipelining:', 1); assert.equal(send(request, 'HTTPShouldHandleCookies'), 0); assert.equal(send(request, 'HTTPShouldUsePipelining'), 1); assert.equal(send(request, 'allowsCellularAccess'), 0);
 send(request, 'setMainDocumentURL:', url); assert.equal(send(request, 'mainDocumentURL'), url); send(request, 'setMainDocumentURL:', 0);
 const bytes = guest.allocate(3); guest.write(bytes, new Uint8Array([0, 1, 2]));
 const data = call('CFDataCreateWithBytesNoCopy', 0, bytes, 3, 0); send(request, 'setHTTPBody:', data); guest.write(bytes, new Uint8Array([9, 9, 9])); call('CFRelease', data);
 const body = send(request, 'HTTPBody'); assert.deepEqual(guest.read(call('CFDataGetBytePtr', body), 3), new Uint8Array([0, 1, 2]));
 const bodyCopy = send(request, 'copy'); send(request, 'setHTTPBody:', 0); assert.ok(guest.core.objects.has(body)); send(bodyCopy, 'release'); assert.equal(guest.core.objects.has(body), false);
 assert.throws(() => header('injected\r\nvalue', 'X-Test'), /header value/); assert.equal(readHeader(request, 'X-Test'), 'three');
 assert.throws(() => header('value', 'Bad Header'), /header field/); assert.throws(() => header('x'.repeat(64 << 10), 'X-Large'), /bounded capacity/);
 assert.throws(() => send(copy, 'setURL:', 0), error => error.details.className === 'NSURLRequest' && error.details.selector === 'setURL:');
 const owned = send(klass, 'alloc'); assert.equal(send(owned, 'initWithURL:', url), owned); send(owned, 'timeoutInterval'); assert.equal(guest.floatingRegister(), 60); send(owned, 'release');
 for (const handle of [mutable, copy, request]) send(handle, 'release'); call('objc_autoreleasePoolPop', nextPool);
 assert.equal(guest.objc.objects.size, 0); assert.equal(guest.core.objects.size, 0);
} finally { guest.close(); }
const fixture = new NativeVst3Guest(uc, nativeRequestFixture());
try { fixture.initialize(); assert.equal(fixture.factoryInfo().classes[0].cid, '01000000000000000000000000000000'); assert.equal(fixture.objc.objects.size, 0); } finally { fixture.close(); }

if (process.platform === 'darwin') {
 const directory = mkdtempSync(join(tmpdir(), 'midi-request-'));
 try {
  const source = fileURLToPath(new URL('./support/native-request-fixture.m', import.meta.url)), binary = join(directory, 'native'), image = join(directory, 'request.dylib'), options = { timeout: 15000, maxBuffer: 1000000 };
  execFileSync('clang', ['-O0', '-DNATIVE', source, '-framework', 'Foundation', '-o', binary], options);
  assert.deepEqual(execFileSync(binary, [], options).toString().trim().split('\n'), ['255', '255', '255', '127', '60 GET one,two', '0 POST', 'GET', 'PUT', 'patch', 'HEAD', 'DELETE', 'OPTIONS', 'trace', 'CONNECT', 'CuStOm']);
  execFileSync('clang', ['-target', 'x86_64-apple-macos10.13', '-O0', '-fno-stack-protector', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', image], options);
  const compiled = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)));
  try {
   const pool = compiled.call(compiled.resolve('_objc_autoreleasePoolPush', 0, 'bind'));
   assert.equal(compiled.call(compiled.export('_probe_request'), [compiled.objc.cstring('https://example.invalid/api/')]), 255);
   assert.equal(compiled.call(compiled.export('_probe_data')), 255);
   assert.equal(compiled.call(compiled.export('_probe_mutable_data')), 255);
   assert.equal(compiled.call(compiled.export('_probe_ivars')), 127);
   compiled.call(compiled.resolve('_objc_autoreleasePoolPop', 0, 'bind'), [pool]);
   assert.equal(compiled.objc.objects.size, 0); assert.equal(compiled.core.objects.size, 0);
  } finally { compiled.close(); }
 } finally { rmSync(directory, { recursive: true, force: true }); }
}
console.log('native requests: native/compiler ABI goldens, XMM0 timeouts, method normalization, case-insensitive headers, independent immutable/mutable copies, retained URLs, byte snapshots and ownership passed; no network I/O');
