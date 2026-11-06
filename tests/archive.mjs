import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArchive } from '../js/archive.js';

const blob = path => new Blob([readFileSync(path)]);
const text = bytes => new TextDecoder().decode(bytes);

// The bundled example: deflated ZIP with plugin.json at the root.
const air = await readArchive(blob(new URL('../plugins/air.zip', import.meta.url)), 'air.zip');
assert.deepEqual(JSON.parse(text(air.get('plugin.json'))).main, 'index.js');
assert.match(text(air.get('index.js')), /export default function createPlugin/);

// A shared top folder, macOS metadata, and stored + deflated entries in ZIP and tar.gz.
const dir = mkdtempSync(join(tmpdir(), 'archive-test-'));
mkdirSync(join(dir, 'Pkg', 'lib'), { recursive: true });
mkdirSync(join(dir, '__MACOSX'));
writeFileSync(join(dir, 'Pkg', 'index.js'), 'export default 1;'.repeat(50));
writeFileSync(join(dir, 'Pkg', 'lib', 'a.txt'), 'a');
writeFileSync(join(dir, 'Pkg', '.DS_Store'), 'x');
writeFileSync(join(dir, '__MACOSX', '._index.js'), 'x');
execFileSync('zip', ['-q', '-r', 'p.zip', 'Pkg', '__MACOSX'], { cwd: dir });
execFileSync('zip', ['-q', '-0', '-r', 'stored.zip', 'Pkg'], { cwd: dir });
execFileSync('tar', ['-czf', 'p.tar.gz', 'Pkg'], { cwd: dir });
execFileSync('tar', ['-cf', 'p.tar', 'Pkg'], { cwd: dir });
for (const name of ['p.zip', 'stored.zip', 'p.tar.gz', 'p.tar']) {
 const files = await readArchive(blob(join(dir, name)), name);
 assert.deepEqual([...files.keys()].sort(), ['index.js', 'lib/a.txt'], name);
 assert.equal(text(files.get('index.js')), 'export default 1;'.repeat(50), name);
}
await assert.rejects(readArchive(new Blob(['7z\xBC\xAF\x27\x1C']), 'x.7z'), /Unsupported archive format/);

console.log('Archive reading passed.');

// Round-trip through the ZIP writer used to export captured plugins.
const { writeZip } = await import('../js/archive.js');
const written = new Map([['plugin.json', new TextEncoder().encode('{"a":1}')], ['dir/ir.f32', new Uint8Array([1, 2, 3, 250])]]);
const back = await readArchive(writeZip(written), 'x.zip');
assert.deepEqual([...back.keys()], ['plugin.json', 'dir/ir.f32']);
assert.deepEqual([...back.get('dir/ir.f32')], [1, 2, 3, 250]);
writeFileSync(join(dir, 'written.zip'), Buffer.from(await writeZip(written).arrayBuffer()));
execFileSync('unzip', ['-tq', join(dir, 'written.zip')]);
const bundle = await readArchive(writeZip(new Map([['Synth.vst3/Contents/x', new Uint8Array([1])]])), 'synth.zip');
assert.deepEqual([...bundle.keys()], ['Synth.vst3/Contents/x'], 'a lone plug-in bundle folder must be kept');
console.log('ZIP writer round-trip passed.');

