import { parseMachO, dyldFixups } from './macho-loader.js';
import { formatGuestPrintf } from './native-vst3-printf.js';
import { scanGuestIntegers } from './native-vst3-scanf.js';
import { GuestMutexes } from './native-vst3-mutex.js';
import { GuestFiles, GuestFileError } from './native-vst3-files.js';

const IMAGE = 0x10000000, HEAP = 0x30000000, HEAP_SIZE = 32 << 20;
const STACK = 0x40000000, STACK_SIZE = 1 << 20, IMPORTS = 0x50000000, IMPORT_SIZE = 1 << 20;
const RETURN = IMPORTS + IMPORT_SIZE - 4096;
const decoder = new TextDecoder();
const hex = value => `0x${value.toString(16)}`;
const unaryMath = new Map([
 ['_sin', Math.sin], ['_cos', Math.cos], ['_tan', Math.tan], ['_asin', Math.asin], ['_acos', Math.acos], ['_atan', Math.atan],
 ['_exp', Math.exp], ['_expm1', Math.expm1], ['_log', Math.log], ['_log2', Math.log2], ['_log10', Math.log10], ['_log1p', Math.log1p],
 ['_sqrt', Math.sqrt], ['_cbrt', Math.cbrt], ['_floor', Math.floor], ['_ceil', Math.ceil], ['_trunc', Math.trunc], ['_fabs', Math.abs],
]);
const fileImports = new Set(['___error', '_getrlimit', '_setrlimit', '_getdtablesize', '_open', '_open$NOCANCEL', '_close', '_close$NOCANCEL', '_read', '_read$NOCANCEL', '_write', '_write$NOCANCEL', '_lseek', '_fcntl', '_dup']);

export class NativeExecutionError extends Error {
 constructor(message, details = {}) { super(message); this.name = 'NativeExecutionError'; this.details = details; }
}

