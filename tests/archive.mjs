import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
