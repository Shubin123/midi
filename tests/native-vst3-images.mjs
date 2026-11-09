import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deflateSync, crc32 } from 'node:zlib';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { decodePng, inflate } from '../js/native-vst3-png.js';

const chunk = (type, body) => {
 const header = Buffer.alloc(8); header.writeUInt32BE(body.length); header.write(type, 4, 'ascii');
 const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])));
 return Buffer.concat([header, body, tail]);
};
const png = ({ width, height, color, depth = 8, rows, palette, transparency }) => {
 const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = color;
 const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header)];
 if (palette) parts.push(chunk('PLTE', Buffer.from(palette)));
 if (transparency) parts.push(chunk('tRNS', Buffer.from(transparency)));
 parts.push(chunk('IDAT', deflateSync(Buffer.concat(rows.map(([filter, ...bytes]) => Buffer.from([filter, ...bytes]))))), chunk('IEND', Buffer.alloc(0)));
 return new Uint8Array(Buffer.concat(parts));
};
const images = {
 rgba: png({ width: 2, height: 2, color: 6, rows: [[0, 255, 0, 0, 255, 0, 255, 0, 128], [1, 10, 20, 30, 0, 245, 235, 225, 255]] }),
 rgb: png({ width: 3, height: 1, color: 2, rows: [[2, 1, 2, 3, 4, 5, 6, 7, 8, 9]] }),
 sub: png({ width: 3, height: 2, color: 2, rows: [[0, 9, 8, 7, 6, 5, 4, 3, 2, 1], [3, 1, 2, 3, 4, 5, 6, 7, 8, 9]] }),
 paeth: png({ width: 3, height: 2, color: 2, rows: [[0, 100, 110, 120, 130, 140, 150, 160, 170, 180], [4, 1, 2, 3, 4, 5, 6, 7, 8, 9]] }),
 palette: png({ width: 4, height: 1, color: 3, depth: 2, palette: [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9], transparency: [255, 0, 128], rows: [[0, 0b00011011]] }),
 gray: png({ width: 2, height: 1, color: 4, rows: [[0, 200, 255, 100, 128]] }),
 small: png({ width: 8, height: 1, color: 0, depth: 1, rows: [[0, 0b10100101]] }),
 opaqueWide: png({ width: 2, height: 1, color: 2, depth: 16, rows: [[0, 255, 0, 128, 0, 0, 0, 0, 255, 255, 255, 1, 0]] }),
};
for (const size of [0, 5, 70000]) {
 const source = new Uint8Array(size).map((_, index) => index * 7 % 251);
 assert.deepEqual([...inflate(new Uint8Array(deflateSync(source)).subarray(2), size)], [...source], 'inflate round trip');
}
assert.throws(() => inflate(new Uint8Array([3]), 4), /Truncated|Invalid/);
assert.equal(decodePng(new Uint8Array(64)), null, 'non-PNG data is not decoded');
const interlaced = images.rgb.slice(); interlaced[28] = 1;
assert.throws(() => decodePng(interlaced), /Interlaced/);

if (process.platform === 'darwin') {
 const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
 const directory = mkdtempSync(join(tmpdir(), 'midi-images-'));
 try {
  const source = fileURLToPath(new URL('./support/native-image-fixture.c', import.meta.url)), binary = join(directory, 'native'), image = join(directory, 'images.dylib'), options = { timeout: 20000, maxBuffer: 4000000 };
  execFileSync('clang', ['-O0', '-DNATIVE', source, '-framework', 'CoreGraphics', '-framework', 'ImageIO', '-framework', 'CoreFoundation', '-o', binary], options);
  execFileSync('clang', ['-target', 'x86_64-apple-macos10.13', '-O0', '-fno-stack-protector', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', image], options);
  for (const [name, bytes] of Object.entries(images)) {
   const file = join(directory, `${name}.png`); writeFileSync(file, bytes);
   const [summary, hex] = execFileSync(binary, [file], options).toString().trim().split('\n');
   const [ok, width, height, alpha, releases] = summary.split(' ').map(Number);
   const guest = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)));
   try {
    const input = guest.allocate(bytes.length), pixels = guest.allocate(1 << 16), numbers = guest.allocate(16);
    guest.write(input, bytes);
    const result = guest.call(guest.export('_probe_image'), [input, bytes.length, pixels, 1 << 16, numbers, numbers + 4, numbers + 8, numbers + 12], { instructionBudget: 8000000, milliseconds: 10000 });
    assert.equal(Number(BigInt.asUintN(32, BigInt(result))), ok, name);
    const fields = guest.read(numbers, 16), view = new DataView(fields.buffer, fields.byteOffset, 16);
    assert.deepEqual([0, 4, 8, 12].map(offset => view.getInt32(offset, true)), [width, height, alpha, releases], name);
    const expected = Buffer.from(hex ?? '', 'hex'), actual = guest.read(pixels, expected.length);
    expected.forEach((byte, index) => assert.ok(Math.abs(actual[index] - byte) <= (name === 'palette' ? 2 : 1), `${name} byte ${index}: guest ${actual[index]}, macOS ${byte}`));
    assert.equal([...guest.core.objects.values()].filter(object => ['provider', 'imageSource', 'image', 'bitmap', 'colorSpace'].includes(object.kind)).length, 0, `${name} objects released`);
   } finally { guest.close(); }
  }
 } finally { rmSync(directory, { recursive: true, force: true }); }
}
console.log('native images: inflate, PNG filters and color types, CoreGraphics alpha info, premultiplied drawing, provider release callbacks and object release match macOS');
