// Reads .zip, .tar, .tar.gz/.tgz and .gz archives in the browser with DecompressionStream.
// Returns a Map of normalized relative paths to Uint8Array contents, or to a LargeEntry for an entry of LARGE
// bytes or more. A ZIP of LARGE bytes or more is read in slices, never whole, so a multi-gigabyte installer
// or disk image costs only its central directory.
export const LARGE = 256 << 20;

// A file too large to hold in memory, read only when asked: as a stream, or the start of it.
export class LargeEntry {
 constructor(source, size, method = 0) { this.source = source; this.size = size; this.method = method; }
 stream() {
  if (this.method === 0) return this.source.stream();
  if (this.method === 8) return this.source.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  throw new Error(`Unsupported ZIP compression method ${this.method}.`);
 }
 async head(n) {
  if (this.method === 0) return new Uint8Array(await this.source.slice(0, n).arrayBuffer());
  const reader = this.stream().getReader(), parts = [];
  for (let got = 0; got < n;) { const { value, done } = await reader.read(); if (done) break; parts.push(value); got += value.length; }
  reader.cancel().catch(() => {});
  return concat(parts).subarray(0, n);
 }
 // A Blob of the contents, to slice: a stored entry's own bytes, or a deflated one's, decompressed.
 async blob() { return this.method === 0 ? this.source : new Response(this.stream()).blob(); }
}

export async function readArchive(blob, name = '') {
 const head = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
 let files;
 if (isZip(head)) files = await unzip(blob);
 else if (head[0] === 0x1f && head[1] === 0x8b) {
  const raw = await inflate(new Uint8Array(await blob.arrayBuffer()), 'gzip');
  files = isTar(raw) ? untar(raw) : new Map([[name.replace(/\.gz$/i, '') || 'file', raw]]);
 } else if (isTar(head)) files = untar(new Uint8Array(await blob.arrayBuffer()));
 else throw new Error(`Unsupported archive format${name ? ' for ' + name : ''}. Use .zip, .tar, .tar.gz or .tgz.`);
 return normalize(files);
}

const isZip = b => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
const isTar = b => b.length > 262 && String.fromCharCode(...b.subarray(257, 262)) === 'ustar';
const text = new TextDecoder();
const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
export const concat = parts => {
 if (parts.length === 1) return parts[0];
 const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
 parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
 return out;
};

