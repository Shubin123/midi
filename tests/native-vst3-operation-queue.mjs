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
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const send = (receiver, selector, ...args) => guest.call(guest.resolve('_objc_msgSend', 0, 'bind'), [receiver, guest.objc.selector(selector), ...args]);
 const klass = guest.objc.foundationClass('NSOperationQueue'), main = send(klass, 'currentQueue');
 assert.ok(main); assert.equal(send(klass, 'mainQueue'), main); assert.equal(send(klass, 'currentQueue'), main);
 assert.equal(send(main, 'class'), klass); assert.equal(send(main, 'retain'), main); send(main, 'release');
 assert.equal(send(klass, 'mainQueue'), main);
 for (const selector of ['addOperation:', 'addOperationWithBlock:', 'waitUntilAllOperationsAreFinished', 'cancelAllOperations']) assert.throws(() => send(main, selector, 0), error => error.details.className === 'NSOperationQueue' && error.details.selector === selector);
} finally { guest.close(); }

if (process.platform === 'darwin') {
 const directory = mkdtempSync(join(tmpdir(), 'midi-operation-queue-'));
 try {
  const source = fileURLToPath(new URL('./support/native-operation-queue-fixture.m', import.meta.url)), binary = join(directory, 'native'), image = join(directory, 'queue.dylib'), options = { timeout: 15000, maxBuffer: 1000000 };
  execFileSync('clang', ['-O0', '-DNATIVE', source, '-framework', 'Foundation', '-o', binary], options);
  assert.deepEqual(execFileSync(binary, [], options).toString().trim().split('\n'), ['1', '1']);
  execFileSync('clang', ['-target', 'x86_64-apple-macos10.13', '-O0', '-fno-stack-protector', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', image], options);
  const compiled = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)));
  try {
   const call = (name, ...args) => compiled.call(compiled.resolve(`_${name}`, 0, 'bind'), args);
   assert.equal(compiled.call(compiled.export('_probe_operation_queue')), 1);
   const output = compiled.allocate(16), klass = compiled.objc.foundationClass('NSOperationQueue');
   const main = call('objc_msgSend', klass, compiled.objc.selector('mainQueue'));
   assert.equal(call('pthread_create', output, 0, compiled.export('_probe_operation_queue_worker'), main), 0);
   assert.equal(call('pthread_join', compiled.pointer(output), output + 8), 0);
   assert.equal(compiled.pointer(output + 8), 1); assert.equal(compiled.threads.report().completed, 1);
   assert.equal(compiled.objc.objects.size, 1); assert.equal(call('objc_msgSend', klass, compiled.objc.selector('currentQueue')), main);
  } finally { compiled.close(); }
 } finally { rmSync(directory, { recursive: true, force: true }); }
}
console.log('native operation queue lookup: main-thread singleton, real pthread currentQueue nil, native/compiler comparisons and explicit unsupported operation execution passed');
