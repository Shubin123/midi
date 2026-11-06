const MAX_DESCRIPTORS = 256, MAX_RESOURCES = 64 << 20, MAX_OUTPUT = 64 << 10;
const CLOEXEC = 0x1000000, NONBLOCK = 4, APPEND = 8;

export class GuestFileError extends Error {
 constructor(errno, message) { super(message); this.errno = errno; }
}
const fail = (errno, message) => { throw new GuestFileError(errno, message); };

export class GuestFiles {
 constructor(files = new Map()) {
  this.files = new Map(); this.descriptors = new Map(); this.softLimit = MAX_DESCRIPTORS; this.hardLimit = MAX_DESCRIPTORS;
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
   if (this.files.has(path) || path === '/') throw new Error('Duplicate or invalid guest resource path');
   this.files.set(path, { data: bytes.slice(), readable: true });
  }
 }
 path(name) {
  if (typeof name !== 'string' || name.includes('\0') || name.length > 4096) fail(22, 'Invalid guest file path');
  const parts = [];
  for (const part of (name.startsWith('/') ? name : `/plugin/${name}`).split('/')) {
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
 open(name, flags = 0) {
  if (!name) fail(2, 'Empty guest file path');
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) fail(22, 'Invalid open flags');
  if (flags & (3 | 0x200 | 0x400)) fail(30, 'Guest resources are read-only');
  if (flags & ~(NONBLOCK | CLOEXEC)) fail(22, 'Unsupported guest open flags');
  const path = this.path(name), resource = this.files.get(path);
  if (resource && name.endsWith('/')) fail(20, 'Guest file is not a directory');
  if (!resource) {
   if (path === '/' || [...this.files.keys()].some(name => name.startsWith(`${path}/`))) fail(21, 'Cannot open a guest directory as a file');
   fail(2, 'Guest file is not mounted');
  }
  if (!this.softLimit) fail(24, 'Guest descriptor table is full');
  return this.allocate({ resource, position: 0n, flags: flags & NONBLOCK }, 0, flags & CLOEXEC ? 1 : 0);
 }
 close(number) { this.descriptor(number); this.descriptors.delete(number); return 0; }
 read(number, count) {
  const description = this.descriptor(number).description;
  if (!description.resource.readable) fail(9, 'Guest descriptor is not readable');
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_RESOURCES) fail(22, 'Invalid guest read length');
  const start = description.position >= BigInt(description.resource.data.length) ? description.resource.data.length : Number(description.position);
  const bytes = description.resource.data.slice(start, start + count);
  description.position += BigInt(bytes.length); return bytes;
 }
 write(number, bytes) {
  const description = this.descriptor(number).description, resource = description.resource;
  if (!resource.writable) fail(9, 'Guest descriptor is not writable');
  if (!(bytes instanceof Uint8Array)) fail(22, 'Invalid guest write bytes');
  if (!bytes.length) return 0;
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
  return { mountedFiles: this.files.size, openDescriptors: this.descriptors.size, descriptorLimits: { soft: this.softLimit, hard: this.hardLimit }, stdout: decoder.decode(this.stdout.data), stderr: decoder.decode(this.stderr.data) };
 }
}
