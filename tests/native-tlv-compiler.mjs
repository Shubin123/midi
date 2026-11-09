import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const directory = mkdtempSync(join(tmpdir(), 'midi-tlv-'));
try {
 const source = fileURLToPath(new URL('./support/native-tlv-fixture.cpp', import.meta.url)), binary = join(directory, 'native'), image = join(directory, 'tlv.dylib'), options = { timeout: 20000, maxBuffer: 1000000 };
 execFileSync('clang++', ['-O0', '-w', '-std=c++17', '-DNATIVE', source, '-o', binary], options);
 execFileSync('clang++', ['-target', 'x86_64-apple-macos10.13', '-O0', '-w', '-std=c++17', '-fno-stack-protector', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', image], options);
 const expected = Number(execFileSync(binary, [], options).toString().trim());
 assert.equal(expected, 15);
 const guest = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)));
 try {
  assert.equal(guest.call(guest.export('_probe_tlv'), [], { instructionBudget: 8000000, milliseconds: 10000 }), expected);
  const before = guest.allocations.size;
  assert.equal(guest.call(guest.export('_probe_tlv'), [], { instructionBudget: 8000000, milliseconds: 10000 }), expected);
  assert.equal(guest.allocations.size, before, 'exited threads release their thread-local block');
 } finally { guest.close(); }
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log('native thread-local variables: per-thread copies of initialized and zeroed data match macOS and are released at thread exit');
