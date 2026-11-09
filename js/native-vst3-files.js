const MAX_DESCRIPTORS = 256, MAX_RESOURCES = 64 << 20, MAX_OUTPUT = 64 << 10;
const CLOEXEC = 0x1000000, NONBLOCK = 4, APPEND = 8;

class ContentBytes {
 constructor(size, read) { this.length = size; this.read = read; }
 slice(start = 0, end = this.length) {
  const low = Math.min(start, this.length), high = Math.min(end, this.length);
  return high > low ? this.read(low, high - low) : new Uint8Array();
 }
 materialize() { return this.slice(); }
}

export class GuestFileError extends Error {
 constructor(errno, message) { super(message); this.errno = errno; }
}
const fail = (errno, message) => { throw new GuestFileError(errno, message); };

export class GuestFiles {
 constructor(files = new Map()) {
  this.contentFiles = 0; this.contentRoot = null; this.files = new Map(); this.descriptors = new Map(); this.softLimit = MAX_DESCRIPTORS; this.hardLimit = MAX_DESCRIPTORS;
  this.homeDirectory = '/Users/plugin'; this.temporaryDirectory = '/tmp'; this.workingDirectory = '/plugin'; this.imageBytes = 0;
  this.directories = new Set(['/', '/plugin', '/Users', this.homeDirectory, this.temporaryDirectory]);
  this.directoryModes = new Map([[this.homeDirectory, 0o700], [this.temporaryDirectory, 0o1777]]); this.directoryTimes = new Map(); this.resourceBytes = 0; this.clock = () => Date.now();
  this.stdout = { data: new Uint8Array(), stream: true, writable: true };
  this.stderr = { data: new Uint8Array(), stream: true, writable: true };
  for (const [descriptor, resource] of [[0, { data: new Uint8Array(), stream: true, readable: true }], [1, this.stdout], [2, this.stderr]]) {
   this.descriptors.set(descriptor, { flags: 0, description: { resource, position: 0n, flags: descriptor ? 1 : 0 } });
  }
  let total = 0;
  for (const [name, bytes] of files) {
   if (this.files.size >= 4096) throw new Error('Guest resource count exceeds 4096 files');
   const path = this.path(name);
   if (!(bytes instanceof Uint8Array) || (total += bytes.length) > MAX_RESOURCES) throw new Error('Guest mounted resources exceed 64 MiB');
   if (this.files.has(path) || this.directories.has(path)) throw new Error('Duplicate or invalid guest resource path');
   this.files.set(path, { data: bytes.slice(), readable: true, path, mounted: true, mode: 0o444 });
  }
  this.resourceBytes = total;
 }
 mountContent({ root, directories = [], files = [] }) {
  if (this.contentRoot) throw new Error('Guest content is already mounted');
  this.contentRoot = this.path(root);
  const time = this.now(), ensure = path => { for (let current = path; current !== '/' && !this.directories.has(current); current = this.parent(current)) { this.directories.add(current); this.directoryModes.set(current, this.writablePath(current) ? 0o777 : 0o555); } };
  ensure(this.contentRoot);
  for (const directory of directories) ensure(this.path(`${root}/${directory}`));
  for (const { path, size, read } of files) {
   const full = this.path(`${root}/${path}`);
   ensure(this.parent(full));
   this.files.set(full, { path: full, data: new ContentBytes(size, read), readable: true, writable: true, mounted: false, content: true, mode: 0o666, birthtime: time, atime: time, mtime: time, ctime: time });
  }
  this.contentFiles = files.length;
 }
 mountImage(name, bytes) {
  const path = this.path(name);
  if (this.imageBytes || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 256 << 20) throw new Error('Invalid guest executable image');
  if (this.files.size - this.contentFiles >= 4096 || this.files.has(path) || this.directories.has(path) || [...this.files.keys(), ...this.directories].some(name => name.startsWith(`${path}/`))) throw new Error('Guest executable path conflicts with mounted resources');
  for (let parent = this.parent(path); parent !== '/'; parent = this.parent(parent)) if (this.files.has(parent)) throw new Error('Guest executable path traverses a regular file');
  this.files.set(path, { data: bytes.slice(), readable: true, path, mounted: true, image: true, mode: 0o555 }); this.imageBytes = bytes.length;
 }
 path(name) {
  if (typeof name !== 'string' || name.includes('\0') || name.length > 4096) fail(22, 'Invalid guest file path');
  const parts = [];
  for (const part of (name.startsWith('/') ? name : `${this.workingDirectory}/${name}`).split('/')) {
   if (!part || part === '.') continue;
   if (part === '..') parts.pop(); else parts.push(part);
  }
  return `/${parts.join('/')}`;
 }
 descriptor(number) {
  const descriptor = this.descriptors.get(number);
  if (!descriptor) fail(9, 'Invalid guest file descriptor');
  return descriptor;
 }
 lookup(name) {
  if (!name) fail(2, 'Empty guest file path');
  const path = this.path(name), resource = this.files.get(path), components = path.split('/').filter(Boolean);
  for (let index = 1; index < components.length; index++) if (this.files.has(`/${components.slice(0, index).join('/')}`)) fail(20, 'Guest path traverses a regular file');
  if (resource) { if (name.endsWith('/')) fail(20, 'Guest file is not a directory'); return { path, resource, directory: false }; }
  if (this.directories.has(path) || [...this.files.keys()].some(name => name.startsWith(`${path}/`))) return { path, directory: true };
  fail(2, 'Guest file is not mounted');
 }
 descendants(name) {
  const { path, directory } = this.lookup(name), prefix = path === '/' ? '/' : `${path}/`;
  if (!directory) return [];
  return [...new Set([...this.files.keys(), ...this.directories].filter(entry => entry.startsWith(prefix) && entry !== path).map(entry => entry.slice(prefix.length)))].sort();
 }
 access(name, mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 7) fail(22, 'Invalid guest access mode');
  const record = this.lookup(name);
  if (mode & 2 && (!this.writablePath(record.path) || record.resource?.mounted)) fail(30, 'Guest resources are read-only');
  const permissions = record.directory ? this.directoryMode(record.path) : record.resource.mode;
  if (mode & 4 && !(permissions & 0o400) || mode & 2 && !(permissions & 0o200) || mode & 1 && !(permissions & 0o100)) fail(13, 'Guest resource permission denied');
  return 0;
 }
 readlink(name) { this.lookup(name); fail(22, 'Guest path is not a symbolic link'); }
 writablePath(path) { return [this.homeDirectory, this.temporaryDirectory, this.contentRoot].some(root => root && path === root || path.startsWith(`${root}/`)); }
 directoryMode(path) { return this.directoryModes.get(path) ?? (this.writablePath(path) ? 0o755 : 0o555); }
 parent(path) { return path.slice(0, path.lastIndexOf('/')) || '/'; }
 now() { const value = Math.trunc(this.clock()); if (!Number.isSafeInteger(value)) throw new Error('Invalid guest filesystem clock'); return value; }
 touchDirectory(path) { this.directoryTimes.set(path, { ...this.directoryTimes.get(path), mtime: this.now(), ctime: this.now() }); }
 writableParent(path) {
  if (!this.writablePath(path)) fail(30, 'Guest resources are read-only');
  const parent = this.lookup(this.parent(path));
  if (!parent.directory) fail(20, 'Guest parent is not a directory');
  if ((this.directoryMode(parent.path) & 0o300) !== 0o300) fail(13, 'Guest parent is not writable');
 }
 mkdir(name, mode) {
  if (!name) fail(2, 'Empty guest file path');
  const path = this.path(name);
  try { this.lookup(path); fail(17, 'Guest path already exists'); } catch (error) { if (!(error instanceof GuestFileError) || error.errno !== 2) throw error; }
  this.writableParent(path);
  if (this.directories.size >= 4096) fail(28, 'Guest directory limit exceeded');
  this.directories.add(path); this.directoryModes.set(path, mode & 0o7777 & ~0o022);
  const time = this.now(); this.directoryTimes.set(path, { birthtime: time, atime: time, mtime: time, ctime: time }); this.touchDirectory(this.parent(path)); return 0;
 }
 remove(name) {
  const record = this.lookup(name), path = record.path;
  if (path === this.homeDirectory || path === this.temporaryDirectory) fail(16, 'Cannot remove a guest mount root');
  this.writableParent(path);
  const files = [...this.files].filter(([name]) => name === path || record.directory && name.startsWith(`${path}/`));
  if (files.some(([, resource]) => resource.mounted)) fail(30, 'Mounted guest resources are read-only');
  for (const [name, resource] of files) {
   this.files.delete(name); resource.unlinked = true; resource.ctime = this.now();
   if (![...this.descriptors.values()].some(descriptor => descriptor.description.resource === resource)) this.resourceBytes -= resource.data.length;
  }
  if (record.directory) for (const name of [...this.directories]) if (name === path || name.startsWith(`${path}/`)) { this.directories.delete(name); this.directoryModes.delete(name); this.directoryTimes.delete(name); }
  this.touchDirectory(this.parent(path));
  return 0;
 }
 rename(from, to) {
  const source = this.lookup(from), target = this.path(to);
  if (source.path === target) return 0;
  this.writableParent(source.path); this.writableParent(target);
  if (source.directory) {
   const prefix = `${source.path}/`;
   if (target.startsWith(prefix)) fail(22, 'Cannot move a guest directory inside itself');
   for (const name of [...this.directories]) if (name === source.path || name.startsWith(prefix)) { const moved = target + name.slice(source.path.length); this.directories.delete(name); this.directories.add(moved); if (this.directoryModes.has(name)) { this.directoryModes.set(moved, this.directoryModes.get(name)); this.directoryModes.delete(name); } }
   for (const [name, resource] of [...this.files]) if (name.startsWith(prefix)) { const moved = target + name.slice(source.path.length); this.files.delete(name); resource.path = moved; this.files.set(moved, resource); }
  } else {
   const existing = this.files.get(target);
   if (this.directories.has(target)) fail(21, 'Guest rename target is a directory');
   if (existing?.mounted) fail(30, 'Mounted guest resources are read-only');
   if (existing && !(existing.data instanceof ContentBytes)) { existing.unlinked = true; this.resourceBytes -= existing.data.length; }
   this.files.delete(source.path); source.resource.path = target; this.files.set(target, source.resource);
  }
  this.touchDirectory(this.parent(source.path)); this.touchDirectory(this.parent(target));
  return 0;
 }
 truncate(number, length) {
  const resource = this.descriptor(number).description.resource;
  if (!resource.writable || resource.stream) fail(22, 'Guest descriptor cannot be truncated');
  if (typeof length !== 'bigint' || length < 0n || length > BigInt(MAX_RESOURCES)) fail(27, 'Guest truncate length is out of range');
  if (resource.data instanceof ContentBytes) resource.data = resource.data.materialize();
  const size = Number(length), data = new Uint8Array(size); data.set(resource.data.subarray(0, size));
  this.resourceBytes += size - resource.data.length; resource.data = data; resource.mtime = resource.ctime = this.now();
  return 0;
 }
 setTimes(name, access, modified) {
  const record = this.lookup(name);
  if (!this.writablePath(record.path) || record.resource?.mounted) fail(30, 'Guest resources are read-only');
  const target = record.directory ? (this.directoryTimes.get(record.path) ?? this.directoryTimes.set(record.path, {}).get(record.path)) : record.resource;
  target.atime = access; target.mtime = modified; target.ctime = this.now(); return 0;
 }
 statBytes(record) {
  const bytes = new Uint8Array(144), view = new DataView(bytes.buffer), resource = record.resource;
  let inode = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(record.path)) inode = BigInt.asUintN(64, (inode ^ BigInt(byte)) * 1099511628211n);
  let links = resource?.unlinked ? 0 : 1;
  if (record.directory) {
   const children = new Set(), prefix = record.path === '/' ? '/' : `${record.path}/`;
   for (const path of [...this.directories, ...this.files.keys()]) if (path.startsWith(prefix) && path !== record.path) {
    const rest = path.slice(prefix.length), separator = rest.indexOf('/');
    if (separator >= 0) children.add(rest.slice(0, separator)); else if (this.directories.has(path)) children.add(rest);
   }
   links = 2 + children.size;
  }
  const mode = record.directory ? 0x4000 | this.directoryMode(record.path) : resource.stream ? 0x2000 | (resource.readable ? 0o400 : 0) | (resource.writable ? 0o200 : 0) : 0x8000 | resource.mode;
  view.setInt32(0, 1, true); view.setUint16(4, mode, true); view.setUint16(6, Math.min(links, 65535), true); view.setBigUint64(8, inode || 1n, true);
  view.setUint32(16, 501, true); view.setUint32(20, 20, true);
  const times = record.directory ? this.directoryTimes.get(record.path) || {} : resource;
  for (const [name, offset] of [['atime', 32], ['mtime', 48], ['ctime', 64], ['birthtime', 80]]) {
   const value = times[name] || 0, seconds = Math.floor(value / 1000);
   view.setBigInt64(offset, BigInt(seconds), true); view.setBigInt64(offset + 8, BigInt((value - seconds * 1000) * 1000000), true);
  }
  const size = record.directory || resource.stream ? 0 : resource.data.length;
  view.setBigInt64(96, BigInt(size), true); view.setBigInt64(104, BigInt(Math.ceil(size / 512)), true); view.setInt32(112, 4096, true);
  return bytes;
 }
 stat(name) { return this.statBytes(this.lookup(name)); }
 filesystemBytes() {
  const bytes = new Uint8Array(2168), view = new DataView(bytes.buffer), nodes = new Set(this.directories);
  for (const path of this.files.keys()) {
   nodes.add(path);
   for (let parent = this.parent(path); !nodes.has(parent); parent = this.parent(parent)) nodes.add(parent);
  }
  const unlinked = new Set([...this.descriptors.values()].map(descriptor => descriptor.description.resource).filter(resource => resource.unlinked));
  const freeNodes = Math.max(0, 4096 - this.files.size) + Math.max(0, 4096 - this.directories.size), freeBlocks = Math.floor((MAX_RESOURCES - this.resourceBytes) / 4096);
  view.setUint32(0, 4096, true); view.setInt32(4, 4096, true);
  for (const [offset, value] of [[8, Math.ceil((MAX_RESOURCES + this.imageBytes) / 4096)], [16, freeBlocks], [24, freeBlocks], [32, nodes.size + unlinked.size + freeNodes], [40, freeNodes]]) view.setBigUint64(offset, BigInt(value), true);
  view.setInt32(48, 1, true); view.setUint32(56, 501, true); view.setUint32(64, 0x1000, true);
  const encoder = new TextEncoder();
  for (const [offset, value] of [[72, 'guest-vfs'], [88, '/'], [1112, 'guest-memory']]) bytes.set(encoder.encode(`${value}\0`), offset);
  return bytes;
 }
 statfs(name) { this.lookup(name); return this.filesystemBytes(); }
 fstatfs(number) {
  const resource = this.descriptor(number).description.resource;
  if (resource.stream) fail(45, 'Guest diagnostic streams have no mounted filesystem');
  return this.filesystemBytes();
 }
 fstat(number) {
  const resource = this.descriptor(number).description.resource;
  return this.statBytes({ resource, directory: false, path: resource.path || (resource === this.stdout ? '/dev/stdout' : resource === this.stderr ? '/dev/stderr' : '/dev/stdin') });
 }
 allocate(description, minimum = 0, flags = 0) {
  if (!Number.isInteger(minimum) || minimum < 0 || minimum >= this.softLimit) fail(22, 'Invalid descriptor minimum');
  for (let descriptor = minimum; descriptor < this.softLimit; descriptor++) {
   if (!this.descriptors.has(descriptor)) { this.descriptors.set(descriptor, { description, flags }); return descriptor; }
  }
  fail(24, 'Guest descriptor table is full');
 }
 setLimits(soft, hard) {
  if (typeof soft !== 'bigint' || typeof hard !== 'bigint' || soft < 0n || soft > hard) fail(22, 'Invalid descriptor resource limits');
  if (hard > BigInt(this.hardLimit)) fail(1, 'Guest cannot raise its hard descriptor limit');
  this.softLimit = Number(soft); this.hardLimit = Number(hard);
 }
 open(name, flags = 0, mode = 0o666) {
  if (!name) fail(2, 'Empty guest file path');
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) fail(22, 'Invalid open flags');
  if ((flags & 3) === 3 || flags & ~(3 | NONBLOCK | APPEND | CLOEXEC | 0x200 | 0x400 | 0x800) || flags & 0x800 && !(flags & 0x200)) fail(22, 'Unsupported guest open flags');
  const path = this.path(name), writing = (flags & 3) !== 0;
  if ((writing || flags & (0x200 | 0x400)) && !this.writablePath(path)) fail(30, 'Guest resources are read-only');
  let record;
  try { record = this.lookup(name); }
  catch (error) {
   if (!(error instanceof GuestFileError) || error.errno !== 2 || !(flags & 0x200)) throw error;
   this.writableParent(path);
   if (name.endsWith('/')) fail(21, 'Cannot create a regular file with a trailing slash');
   if (this.files.size - this.contentFiles >= 4096) fail(28, 'Guest file limit exceeded');
   if (!Array.from({ length: this.softLimit }, (_, descriptor) => descriptor).some(descriptor => !this.descriptors.has(descriptor))) fail(24, 'Guest descriptor table is full');
   const time = this.now(), resource = { path, data: new Uint8Array(), readable: true, writable: true, mode: mode & 0o7777 & ~0o022, mounted: false, birthtime: time, atime: time, mtime: time, ctime: time };
   this.files.set(path, resource); record = { resource, created: true };
   this.touchDirectory(this.parent(path));
  }
  const { resource, directory, created } = record;
  if (directory) fail(21, 'Cannot open a guest directory as a file');
  if (flags & 0x200 && flags & 0x800 && !created) fail(17, 'Guest file already exists');
  if (writing && !resource.writable || flags & 0x400 && resource.mounted) fail(30, 'Guest resources are read-only');
  if (!created && ((flags & 3) !== 1 && !(resource.mode & 0o400) || writing && !(resource.mode & 0o200))) fail(13, 'Guest file permission denied');
  if (!this.softLimit) fail(24, 'Guest descriptor table is full');
  const descriptor = this.allocate({ resource, position: 0n, flags: flags & (3 | NONBLOCK | APPEND) }, 0, flags & CLOEXEC ? 1 : 0);
  if (flags & 0x400) { if (!writing) { this.descriptors.delete(descriptor); fail(22, 'Truncating requires a writable descriptor'); } this.resourceBytes -= resource.data.length; resource.data = new Uint8Array(); resource.mtime = resource.ctime = this.now(); }
  return descriptor;
 }
 close(number) {
  const resource = this.descriptor(number).description.resource; this.descriptors.delete(number);
  if (resource.unlinked && ![...this.descriptors.values()].some(descriptor => descriptor.description.resource === resource)) this.resourceBytes -= resource.data.length;
  return 0;
 }
 read(number, count) {
  const description = this.descriptor(number).description;
  if (!description.resource.readable || (description.flags & 3) === 1) fail(9, 'Guest descriptor is not readable');
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_RESOURCES) fail(22, 'Invalid guest read length');
  const start = description.position >= BigInt(description.resource.data.length) ? description.resource.data.length : Number(description.position);
  const bytes = description.resource.data.slice(start, start + count);
  if (bytes.length && !description.resource.stream) description.resource.atime = this.now();
  description.position += BigInt(bytes.length); return bytes;
 }
 positioned(number, offset, operation) {
  const description = this.descriptor(number).description;
  if (description.resource.stream) fail(29, 'Cannot seek a guest stream');
  if (typeof offset !== 'bigint' || offset < 0n) fail(22, 'Negative guest file position');
  const position = description.position, flags = description.flags;
  description.position = offset; description.flags = flags & ~APPEND;
  try { return operation(); } finally { description.position = position; description.flags = flags; }
 }
 pread(number, offset, count) { return this.positioned(number, offset, () => this.read(number, count)); }
 pwrite(number, offset, bytes) { return this.positioned(number, offset, () => this.write(number, bytes)); }
 write(number, bytes) {
  const description = this.descriptor(number).description, resource = description.resource;
  if (!resource.writable || (description.flags & 3) === 0) fail(9, 'Guest descriptor is not writable');
  if (!(bytes instanceof Uint8Array)) fail(22, 'Invalid guest write bytes');
  if (!bytes.length) return 0;
  if (!resource.stream) {
   const position = description.flags & APPEND ? BigInt(resource.data.length) : description.position;
   if (position > BigInt(MAX_RESOURCES) || bytes.length > MAX_RESOURCES) fail(28, 'Guest file capacity exceeded');
   if (resource.data instanceof ContentBytes) { const existing = resource.data; if (existing.length > MAX_RESOURCES) fail(27, 'Guest content file is too large to modify'); resource.data = existing.materialize(); this.resourceBytes += existing.length; }
   const start = Number(position), size = Math.max(resource.data.length, start + bytes.length), growth = size - resource.data.length;
   if (this.resourceBytes + growth > MAX_RESOURCES) fail(28, 'Guest writable resources exceed 64 MiB');
   const data = new Uint8Array(size); data.set(resource.data); data.set(bytes, start); resource.data = data; this.resourceBytes += growth; description.position = position + BigInt(bytes.length); resource.mtime = resource.ctime = this.now(); return bytes.length;
  }
  const count = Math.min(bytes.length, MAX_OUTPUT - resource.data.length);
  if (!count) fail(28, 'Guest diagnostic output buffer is full');
  const data = new Uint8Array(resource.data.length + count);
  data.set(resource.data); data.set(bytes.subarray(0, count), resource.data.length); resource.data = data;
  return count;
 }
 seek(number, offset, whence) {
  const description = this.descriptor(number).description;
  if (description.resource.stream) fail(29, 'Cannot seek a guest stream');
  if (typeof offset !== 'bigint' || ![0, 1, 2].includes(whence)) fail(22, 'Invalid guest seek');
  const position = offset + (whence === 0 ? 0n : whence === 1 ? description.position : BigInt(description.resource.data.length));
  if (position < 0n) fail(22, 'Negative guest file position');
  if (position > 0x7fffffffffffffffn) fail(84, 'Guest file position overflows off_t');
  description.position = position; return position;
 }
 duplicate(number, minimum = 0) {
  const description = this.descriptor(number).description;
  if (!this.softLimit && minimum === 0) fail(24, 'Guest descriptor table is full');
  return this.allocate(description, minimum);
 }
 control(number, command, argument = 0) {
  const descriptor = this.descriptor(number);
  switch (command) {
   case 0: return this.duplicate(number, argument);
   case 1: return descriptor.flags;
   case 2:
    if (!Number.isInteger(argument) || argument < 0 || argument > 1) fail(22, 'Unsupported descriptor flags');
    descriptor.flags = argument; return 0;
   case 3: return descriptor.description.flags;
   case 4:
    if (!Number.isInteger(argument) || argument < 0 || argument > 0xffffffff || argument & ~(3 | NONBLOCK | APPEND)) fail(22, 'Unsupported file status flags');
    descriptor.description.flags = descriptor.description.flags & 3 | argument & (NONBLOCK | APPEND); return 0;
   default: throw new Error(`Unsupported guest fcntl command: ${command}`);
  }
 }
 report() {
  const decoder = new TextDecoder();
  return { mountedFiles: [...this.files.values()].filter(resource => resource.mounted).length, runtimeFiles: [...this.files.values()].filter(resource => !resource.mounted).length, openDescriptors: this.descriptors.size, descriptorLimits: { soft: this.softLimit, hard: this.hardLimit }, stdout: decoder.decode(this.stdout.data), stderr: decoder.decode(this.stderr.data) };
 }
}
