import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const directory = mkdtempSync(join(tmpdir(), 'midi-rtti-')), source = fileURLToPath(new URL('./support/native-rtti-fixture.cpp', import.meta.url));
try {
 const options = { timeout: 10000, maxBuffer: 1000000 };
 execFileSync('clang++', ['-std=c++11', '-O0', '-fno-exceptions', '-DNATIVE', source, '-o', join(directory, 'native')], options);
 const expected = Number(execFileSync(join(directory, 'native'), [], options).toString().trim()); assert.equal(expected, 1023);
 const binary = join(directory, 'fixture.dylib');
 execFileSync('clang++', ['-target', 'x86_64-apple-macos10.13', '-std=c++11', '-O0', '-fno-exceptions', '-fno-stack-protector', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', binary], options);
 const guest = new NativeVst3Guest(uc, new Uint8Array(readFileSync(binary)));
 try {
  assert.equal(guest.call(guest.export('_probe')), expected); assert.equal(guest.calls.get('___dynamic_cast'), 10);
  assert.equal(guest.report().playable, false);
 } finally { guest.close(); }
 console.log('native RTTI compiler: ten Clang C++ cast results match the real host ABI in the x86 guest; private, multiple, virtual and ambiguous inheritance passed');
} finally { rmSync(directory, { recursive: true, force: true }); }
