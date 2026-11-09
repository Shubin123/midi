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
 const directory = mkdtempSync(join(tmpdir(), 'midi-accelerate-'));
 try {
  const source = fileURLToPath(new URL('./support/native-accelerate-fixture.c', import.meta.url)), binary = join(directory, 'native'), image = join(directory, 'accelerate.dylib'), options = { timeout: 15000, maxBuffer: 4000000 };
  execFileSync('clang', ['-O0', '-DNATIVE', source, '-framework', 'Accelerate', '-o', binary], options);
  execFileSync('clang', ['-target', 'x86_64-apple-macos10.13', '-O0', '-fno-stack-protector', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', image], options);
  const native = execFileSync(binary, [], options).toString().trim().split('\n').map(Number);
  const guest = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)));
  try {
   const size = guest.allocate(4), data = guest.call(guest.export('_probe_accelerate'), [size], { instructionBudget: 20000000, milliseconds: 15000 });
   const bytes = guest.read(size, 4), length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
   assert.equal(length, native.length);
   const raw = guest.read(data, length * 4), view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
   native.forEach((expected, index) => {
    const actual = view.getFloat32(index * 4, true);
    assert.ok(Math.abs(actual - expected) <= 1e-4 * Math.max(1, Math.abs(expected)), `value ${index}: guest ${actual}, macOS ${expected}`);
   });
  } finally { guest.close(); }
 } finally { rmSync(directory, { recursive: true, force: true }); }
}
console.log('native Accelerate: vector arithmetic, strides, statistics, split-complex packing, real and complex FFT scaling and vForce match macOS');
