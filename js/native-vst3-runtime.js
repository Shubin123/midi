import { parseMachO, dyldFixups } from './macho-loader.js';
import { formatGuestPrintf } from './native-vst3-printf.js';
import { scanGuestIntegers } from './native-vst3-scanf.js';
import { GuestMutexes, cppMutexImports } from './native-vst3-mutex.js';
import { GuestThreadAttributes } from './native-vst3-thread-attributes.js';
import { GuestThreads, threadImports } from './native-vst3-threads.js';
import { GuestConditions, conditionImports, cppConditionImports } from './native-vst3-conditions.js';
import { GuestFiles, GuestFileError } from './native-vst3-files.js';
import { GuestObjC, objcImports, objcStringConstants } from './native-vst3-objc.js';
import { GuestStrings, guestStringImport, nextGuestPrime } from './native-vst3-libcpp.js';
import { GuestLocales, localeImports } from './native-vst3-locale.js';
import { GuestCoreFoundation, coreImports, coreStringConstants, coreCallbackConstants } from './native-vst3-corefoundation.js';
import { GuestStdio, stdioImports, stdioGlobals } from './native-vst3-stdio.js';
import { GuestThreadStorage, tlsImports } from './native-vst3-tls.js';
import { GuestBundles, bundleImports } from './native-vst3-bundle.js';
import { GuestRunLoop, runLoopImports } from './native-vst3-runloop.js';
import { GuestTextEncodings, encodingImports } from './native-vst3-encoding.js';
import { darwinErrorMessages } from './native-vst3-errno.js';
import { GuestSystem } from './native-vst3-system.js';
import { GuestHeap } from './native-vst3-heap.js';
import { GuestZones, zoneImports } from './native-vst3-zones.js';
import { atomicImports, invokeGuestAtomic } from './native-vst3-atomic.js';
import { GuestRTTI } from './native-vst3-rtti.js';
import { GuestCLocales, cLocaleImports } from './native-vst3-clocale.js';
import { guestVariadicArguments } from './native-vst3-varargs.js';
import { GuestTime, timeImports } from './native-vst3-time.js';
import { GuestUrlTransport, urlSessionImport } from './native-vst3-session-transport.js';
import { GuestImages, imageImports } from './native-vst3-images.js';
import { invokeGuestLibc, libcImports } from './native-vst3-libc.js';
import { GuestAccelerate, accelerateImports } from './native-vst3-accelerate.js';
import { GuestIostream, iostreamImports, ostreamVtable } from './native-vst3-iostream.js';

const IMAGE = 0x10000000, HEAP = 0x20000000, HEAP_SIZE = 32 << 20, MAX_HEAP_SIZE = 512 << 20;
const STACK = 0x40000000, STACK_SIZE = 1 << 20, IMPORTS = 0x50000000, IMPORT_SIZE = 1 << 20;
const RETURN = IMPORTS + IMPORT_SIZE - 4096;
const decoder = new TextDecoder();
const hex = value => `0x${value.toString(16)}`;
const unaryMath = new Map([
 ['_sin', Math.sin], ['_cos', Math.cos], ['_tan', Math.tan], ['_asin', Math.asin], ['_acos', Math.acos], ['_atan', Math.atan],
 ['_exp', Math.exp], ['_expm1', Math.expm1], ['_log', Math.log], ['_log2', Math.log2], ['_log10', Math.log10], ['_log1p', Math.log1p],
 ['_sqrt', Math.sqrt], ['_cbrt', Math.cbrt], ['_floor', Math.floor], ['_ceil', Math.ceil], ['_trunc', Math.trunc], ['_fabs', Math.abs],
]);
const fileImports = new Set(['___error', '_getrlimit', '_setrlimit', '_getdtablesize', '_open', '_open$NOCANCEL', '_close', '_close$NOCANCEL', '_read', '_read$NOCANCEL', '_write', '_write$NOCANCEL', '_lseek', '_fcntl', '_dup', '_access']);
for (const name of ['_stat', '_stat$INODE64', '_lstat', '_lstat$INODE64', '_fstat', '_fstat$INODE64', '_mkdir', '_strerror', '_sysctlbyname', '_getcwd', '_realpath$DARWIN_EXTSN', '_fsync', '_ftruncate', '_rename', '_unlink', '_remove', '_rmdir', '_chmod', '_fchmod', '_pread', '_pwrite', '_utimes']) fileImports.add(name);
for (const name of ['_statfs$INODE64', '_statfs64', '_fstatfs$INODE64', '_fstatfs64']) fileImports.add(name);

export class NativeExecutionError extends Error {
 constructor(message, details = {}) { super(message); this.name = 'NativeExecutionError'; this.details = details; }
}