export class NativeVst3Guest {
 constructor(uc, bytes, { files = new Map(), monotonicClock = () => performance.now(), wallClock = () => Date.now() } = {}) {
  this.uc = uc;
  this.image = parseMachO(bytes);
  this.slide = IMAGE - this.image.minimum;
  this.imports = new Map(); this.importNames = new Map(); this.calls = new Map(); this.allocations = new Map(); this.destructors = []; this.uuids = new Map();
  this.heapTop = HEAP; this.initialized = false; this.initializersCompleted = 0; this.factory = 0; this.hooks = [];
  this.mutexes = new GuestMutexes(this);
  this.files = new GuestFiles(files);
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
   engine.mem_map(HEAP, HEAP_SIZE, uc.PROT_READ | uc.PROT_WRITE);
   engine.mem_write(HEAP, new Uint8Array(HEAP_SIZE));
   engine.mem_map(STACK, STACK_SIZE, uc.PROT_READ | uc.PROT_WRITE);
   engine.mem_write(STACK, new Uint8Array(STACK_SIZE));
   engine.mem_map(IMPORTS, IMPORT_SIZE, uc.PROT_READ | uc.PROT_EXEC);
   engine.mem_write(IMPORTS, new Uint8Array(IMPORT_SIZE).fill(0xc3));
   dyldFixups(this.image, this.slide, {
    readPointer: address => this.pointer(address), writePointer: (address, value) => this.writePointer(address, value),
    resolve: (name, ordinal, kind) => this.resolve(name, ordinal, kind),
   });
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
  for (const hook of this.hooks) this.engine.hook_del(hook);
  this.hooks = []; this.engine.close(); this.engine = null;
 }
 read(address, size) {
  if (!Number.isSafeInteger(address) || !Number.isSafeInteger(size) || size < 0 || size > HEAP_SIZE) throw new NativeExecutionError('Invalid guest memory read');
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
 floatingRegister(index = 0) {
  if (!Number.isInteger(index) || index < 0 || index > 7) throw new NativeExecutionError('Invalid floating register');
  const bytes = this.engine.reg_read(this.uc[`X86_REG_XMM${index}`], 16);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
 }
 setFloatingRegister(index, value) {
  if (!Number.isInteger(index) || index < 0 || index > 7) throw new NativeExecutionError('Invalid floating register');
  const bytes = this.engine.reg_read(this.uc[`X86_REG_XMM${index}`], 16);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat64(0, value, true);
  this.engine.reg_write(this.uc[`X86_REG_XMM${index}`], bytes);
 }
 argument64(index) {
  if (!Number.isInteger(index) || index < 0 || index >= 64) throw new NativeExecutionError('Guest argument limit exceeded');
  const name = ['RDI', 'RSI', 'RDX', 'RCX', 'R8', 'R9'][index];
  if (name) return BigInt.asUintN(64, this.engine.reg_read_i64(this.uc[`X86_REG_${name}`]));
  const bytes = this.read(this.register('RSP') + 8 * (index - 5), 8);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
 }
 allocate(size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > HEAP_SIZE) throw new NativeExecutionError('Guest allocation exceeds 32 MiB heap');
  const address = this.heapTop, next = address + Math.ceil(Math.max(1, size) / 16) * 16;
  if (next > HEAP + HEAP_SIZE) throw new NativeExecutionError('Guest exhausted the 32 MiB diagnostic heap');
  this.heapTop = next; this.allocations.set(address, size); return address;
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
  if (name === '___stack_chk_guard' || name === '_kCFAllocatorDefault') {
   const address = this.allocate(8);
   this.write(address, name === '___stack_chk_guard' ? crypto.getRandomValues(new Uint8Array(8)) : new Uint8Array(8));
   this.importNames.set(key, address);
   return address;
  }
  const address = IMPORTS + this.imports.size * 16;
  if (address >= RETURN) throw new NativeExecutionError('Too many imports');
  this.imports.set(address, { name, ordinal, library: ordinal > 0 ? this.image.libraries[ordinal - 1] : null });
  this.importNames.set(key, address);
  return address;
 }
 invokeImport(entry) {
  const args = ['RDI', 'RSI', 'RDX', 'RCX', 'R8', 'R9'].map(name => this.register(name));
  const [destination, source, size] = args;
  this.calls.set(entry.name, (this.calls.get(entry.name) || 0) + 1);
  if (fileImports.has(entry.name)) {
   try { return this.invokeFile(entry.name, args); }
   catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
     this.poisoned = true;
     throw new NativeExecutionError(`Emulator fault during ${entry.name}: ${error.message}`, { ...entry, kind: 'emulator-fault' });
    }
    if (!(error instanceof GuestFileError)) throw new NativeExecutionError(error.message || String(error), { ...entry, kind: 'unsupported-filesystem' });
    const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, error.errno, true); this.write(this.errorPointer(), bytes);
    return -1;
   }
  }
  if (unaryMath.has(entry.name)) return { rax: 0, xmm0: unaryMath.get(entry.name)(this.floatingRegister()) };
  if (entry.name.startsWith('_pthread_mutex')) {
   try {
    const result = this.mutexes.invoke(entry.name, destination, source);
    if (result !== undefined) return result;
   } catch (error) { throw new NativeExecutionError(error.message, { ...entry, kind: 'unsupported-threading' }); }
  }
  const fill = (address, length, byte = 0) => {
   if (!Number.isSafeInteger(length) || length < 0 || length > HEAP_SIZE) throw new NativeExecutionError('Guest memory operation exceeds limit');
   this.write(address, new Uint8Array(length).fill(byte));
  };
  switch (entry.name) {
   case '_objc_msgSend': {
    const selector = this.string(source), className = this.imports.get(destination)?.name.match(/^_OBJC_CLASS_\$_(.+)$/)?.[1];
    if (selector === 'class' && (className === 'NSObject' || destination === 0)) return destination;
    throw new NativeExecutionError(`Unsupported Objective-C message: ${className || hex(destination)} ${selector}`, { ...entry, kind: 'unsupported-objc', receiver: hex(destination), className: className || null, selector });
   }
   case '_mach_timebase_info': {
    const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
    view.setUint32(0, 1, true); view.setUint32(4, 1, true); this.write(destination, bytes); return 0;
   }
   case '_mach_absolute_time': {
    const milliseconds = this.monotonicClock();
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > Number.MAX_SAFE_INTEGER / 1000000) throw new NativeExecutionError('Invalid guest monotonic clock');
    const tick = BigInt(Math.floor(milliseconds * 1000000));
    if (tick > this.lastTick) this.lastTick = tick;
    return this.lastTick;
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
   case '_pow': {
    const base = this.floatingRegister(), exponent = this.floatingRegister(1);
    return { rax: 0, xmm0: base === 1 || base === -1 && Math.abs(exponent) === Infinity ? 1 : base ** exponent };
   }
   case '_malloc': case '__Znwm': case '__Znam': return this.allocate(destination);
   case '_calloc': { const address = this.allocate(destination * source); fill(address, destination * source); return address; }
   case '_free': case '__ZdlPv': case '__ZdaPv': this.allocations.delete(destination); return 0;
   case '_memset': fill(destination, size, source); return destination;
   case '_bzero': case '___bzero': fill(destination, source); return 0;
   case '_memcpy': case '_memmove': this.write(destination, this.read(source, size)); return destination;
   case '_strlen': return this.stringBytes(destination).length;
   case '_strcpy': case '_strcat': {
    const sourceBytes = this.stringBytes(source, 1 << 20), bytes = new Uint8Array(sourceBytes.length + 1);
    const offset = entry.name === '_strcat' ? this.stringBytes(destination, 1 << 20).length : 0;
    if (offset + bytes.length > (1 << 20)) throw new NativeExecutionError('Guest string exceeds limit');
    bytes.set(sourceBytes); this.write(destination + offset, bytes); return destination;
   }
   case '_sprintf': case '_snprintf': {
    const bounded = entry.name === '_snprintf', capacity = bounded ? source : 1 << 20;
    if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > (1 << 20)) throw new NativeExecutionError('printf capacity exceeds limit');
    let index = bounded ? 3 : 2;
    let output;
    try {
     output = formatGuestPrintf(this.stringBytes(bounded ? size : source), () => this.argument64(index++), (pointer, precision) => {
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
    if (guard[1]) throw new NativeExecutionError('Recursive static initialization');
    this.write(destination + 1, new Uint8Array([1])); return 1;
   }
   case '___cxa_guard_release': this.write(destination, new Uint8Array([1, 0])); return 0;
   case '___cxa_guard_abort': this.write(destination + 1, new Uint8Array([0])); return 0;
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
  if (!this.errnoAddress) { this.errnoAddress = this.allocate(4); this.write(this.errnoAddress, new Uint8Array(4)); }
  return this.errnoAddress;
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
   case '_open': case '_open$NOCANCEL': return this.files.open(memory(() => this.string(destination)), source);
   case '_close': case '_close$NOCANCEL': return this.files.close(destination);
   case '_read': case '_read$NOCANCEL': {
    if (size > HEAP_SIZE) throw new GuestFileError(22, 'Guest read exceeds memory limit');
    const bytes = this.files.read(destination, size); if (bytes.length) memory(() => this.write(source, bytes)); return bytes.length;
   }
   case '_write': case '_write$NOCANCEL': {
    if (size > HEAP_SIZE) throw new GuestFileError(22, 'Guest write exceeds memory limit');
    return this.files.write(destination, size ? memory(() => this.read(source, size)) : new Uint8Array());
   }
   case '_lseek': return this.files.seek(destination, BigInt.asIntN(64, this.argument64(1)), size);
   case '_fcntl': return this.files.control(destination, source, size);
   case '_dup': return this.files.duplicate(destination);
  }
 }
 call(address, args = [], { instructionBudget = 2000000, milliseconds = 2000 } = {}) {
  if (!this.engine) throw new NativeExecutionError('Guest is closed');
  if (this.poisoned) throw new NativeExecutionError('The emulator faulted; start a fresh worker');
  if (!Number.isSafeInteger(instructionBudget) || instructionBudget <= 0 || instructionBudget > 10000000 || !Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 10000) throw new NativeExecutionError('Invalid execution limits');
  const stack = STACK + STACK_SIZE - 8;
  this.writePointer(stack, RETURN); this.setRegister('RSP', stack);
  for (const [index, name] of ['RDI', 'RSI', 'RDX', 'RCX', 'R8', 'R9'].entries()) this.setRegister(name, args[index] || 0);
  this.setRegister('RIP', address);
  const deadline = performance.now() + milliseconds;
  let remaining = instructionBudget;
  while (remaining > 0 && performance.now() < deadline) {
   const allowance = Math.min(128, remaining); remaining -= allowance; this.pending = null;
   const begin = this.register('RIP');
   try { this.engine.emu_start(begin, RETURN, 0, allowance); }
   catch (error) {
    this.poisoned = error instanceof WebAssembly.RuntimeError;
    const stopped = this.poisoned ? begin : this.register('RIP');
    throw new NativeExecutionError(`CPU stopped at ${hex(stopped)}: ${String(error)}`, { kind: this.poisoned ? 'emulator-fault' : 'cpu-fault', address: hex(stopped), addressKind: this.poisoned ? 'last-entry' : 'faulting-instruction' });
   }
   if (this.register('RIP') === RETURN) return this.register('RAX');
   if (!this.pending) continue;
   const pending = this.pending;
   if (pending.kind === 'syscall' || pending.kind === 'interrupt') throw new NativeExecutionError(`Unsupported guest ${pending.kind}`, pending);
   const entry = this.imports.get(pending.address - (pending.address - IMPORTS) % 16);
   if (!entry || pending.kind === 'data') throw new NativeExecutionError(`Unsupported imported data: ${entry?.name || hex(pending.address)}`, { ...entry, kind: 'unsupported-data' });
   const result = this.invokeImport(entry);
   const returnAddress = this.pointer(this.register('RSP'));
   this.setRegister('RSP', this.register('RSP') + 8);
   this.setRegister('RAX', BigInt.asUintN(64, BigInt(typeof result === 'object' ? result.rax : result)));
   if (typeof result === 'object' && result.rdx !== undefined) this.setRegister('RDX', result.rdx);
   if (typeof result === 'object' && result.xmm0 !== undefined) this.setFloatingRegister(0, result.xmm0);
   this.setRegister('RIP', returnAddress);
  }
  throw new NativeExecutionError('Execution limit reached; the guest did not return', { kind: 'execution-limit', address: hex(this.register('RIP')) });
 }
 export(name) {
  const address = this.image.symbols.get(name);
  if (address === undefined) throw new NativeExecutionError(`Missing export: ${name}`);
  return address + this.slide;
 }
 initialize() {
  if (this.initialized) return;
  for (const section of this.image.initializers) for (let offset = 0; offset < section.size; offset += 8) {
   const address = this.pointer(section.address + this.slide + offset);
   if (address) this.call(address);
   this.initializersCompleted++;
  }
  if (this.image.symbols.has('_bundleEntry')) throw new NativeExecutionError('bundleEntry requires a real CFBundle compatibility layer', { kind: 'unsupported-bundle-entry' });
  this.initialized = true;
 }
 virtual(object, index, args = []) { return this.call(this.pointer(this.pointer(object) + index * 8), [object, ...args]); }
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
  return { architecture: 'x86_64', libraries: this.image.libraries, imports: this.imports.size, initializerCount: this.image.initializers.reduce((sum, section) => sum + section.size / 8, 0), initializersCompleted: this.initializersCompleted, initialized: this.initialized, playable: false, calls: Object.fromEntries(this.calls), files: this.files.report() };
 }
}
