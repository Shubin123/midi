import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

if (!process.env.NATIVE_ENGINE_CHILD) {
 const output = execFileSync(process.execPath, [new URL(import.meta.url).pathname], {
  env: { ...process.env, NATIVE_ENGINE_CHILD: '1' }, timeout: 30000, encoding: 'utf8', maxBuffer: 100000,
 });
 process.stdout.write(output);
} else {
 const { createRequire } = await import('node:module');
 const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
 const engine = new uc.Unicorn(uc.ARCH_X86, uc.MODE_64), hooks = [];
 try {
  engine.mem_map(0x10000, 65536, uc.PROT_ALL);
  engine.mem_map(0x20000, 4096, uc.PROT_READ | uc.PROT_WRITE);
  const code = [];
  for (let index = 0; index < 512; index++) code.push(0x48, 0xb8, 0x22, 0x88, 0x8d, 0xdb, 0x15, 0x6e, 0x45, 0xae, 0x48, 0x89, 0x07, 0x48, 0x8b, 0x07);
  code.push(0x90);
  engine.mem_write(0x10000, code);
  engine.reg_write_i64(uc.X86_REG_RDI, 0x20000n);
  hooks.push(engine.hook_add(uc.HOOK_MEM_READ, () => {}, {}, 0x50000000, 0x500ff000));
  hooks.push(engine.hook_add(uc.HOOK_CODE, () => {}, {}, 0x50000000, 0x500ff000));
  engine.emu_start(0x10000, 0x10000 + code.length, 0, 0);
  assert.equal(BigInt.asUintN(64, engine.reg_read_i64(uc.X86_REG_RAX)), 0xae456e15db8d8822n);
  assert.deepEqual([...engine.mem_read(0x20000, 8)], [0x22, 0x88, 0x8d, 0xdb, 0x15, 0x6e, 0x45, 0xae]);
  const vector = [0x66, 0x48, 0x0f, 0x6e, 0xc8, 0x66, 0x0f, 0xc5, 0xc1, 0x00, 0x66, 0x0f, 0xc5, 0xd9, 0x03, 0x90];
  engine.mem_write(0x18000, vector);
  engine.reg_write_i64(uc.X86_REG_RAX, 0xfedcba9876543210n);
  engine.emu_start(0x18000, 0x18000 + vector.length, 0, 0);
  assert.equal(BigInt.asUintN(64, engine.reg_read_i64(uc.X86_REG_RAX)), 0x3210n, 'pextrw reads the low word');
  assert.equal(BigInt.asUintN(64, engine.reg_read_i64(uc.X86_REG_RBX)), 0xfedcn, 'pextrw reads the high word');
  console.log('native engine: 512 instrumented load/store groups execute without TCI temporary exhaustion and pextrw loads execute');
 } finally {
  for (const hook of hooks) engine.hook_del(hook);
  engine.close();
 }
}
