export const bundleImports = new Set(['_CFBundleCopyBundleURL', '_CFURLGetFileSystemRepresentation', '_CFURLCopyFileSystemPath', '_dladdr', '__NSGetExecutablePath']);

export class GuestBundles {
 constructor(memory, path, executableName) {
  if (typeof path !== 'string' || !path.startsWith('/') || !path.endsWith('.vst3') || path.includes('\0')) throw new Error('Invalid guest bundle path');
  this.memory = memory; this.path = memory.files.path(path); this.handle = 0;
  executableName ??= this.path.split('/').at(-1).slice(0, -5);
  if (typeof executableName !== 'string' || !executableName || executableName.includes('/') || executableName.includes('\0') || ['.', '..'].includes(executableName)) throw new Error('Invalid guest executable name');
  this.executablePath = `${this.path}/Contents/MacOS/${executableName}`; this.symbolNames = new Map();
 }
 main() {
  if (!this.handle) this.handle = this.memory.core.create('bundle', { path: this.path });
  return this.handle;
 }
 lookup(address, output) {
  const memory = this.memory, image = memory.image;
  if (!output || !image.segments.some(segment => address >= segment.address + memory.slide && address < segment.address + memory.slide + segment.size)) return 0;
  memory.read(output, 32);
  const header = image.segments.find(segment => segment.offset === 0 && segment.fileSize >= 32);
  if (!header) throw new Error('Mapped image has no Mach-O header');
  const base = header.address + memory.slide;
  let name = null, symbol = 0;
  if (address === base) { name = '__dso_handle'; symbol = base; }
  else {
   this.symbols ??= Array.from(image.symbols, ([name, value]) => ({ name, address: value + memory.slide })).filter(entry => entry.address !== base && image.segments.some(segment => entry.address >= segment.address + memory.slide && entry.address < segment.address + memory.slide + segment.size)).sort((left, right) => left.address - right.address);
   let low = 0, high = this.symbols.length;
   while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (this.symbols[middle].address <= address) low = middle + 1; else high = middle;
   }
   if (low) { const entry = this.symbols[low - 1]; name = entry.name.replace(/^_/, ''); symbol = entry.address; }
  }
  this.pathPointer ??= memory.objc.cstring(this.executablePath);
  if (name !== null && !this.symbolNames.has(name)) this.symbolNames.set(name, memory.objc.cstring(name));
  const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
  for (const [index, value] of [this.pathPointer, base, name === null ? 0 : this.symbolNames.get(name), symbol].entries()) view.setBigUint64(index * 8, BigInt(value), true);
  memory.write(output, bytes); return 1;
 }
 invoke(name, [first, second, third, fourth]) {
  const core = this.memory.core;
  switch (name) {
   case '__NSGetExecutablePath': {
    const size = this.memory.read(second, 4), view = new DataView(size.buffer, size.byteOffset, size.byteLength), bytes = new TextEncoder().encode(`${this.executablePath}\0`);
    if (view.getUint32(0, true) < bytes.length) { view.setUint32(0, bytes.length, true); this.memory.write(second, size); return -1; }
    this.memory.write(first, bytes); return 0;
   }
   case '_dladdr': return this.lookup(first, second);
   case '_CFBundleCopyBundleURL': return core.create('url', { path: core.object(first, 'bundle').path, directory: true });
   case '_CFURLCopyFileSystemPath':
    if (second !== 0) throw new Error('Only POSIX URL paths are supported');
    return core.string(core.object(first, 'url').path);
   case '_CFURLGetFileSystemRepresentation': {
    const path = core.object(first, 'url').path, bytes = new TextEncoder().encode(`${path}\0`);
    if (![0, 1].includes(second) || !Number.isSafeInteger(fourth) || fourth < 0 || fourth > 1 << 20) throw new Error('Invalid URL representation options');
    if (fourth < bytes.length) return 0;
    this.memory.write(third, bytes); return 1;
   }
   default: throw new Error('Unsupported bundle operation');
  }
 }
}
