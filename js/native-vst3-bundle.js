export const bundleImports = new Set(['_CFBundleCopyBundleURL', '_CFURLGetFileSystemRepresentation', '_CFURLCopyFileSystemPath']);

export class GuestBundles {
 constructor(memory, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || !path.endsWith('.vst3') || path.includes('\0')) throw new Error('Invalid guest bundle path');
  this.memory = memory; this.path = memory.files.path(path); this.handle = 0;
 }
 main() {
  if (!this.handle) this.handle = this.memory.core.create('bundle', { path: this.path });
  return this.handle;
 }
 invoke(name, [first, second, third, fourth]) {
  const core = this.memory.core;
  switch (name) {
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
