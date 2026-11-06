// Identifies native audio plugins (VST3, AU, VST2, CLAP, AAX) from dropped files without running them.
// Reads bundle metadata, VST3 moduleinfo.json, binary headers, and macOS .pkg installers (xar + cpio). A file
// may be a LargeEntry (js/archive.js): of those only the start of a binary is read, and an installer is streamed.
import { readArchive, LargeEntry, LARGE, concat } from './archive.js';
import { parseXml, parsePlist } from './plist.js';

const BUNDLE = /^(.*?[^/]+\.(vst3|component|vst|clap|aaxplugin))(?:\/|$)/i;
const FORMATS = { vst3: 'VST3', component: 'Audio Unit', vst: 'VST2', clap: 'CLAP', aaxplugin: 'AAX' };
const AU_TYPES = { aumu: 'Instrument', aufx: 'Effect', aumf: 'Effect (MIDI controlled)', aumi: 'MIDI processor', augn: 'Generator', aupn: 'Panner', aumx: 'Mixer' };
const FRAMEWORKS = [['JUCE', /JUCE v(\d+\.\d+\.\d+)/], ['iPlug2', /iPlug2|IPlug2/], ['iPlug', /IPlug[^2]/], ['DPF', /DISTRHO/], ['VSTGUI', /VSTGUI/], ['HISE', /\bHISE\b/], ['NIH-plug', /nih_plug/], ['Cmajor', /cmajor::/]];
const SCAN_LIMIT = 64 << 20;
const latin1 = new TextDecoder('latin1'), utf8 = new TextDecoder();
const base = path => path.split('/').pop();
const attempt = fn => { try { return fn(); } catch { return null; } };