async function inflate(bytes, format) {
 const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
 return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(blob) {
 const whole = blob.size < LARGE ? new Uint8Array(await blob.arrayBuffer()) : null;
 const read = async (start, end) => whole ? whole.subarray(start, end) : new Uint8Array(await blob.slice(start, end).arrayBuffer());
 // The end record is in the last 65,557 bytes (its comment is at most 65,535), a ZIP64 locator just before it.
 const tailStart = Math.max(0, blob.size - 65557 - 20), tail = await read(tailStart, blob.size), tv = view(tail);
 let end = -1;
 for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { end = i; break; }
 if (end < 0) throw new Error('Corrupt ZIP: end of central directory not found.');
 let count = tv.getUint16(end + 10, true), dirSize = tv.getUint32(end + 12, true), at = tv.getUint32(end + 16, true);
 // ZIP64 (over 4 GB or 65,535 files): the real count, size and offset are in the record the locator points to.
 if ((count === 0xffff || dirSize === 0xffffffff || at === 0xffffffff) && end >= 20 && tv.getUint32(end - 20, true) === 0x07064b50) {
  const rec = Number(tv.getBigUint64(end - 12, true)), z = view(await read(rec, rec + 56));
  if (z.getUint32(0, true) !== 0x06064b50) throw new Error('Corrupt ZIP64 end of central directory.');
  count = Number(z.getBigUint64(32, true)); dirSize = Number(z.getBigUint64(40, true)); at = Number(z.getBigUint64(48, true));
 }
 const dir = await read(at, at + dirSize), dv = view(dir);
 const files = new Map();
 for (let n = 0, p = 0; n < count; n++) {
  if (p + 46 > dir.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
  const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
  let packed = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true), local = dv.getUint32(p + 42, true);
  const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
  const path = text.decode(dir.subarray(p + 46, p + 46 + nameLen));
  // The ZIP64 extra field (id 1) holds, in this order, the sizes and offset that read 0xffffffff above.
  for (let x = p + 46 + nameLen, stop = x + extraLen; x + 4 <= stop; x += 4 + dv.getUint16(x + 2, true)) {
   if (dv.getUint16(x, true) !== 1) continue;
   let f = x + 4;
   const next = () => { const v = Number(dv.getBigUint64(f, true)); f += 8; return v; };
   if (size === 0xffffffff) size = next();
   if (packed === 0xffffffff) packed = next();
   if (local === 0xffffffff) local = next();
   break;
  }
  p += 46 + nameLen + extraLen + commentLen;
  if (path.endsWith('/')) continue;
  if (flags & 1) throw new Error(`${path} is encrypted; password-protected ZIPs are not supported.`);
  const lv = view(await read(local, local + 30));
  const start = local + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
  if (size >= LARGE) { files.set(path, new LargeEntry(blob.slice(start, start + packed), size, method)); continue; }
  const data = await read(start, start + packed);
  if (method === 0) files.set(path, data);
  else if (method === 8) files.set(path, await inflate(data, 'deflate-raw'));
  else throw new Error(`${path} uses unsupported ZIP compression method ${method}.`);
 }
 return files;
}

function untar(bytes) {
 const files = new Map();
 const field = (h, start, len) => text.decode(h.subarray(start, start + len)).replace(/\0.*$/s, '');
 let at = 0, longName = null, paxPath = null;
 while (at + 512 <= bytes.length) {
  const h = bytes.subarray(at, at + 512);
  if (h.every(b => b === 0)) break;
  const size = parseInt(field(h, 124, 12).trim() || '0', 8);
  const type = String.fromCharCode(h[156] || 48);
  const prefix = field(h, 345, 155);
  const data = bytes.subarray(at + 512, at + 512 + size);
  const path = paxPath ?? longName ?? (prefix ? prefix + '/' : '') + field(h, 0, 100);
  at += 512 + Math.ceil(size / 512) * 512;
  if (type === 'L') { longName = text.decode(data).replace(/\0.*$/s, ''); continue; }
  if (type === 'x') { paxPath = text.decode(data).match(/^\d+ path=(.*)$/m)?.[1] ?? null; continue; }
  longName = paxPath = null;
  if (type === '0' || type === '7') files.set(path, data);
 }
 return files;
}

// Drops macOS metadata, rejects path traversal, and strips a single shared top-level folder.
function normalize(files) {
 const clean = new Map();
 for (const [raw, data] of files) {
  const parts = raw.replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
  if (parts.includes('..') || parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store' || parts.at(-1)?.startsWith('._')) continue;
  clean.set(parts.join('/'), data);
 }
 const roots = new Set([...clean.keys()].map(p => p.split('/')[0]));
 // A plug-in bundle folder (Name.vst3/, Name.component/, ...) is the plug-in itself, never a wrapper to strip.
 if (roots.size === 1 && [...clean.keys()].every(p => p.includes('/')) && !/\.(vst3|component|vst|clap|aaxplugin)$/i.test([...roots][0])) {
  return new Map([...clean].map(([p, d]) => [p.slice(p.indexOf('/') + 1), d]));
 }
 return clean;
}

// Writes an uncompressed ZIP (method 0) from a Map of paths to Uint8Array contents.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = data => { let c = 0xffffffff; for (const b of data) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function writeZip(files) {
 const parts = [], central = [], enc = new TextEncoder();
 let offset = 0;
 for (const [path, data] of files) {
  const name = enc.encode(path), crc = crc32(data);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint32(14, crc, true);
  local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true);
  const dir = new DataView(new ArrayBuffer(46));
  dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint32(16, crc, true);
  dir.setUint32(20, data.length, true); dir.setUint32(24, data.length, true); dir.setUint16(28, name.length, true); dir.setUint32(42, offset, true);
  parts.push(local, name, data); central.push(dir, name);
  offset += 30 + name.length + data.length;
 }
 const size = central.reduce((n, p) => n + p.byteLength, 0), end = new DataView(new ArrayBuffer(22));
 end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.size, true); end.setUint16(10, files.size, true);
 end.setUint32(12, size, true); end.setUint32(16, offset, true);
 return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
