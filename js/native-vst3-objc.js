import { GuestFileError } from './native-vst3-files.js';

const MAX_CLASSES = 256, MAX_SELECTORS = 4096, MAX_METHODS = 16384, MAX_OBJECT = 1 << 20;
const align = (value, alignment) => Math.ceil(value / alignment) * alignment;
const encoder = new TextEncoder();

export const objcImports = new Set([
 '_objc_autoreleasePoolPush', '_objc_autoreleasePoolPop',
 '_objc_allocateClassPair', '_objc_registerClassPair', '_objc_disposeClassPair', '_objc_getClass', '_objc_lookUpClass', '_objc_getMetaClass',
 '_object_getClass', '_object_getIndexedIvars', '_class_getSuperclass', '_class_getName', '_class_isMetaClass', '_class_getInstanceSize',
 '_class_addIvar', '_class_getInstanceVariable', '_ivar_getOffset', '_ivar_getName', '_ivar_getTypeEncoding',
 '_class_addMethod', '_class_replaceMethod', '_class_getInstanceMethod', '_class_getClassMethod', '_method_getName', '_method_getImplementation', '_method_getTypeEncoding',
 '_sel_registerName', '_sel_getUid', '_sel_getName', '_sel_isEqual', '_class_createInstance', '_object_dispose',
 '_class_addProtocol', '_class_conformsToProtocol', '_protocol_conformsToProtocol', '_protocol_getName', '_protocol_isEqual', '_objc_getProtocol',
 '_objc_msgSend', '_objc_msgSendSuper', '_objc_msgSendSuper2',
]);

export class GuestObjCError extends Error {
 constructor(message, details = {}) { super(message); this.details = details; }
}