export async function identifyNative(files, depth = 0) {
 const results = [], bundles = new Map();
 // Of a large binary only the start is needed: its headers, and the strings scanned for.
 for (const [path, data] of files) if (data instanceof LargeEntry && (/\.(dll|so|dylib)$/i.test(path) || (BUNDLE.test(path) && !/\/Contents\/Resources\//.test(path)))) files.set(path, await data.head(SCAN_LIMIT));
 for (const path of files.keys()) { const m = path.match(BUNDLE); if (m && !bundles.has(m[1])) bundles.set(m[1], m[2].toLowerCase()); }
 for (const [root, ext] of bundles) results.push(describeBundle(files, root, ext));
 for (const [path, data] of files) {
  if (BUNDLE.test(path)) continue;
  const low = path.toLowerCase();
  if (/\.(dll|so|dylib)$/.test(low) && binaryInfo(data)) results.push(describeLoose(path, data));
  else if (/\.m?pkg$/.test(low) || isXar(data)) results.push(...await describePkg(path, data, depth));
  else if (low.endsWith('.dmg')) results.push(installer(path, 'macOS disk image', 'A disk image holds a whole Mac file system, which this widget does not read. Double-click it on a Mac and drop the .pkg installer, or the .vst3 or .component, inside it onto this widget.'));
  else if (/\.(exe|msi)$/.test(low)) results.push(installer(path, 'Windows installer', 'Installers are programs, so their contents cannot be listed here. After installing, drop the .vst3 from C:\\Program Files\\Common Files\\VST3.'));
  else if (depth === 0 && /\.(zip|tar|tgz|tar\.gz)$/.test(low)) {
   const inner = await readArchive(data instanceof LargeEntry ? await data.blob() : new Blob([data]), path).catch(() => null);
   if (inner) (await identifyNative(inner, 1)).forEach(r => results.push({ ...r, path: `${path} › ${r.path}` }));
  }
 }
 if (depth === 0) fillFromSiblings(results);
 return results;
}

// Builds of one plugin in several formats share a bundle ID; fill gaps from the most complete one.
function fillFromSiblings(results) {
 for (const r of results) {
  if (!r.bundleId) continue;
  const twin = results.find(o => o !== r && o.bundleId?.toLowerCase() === r.bundleId.toLowerCase() && o.kind && o.kind !== 'Unknown');
  if (!twin) continue;
  r.notes ||= [];
  if (r.kind === 'Unknown') { r.kind = twin.kind; r.notes.push(`Type taken from the ${twin.format} build of the same plugin.`); }
  if (!r.categories.length && twin.categories.length) r.categories = twin.categories;
  if (twin.vendor && (!r.vendor || r.vendor === vendorFromId(r.bundleId))) r.vendor = twin.vendor;
 }
}

function describeBundle(files, root, ext) {
 const get = rel => files.get(`${root}/${rel}`);
 const info = (get('Contents/Info.plist') && attempt(() => parsePlist(get('Contents/Info.plist')))) || {};
 const moduleInfo = get('Contents/Resources/moduleinfo.json') && attempt(() => looseJson(utf8.decode(get('Contents/Resources/moduleinfo.json'))));
 const binaries = [...files].filter(([p]) => p === root || p.startsWith(root + '/')).map(([, d]) => d).filter(binaryInfo);
 const scan = scanBinaries(binaries);
 const classes = (moduleInfo?.Classes || []).filter(c => c.Category === 'Audio Module Class');
 const au = Array.isArray(info.AudioComponents) ? info.AudioComponents[0] : null;
 const sub = classes.flatMap(c => Array.isArray(c['Sub Categories']) ? c['Sub Categories'] : String(c['Sub Categories'] || '').split('|')).filter(Boolean);
 const categories = [...new Set(sub.length ? sub : scan.categories.flatMap(c => c.split('|')))];
 const auName = au?.name?.split(':');
 return {
  path: root, format: FORMATS[ext],
  name: classes[0]?.Name || moduleInfo?.Name || auName?.[1]?.trim() || info.CFBundleName || base(root).replace(/\.[^.]+$/, ''),
  vendor: moduleInfo?.['Factory Info']?.Vendor || classes[0]?.Vendor || auName?.[0]?.trim() || vendorFromId(info.CFBundleIdentifier),
  version: classes[0]?.Version || moduleInfo?.Version || info.CFBundleShortVersionString || info.CFBundleVersion || null,
  bundleId: info.CFBundleIdentifier || null,
  kind: au ? AU_TYPES[au.type] || au.type : kindOf(categories),
  categories,
  platforms: binaries.map(binaryInfo).map(b => `${b.platform} (${b.archs.join(' + ')})`),
  frameworks: scan.frameworks,
  sdk: classes[0]?.['SDK Version'] || scan.sdk,
  minOS: info.LSMinimumSystemVersion || null,
  complete: binaries.length > 0
 };
}

function describeLoose(path, data) {
 const bin = binaryInfo(data), scan = scanBinaries([data]);
 const vst3 = scan.sdk || scan.categories.length;
 return { path, format: vst3 ? 'VST3 (single file)' : `${bin.platform} plugin library (likely VST2)`, name: base(path).replace(/\.[^.]+$/, ''),
  vendor: null, version: null, bundleId: null, kind: kindOf(scan.categories.flatMap(c => c.split('|'))), categories: scan.categories,
  platforms: [`${bin.platform} (${bin.archs.join(' + ')})`], frameworks: scan.frameworks, sdk: scan.sdk, minOS: null, complete: true };
}

const installer = (path, format, note) => ({ path, format, name: base(path), installer: true, note, categories: [], platforms: [], frameworks: [] });
const vendorFromId = id => id?.split('.').length > 2 ? id.split('.')[1] : null;
const kindOf = cats => cats.includes('Instrument') ? 'Instrument' : cats.includes('Fx') ? 'Effect' : cats.includes('Generator') ? 'Generator' : cats.includes('Analyzer') ? 'Analyzer' : 'Unknown';
const looseJson = text => JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));

export function binaryInfo(b) {
 if (!(b instanceof Uint8Array) || b.length < 64) return null;
 const v = new DataView(b.buffer, b.byteOffset, b.byteLength), be = v.getUint32(0), le = v.getUint32(0, true);
 const cpu = c => ({ 7: 'i386', 0x01000007: 'x86_64', 12: 'arm', 0x0100000c: 'arm64', 0x0200000c: 'arm64_32' })[c] || `cpu ${c}`;
 if (be === 0xcafebabe || be === 0xcafebabf) {
  const n = v.getUint32(4), size = be === 0xcafebabf ? 32 : 20;
  if (n > 0 && n < 16 && 8 + n * size <= b.length) return { platform: 'macOS', archs: Array.from({ length: n }, (_, i) => cpu(v.getUint32(8 + i * size))) };
 }
 if (le === 0xfeedfacf || le === 0xfeedface) return { platform: 'macOS', archs: [cpu(v.getUint32(4, true))] };
 if (b[0] === 0x4d && b[1] === 0x5a) {
  const pe = v.getUint32(0x3c, true);
  if (pe + 6 < b.length && v.getUint32(pe) === 0x50450000) {
   const m = v.getUint16(pe + 4, true);
   return { platform: 'Windows', archs: [({ 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'x86', 0xa641: 'arm64ec' })[m] || `machine 0x${m.toString(16)}`] };
  }
 }
 if (be === 0x0061736d) return { platform: 'WebAssembly', archs: ['wasm32'] };
 if (be === 0x7f454c46) { const m = v.getUint16(18, true); return { platform: 'Linux', archs: [({ 62: 'x86_64', 183: 'aarch64', 3: 'x86', 40: 'arm' })[m] || `machine ${m}`] }; }
 return null;
}

// Pulls VST3 sub-category strings, the VST SDK version, and framework signatures out of compiled code.
function scanBinaries(list) {
 const categories = new Set(), frameworks = new Set();
 let sdk = null;
 for (const data of list) {
  const text = latin1.decode(data.subarray(0, SCAN_LIMIT));
  for (const m of text.matchAll(/\0((?:Fx|Instrument|Spatial|Analyzer|Generator)(?:\|[A-Z][A-Za-z ]{1,20}){0,4})\0/g)) categories.add(m[1]);
  sdk ||= text.match(/VST 3\.\d+\.\d+/)?.[0] || null;
  for (const [name, re] of FRAMEWORKS) { const m = text.match(re); if (m) frameworks.add(m[1] ? `${name} ${m[1]}` : name); }
 }
 if ([...frameworks].some(f => f.startsWith('iPlug2'))) frameworks.delete('iPlug');
 return { categories: [...categories], frameworks: [...frameworks], sdk };
}

const isXar = b => b instanceof Uint8Array && b.length >= 28 && b[0] === 0x78 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21;
async function inflate(bytes, format) {
 return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format))).arrayBuffer());
}

