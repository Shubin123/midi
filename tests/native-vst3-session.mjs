import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const fixtureBytes = nativeFixture(); fixtureBytes.set([0x48, 0x89, 0xf0, 0xc3], 0x500);
const guest = new NativeVst3Guest(uc, fixtureBytes);
try {
 const call = (name, ...args) => guest.call(guest.resolve(`_${name}`, 0, 'bind'), args);
 const send = (receiver, selector, ...args) => call('objc_msgSend', receiver, guest.objc.selector(selector), ...args);
 assert.equal(call('objc_alloc', 0), 0);
 const root = guest.objc.rootClass().handle, allocated = call('objc_alloc', root);
 assert.equal(guest.pointer(allocated), root); assert.equal(guest.objc.objects.get(allocated).references, 1); send(allocated, 'release');
 const override = call('objc_allocateClassPair', root, guest.objc.cstring('GuestAllocFixture'), 0);
 assert.equal(call('class_addMethod', call('object_getClass', override), guest.objc.selector('alloc'), guest.slide + 0x500, guest.objc.cstring('@@:')), 1);
 call('objc_registerClassPair', override);
 assert.equal(call('objc_alloc', override), guest.objc.selector('alloc'));
 const klass = guest.objc.foundationClass('NSURLSession'), configurationClass = guest.objc.foundationClass('NSURLSessionConfiguration');
 assert.throws(() => send(klass, 'sessionWithConfiguration:', 0), /Autorelease requires/);
 const pool = call('objc_autoreleasePoolPush'), configuration = send(configurationClass, 'defaultSessionConfiguration');
 const delegate = send(guest.objc.rootClass().handle, 'new'), queue = send(guest.objc.foundationClass('NSOperationQueue'), 'mainQueue');
 guest.setFloatingRegister(0, 2.75); send(configuration, 'setTimeoutIntervalForRequest:');
 const session = send(klass, 'sessionWithConfiguration:delegate:delegateQueue:', configuration, delegate, queue);
 send(delegate, 'release'); assert.ok(guest.objc.objects.has(delegate));
 assert.equal(send(session, 'delegate'), delegate); assert.equal(send(session, 'delegateQueue'), queue);
 assert.equal(send(queue, 'maxConcurrentOperationCount'), 1); assert.equal(send(queue, 'operationCount'), 0); assert.equal(send(queue, 'isSuspended'), 0);
 const first = send(session, 'configuration'); assert.notEqual(first, configuration);
 guest.setFloatingRegister(0, 7.125); send(configuration, 'setTimeoutIntervalForRequest:');
 send(first, 'timeoutIntervalForRequest'); assert.equal(guest.floatingRegister(), 2.75);
 guest.setFloatingRegister(0, 1); send(first, 'setTimeoutIntervalForRequest:');
 const second = send(session, 'configuration'); assert.notEqual(first, second);
 send(second, 'timeoutIntervalForRequest'); assert.equal(guest.floatingRegister(), 2.75);
 assert.equal(send(session, 'sessionDescription'), 0);
 const description = guest.objc.foundationString('guest session'); send(session, 'setSessionDescription:', description); send(description, 'release');
 assert.equal(guest.core.text(send(session, 'sessionDescription')), 'guest session');
 send(session, 'setSessionDescription:', 0); assert.equal(send(session, 'sessionDescription'), 0);
 assert.throws(() => call('object_dispose', session), /managed Foundation/);
 for (const selector of ['invalidateAndCancel']) assert.throws(() => send(session, selector, 0), error => error.details.className === 'NSURLSession' && error.details.selector === selector);
 const automatic = send(klass, 'sessionWithConfiguration:', configuration), automaticQueue = send(automatic, 'delegateQueue');
 assert.equal(send(automatic, 'delegate'), 0); assert.notEqual(automaticQueue, queue); assert.equal(send(automaticQueue, 'maxConcurrentOperationCount'), 1);
 const objects = guest.objc.objects.size;
 for (const args of [[0, 0, 0], [1, 0, 0], [configuration, 1, 0], [configuration, 0, 1], [configuration, 0, delegate]]) assert.throws(() => send(klass, 'sessionWithConfiguration:delegate:delegateQueue:', ...args));
 assert.equal(guest.objc.objects.size, objects);
 const entries = guest.objc.pools.at(-1).entries; const saved = entries.length; entries.length = 65536;
 assert.throws(() => send(klass, 'sessionWithConfiguration:', configuration), /pool entry limit/);
 assert.equal(guest.objc.objects.size, objects); entries.length = saved;
 call('objc_autoreleasePoolPop', pool);
 assert.ok(guest.objc.objects.has(session)); assert.ok(guest.objc.objects.has(automatic)); assert.ok(guest.objc.objects.has(delegate));
 const live = guest.objc.objects.size;
 assert.throws(() => send(session, 'configuration'), /Autorelease requires/); assert.equal(guest.objc.objects.size, live);
 assert.equal(guest.objc.objects.get(session).references, 1); assert.equal(guest.core.objects.size, 0); assert.equal(guest.report().files.runtimeFiles, 0);
} finally { guest.close(); }

if (process.platform === 'darwin') {
 const directory = mkdtempSync(join(tmpdir(), 'midi-session-'));
 try {
  const source = fileURLToPath(new URL('./support/native-session-fixture.m', import.meta.url)), binary = join(directory, 'native'), image = join(directory, 'session.dylib'), options = { timeout: 15000, maxBuffer: 1000000 };
  execFileSync('clang', ['-O0', '-DNATIVE', source, '-framework', 'Foundation', '-o', binary], options);
  assert.equal(execFileSync(binary, [], options).toString().trim(), '511');
  execFileSync('clang', ['-target', 'x86_64-apple-macos10.13', '-O0', '-fno-stack-protector', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', image], options);
  const compiled = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)));
  try {
   const pool = compiled.call(compiled.resolve('_objc_autoreleasePoolPush', 0, 'bind'));
   assert.equal(compiled.call(compiled.export('_probe_session')), 511);
   compiled.call(compiled.resolve('_objc_autoreleasePoolPop', 0, 'bind'), [pool]);
   const sessions = [...compiled.objc.objects.values()].filter(object => object.session);
   assert.equal(sessions.length, 2); assert.ok(sessions.every(object => object.references === 1));
  } finally { compiled.close(); }
 } finally { rmSync(directory, { recursive: true, force: true }); }
}
console.log('native sessions: native/compiler metadata goldens, configuration snapshots, retained delegates/queues, serial default queue, copied descriptions, active ownership and rollback passed; invalidateAndCancel remains unsupported');
