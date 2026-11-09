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
 const directory = mkdtempSync(join(tmpdir(), 'midi-libc-'));
 try {
  const source = fileURLToPath(new URL('./support/native-libc-fixture.c', import.meta.url)), binary = join(directory, 'native'), image = join(directory, 'libc.dylib'), options = { timeout: 15000, maxBuffer: 1000000 };
  execFileSync('clang', ['-O0', '-fno-builtin', '-DNATIVE', source, '-lm', '-o', binary], options);
  execFileSync('clang', ['-target', 'x86_64-apple-macos10.13', '-O0', '-fno-builtin', '-fno-stack-protector', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', image], options);
  const native = execFileSync(binary, [], options).toString().trim();
  const guest = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)));
  try {
   const size = guest.allocate(8), data = guest.call(guest.export('_probe_libc'), [size], { instructionBudget: 20000000, milliseconds: 15000 });
   const length = guest.pointer(size), result = Buffer.from(guest.read(data, length)).toString('hex');
   assert.equal(result.length, native.length);
   for (let index = 0; index < native.length; index += 16) assert.equal(result.slice(index, index + 16), native.slice(index, index + 16), `byte offset ${index / 2}`);
  } finally { guest.close(); }
 } finally { rmSync(directory, { recursive: true, force: true }); }
}
console.log('native libc: compiled strtoll, rounding, frexp/modf, ldexp, fmod, case-insensitive compare, strstr and strlcpy match macOS bit for bit');