export class NativeVst3Guest {
 constructor(uc, bytes, { files = new Map(), bundlePath = '/plugin/Plugin.vst3', executableName, heapSize = HEAP_SIZE, monotonicClock = () => performance.now(), wallClock = () => Date.now(), network = null, content = null } = {}) {
  if (!Number.isSafeInteger(heapSize) || heapSize < (1 << 20) || heapSize > MAX_HEAP_SIZE || heapSize % 4096) throw new NativeExecutionError('Invalid guest heap size');
  this.uc = uc;
  this.heapSize = heapSize;
  this.image = parseMachO(bytes);
  this.slide = IMAGE - this.image.minimum;
  this.imports = new Map(); this.importNames = new Map(); this.calls = new Map(); this.allocations = new GuestHeap(this, HEAP, heapSize); this.destructors = []; this.uuids = new Map(); this.errorStrings = new Map();
  this.heapTop = HEAP; this.initialized = false; this.initializersCompleted = 0; this.factory = 0; this.hooks = [];
  this.zones = new GuestZones(this);
  this.rtti = new GuestRTTI(this);
  this.mutexes = new GuestMutexes(this);
  this.threadAttributes = new GuestThreadAttributes(this);
  this.threadStorage = new GuestThreadStorage(this);
  this.threads = new GuestThreads(this, STACK, STACK + STACK_SIZE, RETURN);
  this.staticGuards = new Map();
  this.conditions = new GuestConditions(this);
  this.files = new GuestFiles(files); this.files.clock = wallClock;
  if (content) this.files.mountContent(content);
  this.system = new GuestSystem(this, heapSize + STACK_SIZE + IMPORT_SIZE + this.image.segments.reduce((total, segment) => total + Math.ceil(segment.size / 4096) * 4096, 0));
  this.bundles = new GuestBundles(this, bundlePath, executableName); this.startupStage = 'mapped'; this.startupFailure = null;
  this.files.mountImage(this.bundles.executablePath, this.image.bytes);
  this.objc = new GuestObjC(this);
  this.urlTransport = new GuestUrlTransport(this, network);
  this.images = new GuestImages(this);
  this.accelerate = new GuestAccelerate(this);
  this.iostream = new GuestIostream(this);
  this.locales = new GuestLocales(this);
  this.cLocales = new GuestCLocales(this);
  this.strings = new GuestStrings(this);
  this.core = new GuestCoreFoundation(this);
  this.runLoop = new GuestRunLoop(this);
  this.encodings = new GuestTextEncodings(this);
  this.stdio = new GuestStdio(this);
  this.time = new GuestTime(this);
  this.monotonicClock = monotonicClock; this.wallClock = wallClock; this.lastTick = 0n;
  this.engine = new uc.Unicorn(uc.ARCH_X86, uc.MODE_64);
  try {
   const engine = this.engine;
   for (const segment of this.image.segments) {
    const address = segment.address + this.slide, size = Math.ceil(segment.size / 4096) * 4096;
    engine.mem_map(address, size, uc.PROT_ALL);
    if (size > segment.fileSize) engine.mem_write(address + segment.fileSize, new Uint8Array(size - segment.fileSize));
    if (segment.fileSize) engine.mem_write(address, this.image.bytes.subarray(segment.offset, segment.offset + segment.fileSize));
   }
   engine.mem_map(HEAP, heapSize, uc.PROT_READ | uc.PROT_WRITE);
   engine.mem_write(HEAP, new Uint8Array(heapSize));
   engine.mem_map(STACK, STACK_SIZE, uc.PROT_READ | uc.PROT_WRITE);
   engine.mem_write(STACK, new Uint8Array(STACK_SIZE));
   engine.mem_map(IMPORTS, IMPORT_SIZE, uc.PROT_READ | uc.PROT_EXEC);
   engine.mem_write(IMPORTS, new Uint8Array(IMPORT_SIZE).fill(0xc3));
   this.zones.default();
   dyldFixups(this.image, this.slide, {
    readPointer: address => this.pointer(address), writePointer: (address, value) => this.writePointer(address, value),
    resolve: (name, ordinal, kind) => this.resolve(name, ordinal, kind),
   });
   this.objc.prepareSelectors(this.image.selectors, this.slide);
   this.objc.prepareProtocols(this.image.protocols, this.slide);
   for (const segment of this.image.segments) engine.mem_protect(segment.address + this.slide, Math.ceil(segment.size / 4096) * 4096, segment.protection & 7);
   this.hooks.push(engine.hook_add(uc.HOOK_CODE, (_, address) => {
    this.pending = { address: Number(address), kind: 'call' }; engine.emu_stop();
   }, {}, IMPORTS, RETURN - 1));
   this.hooks.push(engine.hook_add(uc.HOOK_MEM_READ, (_, type, address) => {
    this.pending = { address: Number(address), kind: 'data' }; engine.emu_stop();
   }, {}, IMPORTS, RETURN - 1));
   this.hooks.push(engine.hook_add(uc.HOOK_INTR, (_, interrupt) => {
    this.pending = { kind: 'interrupt', interrupt }; engine.emu_stop();
   }));
   this.hooks.push(engine.hook_add(uc.HOOK_INSN, () => {
    this.pending = { kind: 'syscall' }; engine.emu_stop();
   }, {}, 1, 0, uc.X86_INS_SYSCALL));
  } catch (error) { this.poisoned = error instanceof WebAssembly.RuntimeError; this.close(); throw error; }
 }
 close() {
  if (!this.engine) return;
  if (this.poisoned) { this.engine = null; this.hooks = []; return; }
  this.threads.close();
  for (const hook of this.hooks) this.engine.hook_del(hook);
  this.hooks = []; this.engine.close(); this.engine = null;
 }
 read(address, size) {
  if (!Number.isSafeInteger(address) || !Number.isSafeInteger(size) || size < 0 || size > this.heapSize) throw new NativeExecutionError('Invalid guest memory read');
  return this.engine.mem_read(address, size);
 }
 write(address, bytes) { this.engine.mem_write(address, bytes); }
 pointer(address) {
  const bytes = this.read(address, 8), value = Number(new DataView(bytes.buffer).getBigUint64(0, true));
  if (!Number.isSafeInteger(value)) throw new NativeExecutionError('Guest pointer exceeds JavaScript integer precision');
  return value;
 }
 writePointer(address, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new NativeExecutionError('Invalid guest pointer');
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true); this.write(address, bytes);
 }
 register(name) { return Number(BigInt.asUintN(64, this.engine.reg_read_i64(this.uc[`X86_REG_${name}`]))); }
 setRegister(name, value) { this.engine.reg_write_i64(this.uc[`X86_REG_${name}`], BigInt(value)); }
 isExecutable(address) {
  return this.imports.has(address) || this.image.segments.some(segment => segment.protection & 4 && address >= segment.address + this.slide && address < segment.address + this.slide + segment.size);
 }
 floatingRegister(index = 0, bits = 64) {
  if (!Number.isInteger(index) || index < 0 || index > 7 || ![32, 64].includes(bits)) throw new NativeExecutionError('Invalid floating register');
  const bytes = this.engine.reg_read(this.uc[`X86_REG_XMM${index}`], 16);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return bits === 32 ? view.getFloat32(0, true) : view.getFloat64(0, true);
 }
 setFloatingRegister(index, value, bits = 64) {
  if (!Number.isInteger(index) || index < 0 || index > 7 || ![32, 64].includes(bits)) throw new NativeExecutionError('Invalid floating register');
  const bytes = this.engine.reg_read(this.uc[`X86_REG_XMM${index}`], 16);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bits === 32) view.setFloat32(0, value, true); else view.setFloat64(0, value, true);
  this.engine.reg_write(this.uc[`X86_REG_XMM${index}`], bytes);
 }
 argument64(index) {
  if (!Number.isInteger(index) || index < 0 || index >= 64) throw new NativeExecutionError('Guest argument limit exceeded');
  const name = ['RDI', 'RSI', 'RDX', 'RCX', 'R8', 'R9'][index];
  if (name) return BigInt.asUintN(64, this.engine.reg_read_i64(this.uc[`X86_REG_${name}`]));
  const bytes = this.read(this.register('RSP') + 8 * (index - 5), 8);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
 }
 allocate(size, alignment = 16) {
  try { return this.allocations.allocate(size, alignment); }
  catch (error) { throw new NativeExecutionError(error.message, { kind: 'heap-allocation', requested: size, alignment, heap: this.allocations.report() }); }
 }
 stringBytes(address, limit = 4096) {
  const parts = [];
  for (let offset = 0; offset < limit; offset++) {
   const byte = this.read(address + offset, 1)[0];
   if (!byte) return new Uint8Array(parts);
   parts.push(byte);
  }
  throw new NativeExecutionError('Guest string exceeds limit');
 }
 string(address, limit = 4096) { return decoder.decode(this.stringBytes(address, limit)); }
 resolve(name, ordinal, kind) {
  if (ordinal <= 0 && this.image.symbols.has(name)) return this.image.symbols.get(name) + this.slide;
  if (kind === 'weak' && this.image.symbols.has(name)) return this.image.symbols.get(name) + this.slide;
  const key = `${ordinal}:${name}`;
  if (this.importNames.has(key)) return this.importNames.get(key);
  if (name.startsWith('_OBJC_CLASS_$_')) {
   const existing = [...this.imports].find(([, entry]) => entry.name === name);
   if (existing) { this.importNames.set(key, existing[0]); return existing[0]; }
  }
  if (name === '__DefaultRuneLocale') {
   const address = this.locales.runeLocale(); this.importNames.set(key, address); return address;
  }
  if (stdioGlobals.has(name)) {
   const address = this.stdio.global(name); this.importNames.set(key, address); return address;
  }
  if (coreCallbackConstants.has(name)) {
   const address = this.core.callbacksGlobal(name); this.importNames.set(key, address); return address;
  }
  if (coreStringConstants.has(name)) {
   const address = this.core.constantGlobal(name); this.importNames.set(key, address); return address;
  }
  if (objcStringConstants.has(name)) {
   const address = this.objc.constantGlobal(name); this.importNames.set(key, address); return address;
  }
  if (name === ostreamVtable) {
   const address = this.iostream.ostreamTable(); this.importNames.set(key, address); return address;
  }
  if (name === '_NSApp') {
   const address = this.objc.applicationGlobal(); this.importNames.set(key, address); return address;
  }
  if (name === '_kCFAllocatorNull') {
   const address = this.core.nullAllocatorGlobal(); this.importNames.set(key, address); return address;
  }
  if (name === '_CGAffineTransformIdentity') {
   const address = this.allocate(48), bytes = new Uint8Array(48), view = new DataView(bytes.buffer);
   view.setFloat64(0, 1, true); view.setFloat64(24, 1, true); this.write(address, bytes);
   this.importNames.set(key, address); return address;
  }
  if (name === '___stack_chk_guard' || name === '_kCFAllocatorDefault') {
   const address = this.allocate(8);
   this.write(address, name === '___stack_chk_guard' ? crypto.getRandomValues(new Uint8Array(8)) : new Uint8Array(8));
   this.importNames.set(key, address);
   return address;
  }
  const address = IMPORTS + this.imports.size * 16;
  if (address >= RETURN) throw new NativeExecutionError('Too many imports');
  this.imports.set(address, { name, ordinal, library: ordinal > 0 ? this.image.libraries[ordinal - 1] : null });
  this.rtti.bind(name, address);
  this.importNames.set(key, address);
  return address;
 }
 invokeImport(entry) {
  const args = ['RDI', 'RSI', 'RDX', 'RCX', 'R8', 'R9'].map(name => this.register(name));
  const [destination, source, size] = args;
  this.calls.set(entry.name, (this.calls.get(entry.name) || 0) + 1);
  if (timeImports.has(entry.name)) {
   try { return this.time.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof GuestFileError) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, error.errno, true); this.write(this.errorPointer(), bytes); return entry.name === '_nanosleep' ? -1 : 0; }
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-time' });
   }
  }
  if (cLocaleImports.has(entry.name)) {
   try { return this.cLocales.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-c-locale' });
   }
  }
  if (atomicImports.has(entry.name)) {
   try { return invokeGuestAtomic(this, entry.name); }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-atomic' });
   }
  }
  if (zoneImports.has(entry.name) || entry.name.startsWith('__midi_zone_')) {
   try { return this.zones.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-malloc-zone' });
   }
  }
  if (iostreamImports.has(entry.name)) {
   try { return this.iostream.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof NativeExecutionError) throw error;
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-iostream' });
   }
  }
  if (accelerateImports.has(entry.name)) {
   try { return this.accelerate.invoke(entry.name); }
   catch (error) {
    if (error instanceof NativeExecutionError) throw error;
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-accelerate' });
   }
  }
  if (libcImports.has(entry.name)) {
   try { return invokeGuestLibc(this, entry.name, args); }
   catch (error) {
    if (error instanceof NativeExecutionError) throw error;
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-libc' });
   }
  }
  if (imageImports.has(entry.name)) {
   try { return this.images.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof NativeExecutionError) throw error;
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-image' });
   }
  }
  if (urlSessionImport(entry.name)) {
   try { return this.urlTransport.invoke(entry.name); }
   catch (error) {
    if (error instanceof NativeExecutionError) throw error;
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-url-session' });
   }
  }
  if (entry.name.startsWith('__midi_vst3_')) {
   try {
    if (!this.audioHost) throw new Error('No VST3 host callback owner');
    return this.audioHost.invoke(entry.name, args);
   } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-vst3-host' });
   }
  }
  if (runLoopImports.has(entry.name)) {
   try { return this.runLoop.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-runloop' });
   }
  }
  if (bundleImports.has(entry.name)) {
   try { return this.bundles.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-bundle' });
   }
  }
  if (stdioImports.has(entry.name) || entry.name.startsWith('__midi_stdio_')) {
   try { return this.stdio.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof GuestFileError) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, error.errno, true); this.write(this.errorPointer(), bytes); return ['_fread', '_fwrite'].includes(entry.name) ? 0 : -1; }
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-stdio' });
   }
  }
  if (encodingImports.has(entry.name)) {
   try { return this.encodings.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-encoding', ...error.details });
   }
  }
  if (coreImports.has(entry.name) || entry.name.startsWith('__midi_cf_') || entry.name === '_CFRelease' && (this.core.objects.has(destination) || this.objc.objects.has(destination))) {
   try {
    if (this.objc.objects.has(destination)) {
     if (entry.name === '_CFRetain') return this.objc.retainObject(destination);
     if (entry.name === '_CFRelease') return this.objc.releaseObject(destination);
     if (entry.name === '_CFGetRetainCount') return this.objc.objects.get(destination).references;
    }
    return entry.name === '_CFRelease' ? this.core.release(destination) : this.core.invoke(entry.name, args);
   }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-corefoundation' });
   }
  }
  if (guestStringImport(entry.name)) {
   try { return this.strings.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-libcpp' });
   }
  }
  if (localeImports.has(entry.name) || entry.name.startsWith('__midi_locale_')) {
   try { return entry.name.startsWith('__midi_locale_') ? this.locales.virtual(entry.name, args) : this.locales.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-locale' });
   }
  }
  if (objcImports.has(entry.name)) {
   try { return this.objc.invoke(entry.name, args); }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
    throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-objc', ...error.details });
   }
  }
  if (fileImports.has(entry.name)) {
   try { return this.invokeFile(entry.name, args); }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
     this.poisoned = true;
     throw new NativeExecutionError(`Emulator fault during ${entry.name}: ${error.message}`, { ...entry, kind: 'emulator-fault' });
    }
    if (!(error instanceof GuestFileError)) throw new NativeExecutionError(error.message || String(error), { ...entry, kind: 'unsupported-filesystem' });
    const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, error.errno, true); this.write(this.errorPointer(), bytes);
    return entry.name === '_getcwd' || entry.name === '_realpath$DARWIN_EXTSN' ? 0 : -1;
   }
  }
  if (unaryMath.has(entry.name)) return { rax: 0, xmm0: unaryMath.get(entry.name)(this.floatingRegister()) };
  if (tlsImports.has(entry.name)) {
   try { return this.threadStorage.invoke(entry.name, destination, source); }
   catch (error) { this.poisoned ||= error instanceof WebAssembly.RuntimeError; throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-threading' }); }
  }
  if (threadImports.has(entry.name)) {
   try { return this.threads.invoke(entry.name, args); }
   catch (error) { this.poisoned ||= error instanceof WebAssembly.RuntimeError; throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-threading' }); }
  }
  if (conditionImports.has(entry.name) || cppConditionImports.has(entry.name)) {
   try { return cppConditionImports.has(entry.name) ? this.conditions.invokeCpp(entry.name, destination, source) : this.conditions.invoke(entry.name, destination, source); }
   catch (error) { this.poisoned ||= error instanceof WebAssembly.RuntimeError; throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-threading' }); }
  }
  if (entry.name.startsWith('_pthread_attr_')) {
   try {
    const result = this.threadAttributes.invoke(entry.name, destination, source);
    if (result !== undefined) return result;
   } catch (error) { this.poisoned ||= error instanceof WebAssembly.RuntimeError; throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-threading' }); }
  }
  if (entry.name.endsWith('f') && unaryMath.has(entry.name.slice(0, -1))) return { rax: 0, xmm0f: Math.fround(unaryMath.get(entry.name.slice(0, -1))(this.floatingRegister(0, 32))) };
  if (entry.name.startsWith('_pthread_mutex') || cppMutexImports.has(entry.name)) {
   try {
    const result = cppMutexImports.has(entry.name) ? this.mutexes.invokeCpp(entry.name, destination) : this.mutexes.invoke(entry.name, destination, source);
    if (result !== undefined) return result;
   } catch (error) { this.poisoned ||= error instanceof WebAssembly.RuntimeError; throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-threading' }); }
  }
  const fill = (address, length, byte = 0) => {
   if (!Number.isSafeInteger(length) || length < 0 || length > this.heapSize) throw new NativeExecutionError('Guest memory operation exceeds limit');
   this.write(address, new Uint8Array(length).fill(byte));
  };
  switch (entry.name) {
   case '_DASessionCreate':
    if (destination) throw new NativeExecutionError('Custom Disk Arbitration allocators are not implemented', { ...entry, kind: 'unsupported-disk-arbitration' });
    return 0;
   case '_mach_timebase_info': {
    const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
    view.setUint32(0, 1, true); view.setUint32(4, 1, true); this.write(destination, bytes); return 0;
   }
   case '__ZNSt3__16chrono12steady_clock3nowEv':
   case '_mach_absolute_time': {
    const milliseconds = this.monotonicClock();
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > Number.MAX_SAFE_INTEGER / 1000000) throw new NativeExecutionError('Invalid guest monotonic clock');
    const tick = BigInt(Math.floor(milliseconds * 1000000));
    if (tick > this.lastTick) this.lastTick = tick;
    return this.lastTick;
   }
   case '__ZNSt3__16chrono12system_clock3nowEv': {
    const milliseconds = this.wallClock();
    if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > Number.MAX_SAFE_INTEGER / 1000) throw new NativeExecutionError('Invalid guest wall clock');
    return BigInt(Math.floor(milliseconds * 1000));
   }
   case '_gettimeofday': {
    if (source) throw new NativeExecutionError('Legacy gettimeofday timezone output is not implemented', { ...entry, kind: 'unsupported-time' });
    const milliseconds = this.wallClock();
    if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > Number.MAX_SAFE_INTEGER / 1000) throw new NativeExecutionError('Invalid guest wall clock');
    if (destination) {
     const seconds = Math.floor(milliseconds / 1000), bytes = new Uint8Array(12), view = new DataView(bytes.buffer);
     view.setBigInt64(0, BigInt(seconds), true); view.setInt32(8, Math.floor((milliseconds - seconds * 1000) * 1000), true); this.write(destination, bytes);
    }
    return 0;
   }
   case '_exp2': return { rax: 0, xmm0: 2 ** this.floatingRegister() };
   case '___exp10': return { rax: 0, xmm0: 10 ** this.floatingRegister() };
   case '_exp2f': case '___exp10f': return { rax: 0, xmm0f: Math.fround((entry.name === '_exp2f' ? 2 : 10) ** this.floatingRegister(0, 32)) };
   case '_powf': {
    const base = this.floatingRegister(0, 32), exponent = this.floatingRegister(1, 32);
    return { rax: 0, xmm0f: Math.fround(base === 1 || base === -1 && Math.abs(exponent) === Infinity ? 1 : base ** exponent) };
   }
   case '_pow': {
    const base = this.floatingRegister(), exponent = this.floatingRegister(1);
    return { rax: 0, xmm0: base === 1 || base === -1 && Math.abs(exponent) === Infinity ? 1 : base ** exponent };
   }
   case '___sincos_stret': { const value = this.floatingRegister(); return { rax: 0, xmm0: Math.sin(value), xmm1: Math.cos(value) }; }
   case '___sincosf_stret': {
    const value = this.floatingRegister(0, 32), bytes = new ArrayBuffer(8), view = new DataView(bytes);
    view.setFloat32(0, Math.sin(value), true); view.setFloat32(4, Math.cos(value), true); return { rax: 0, xmm0Bits: view.getBigUint64(0, true) };
   }
   case '_malloc': case '__Znwm': case '__Znam': return this.allocate(destination);
   case '__ZnwmRKSt9nothrow_t': case '__ZnamRKSt9nothrow_t': {
    const requested = this.argument64(0);
    if (requested > BigInt(this.heapSize)) return 0;
    try { return this.allocate(Number(requested)); }
    catch (error) { if (error instanceof NativeExecutionError && error.details.kind === 'heap-allocation') return 0; throw error; }
   }
   case '_getpid': return this.system.pid;
   case '__ZNSt3__16thread20hardware_concurrencyEv': return new DataView(this.system.nodes.get('hw.ncpu').buffer).getUint32(0, true);
   case '__ZNSt3__119__shared_weak_count14__release_weakEv': {
    const bytes = this.read(destination + 16, 8), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), owners = view.getBigInt64(0, true);
    if (owners !== 0n) { view.setBigInt64(0, owners - 1n, true); this.write(destination + 16, bytes); return 0; }
    return { tailCall: this.pointer(this.pointer(destination) + 32) };
   }
   case '__ZNSt3__119__shared_weak_count4lockEv': {
    const bytes = this.read(destination + 8, 8), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), owners = view.getBigInt64(0, true);
    if (owners === -1n) return 0;
    view.setBigInt64(0, owners + 1n, true); this.write(destination + 8, bytes); return destination;
   }
   case '__ZNKSt3__119__shared_weak_count13__get_deleterERKSt9type_info': return 0;
   case '__ZNSt3__119__shared_weak_countD2Ev': return destination;
   case '_getenv': this.string(destination); return 0;
   case '_arc4random_buf': {
    if (source > 1 << 20) throw new NativeExecutionError('arc4random_buf request exceeds limit', { ...entry, kind: 'unsupported-import' });
    const bytes = new Uint8Array(source);
    for (let offset = 0; offset < source; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
    if (source) this.write(destination, bytes);
    return 0;
   }
   case '_dlopen': this.string(destination); this.dynamicError = 'The browser guest has no dynamic libraries to load'; return 0;
   case '_dlsym': this.string(source); this.dynamicError = 'The browser guest has no dynamic symbols to resolve'; return 0;
   case '_dlclose': return 0;
   case '_dlerror': {
    if (!this.dynamicError) return 0;
    const text = this.dynamicError; this.dynamicError = null; return this.objc.cstring(text);
   }
   case '__tlv_bootstrap': {
    const thread = this.threads.current;
    if (!thread.threadLocal) {
     const sections = this.image.threadLocal.slice().sort((left, right) => left.address - right.address);
     if (!sections.length) throw new NativeExecutionError('Thread-local access without thread-local sections', { ...entry, kind: 'unsupported-import' });
     const start = sections[0].address, size = sections.at(-1).address + sections.at(-1).size - start, block = this.allocate(size, 16);
     this.write(block, new Uint8Array(size));
     for (const section of sections) if (!section.zero && section.size) this.write(block + section.address - start, this.read(section.address + this.slide, section.size));
     thread.threadLocal = block;
    }
    return thread.threadLocal + this.pointer(destination + 16);
   }
   case '_srand': this.randomState = Number(BigInt.asUintN(32, BigInt(destination))); return 0;
   case '_rand': {
    let value = this.randomState ?? 1; if (!value) value = 123459876;
    const quotient = Math.floor(value / 127773), remainder = value % 127773;
    value = 16807 * remainder - 2836 * quotient; if (value < 0) value += 0x7fffffff;
    this.randomState = value; return value;
   }
   case '_geteuid': case '_getuid': return 501;
   case '_getifaddrs': this.writePointer(destination, 0); return 0;
   case '_freeifaddrs': if (destination) throw new NativeExecutionError('Guest has no interface list to free', { ...entry, kind: 'unsupported-import' }); return 0;
   case '___dynamic_cast': {
    try { return this.rtti.cast(destination, source, size); }
    catch (error) {
     if (error instanceof WebAssembly.RuntimeError) this.poisoned = true;
     throw new NativeExecutionError(error.message || String(error), { ...entry, kind: this.poisoned ? 'emulator-fault' : 'unsupported-rtti' });
    }
   }
   case '__ZNSt3__112__next_primeEm': {
    try { return nextGuestPrime(this.argument64(0)); }
    catch (error) { throw new NativeExecutionError(error.message, { ...entry, kind: 'unsupported-libcpp' }); }
   }
   case '_realloc': {
    if (!destination) return this.allocate(source);
    if (!this.allocations.has(destination)) throw new NativeExecutionError('realloc received an unknown allocation');
    if (!Number.isSafeInteger(source) || source < 0 || source > this.heapSize) throw new NativeExecutionError('realloc size exceeds guest heap');
    const previous = this.allocations.get(destination);
    if (source && source <= previous) { this.allocations.set(destination, source); return destination; }
    const address = this.allocate(source);
    if (previous && source) this.write(address, this.read(destination, Math.min(previous, source)));
    if (this.zones.owners.has(destination)) this.zones.adopt(address, this.zones.owners.get(destination));
    this.allocations.delete(destination); return address;
   }
   case '_calloc': { const address = this.allocate(destination * source); fill(address, destination * source); return address; }
   case '_free': case '__ZdlPv': case '__ZdaPv': case '__ZdlPvRKSt9nothrow_t': case '__ZdaPvRKSt9nothrow_t': this.allocations.delete(destination); return 0;
   case '_memset': fill(destination, size, source); return destination;
   case '_bzero': case '___bzero': fill(destination, source); return 0;
   case '_memcpy': case '_memmove': this.write(destination, this.read(source, size)); return destination;
   case '_memcmp': {
    if (!size) return 0;
    const left = this.read(destination, size), right = this.read(source, size);
    for (let index = 0; index < size; index++) if (left[index] !== right[index]) return left[index] - right[index];
    return 0;
   }
   case '_memchr': {
    if (!size) return 0;
    const index = this.read(destination, size).indexOf(source & 255); return index < 0 ? 0 : destination + index;
   }
   case '_strcmp': case '_strncmp': {
    const length = entry.name === '_strncmp' ? size : 1 << 20;
    if (!Number.isSafeInteger(length) || length < 0 || length > 1 << 20) throw new NativeExecutionError('Guest string comparison exceeds limit');
    for (let index = 0; index < length; index++) {
     const left = this.read(destination + index, 1)[0], right = this.read(source + index, 1)[0];
     if (left !== right) return left - right;
     if (!left) return 0;
    }
    if (entry.name === '_strcmp') throw new NativeExecutionError('Unterminated guest string comparison');
    return 0;
   }
   case '_strchr': case '_strrchr': {
    const bytes = this.stringBytes(destination, 1 << 20), character = source & 255;
    if (!character) return destination + bytes.length;
    const index = entry.name === '_strchr' ? bytes.indexOf(character) : bytes.lastIndexOf(character); return index < 0 ? 0 : destination + index;
   }
   case '_strlen': return this.stringBytes(destination).length;
   case '_atoi': {
    const bytes = this.stringBytes(destination, 1 << 20); let index = 0, sign = 1n, value = 0n;
    while (index < bytes.length && [9, 10, 11, 12, 13, 32].includes(bytes[index])) index++;
    if (bytes[index] === 43 || bytes[index] === 45) { if (bytes[index] === 45) sign = -1n; index++; }
    while (index < bytes.length && bytes[index] >= 48 && bytes[index] <= 57) {
     value = value * 10n + BigInt(bytes[index++] - 48);
     if (value > (sign < 0n ? 2147483648n : 2147483647n)) throw new NativeExecutionError('atoi exceeds signed 32-bit range');
    }
    return value * sign;
   }
   case '_strcpy': case '_strcat': {
    const sourceBytes = this.stringBytes(source, 1 << 20), bytes = new Uint8Array(sourceBytes.length + 1);
    const offset = entry.name === '_strcat' ? this.stringBytes(destination, 1 << 20).length : 0;
    if (offset + bytes.length > (1 << 20)) throw new NativeExecutionError('Guest string exceeds limit');
    bytes.set(sourceBytes); this.write(destination + offset, bytes); return destination;
   }
   case '_sprintf': case '_snprintf': {
    const bounded = entry.name === '_snprintf', capacity = bounded ? source : 1 << 20;
    if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > (1 << 20)) throw new NativeExecutionError('printf capacity exceeds limit');
    const next = guestVariadicArguments(this, bounded ? 3 : 2);
    let output;
    try {
     output = formatGuestPrintf(this.stringBytes(bounded ? size : source), next, (pointer, precision) => {
      const address = Number(pointer);
      if (!Number.isSafeInteger(address)) throw new NativeExecutionError('Invalid printf string pointer');
      if (precision === 0) return new Uint8Array();
      const bytes = [];
      for (let offset = 0; offset < (precision ?? 1 << 20); offset++) {
       const byte = this.read(address + offset, 1)[0];
       if (!byte) return new Uint8Array(bytes);
       bytes.push(byte);
      }
      if (precision === null) throw new NativeExecutionError('Unterminated printf string');
      return new Uint8Array(bytes);
     });
    } catch (error) { throw new NativeExecutionError(error.message, { ...entry, kind: 'unsupported-printf' }); }
    if (!bounded && output.length >= capacity) throw new NativeExecutionError('sprintf output exceeds limit');
    if (capacity) {
     const bytes = new Uint8Array(Math.min(output.length, capacity - 1) + 1);
     bytes.set(output.subarray(0, bytes.length - 1)); this.write(destination, bytes);
    }
    return output.length;
   }
   case '_strcmp': {
    const left = this.stringBytes(destination), right = this.stringBytes(source);
    for (let index = 0; index <= Math.max(left.length, right.length); index++) { const difference = (left[index] || 0) - (right[index] || 0); if (difference) return difference; }
    return 0;
   }
   case '_sscanf': {
    let index = 2;
    try {
     return scanGuestIntegers(this.stringBytes(destination, 1 << 20), this.stringBytes(source), (value, bits) => {
      const pointer = Number(this.argument64(index++));
      if (!Number.isSafeInteger(pointer)) throw new NativeExecutionError('Invalid scanf destination pointer');
      const bytes = new Uint8Array(bits / 8);
      for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = Number(value >> BigInt(offset * 8) & 255n);
      this.write(pointer, bytes);
     });
    } catch (error) { throw new NativeExecutionError(error.message, { ...entry, kind: 'unsupported-scanf' }); }
   }
   case '___cxa_guard_acquire': {
    const guard = this.read(destination, 2);
    if (guard[0]) return 0;
    if (guard[1]) {
     if (this.staticGuards.get(destination) === this.threads.current) throw new NativeExecutionError('Recursive static initialization');
     if (!this.staticGuards.has(destination)) throw new NativeExecutionError('Unknown static initialization owner');
     return this.threads.park('static-guard', destination);
    }
    this.staticGuards.set(destination, this.threads.current);
    this.write(destination + 1, new Uint8Array([1])); return 1;
   }
   case '___cxa_guard_release': case '___cxa_guard_abort':
    if (this.staticGuards.get(destination) !== this.threads.current) throw new NativeExecutionError('Static initialization guard is not owned by this thread');
    this.write(destination, new Uint8Array([entry.name === '___cxa_guard_release' ? 1 : 0, 0]));
    this.staticGuards.delete(destination); this.threads.wake('static-guard', destination); return 0;
   case '___cxa_atexit': this.destructors.push(args.slice(0, 3)); return 0;
   case '_CFUUIDCreate': {
    if (destination !== 0) throw new NativeExecutionError('Custom CoreFoundation allocators are not implemented');
    const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const address = this.allocate(16); this.write(address, bytes); this.uuids.set(address, bytes); return address;
   }
   case '_CFUUIDGetUUIDBytes': {
    const bytes = this.uuids.get(destination);
    if (!bytes) throw new NativeExecutionError('CFUUIDGetUUIDBytes received an unsupported object');
    const view = new DataView(bytes.buffer);
    return { rax: view.getBigUint64(0, true), rdx: view.getBigUint64(8, true) };
   }
   case '_CFRelease': {
    if (!this.uuids.delete(destination)) throw new NativeExecutionError('CFRelease received an unsupported object');
    this.allocations.delete(destination); return 0;
   }
   default: throw new NativeExecutionError(`Unsupported macOS import: ${entry.name}`, { ...entry, kind: 'unsupported-import' });
  }
 }
 errorPointer() {
  const thread = this.threads.current;
  if (!thread.errnoAddress) { thread.errnoAddress = this.allocate(4); this.write(thread.errnoAddress, new Uint8Array(4)); }
  return thread.errnoAddress;
 }
 invokeFile(name, [destination, source, size]) {
  const memory = operation => {
   try { return operation(); }
   catch (error) {
    const code = Number(String(error).match(/uc_mem_(?:read|write) failed with code (\d+):/)?.[1]);
    if ([this.uc.ERR_READ_UNMAPPED, this.uc.ERR_WRITE_UNMAPPED, this.uc.ERR_READ_PROT, this.uc.ERR_WRITE_PROT].includes(code) || error instanceof NativeExecutionError && error.message === 'Invalid guest memory read') throw new GuestFileError(14, 'Invalid guest file I/O buffer');
    throw error;
   }
  };
  switch (name) {
   case '___error': return this.errorPointer();
   case '_getdtablesize': return this.files.softLimit;
   case '_getrlimit': case '_setrlimit': {
    if (destination !== 8) throw new Error(`Unsupported guest resource limit: ${destination}`);
    if (name === '_getrlimit') {
     const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
     view.setBigUint64(0, BigInt(this.files.softLimit), true); view.setBigUint64(8, BigInt(this.files.hardLimit), true); memory(() => this.write(source, bytes));
    } else {
     const bytes = memory(() => this.read(source, 16)), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
     this.files.setLimits(view.getBigUint64(0, true), view.getBigUint64(8, true));
    }
    return 0;
   }
   case '_access': return this.files.access(memory(() => this.string(destination)), source);
   case '_sysctlbyname': return memory(() => this.system.sysctlbyname([destination, source, size, this.register('RCX'), this.register('R8')]));
   case '_strerror': {
    const code = Number(BigInt.asIntN(32, this.argument64(0))), known = code >= 0 && code < darwinErrorMessages.length;
    if (known && this.errorStrings.has(code)) return this.errorStrings.get(code);
    const bytes = new TextEncoder().encode(`${known ? darwinErrorMessages[code] : `Unknown error: ${code}`}\0`);
    if (known) { const pointer = this.allocate(bytes.length); this.write(pointer, bytes); this.errorStrings.set(code, pointer); return pointer; }
    this.unknownErrorString ??= this.allocate(256); this.write(this.unknownErrorString, bytes);
    const error = new Uint8Array(4); new DataView(error.buffer).setInt32(0, 22, true); this.write(this.errorPointer(), error); return this.unknownErrorString;
   }
   case '_getcwd': {
    this.errorPointer();
    const bytes = new TextEncoder().encode(`${this.files.workingDirectory}\0`), capacity = this.argument64(1);
    if (destination && !capacity) throw new GuestFileError(22, 'getcwd requires a nonzero buffer size');
    if (destination && capacity < BigInt(bytes.length)) throw new GuestFileError(34, 'getcwd buffer is too small');
    let pointer = destination;
    if (!pointer) {
     try { pointer = this.allocate(bytes.length); }
     catch (error) { if (error instanceof NativeExecutionError && error.details.kind === 'heap-allocation') throw new GuestFileError(12, 'getcwd allocation failed'); throw error; }
    }
    try { memory(() => this.write(pointer, bytes)); }
    catch (error) { if (!destination) this.allocations.delete(pointer); throw error; }
    return pointer;
   }
   case '_realpath$DARWIN_EXTSN': {
    this.errorPointer();
    const bytes = new TextEncoder().encode(`${this.files.lookup(memory(() => this.string(destination))).path}\0`);
    if (bytes.length > 1024) throw new GuestFileError(63, 'realpath result exceeds PATH_MAX');
    const pointer = source || this.allocate(bytes.length);
    memory(() => this.write(pointer, bytes)); return pointer;
   }
   case '_utimes': {
    const path = memory(() => this.string(destination));
    let access = this.files.now(), modified = access;
    if (source) {
     const bytes = memory(() => this.read(source, 32)), view = new DataView(bytes.buffer, bytes.byteOffset, 32), time = offset => Number(view.getBigInt64(offset, true)) * 1000 + Math.floor(view.getInt32(offset + 8, true) / 1000);
     access = time(0); modified = time(16);
    }
    return this.files.setTimes(path, access, modified);
   }
   case '_fsync': this.files.descriptor(destination); return 0;
   case '_ftruncate': return this.files.truncate(destination, BigInt.asIntN(64, this.argument64(1)));
   case '_rename': return this.files.rename(memory(() => this.string(destination)), memory(() => this.string(source)));
   case '_unlink': case '_remove': case '_rmdir': return this.files.remove(memory(() => this.string(destination)));
   case '_chmod': this.files.lookup(memory(() => this.string(destination))); return 0;
   case '_fchmod': this.files.descriptor(destination); return 0;
   case '_mkdir': return this.files.mkdir(memory(() => this.string(destination)), source);
   case '_stat': case '_stat$INODE64': case '_lstat': case '_lstat$INODE64': {
    const bytes = this.files.stat(memory(() => this.string(destination))); memory(() => this.write(source, bytes)); return 0;
   }
   case '_statfs$INODE64': case '_statfs64': {
    const bytes = this.files.statfs(memory(() => this.string(destination))); memory(() => this.write(source, bytes)); return 0;
   }
   case '_fstatfs$INODE64': case '_fstatfs64': {
    const bytes = this.files.fstatfs(destination); memory(() => this.write(source, bytes)); return 0;
   }
   case '_fstat': case '_fstat$INODE64': {
    const bytes = this.files.fstat(destination); memory(() => this.write(source, bytes)); return 0;
   }
   case '_open': case '_open$NOCANCEL': return this.files.open(memory(() => this.string(destination)), source, size);
   case '_close': case '_close$NOCANCEL': return this.files.close(destination);
   case '_read': case '_read$NOCANCEL': {
    if (size > this.heapSize) throw new GuestFileError(22, 'Guest read exceeds memory limit');
    const bytes = this.files.read(destination, size); if (bytes.length) memory(() => this.write(source, bytes)); return bytes.length;
   }
   case '_write': case '_write$NOCANCEL': {
    if (size > this.heapSize) throw new GuestFileError(22, 'Guest write exceeds memory limit');
    return this.files.write(destination, size ? memory(() => this.read(source, size)) : new Uint8Array());
   }
   case '_lseek': return this.files.seek(destination, BigInt.asIntN(64, this.argument64(1)), size);
   case '_fcntl':
    if ([7, 8, 9].includes(source)) {
     this.files.descriptor(destination);
     const bytes = memory(() => this.read(size, 24));
     if (source === 7) { new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt16(20, 2, true); memory(() => this.write(size, bytes)); }
     return 0;
    }
    return this.files.control(destination, source, size);
   case '_pread': {
    if (size > this.heapSize) throw new GuestFileError(22, 'Guest read exceeds memory limit');
    const bytes = this.files.pread(destination, BigInt.asIntN(64, this.argument64(3)), size); if (bytes.length) memory(() => this.write(source, bytes)); return bytes.length;
   }
   case '_pwrite': {
    if (size > this.heapSize) throw new GuestFileError(22, 'Guest write exceeds memory limit');
    return this.files.pwrite(destination, BigInt.asIntN(64, this.argument64(3)), size ? memory(() => this.read(source, size)) : new Uint8Array());
   }
   case '_dup': return this.files.duplicate(destination);
  }
 }
 callback(address, args = []) {
  if ((this.callbackDepth || 0) >= 16) throw new NativeExecutionError('Guest callback nesting limit exceeded');
  const stackTop = Math.floor((this.register('RSP') - 256) / 16) * 16;
  const thread = this.threads.current;
  if (stackTop < thread.stackBase + 4096 || stackTop >= thread.stackTop) throw new NativeExecutionError('Guest callback stack exhausted');
  const context = this.engine.context_alloc(); this.engine.context_save(context);
  const previous = this.callbackStackTop; this.callbackStackTop = stackTop; this.callbackDepth = (this.callbackDepth || 0) + 1;
  try { return this.call(address, args); }
  finally {
   this.callbackStackTop = previous; this.callbackDepth--;
   if (!this.poisoned) {
    this.engine.context_restore(context); this.engine.context_free(context);
   }
  }
 }
 call(address, args = [], { instructionBudget = 2000000, milliseconds = 2000, longRunning = false, uncounted = false } = {}) {
  if (!this.engine) throw new NativeExecutionError('Guest is closed');
  if (this.poisoned) throw new NativeExecutionError('The emulator faulted; start a fresh worker');
  if (this.threads.failure) throw this.threads.failure;
  if (!Number.isSafeInteger(instructionBudget) || instructionBudget <= 0 || instructionBudget > (longRunning ? 20000000000 : 100000000) || !Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > (longRunning ? 110000 : 30000)) throw new NativeExecutionError('Invalid execution limits');
  if (!Array.isArray(args) || args.length > 64 || args.some(value => typeof value !== 'bigint' && !Number.isSafeInteger(value) || BigInt(value) < -(1n << 63n) || BigInt(value) > 0xffffffffffffffffn)) throw new NativeExecutionError('Invalid guest call arguments');
  const previous = this.executionBudget, budget = previous || { remaining: instructionBudget, deadline: performance.now() + milliseconds, uncounted };
  this.executionBudget = budget;
  const owner = this.threads.current, previousState = owner.state;
  owner.state = 'runnable'; this.callDepth = (this.callDepth || 0) + 1;
  try {
  const stack = (this.callbackStackTop ?? owner.stackTop) - 8 - Math.ceil(Math.max(0, args.length - 6) / 2) * 16;
  this.writePointer(stack, RETURN); this.setRegister('RSP', stack);
  for (let index = 6; index < args.length; index++) {
   const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(args[index])), true);
   this.write(stack + 8 + (index - 6) * 8, bytes);
  }
  for (const [index, name] of ['RDI', 'RSI', 'RDX', 'RCX', 'R8', 'R9'].entries()) this.setRegister(name, args[index] || 0);
  this.setRegister('RIP', address);
  const deadline = Math.min(budget.deadline, performance.now() + milliseconds);
  while (budget.remaining > 0 && performance.now() < deadline) {
   if (this.threads.current.state === 'runnable') {
   const contended = this.threads.contended(), allowance = Math.min(contended ? 128 : 8192, budget.remaining); budget.remaining -= allowance; this.pending = null;
   if (this.register('RIP') === RETURN) {
    if (this.threads.current === owner) return this.register('RAX');
    this.threads.finish(this.engine.reg_read_i64(this.uc.X86_REG_RAX));
   } else { this.executeQuantum(budget.uncounted && !contended ? 0 : allowance); if (this.pending && allowance > 128) budget.remaining += allowance - 128; }
   if (this.threads.current === owner && this.register('RIP') === RETURN && owner.state === 'runnable') return this.register('RAX');
   }
   if (this.callDepth === 1) {
    try { if (this.threads.schedule() === false) this.threads.idle(deadline); }
    catch (error) { throw new NativeExecutionError(error.message, { kind: 'unsupported-threading', threads: this.threads.report() }); }
   }
  }
  throw new NativeExecutionError('Execution limit reached; the guest did not return', { kind: 'execution-limit', reason: budget.remaining <= 0 ? 'instruction-budget' : 'wall-clock', remaining: budget.remaining, address: hex(this.register('RIP')) });
  } catch (error) {
   if (this.threads.current !== owner) {
    if (error instanceof NativeExecutionError) error.details.thread = this.threads.current.handle;
    this.threads.current.state = 'failed'; this.threads.failure = error;
   }
   throw error;
  } finally {
   if (!this.poisoned && this.threads.current !== owner) this.threads.select(owner);
   owner.state = previousState; this.callDepth--; this.executionBudget = previous;
  }
 }
 executeQuantum(allowance) {
   const begin = this.register('RIP');
   try { this.engine.emu_start(begin, RETURN, 0, allowance); }
   catch (error) {
    this.poisoned = error instanceof WebAssembly.RuntimeError;
    const stopped = this.poisoned ? begin : this.register('RIP');
    throw new NativeExecutionError(`CPU stopped at ${hex(stopped)}: ${String(error)}`, { kind: this.poisoned ? 'emulator-fault' : 'cpu-fault', address: hex(stopped), addressKind: this.poisoned ? 'last-entry' : 'faulting-instruction' });
   }
   if (this.register('RIP') === RETURN || !this.pending) return;
   const pending = this.pending;
   if (pending.kind === 'syscall' || pending.kind === 'interrupt') throw new NativeExecutionError(`Unsupported guest ${pending.kind}`, pending);
   const entry = this.imports.get(pending.address - (pending.address - IMPORTS) % 16);
   if (!entry || pending.kind === 'data') throw new NativeExecutionError(`Unsupported imported data: ${entry?.name || hex(pending.address)}`, { ...entry, kind: 'unsupported-data' });
   const result = this.invokeImport(entry);
   if (typeof result === 'object' && result.threadBlocked) return;
   if (typeof result === 'object' && result.threadExit !== undefined) { this.threads.finish(result.threadExit); return; }
   if (typeof result === 'object' && result.tailCall !== undefined) {
    if (!this.isExecutable(result.tailCall)) throw new NativeExecutionError('Invalid Objective-C guest method target');
    this.setRegister('RIP', result.tailCall); return;
   }
   const returnAddress = this.pointer(this.register('RSP'));
   this.setRegister('RSP', this.register('RSP') + 8);
   this.setRegister('RAX', BigInt.asUintN(64, BigInt(typeof result === 'object' ? result.rax : result)));
   if (typeof result === 'object' && result.rdx !== undefined) this.setRegister('RDX', result.rdx);
   if (typeof result === 'object' && result.xmm0 !== undefined) this.setFloatingRegister(0, result.xmm0);
   if (typeof result === 'object' && result.xmm0Bits !== undefined) {
    const bytes = this.engine.reg_read(this.uc.X86_REG_XMM0, 16); new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(0, result.xmm0Bits, true);
    this.engine.reg_write(this.uc.X86_REG_XMM0, bytes);
   }
   if (typeof result === 'object' && result.xmm0f !== undefined) this.setFloatingRegister(0, result.xmm0f, 32);
   if (typeof result === 'object' && result.xmm1 !== undefined) this.setFloatingRegister(1, result.xmm1);
   if (typeof result === 'object' && result.zeroVectors) for (const index of [0, 1]) this.engine.reg_write(this.uc[`X86_REG_XMM${index}`], new Uint8Array(16));
   this.setRegister('RIP', returnAddress);
 }
 export(name) {
  const address = this.image.symbols.get(name);
  if (address === undefined) throw new NativeExecutionError(`Missing export: ${name}`);
  return address + this.slide;
 }
 initialize() {
  if (this.initialized) return;
  if (this.startupFailure) throw this.startupFailure;
  try {
   this.startupStage = 'initializers';
   for (const section of this.image.initializers) for (let offset = 0; offset < section.size; offset += 8) {
    const address = this.pointer(section.address + this.slide + offset);
    if (address) this.call(address);
    this.initializersCompleted++;
   }
   if (this.image.symbols.has('_bundleEntry')) {
    this.startupStage = 'bundle-entry';
    this.call(this.export('_bundleEntry'), [this.bundles.main()]);
    if (BigInt.asUintN(8, this.engine.reg_read_i64(this.uc.X86_REG_RAX)) !== 1n) throw new NativeExecutionError('bundleEntry rejected startup', { kind: 'bundle-entry-failed' });
   }
   this.initialized = true; this.startupStage = 'ready';
  } catch (error) {
   this.startupFailure = error; throw error;
  }
 }
 virtual(object, index, args = [], limits) { return this.call(this.pointer(this.pointer(object) + index * 8), [object, ...args], limits); }
 factoryInfo() {
  this.factory = this.call(this.export('_GetPluginFactory'));
  if (!this.factory) throw new NativeExecutionError('GetPluginFactory returned null');
  const info = this.allocate(452);
  if (this.virtual(this.factory, 3, [info]) !== 0) throw new NativeExecutionError('getFactoryInfo failed');
  const count = this.virtual(this.factory, 4);
  if (!Number.isSafeInteger(count) || count > 256) throw new NativeExecutionError('Invalid VST3 class count');
  const classes = [];
  for (let index = 0; index < count; index++) {
   const record = this.allocate(116);
   if (this.virtual(this.factory, 5, [index, record]) !== 0) throw new NativeExecutionError('getClassInfo failed');
   classes.push({ cid: [...this.read(record, 16)].map(byte => byte.toString(16).padStart(2, '0')).join(''), category: this.string(record + 20, 32), name: this.string(record + 52, 64) });
  }
  return { vendor: this.string(info, 64), url: this.string(info + 64, 256), email: this.string(info + 320, 128), classes };
 }
 report() {
  return { architecture: 'x86_64', libraries: this.image.libraries, imports: this.imports.size, initializerCount: this.image.initializers.reduce((sum, section) => sum + section.size / 8, 0), initializersCompleted: this.initializersCompleted, initialized: this.initialized, playable: false, calls: Object.fromEntries(this.calls), heap: this.allocations.report(), files: this.files.report(), objc: this.objc.report(), threads: this.threads.report(), time: this.time.report(), network: this.urlTransport.report(), services: { diskArbitration: 'unavailable' } };
 }
}
