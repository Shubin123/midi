import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';

if (process.platform === 'darwin') {
 const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
 const directory = mkdtempSync(join(tmpdir(), 'midi-iostream-'));
 try {
  const source = fileURLToPath(new URL('./support/native-iostream-fixture.cpp', import.meta.url)), binary = join(directory, 'native'), image = join(directory, 'iostream.dylib'), options = { timeout: 30000, maxBuffer: 1000000 };
  execFileSync('clang++', ['-O1', '-std=c++17', '-DNATIVE', source, '-o', binary], options);
  execFileSync('clang++', ['-target', 'x86_64-apple-macos10.13', '-O1', '-std=c++17', '-fno-stack-protector', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', image], options);
  const native = execFileSync(binary, [], options).toString().split('\n');
  const guest = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)));
  try {
   guest.initialize();
   const text = guest.string(guest.call(guest.export('_probe_iostream'), [], { instructionBudget: 80000000, milliseconds: 20000 }), 8192).split('\n');
   const weak = guest.call(guest.export('_probe_weak'), [], { instructionBudget: 8000000, milliseconds: 10000 });
   assert.deepEqual([...text.slice(0, -1), `weak ${Number(BigInt.asUintN(32, BigInt(weak)))}`, ''], native);
  } finally { guest.close(); }
 } finally { rmSync(directory, { recursive: true, force: true }); }
}
console.log('native iostream: libc++ streambuf/ostream layout, %g/%f/%e double formatting with exact ties, integer bases, width, fill and raw output and std::weak_ptr control blocks match macOS');