// Reads a stream front to back: exact byte counts, skips, and the next n bytes run through a transform.
class StreamReader {
 constructor(stream) { this.reader = stream.getReader(); this.chunk = new Uint8Array(0); this.pos = 0; }
 async upTo(n) {
  while (!this.chunk.length) { const { value, done } = await this.reader.read(); if (done) return this.chunk; this.chunk = value; }
  const piece = this.chunk.subarray(0, n);
  this.chunk = this.chunk.subarray(piece.length); this.pos += piece.length;
  return piece;
 }
 async peek(n) {
  while (this.chunk.length < n) { const { value, done } = await this.reader.read(); if (done) break; this.chunk = concat([this.chunk, value]); }
  return this.chunk.subarray(0, n);
 }
 async read(n) {
  const parts = [];
  for (let got = 0; got < n;) { const piece = await this.upTo(n - got); if (!piece.length) break; parts.push(piece); got += piece.length; }
  return parts.length ? concat(parts) : new Uint8Array(0);
 }
 async skip(n) { while (n > 0) { const piece = await this.upTo(n); if (!piece.length) return; n -= piece.length; } }
 // consume() gets a reader over the next n bytes after transform; afterwards this reader is n bytes on,
 // however much of them consume() read.
 async through(n, transform, consume) {
  const writer = transform.writable.getWriter(), inner = new StreamReader(transform.readable);
  const feed = (async () => {
   try { while (n > 0) { const piece = await this.upTo(n); if (!piece.length) break; n -= piece.length; await writer.write(piece); } await writer.close(); } catch { /* consume() stopped, or the data was corrupt */ }
  })();
  try { return await consume(inner); } finally { await inner.cancel(); await feed; await this.skip(n); }
 }
 cancel() { return this.reader.cancel().catch(() => {}); }
}
const streamOf = data => data instanceof LargeEntry ? data.stream() : new Blob([data]).stream();

