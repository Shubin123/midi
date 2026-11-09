import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { cppTimedWait } from '../js/native-vst3-conditions.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const directory = mkdtempSync(join(tmpdir(), 'midi-threads-')), source = fileURLToPath(new URL('./support/native-thread-fixture.c', import.meta.url));
try {
 const options = { timeout: 15000, maxBuffer: 1000000 };
 execFileSync('clang', ['-O0', '-DNATIVE', source, '-lobjc', '-lc++', '-o', join(directory, 'native')], options);
 const [expected, scheduling] = execFileSync(join(directory, 'native'), [], options).toString().trim().split(/\s+/).map(Number);
 assert.equal(expected, 2047); assert.equal(scheduling, 65567);
 const binary = join(directory, 'fixture.dylib');
 execFileSync('clang', ['-target', 'x86_64-apple-macos10.13', '-O0', '-fno-stack-protector', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', binary], options);
 const guest = new NativeVst3Guest(uc, new Uint8Array(readFileSync(binary)));
 try {
  assert.equal(guest.call(guest.export('_probe'), [], { instructionBudget: 10000000, milliseconds: 15000 }), expected);
  const report = guest.threads.report();
  assert.equal(report.created, 2); assert.equal(report.completed, 2); assert.equal(report.active, 0); assert.equal(report.stackBytes, 0);
  assert.ok(report.switches > 100); assert.equal(guest.threads.records.size, 1);
  assert.equal(guest.objc.pools.length, 0); assert.equal(guest.calls.get('_pthread_exit'), 1);
  assert.equal(guest.threadStorage.keys.size, 0);
  assert.equal(guest.staticGuards.size, 0);
 } finally { guest.close(); }
 const cppSource = fileURLToPath(new URL('./support/native-thread-fixture.cpp', import.meta.url));
 execFileSync('clang++', ['-std=c++11', '-O0', '-DNATIVE', cppSource, '-o', join(directory, 'native-cpp')], options);
 const cppExpected = Number(execFileSync(join(directory, 'native-cpp'), [], options).toString().trim()); assert.equal(cppExpected, 31);
 const calendars = execFileSync(join(directory, 'native-cpp'), ['calendar'], options).toString().trim().split('\n').map(line => JSON.parse(line));
 const cppBinary = join(directory, 'cpp.dylib');
 execFileSync('clang++', ['-target', 'x86_64-apple-macos10.13', '-std=c++11', '-O0', '-fno-exceptions', '-fno-stack-protector', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', cppSource, '-o', cppBinary], options);
 const cppGuest = new NativeVst3Guest(uc, new Uint8Array(readFileSync(cppBinary)), { monotonicClock: () => 12.5, wallClock: () => 1500.25 });
 try {
  const calendarOutput = cppGuest.allocate(36);
  for (const [timestamp, error, ...fields] of calendars) {
   cppGuest.write(calendarOutput, new Uint8Array(36));
   assert.equal(cppGuest.call(cppGuest.export('_probe_calendar_cpp'), [BigInt(timestamp), calendarOutput]), error);
   const result = cppGuest.read(calendarOutput, 36), view = new DataView(result.buffer, result.byteOffset, result.byteLength);
   assert.deepEqual(Array.from({ length: 9 }, (_, index) => view.getInt32(index * 4, true)), fields);
  }
  assert.equal(cppGuest.call(cppGuest.export('_probe_steady_clock')), 12500000);
  assert.equal(cppGuest.call(cppGuest.export('_probe_system_clock')), 1500250);
  assert.equal(cppGuest.call(cppGuest.export('_probe_cwd_cpp')), 31);
  assert.equal(cppGuest.call(cppGuest.export('_probe_nothrow_cpp')), 79);
  assert.equal(cppGuest.call(cppGuest.export('_probe_filesystem_cpp'), [cppGuest.objc.cstring(cppGuest.bundles.executablePath)]), 63);
  assert.equal(cppGuest.call(cppGuest.export('_probe_executable_cpp')), 15);
  cppGuest.wallClock = () => Date.now();
  assert.equal(cppGuest.call(cppGuest.export('_probe_timed_cpp')), 1);
  assert.ok(cppGuest.calls.get(cppTimedWait) > 0);
  assert.equal(cppGuest.call(cppGuest.export('_probe_cpp')), cppExpected);
  assert.equal(cppGuest.threads.report().completed, 1); assert.equal(cppGuest.threads.report().stackBytes, 0);
  assert.ok(cppGuest.calls.get('__ZNSt3__118condition_variable4waitERNS_11unique_lockINS_5mutexEEE') > 0);
  assert.ok(Array.from(cppGuest.conditions.conditions.values()).every(condition => condition.waiters.length === 0));
 } finally { cppGuest.close(); }
 const boundedGuest = new NativeVst3Guest(uc, new Uint8Array(readFileSync(cppBinary)), { wallClock: () => 1500 });
 try {
  assert.throws(() => boundedGuest.call(boundedGuest.export('_probe_timed_cpp'), [], { milliseconds: 20 }), error => error.details.kind === 'execution-limit' && error.details.reason === 'wall-clock' && error.details.remaining > 0);
 } finally { boundedGuest.close(); }
 console.log('native thread compiler: C/C++ pthread results match the host; chrono units/returns, real timed waits, bounded idle deadlines, mutex handoffs, TLS/errno/pools, FP contexts, joins and destructors passed');
} finally { rmSync(directory, { recursive: true, force: true }); }