export class GuestObjC {
 constructor(memory) {
  this.memory = memory; this.classes = new Map(); this.names = new Map(); this.selectors = new Map();
  this.methods = new Map(); this.ivars = new Map(); this.objects = new Map(); this.protocols = new Map(); this.protocolNames = new Map(); this.root = 0; this.pools = [];
 }
 cstring(value) {
  const bytes = encoder.encode(`${value}\0`), address = this.memory.allocate(bytes.length);
  this.memory.write(address, bytes); return address;
 }
 selector(name) {
  if (this.selectors.has(name)) return this.selectors.get(name);
  if (!name || encoder.encode(name).length > 4095 || this.selectors.size >= MAX_SELECTORS) throw new GuestObjCError('Invalid selector or selector limit exceeded');
  const address = this.cstring(name); this.selectors.set(name, address); return address;
 }
 prepareSelectors(sections, slide) {
  let count = 0;
  for (const section of sections) for (let offset = 0; offset < section.size; offset += 8) {
   if (++count > 65536) throw new GuestObjCError('Objective-C selector-reference limit exceeded');
   const address = section.address + slide + offset, pointer = this.memory.pointer(address);
   if (pointer) this.memory.writePointer(address, this.selector(this.memory.string(pointer)));
  }
 }
 prepareProtocols(sections, slide) {
  let count = 0;
  for (const section of sections.filter(section => section.name === '__objc_protolist')) for (let offset = 0; offset < section.size; offset += 8) {
   if (++count > 65536) throw new GuestObjCError('Objective-C protocol-reference limit exceeded');
   const pointer = this.memory.pointer(section.address + slide + offset); if (pointer) this.protocol(pointer);
  }
  for (const section of sections.filter(section => section.name === '__objc_protorefs')) for (let offset = 0; offset < section.size; offset += 8) {
   if (++count > 65536) throw new GuestObjCError('Objective-C protocol-reference limit exceeded');
   const address = section.address + slide + offset, record = this.protocols.get(this.memory.pointer(address));
   if (record) this.memory.writePointer(address, record.handle);
  }
 }
 protocol(handle) {
  if (this.protocols.has(handle)) return this.protocols.get(handle);
  if (this.protocols.size >= 65536 || this.protocolNames.size >= 1024) throw new GuestObjCError('Objective-C protocol limit exceeded');
  const header = this.memory.read(handle, 72), size = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(64, true);
  if (size < 72 || size > 256) throw new GuestObjCError('Unsupported Objective-C protocol layout');
  this.memory.read(handle, size);
  const name = this.memory.string(this.memory.pointer(handle + 8));
  if (!name) throw new GuestObjCError('Invalid Objective-C protocol name');
  if (this.protocolNames.has(name)) { const record = this.protocolNames.get(name); this.protocols.set(handle, record); return record; }
  const record = { handle, name, namePointer: this.cstring(name), inherited: new Set() };
  this.protocols.set(handle, record); this.protocolNames.set(name, record);
  const inherited = this.memory.pointer(handle + 16);
  if (inherited) {
   const count = this.memory.pointer(inherited); if (count > 256) throw new GuestObjCError('Objective-C protocol inheritance limit exceeded');
   for (let index = 0; index < count; index++) record.inherited.add(this.protocol(this.memory.pointer(inherited + 8 + index * 8)).handle);
  }
  return record;
 }
 protocolConforms(handle, requested, visited = new Set()) {
  const record = this.protocol(handle), expected = this.protocol(requested);
  if (record.handle === expected.handle) return true;
  if (visited.has(record.handle)) return false;
  visited.add(record.handle);
  return [...record.inherited].some(parent => this.protocolConforms(parent, expected.handle, visited));
 }
 classConforms(handle, protocol) {
  const requested = this.protocol(protocol);
  for (let record = this.klass(handle); record; record = record.superclass ? this.klass(record.superclass) : null) {
   if (record.builtin && requested.name === 'NSObject') return true;
   if ([...record.protocols].some(adopted => this.protocolConforms(adopted, requested.handle))) return true;
  }
  return false;
 }
 rootClass() {
  if (this.root) return this.classes.get(this.root);
  const imported = [...this.memory.imports].find(([, entry]) => entry.name === '_OBJC_CLASS_$_NSObject');
  const handle = imported?.[0] ?? this.memory.resolve('_OBJC_CLASS_$_NSObject', 0, 'bind');
  const meta = this.memory.allocate(40), name = this.cstring('NSObject');
  this.memory.write(meta, new Uint8Array(40)); this.memory.writePointer(meta, meta); this.memory.writePointer(meta + 8, handle);
  this.classes.set(handle, { handle, name: 'NSObject', namePointer: name, superclass: 0, metaclass: meta, size: 8, registered: true, builtin: true, methods: new Map(), ivars: new Map(), protocols: new Set() });
  this.classes.set(meta, { handle: meta, name: 'NSObject', namePointer: name, superclass: handle, metaclass: meta, size: 40, registered: true, builtin: true, meta: true, methods: new Map(), ivars: new Map(), protocols: new Set() });
  this.names.set('NSObject', handle); this.root = handle; return this.classes.get(handle);
 }
 klass(handle) {
  if (!this.classes.has(handle) && this.memory.imports.get(handle)?.name === '_OBJC_CLASS_$_NSObject') this.rootClass();
  if (!this.classes.has(handle) && this.memory.imports.get(handle)?.name === '_OBJC_CLASS_$_NSString') {
   const root = this.rootClass(), meta = this.memory.allocate(40), namePointer = this.cstring('NSString');
   this.memory.write(meta, new Uint8Array(40)); this.memory.writePointer(meta, root.metaclass); this.memory.writePointer(meta + 8, root.metaclass);
   this.classes.set(handle, { handle, name: 'NSString', namePointer, superclass: root.handle, metaclass: meta, size: 8, registered: true, builtin: true, foundation: 'NSString', methods: new Map(), ivars: new Map(), protocols: new Set() });
   this.classes.set(meta, { handle: meta, name: 'NSString', namePointer, superclass: root.metaclass, metaclass: root.metaclass, size: 40, registered: true, builtin: true, meta: true, methods: new Map(), ivars: new Map(), protocols: new Set() });
   this.names.set('NSString', handle);
  }
  const record = this.classes.get(handle);
  if (!record) throw new GuestObjCError('Unknown Objective-C class', { receiver: `0x${handle.toString(16)}` });
  return record;
 }
 lookup(start, selector, field = 'methods') {
  for (let record = start; record; record = record.superclass ? this.klass(record.superclass) : null) {
   if (record[field].has(selector)) return record[field].get(selector);
  }
  return null;
 }
 allocate(superclass, name, extra) {
  if (!name || encoder.encode(name).length > 4095 || !Number.isSafeInteger(extra) || extra < 0 || extra > MAX_OBJECT) throw new GuestObjCError('Invalid Objective-C class allocation');
  this.rootClass();
  if (this.names.has(name)) return 0;
  if ([...this.memory.imports.values()].some(entry => entry.name === `_OBJC_CLASS_$_${name}`)) return 0;
  if (this.names.size >= MAX_CLASSES) throw new GuestObjCError('Objective-C class limit exceeded');
  const parent = superclass ? this.klass(superclass) : null;
  if (parent && (!parent.registered || parent.meta)) return 0;
  const handle = this.memory.allocate(40 + extra), meta = this.memory.allocate(40 + extra), namePointer = this.cstring(name);
  for (const address of [handle, meta]) this.memory.write(address, new Uint8Array(40 + extra));
  const rootMeta = parent ? this.klass(parent.metaclass).metaclass : meta;
  this.memory.writePointer(handle, meta); this.memory.writePointer(handle + 8, superclass);
  this.memory.writePointer(meta, rootMeta); this.memory.writePointer(meta + 8, parent ? parent.metaclass : handle);
  this.classes.set(handle, { handle, name, namePointer, superclass, metaclass: meta, size: parent ? parent.size : 8, extra, registered: false, methods: new Map(), ivars: new Map(), protocols: new Set() });
  this.classes.set(meta, { handle: meta, name, namePointer, superclass: parent ? parent.metaclass : handle, metaclass: rootMeta, owner: handle, size: 40, extra, registered: false, meta: true, methods: new Map(), ivars: new Map(), protocols: new Set() });
  this.names.set(name, handle); return handle;
 }
 register(handle) {
  const record = this.klass(handle);
  if (record.meta) throw new GuestObjCError('Cannot register a metaclass as a class pair');
  if (record.registered) return 0;
  record.registered = true; this.klass(record.metaclass).registered = true; return 0;
 }
 disposeClass(handle) {
  const record = this.klass(handle);
  if (record.builtin || record.meta || [...this.objects.values()].some(object => object.classHandle === handle) || [...this.classes.values()].some(klass => !klass.meta && klass.superclass === handle)) throw new GuestObjCError('Cannot dispose an in-use Objective-C class');
  for (const klass of [record, this.klass(record.metaclass)]) {
   for (const method of klass.methods.values()) this.methods.delete(method.handle);
   for (const ivar of klass.ivars.values()) this.ivars.delete(ivar.handle);
   this.classes.delete(klass.handle); this.memory.allocations.delete(klass.handle);
  }
  this.names.delete(record.name); return 0;
 }
 addIvar(handle, name, size, alignment, types) {
  const record = this.klass(handle);
  if (record.registered || record.meta || !name || name === 'isa' || this.lookup(record, name, 'ivars')) return 0;
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isInteger(alignment) || alignment < 0 || alignment > 20) throw new GuestObjCError('Invalid Objective-C ivar layout');
  if (this.ivars.size >= MAX_METHODS) throw new GuestObjCError('Objective-C ivar limit exceeded');
  const offset = align(record.size, 2 ** alignment), next = offset + size;
  if (next > MAX_OBJECT) throw new GuestObjCError('Objective-C instance exceeds 1 MiB');
  const ivar = { handle: this.memory.allocate(8), namePointer: this.cstring(name), typesPointer: types === null ? 0 : this.cstring(types), offset, size };
  this.memory.write(ivar.handle, new Uint8Array(8)); this.ivars.set(ivar.handle, ivar); record.ivars.set(name, ivar); record.size = next; return 1;
 }
 addMethod(handle, name, implementation, types, replace = false) {
  const record = this.klass(handle), previous = record.methods.get(name);
  if (previous && !replace) return 0;
  if (!this.memory.isExecutable(implementation)) throw new GuestObjCError('Objective-C IMP is not executable guest code');
  if (previous) { const original = previous.implementation; previous.implementation = implementation; return original; }
  if (this.methods.size >= MAX_METHODS) throw new GuestObjCError('Objective-C method limit exceeded');
  const method = { handle: this.memory.allocate(8), selector: this.selector(name), implementation, types: this.cstring(types) };
  this.memory.write(method.handle, new Uint8Array(8)); this.methods.set(method.handle, method); record.methods.set(name, method); return replace ? 0 : 1;
 }
 instance(handle, extra) {
  const record = this.klass(handle);
  if (!record.registered || record.meta) throw new GuestObjCError('Cannot instantiate an unregistered class or metaclass');
  if (this.objects.size >= 65536) throw new GuestObjCError('Objective-C instance count limit exceeded');
  if (!Number.isSafeInteger(extra) || extra < 0 || extra + align(record.size, 8) > MAX_OBJECT) throw new GuestObjCError('Objective-C instance exceeds 1 MiB');
  if (this.lookup(record, '.cxx_construct')) throw new GuestObjCError('Guest C++ Objective-C instance constructors are not implemented');
  const size = align(record.size, 8), object = this.memory.allocate(size + extra);
  this.memory.write(object, new Uint8Array(size + extra)); this.memory.writePointer(object, handle);
  this.objects.set(object, { classHandle: handle, size, extra }); return object;
 }
 objectClass(receiver) {
  if (!receiver) return 0;
  if (this.objects.has(receiver)) return this.objects.get(receiver).classHandle;
  return this.klass(receiver).metaclass;
 }
 autorelease(handle) {
  if (!this.pools.length) throw new GuestObjCError('Autorelease requires a guest pool');
  if (this.pools.at(-1).entries.length >= 65536) throw new GuestObjCError('Autorelease pool entry limit exceeded');
  this.pools.at(-1).entries.push(handle); return handle;
 }
 releaseString(handle) {
  const object = this.objects.get(handle);
  if (!object || !object.references) throw new GuestObjCError('Invalid NSString release');
  if (--object.references === 0) {
   if (object.utf8) this.memory.allocations.delete(object.utf8);
   this.objects.delete(handle); this.memory.allocations.delete(handle);
  }
  return 0;
 }
 stringMessage(receiver, name, record, object) {
  const argument = this.memory.register('RDX');
  const initialize = (handle, bytes) => {
   const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes), instance = this.objects.get(handle), storage = new Uint8Array(bytes.length + 1);
   storage.set(bytes); const pointer = this.memory.allocate(storage.length); this.memory.write(pointer, storage);
   if (instance.utf8) this.memory.allocations.delete(instance.utf8);
   instance.text = value; instance.utf8 = pointer; instance.references ??= 1; return handle;
  };
  if (!object && name === 'stringWithUTF8String:') return this.autorelease(initialize(this.instance(record.handle, 0), this.memory.stringBytes(argument, 1 << 20)));
  if (!object) return undefined;
  if (name === 'initWithUTF8String:') return initialize(receiver, this.memory.stringBytes(argument, 1 << 20));
  if (name === 'init') return initialize(receiver, new Uint8Array());
  if (object.text === undefined) return undefined;
  switch (name) {
   case 'UTF8String': return object.utf8;
   case 'length': return object.text.length;
   case 'retain': case 'copy':
    if (object.references >= 65536) throw new GuestObjCError('NSString reference limit exceeded');
    object.references++; return receiver;
   case 'retainCount': return object.references;
   case 'release': return this.releaseString(receiver);
   case 'autorelease': return this.autorelease(receiver);
   case 'isEqualToString:': return this.objects.get(argument)?.text === object.text ? 1 : 0;
  }
 }
 message(receiver, selector, start = null) {
  if (!receiver) return { rax: 0, rdx: 0, zeroVectors: true };
  const name = this.memory.string(selector), canonical = this.selector(name);
  this.memory.setRegister('RSI', canonical);
  if (this.memory.imports.get(receiver)?.name === '_OBJC_CLASS_$_NSDictionary' && name === 'dictionaryWithContentsOfFile:') {
   const path = this.objects.get(this.memory.register('RDX'))?.text;
   if (path === undefined) throw new GuestObjCError('Dictionary file path must be a supported NSString');
   let descriptor;
   try { descriptor = this.memory.files.open(path, 0); }
   catch (error) { if (error instanceof GuestFileError && error.errno === 2) return 0; throw error; }
   this.memory.files.close(descriptor); throw new GuestObjCError('Property-list parsing is not implemented for mounted dictionary files');
  }
  const object = this.objects.get(receiver), record = object ? this.klass(object.classHandle) : this.klass(receiver);
  const lookup = start || (object ? record : this.klass(record.metaclass));
  if (!record.registered) throw new GuestObjCError('Message sent to an unregistered Objective-C class');
  if (!record.initialized) {
   if (this.lookup(this.klass(record.metaclass), 'initialize')) throw new GuestObjCError('Guest +initialize callbacks are not implemented');
   record.initialized = true;
  }
  const method = this.lookup(lookup, name);
  if (method) return { tailCall: method.implementation };
  if (record.foundation === 'NSString') { const result = this.stringMessage(receiver, name, record, object); if (result !== undefined) return result; }
  let builtin = false;
  for (let current = lookup; current; current = current.superclass ? this.klass(current.superclass) : null) if (current.builtin) builtin = true;
  if (builtin) {
   if (name === 'class') return object ? record.handle : receiver;
   if (name === 'self' || name === 'init') return receiver;
   if (name === 'superclass') return record.superclass;
   if (!object && name === 'alloc') return this.instance(receiver, 0);
   if (!object && name === 'new') {
    const instance = this.instance(receiver, 0); this.memory.setRegister('RDI', instance);
    return this.message(instance, this.selector('init'));
   }
  }
  throw new GuestObjCError(`Unsupported Objective-C message: ${record.name} ${name}`, { className: record.name, selector: name, receiver: `0x${receiver.toString(16)}` });
 }
 invoke(name, args) {
  const [first, second, third, fourth, fifth] = args, string = address => this.memory.string(address);
  const method = address => { const record = this.methods.get(address); if (!record) throw new GuestObjCError('Unknown Objective-C method'); return record; };
  const ivar = address => { const record = this.ivars.get(address); if (!record) throw new GuestObjCError('Unknown Objective-C ivar'); return record; };
  switch (name) {
   case '_objc_autoreleasePoolPush': {
    if (this.pools.length >= 256) throw new GuestObjCError('Autorelease pool nesting limit exceeded');
    const token = this.memory.allocate(8); this.memory.write(token, new Uint8Array(8)); this.pools.push({ token, entries: [] }); return token;
   }
   case '_objc_autoreleasePoolPop': {
    const index = this.pools.findIndex(pool => pool.token === first); if (index < 0) throw new GuestObjCError('Invalid autorelease pool token');
    for (const pool of this.pools.splice(index).reverse()) {
     for (const handle of pool.entries.reverse()) this.releaseString(handle);
     this.memory.allocations.delete(pool.token);
    }
    return 0;
   }
   case '_objc_allocateClassPair': return this.allocate(first, string(second), third);
   case '_objc_registerClassPair': return this.register(first);
   case '_objc_disposeClassPair': return this.disposeClass(first);
   case '_objc_getClass': case '_objc_lookUpClass': case '_objc_getMetaClass': {
    const requested = string(first); if (requested === 'NSObject') this.rootClass();
    if (requested === 'NSString' && !this.names.has(requested)) {
     const imported = [...this.memory.imports].find(([, entry]) => entry.name === '_OBJC_CLASS_$_NSString'); if (imported) this.klass(imported[0]);
    }
    const record = this.classes.get(this.names.get(requested));
    if (!record && [...this.memory.imports.values()].some(entry => entry.name === `_OBJC_CLASS_$_${requested}`)) throw new GuestObjCError(`Imported Foundation class is not implemented: ${requested}`);
    if (!record?.registered) return 0;
    return name === '_objc_getMetaClass' ? record.metaclass : record.handle;
   }
   case '_object_getClass': return this.objectClass(first);
   case '_object_getIndexedIvars': {
    const object = this.objects.get(first); if (object) return first + object.size;
    this.klass(first); return first + 40;
   }
   case '_class_getSuperclass': return first ? this.klass(first).superclass : 0;
   case '_class_addProtocol': {
    const record = this.klass(first), protocol = this.protocol(second);
    if (this.classConforms(first, protocol.handle)) return 0;
    record.protocols.add(protocol.handle); return 1;
   }
   case '_class_conformsToProtocol': return first && second && this.classConforms(first, second) ? 1 : 0;
   case '_protocol_conformsToProtocol': return first && second && this.protocolConforms(first, second) ? 1 : 0;
   case '_protocol_getName': return this.protocol(first).namePointer;
   case '_protocol_isEqual': return first === second || first && second && this.protocol(first).handle === this.protocol(second).handle ? 1 : 0;
   case '_objc_getProtocol': return this.protocolNames.get(string(first))?.handle || 0;
   case '_class_getName': return this.klass(first).namePointer;
   case '_class_isMetaClass': return first && this.klass(first).meta ? 1 : 0;
   case '_class_getInstanceSize': return first ? align(this.klass(first).size, 8) : 0;
   case '_class_addIvar': return this.addIvar(first, string(second), third, fourth, fifth ? string(fifth) : null);
   case '_class_getInstanceVariable': return first ? this.lookup(this.klass(first), string(second), 'ivars')?.handle || 0 : 0;
   case '_ivar_getOffset': return ivar(first).offset;
   case '_ivar_getName': return ivar(first).namePointer;
   case '_ivar_getTypeEncoding': return ivar(first).typesPointer;
   case '_class_addMethod': return this.addMethod(first, string(second), third, string(fourth));
   case '_class_replaceMethod': return this.addMethod(first, string(second), third, string(fourth), true);
   case '_class_getInstanceMethod': case '_class_getClassMethod': {
    const record = this.klass(first), selector = string(second), start = name === '_class_getClassMethod' ? this.klass(record.metaclass) : record;
    const found = this.lookup(start, selector);
    if (found) return found.handle;
    if (['class', 'self', 'init', 'alloc', 'new', 'superclass'].includes(selector)) throw new GuestObjCError('Host NSObject method introspection is not implemented');
    return 0;
   }
   case '_method_getName': return method(first).selector;
   case '_method_getImplementation': return method(first).implementation;
   case '_method_getTypeEncoding': return method(first).types;
   case '_sel_registerName': case '_sel_getUid': return this.selector(string(first));
   case '_sel_getName': return this.selector(string(first));
   case '_sel_isEqual': return first === second || first && second && string(first) === string(second) ? 1 : 0;
   case '_class_createInstance': return this.instance(first, second);
   case '_object_dispose': {
    if (!first) return 0;
    const object = this.objects.get(first); if (!object) throw new GuestObjCError('Unknown Objective-C instance');
    if (this.lookup(this.klass(object.classHandle), '.cxx_destruct')) throw new GuestObjCError('Guest C++ Objective-C instance destructors are not implemented');
    this.objects.delete(first); this.memory.allocations.delete(first); return 0;
   }
   case '_objc_msgSend': return this.message(first, second);
   case '_objc_msgSendSuper': case '_objc_msgSendSuper2': {
    const receiver = this.memory.pointer(first), superclass = this.klass(this.memory.pointer(first + 8));
    this.memory.setRegister('RDI', receiver);
    const start = name === '_objc_msgSendSuper2' ? superclass.superclass : superclass.handle;
    if (!start) throw new GuestObjCError('Objective-C super dispatch has no superclass');
    return this.message(receiver, second, this.klass(start));
   }
  }
 }
 report() { return { dynamicClasses: [...this.classes.values()].filter(record => !record.meta && !record.builtin).length, registeredClasses: [...this.classes.values()].filter(record => !record.meta && record.registered).length, selectors: this.selectors.size, methods: this.methods.size, ivars: this.ivars.size, instances: this.objects.size, protocols: this.protocolNames.size }; }
}