// macOS installer packages are xar archives; each component has a PackageInfo and a gzip cpio Payload. The heap
// is read once, front to back, so an installer of many gigabytes is streamed: the Distribution and each
// PackageInfo are kept, each Payload is unpacked and identified as it passes, and everything else is skipped.
async function describePkg(path, data, depth) {
 const r = new StreamReader(streamOf(data));
 try {
  const head = await r.read(28);
  if (!isXar(head)) return [installer(path, 'macOS installer', 'This file is not a readable xar package.')];
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const header = v.getUint16(4), tocSize = Number(v.getBigUint64(8));
  await r.skip(header - 28);
  const toc = parseXml(utf8.decode(await inflate(await r.read(tocSize), 'deflate')));
  const entries = new Map();
  const walk = (el, prefix) => el.children.filter(c => c.name === 'file').forEach(f => {
   const name = prefix + (f.children.find(c => c.name === 'name')?.text ?? '');
   const data = f.children.find(c => c.name === 'data');
   if (data) {
    const field = n => Number(data.children.find(c => c.name === n)?.text);
    entries.set(name, { offset: field('offset'), length: field('length'), encoding: data.children.find(c => c.name === 'encoding')?.attrs.style });
   }
   walk(f, name + '/');
  });
  walk(toc.children.find(c => c.name === 'xar')?.children.find(c => c.name === 'toc') ?? toc, '');
  const got = new Map(), byOffset = new Map();
  let at = 0;
  for (const [name, e] of [...entries].filter(([n]) => n === 'Distribution' || ['PackageInfo', 'Payload'].includes(base(n))).sort(([, a], [, b]) => a.offset - b.offset)) {
   if (e.offset < at) { if (byOffset.has(e.offset)) got.set(name, byOffset.get(e.offset)); continue; } // the bytes of one already read
   await r.skip(e.offset - at);
   at = e.offset + e.length;
   let value;
   if (base(name) === 'Payload') {
    const files = depth < 2 ? await unpackPayload(r, e.length) : (await r.skip(e.length), null);
    value = files ? (await identifyNative(files, depth + 1)).filter(item => !item.installer) : [];
   }
   else { const raw = await r.read(e.length); value = utf8.decode(e.encoding === 'application/x-gzip' ? await inflate(raw, 'deflate') : raw); }
   got.set(name, value); byOffset.set(e.offset, value);
  }
  const rawTitle = got.has('Distribution') && parseXml(got.get('Distribution')).children.find(c => c.children.length)?.children.find(c => c.name === 'title')?.text.trim();
  const title = rawTitle && !/^[A-Z0-9_]+$/.test(rawTitle) ? rawTitle : null;
  const results = [];
  for (const name of [...got.keys()].filter(n => base(n) === 'PackageInfo')) {
   const dir = name.slice(0, -'PackageInfo'.length);
   const pkgInfo = parseXml(got.get(name)).children.find(c => c.name === 'pkg-info');
   const declared = [];
   const findBundles = el => el.children.forEach(c => { if (c.name === 'bundle' && BUNDLE.test(c.attrs.path || '')) declared.push(c.attrs); findBundles(c); });
   if (pkgInfo) findBundles(pkgInfo);
   let found = got.get(dir + 'Payload') || [];
   if (!found.length) found = declared.map(b => ({ path: b.path.replace(/^\.\//, ''), format: FORMATS[b.path.match(BUNDLE)[2].toLowerCase()],
    name: base(b.path.match(BUNDLE)[1]).replace(/\.[^.]+$/, ''), vendor: vendorFromId(b.id), version: b.CFBundleShortVersionString || null,
    bundleId: b.id || null, kind: 'Unknown', categories: [], platforms: [], frameworks: [], sdk: null, minOS: null, complete: false }));
   const where = dir ? `${path} › ${dir.replace(/\/$/, '')}` : path;
   found.forEach(r => results.push({ ...r, path: `${where} › ${r.path}`, installLocation: pkgInfo?.attrs['install-location'], package: title || base(path) }));
  }
  return results.length ? results : [installer(path, 'macOS installer', 'No audio plugins were found in this package.')];
 } finally { await r.cancel(); }
}

// A gzip cpio Payload, unpacked as it streams past, keeping only what identifyNative reads: in a plug-in
// bundle its Info.plist, moduleinfo.json and the start of each binary; outside one, the start of each library,
// the packages and archives it opens and the installers it names. The rest (often gigabytes of samples) is
// skipped. null when the payload isn't gzip cpio.
async function unpackPayload(r, length) {
 const magic = await r.peek(2);
 if (magic[0] !== 0x1f || magic[1] !== 0x8b) { await r.skip(length); return null; }
 const files = new Map();
 return r.through(length, new DecompressionStream('gzip'), async c => {
  try {
   while (true) {
    const magic = latin1.decode(await c.read(6));
    let mode, size, name;
    if (magic === '070707') {
     const h = latin1.decode(await c.read(70));
     mode = parseInt(h.slice(12, 18), 8); size = parseInt(h.slice(59, 70), 8);
     name = utf8.decode((await c.read(parseInt(h.slice(53, 59), 8))).subarray(0, -1));
    } else if (magic === '070701' || magic === '070702') {
     const h = latin1.decode(await c.read(104)), hex = i => parseInt(h.slice(i * 8, i * 8 + 8), 16);
     mode = hex(1); size = hex(6);
     name = utf8.decode((await c.read(hex(11))).subarray(0, -1));
     await c.skip(-c.pos & 3);
    } else break;
    if (name === 'TRAILER!!!' || Number.isNaN(size)) break;
    const path = name.replace(/^\.?\//, ''), regular = (mode & 0o170000) === 0o100000;
    const head = regular ? await c.read(Math.min(size, 4096)) : new Uint8Array(0);
    const keep = !regular ? -1 : BUNDLE.test(path) ? (/\/Contents\/(Info\.plist|Resources\/moduleinfo\.json)$/.test(path) ? size : binaryInfo(head) ? Math.min(size, SCAN_LIMIT) : -1)
     : /\.(dll|so|dylib)$/i.test(path) ? Math.min(size, SCAN_LIMIT) : /\.(m?pkg|zip|tar|tgz|tar\.gz)$/i.test(path) && size < LARGE ? size : /\.(dmg|exe|msi)$/i.test(path) ? 0 : -1;
    if (keep >= 0) files.set(path, keep <= head.length ? head.subarray(0, keep) : concat([head, await c.read(keep - head.length)]));
    await c.skip(size - Math.max(head.length, keep));
    if (magic !== '070707') await c.skip(-c.pos & 3);
   }
  } catch { /* a truncated or corrupt payload: keep what was read */ }
  return files;
 });
}

// Picks the closest built-in browser effect for an identified plugin.
const STAND_INS = [['reverb', /reverb|room|hall|plate|space|ambien/i], ['delay', /delay|echo/i], ['compressor', /dynamics|compress|limit|gate|expand|level|squash|glue|punch/i],
 ['saturator', /distort|saturat|drive|tape|amp|fuzz|crush|warm/i], ['chorus', /modulation|chorus|flang|phas|ensemble|vibrato|tremolo/i], ['air', /eq|filter|exciter|enhanc|air|master|bright|presence/i]];
// The editor framework compiled into a binary (a WebAssembly VST3 that doesn't say in its editor.json), as the
// adapter id js/plugin-editor.js looks for: 'juce', 'iplug2', 'dpf' or 'vstgui', or null when none shows.
const EDITOR_FRAMEWORKS = [['juce', /JUCE v\d+\.\d+|juce::/], ['iplug2', /iPlug2|IPlug2|IGraphics/], ['dpf', /DISTRHO/], ['imgui', /Dear ImGui|ImGui::/], ['vstgui', /VSTGUI/]];
export function editorFrameworkOf(bytes) {
 const text = latin1.decode(bytes.subarray(0, SCAN_LIMIT * 4));
 return EDITOR_FRAMEWORKS.find(([, re]) => re.test(text))?.[0] || null;
}

export function standInFor(item) {
 if (item.installer || item.kind === 'Instrument' || item.kind === 'Generator') return null;
 const text = [...item.categories, item.name].join(' ');
 return STAND_INS.find(([, re]) => re.test(text))?.[0] ?? null;
}