// ZIP64, as tools write archives over 4 GB: 0xffffffff in the sizes and offsets, the real values in each entry's
// ZIP64 extra field, and the count and directory offset in a ZIP64 end record found through its locator.
const { crc32 } = await import('node:zlib');
function zip64(entries) {
 const parts = [], central = [], u64 = (v, at, n) => v.setBigUint64(at, BigInt(n), true);
 let offset = 0;
 for (const [path, data] of entries) {
  const name = new TextEncoder().encode(path), crc = crc32(data);
  const local = new DataView(new ArrayBuffer(30 + name.length + 20));
  local.setUint32(0, 0x04034b50, true); local.setUint16(4, 45, true); local.setUint32(14, crc, true);
  local.setUint32(18, 0xffffffff, true); local.setUint32(22, 0xffffffff, true); local.setUint16(26, name.length, true); local.setUint16(28, 20, true);
  new Uint8Array(local.buffer).set(name, 30);
  local.setUint16(30 + name.length, 1, true); local.setUint16(32 + name.length, 16, true); u64(local, 34 + name.length, data.length); u64(local, 42 + name.length, data.length);
  const dir = new DataView(new ArrayBuffer(46 + name.length + 28));
  dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 45, true); dir.setUint16(6, 45, true); dir.setUint32(16, crc, true);
  dir.setUint32(20, 0xffffffff, true); dir.setUint32(24, 0xffffffff, true); dir.setUint16(28, name.length, true); dir.setUint16(30, 28, true); dir.setUint32(42, 0xffffffff, true);
  new Uint8Array(dir.buffer).set(name, 46);
  dir.setUint16(46 + name.length, 1, true); dir.setUint16(48 + name.length, 24, true);
  u64(dir, 50 + name.length, data.length); u64(dir, 58 + name.length, data.length); u64(dir, 66 + name.length, offset);
  parts.push(local, data); central.push(dir);
  offset += local.byteLength + data.length;
 }
 const size = central.reduce((n, d) => n + d.byteLength, 0);
 const end = new DataView(new ArrayBuffer(56 + 20 + 22));
 end.setUint32(0, 0x06064b50, true); u64(end, 4, 44); end.setUint16(12, 45, true); end.setUint16(14, 45, true);
 u64(end, 24, entries.length); u64(end, 32, entries.length); u64(end, 40, size); u64(end, 48, offset);
 end.setUint32(56, 0x07064b50, true); u64(end, 64, offset + size); end.setUint32(72, 1, true);
 end.setUint32(76, 0x06054b50, true); end.setUint16(84, 0xffff, true); end.setUint16(86, 0xffff, true); end.setUint32(88, 0xffffffff, true); end.setUint32(92, 0xffffffff, true);
 return new Uint8Array(Buffer.concat([...parts, ...central, end].map(p => p instanceof DataView ? new Uint8Array(p.buffer) : p)));
}
writeFileSync(join(dir, 'z64.zip'), zip64([['Pkg/a.txt', new TextEncoder().encode('first')], ['Pkg/b/c.txt', new TextEncoder().encode('second')]]));
execFileSync('unzip', ['-tq', join(dir, 'z64.zip')]);
const z64 = await readArchive(blob(join(dir, 'z64.zip')), 'z64.zip');
assert.deepEqual([...z64].map(([p, d]) => [p, text(d)]), [['a.txt', 'first'], ['b/c.txt', 'second']]);
console.log('ZIP64 passed.');

// An entry of LARGE bytes or more is left unread (a LargeEntry), deflated or stored, and an archive of LARGE bytes
// or more is read in slices: here a disk image of zeros beside a small file.
const { LARGE, LargeEntry } = await import('../js/archive.js');
mkdirSync(join(dir, 'big'));
writeFileSync(join(dir, 'big', 'Installer.dmg'), Buffer.alloc(LARGE + 4096));
writeFileSync(join(dir, 'big', 'readme.txt'), 'small');
execFileSync('zip', ['-q', 'deflated.zip', 'Installer.dmg', 'readme.txt'], { cwd: join(dir, 'big') });
execFileSync('zip', ['-q', '-0', 'stored.zip', 'Installer.dmg', 'readme.txt'], { cwd: join(dir, 'big') });
for (const [name, method] of [['deflated.zip', 8], ['stored.zip', 0]]) {
 const files = await readArchive(blob(join(dir, 'big', name)), name), dmg = files.get('Installer.dmg');
 assert.equal(text(files.get('readme.txt')), 'small', name);
 assert.ok(dmg instanceof LargeEntry, name);
 assert.equal(dmg.size, LARGE + 4096, name);
 assert.equal(dmg.method, method, name);
 assert.deepEqual([...await dmg.head(8)], [0, 0, 0, 0, 0, 0, 0, 0], name);
 let streamed = 0;
 for await (const chunk of dmg.stream()) streamed += chunk.length;
 assert.equal(streamed, LARGE + 4096, name);
}
rmSync(join(dir, 'big'), { recursive: true });
console.log('Large entries passed: left unread, then streamed in full.');
