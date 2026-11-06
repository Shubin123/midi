import { readArchive, LargeEntry, concat } from './archive.js';
import { parseXml } from './plist.js';

const MAX_BINARY = 256 << 20, MAX_TOC = 16 << 20;
const text = new TextDecoder();
const binaryPath = /\.vst3\/Contents\/MacOS\/[^/]+$/i;
const fail = message => { throw new Error(`Native input: ${message}`); };

class Reader {
 constructor(stream) { this.reader = stream.getReader(); this.chunk = new Uint8Array(0); this.position = 0; }
 async piece(size) {
  while (!this.chunk.length) {
   const { value, done } = await this.reader.read();
   if (done) fail('truncated payload');
   this.chunk = value;
  }
  const result = this.chunk.subarray(0, size);
  this.chunk = this.chunk.subarray(result.length); this.position += result.length;
  return result;
 }
 async read(size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BINARY) fail('read exceeds size limit');
  const parts = [];
  for (let remaining = size; remaining;) { const part = await this.piece(remaining); parts.push(part); remaining -= part.length; }
  return parts.length ? concat(parts) : new Uint8Array(0);
 }
 async skip(size) {
  if (!Number.isSafeInteger(size) || size < 0) fail('invalid skip size');
  while (size) size -= (await this.piece(size)).length;
 }
 async close() { await this.reader.cancel().catch(() => {}); }
}

async function cpio(blob) {
 const reader = new Reader(blob.stream().pipeThrough(new DecompressionStream('gzip')));
 try {
  for (let index = 0; index < 100000; index++) {
   const magic = text.decode(await reader.read(6));
   let mode, size, nameSize, aligned = false;
   if (magic === '070707') {
    const header = text.decode(await reader.read(70));
    mode = parseInt(header.slice(12, 18), 8); nameSize = parseInt(header.slice(53, 59), 8); size = parseInt(header.slice(59, 70), 8);
   } else if (magic === '070701' || magic === '070702') {
    const header = text.decode(await reader.read(104)), field = index => parseInt(header.slice(index * 8, index * 8 + 8), 16);
    mode = field(1); size = field(6); nameSize = field(11); aligned = true;
   } else fail('unsupported cpio payload');
   if (!Number.isSafeInteger(mode) || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(nameSize) || nameSize < 1 || nameSize > 4096) fail('invalid cpio header');
   const nameBytes = await reader.read(nameSize);
   if (nameBytes.at(-1) !== 0) fail('unterminated cpio name');
   const name = text.decode(nameBytes.subarray(0, -1)).replace(/^\.\//, '');
   if (aligned) await reader.skip(-reader.position & 3);
   if (name === 'TRAILER!!!') return null;
   if ((mode & 0o170000) === 0o100000 && binaryPath.test(name)) {
    if (size > MAX_BINARY) fail('plugin binary exceeds 256 MiB');
    return { name, bytes: await reader.read(size) };
   }
   await reader.skip(size);
   if (aligned) await reader.skip(-reader.position & 3);
  }
  fail('too many cpio entries');
 } finally { await reader.close(); }
}

async function packageBinary(blob) {
 const header = new Uint8Array(await blob.slice(0, 28).arrayBuffer());
 if (header.length !== 28) fail('truncated xar header');
 const view = new DataView(header.buffer), headerSize = view.getUint16(4), packed = Number(view.getBigUint64(8)), unpacked = Number(view.getBigUint64(16));
 if (headerSize < 28 || view.getUint16(6) !== 1 || !Number.isSafeInteger(packed) || packed < 1 || packed > MAX_TOC || unpacked > MAX_TOC || headerSize + packed > blob.size) fail('invalid xar table of contents');
 const reader = new Reader(blob.slice(headerSize, headerSize + packed).stream().pipeThrough(new DecompressionStream('deflate')));
 let toc;
 try { toc = parseXml(text.decode(await reader.read(unpacked))); } finally { await reader.close(); }
 const entries = [], heap = headerSize + packed;
 const walk = (element, prefix = '', depth = 0) => {
  if (depth > 64) fail('xar nesting exceeds limit');
  for (const file of element.children.filter(child => child.name === 'file')) {
   const name = prefix + (file.children.find(child => child.name === 'name')?.text || '');
   const data = file.children.find(child => child.name === 'data');
   if (data && /(?:^|\/)Payload$/.test(name)) {
    const field = key => Number(data.children.find(child => child.name === key)?.text);
    const offset = field('offset'), length = field('length');
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || heap + offset > blob.size - length) fail('xar payload exceeds file');
    entries.push({ name, offset: heap + offset, length });
   }
   walk(file, `${name}/`, depth + 1);
  }
 };
 const root = toc.children.find(child => child.name === 'xar')?.children.find(child => child.name === 'toc');
 if (!root) fail('missing xar toc');
 walk(root);
 entries.sort((left, right) => Number(/vst3/i.test(right.name)) - Number(/vst3/i.test(left.name)));
 for (const entry of entries) {
  const magic = new Uint8Array(await blob.slice(entry.offset, entry.offset + 2).arrayBuffer());
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) continue;
  const result = await cpio(blob.slice(entry.offset, entry.offset + entry.length));
  if (result) return { ...result, source: entry.name };
 }
 fail('no macOS VST3 executable found in package');
}

export async function readNativeVst3(blob, name = blob.name || 'plugin') {
 const magic = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
 if (text.decode(magic) === 'xar!') return packageBinary(blob);
 if (magic[0] === 0x50 && magic[1] === 0x4b) {
  const entries = await readArchive(blob, name);
  const binaries = [...entries].filter(([path]) => binaryPath.test(path));
  if (binaries.length !== 1) fail(`expected one macOS VST3 executable in ZIP, found ${binaries.length}`);
  const [path, data] = binaries[0];
  const binary = data instanceof LargeEntry ? await data.blob() : new Blob([data]);
  if (binary.size > MAX_BINARY) fail('plugin binary exceeds 256 MiB');
  return { name: path, bytes: new Uint8Array(await binary.arrayBuffer()) };
 }
 if (blob.size > MAX_BINARY) fail('plugin binary exceeds 256 MiB');
 return { name, bytes: new Uint8Array(await blob.arrayBuffer()) };
}
