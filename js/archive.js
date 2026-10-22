// Reads .zip, .tar, .tar.gz/.tgz and .gz archives in the browser with DecompressionStream.
// Returns a Map of normalized relative paths to Uint8Array contents.
export async function readArchive(blob, name = '') {
 const bytes = new Uint8Array(await blob.arrayBuffer());
 let files;
 if (isZip(bytes)) files = await unzip(bytes);
 else if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
  const raw = await inflate(bytes, 'gzip');
  files = isTar(raw) ? untar(raw) : new Map([[name.replace(/\.gz$/i, '') || 'file', raw]]);
 } else if (isTar(bytes)) files = untar(bytes);
 else throw new Error(`Unsupported archive format${name ? ' for ' + name : ''}. Use .zip, .tar, .tar.gz or .tgz.`);
 return normalize(files);
}

const isZip = b => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
const isTar = b => b.length > 262 && String.fromCharCode(...b.subarray(257, 262)) === 'ustar';
const text = new TextDecoder();

async function inflate(bytes, format) {
 const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
 return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(bytes) {
 const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
 let end = -1;
 for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
 if (end < 0) throw new Error('Corrupt ZIP: end of central directory not found.');
 const count = view.getUint16(end + 10, true);
 let at = view.getUint32(end + 16, true);
 if (at === 0xffffffff) throw new Error('ZIP64 archives (over 4 GB or 65,535 files) are not supported.');
 const files = new Map();
 for (let n = 0; n < count; n++) {
  if (view.getUint32(at, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
  const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
  const size = view.getUint32(at + 20, true), nameLen = view.getUint16(at + 28, true);
  const extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
  const local = view.getUint32(at + 42, true);
  const path = text.decode(bytes.subarray(at + 46, at + 46 + nameLen));
  at += 46 + nameLen + extraLen + commentLen;
  if (path.endsWith('/')) continue;
  if (flags & 1) throw new Error(`${path} is encrypted; password-protected ZIPs are not supported.`);
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const data = bytes.subarray(start, start + size);
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
