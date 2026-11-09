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
 const call = (name, ...args) => guest.call(guest.resolve(`_${name}`, 0, 'bind'), args);
 const send = (receiver, selector, ...args) => call('objc_msgSend', receiver, guest.objc.selector(selector), ...args);
 const text = (value, operation) => { const handle = guest.objc.foundationString(value); try { return operation(handle); } finally { send(handle, 'release'); } };
 const pool = call('objc_autoreleasePoolPush'), configuration = send(guest.objc.foundationClass('NSURLSessionConfiguration'), 'defaultSessionConfiguration');
 const session = send(guest.objc.foundationClass('NSURLSession'), 'sessionWithConfiguration:', configuration);
 const url = text('https://example.invalid/task', value => send(guest.objc.foundationClass('NSURL'), 'URLWithString:', value));
 const request = send(guest.objc.foundationClass('NSMutableURLRequest'), 'requestWithURL:', url);
 text('POST', value => send(request, 'setHTTPMethod:', value));
 const bytes = guest.allocate(3); guest.write(bytes, new Uint8Array([1, 2, 3]));
 const data = send(guest.objc.foundationClass('NSData'), 'dataWithBytes:length:', bytes, 3); send(request, 'setHTTPBody:', data);
 const task = send(session, 'dataTaskWithRequest:', request);
 assert.equal(send(task, 'state'), 1); assert.equal(send(task, 'taskIdentifier'), 1);
 assert.equal(call('class_getSuperclass', send(task, 'class')), guest.objc.foundationClass('NSURLSessionTask'));
 for (const property of ['response', 'error', 'countOfBytesSent', 'countOfBytesReceived', 'countOfBytesExpectedToSend', 'countOfBytesExpectedToReceive']) assert.equal(send(task, property), 0);
 const original = send(task, 'originalRequest'); assert.notEqual(original, request);
 text('GET', value => send(request, 'setHTTPMethod:', value)); send(request, 'setHTTPBody:', 0);
 assert.equal(guest.core.text(send(original, 'HTTPMethod')), 'POST'); assert.equal(send(send(original, 'HTTPBody'), 'length'), 3);
 assert.equal(guest.core.text(send(send(task, 'currentRequest'), 'HTTPMethod')), 'POST');
 send(task, 'priority'); assert.equal(guest.floatingRegister(0, 32), 0.5);
 for (const value of [0.75, 0, 1, NaN]) { guest.setFloatingRegister(0, value, 32); send(task, 'setPriority:'); send(task, 'priority'); assert.ok(Object.is(guest.floatingRegister(0, 32), value)); }
 for (const value of [-1, 2, Infinity, -Infinity]) {
  guest.setFloatingRegister(0, 0.5, 32); send(task, 'setPriority:'); guest.setFloatingRegister(0, value, 32); send(task, 'setPriority:'); send(task, 'priority'); assert.equal(guest.floatingRegister(0, 32), 0.5);
 }
 assert.equal(send(task, 'taskDescription'), 0); text('guest task', value => send(task, 'setTaskDescription:', value)); assert.equal(guest.core.text(send(task, 'taskDescription')), 'guest task'); send(task, 'setTaskDescription:', 0);
 const second = send(session, 'dataTaskWithRequest:', request); assert.equal(send(second, 'taskIdentifier'), 2);
 for (const selector of ['suspend']) assert.throws(() => send(task, selector), error => error.details.className === 'NSURLSessionDataTask' && error.details.selector === selector);
 assert.equal(send(task, 'state'), 1); assert.throws(() => call('object_dispose', task), /managed Foundation/);
 const count = guest.objc.objects.size, registry = guest.objc.objects.get(session).session;
 for (const source of [0, 1, data]) assert.throws(() => send(session, 'dataTaskWithRequest:', source), /task request/);
 const entries = guest.objc.pools.at(-1).entries, saved = entries.length; entries.length = 65536;
 assert.throws(() => send(session, 'dataTaskWithRequest:', request), /pool entry limit/); entries.length = saved;
 assert.equal(guest.objc.objects.size, count); assert.equal(registry.tasks.size, 2); assert.equal(registry.nextTask, 3n);
 call('objc_autoreleasePoolPop', pool);
 assert.equal(guest.objc.objects.get(task).references, 1); assert.equal(send(task, 'state'), 1); assert.equal(send(original, 'HTTPBody') !== 0, true);
 assert.throws(() => send(session, 'dataTaskWithRequest:', original), /Autorelease requires/);
 assert.equal(registry.tasks.size, 2); assert.equal(guest.report().files.runtimeFiles, 0);
} finally { guest.close(); }

if (process.platform === 'darwin') {
 const directory = mkdtempSync(join(tmpdir(), 'midi-session-task-'));
 try {
  const source = fileURLToPath(new URL('./support/native-session-task-fixture.m', import.meta.url)), binary = join(directory, 'native'), image = join(directory, 'task.dylib'), options = { timeout: 15000, maxBuffer: 1000000 };
  execFileSync('clang', ['-O0', '-DNATIVE', source, '-framework', 'Foundation', '-o', binary], options);
  const native = execFileSync(binary, [], options).toString().trim().split('\n');
  assert.deepEqual(native.slice(0, 3), ['60.000 60.000 0 0 0', '0.50', '0.50']); assert.equal(Number(native[3]), NaN); assert.deepEqual(native.slice(4), ['0.50', '255']);
  execFileSync('clang', ['-target', 'x86_64-apple-macos10.13', '-O0', '-fno-stack-protector', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', image], options);
  const compiled = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)));
  try {
   const pool = compiled.call(compiled.resolve('_objc_autoreleasePoolPush', 0, 'bind'));
   assert.equal(compiled.call(compiled.export('_probe_session_task')), 255);
   compiled.call(compiled.resolve('_objc_autoreleasePoolPop', 0, 'bind'), [pool]);
   const tasks = [...compiled.objc.objects.values()].filter(object => object.sessionTask);
   assert.equal(tasks.length, 2); assert.ok(tasks.every(object => object.references === 1 && object.sessionTask.state === 1));
  } finally { compiled.close(); }
 } finally { rmSync(directory, { recursive: true, force: true }); }
}
console.log('native suspended tasks: native/compiler request snapshots, POST bodies, sequential IDs, nil responses/errors, zero progress, float32 priority, descriptions, retention and rollback passed; suspend remains unsupported');
