import { GuestFileError } from './native-vst3-files.js';
import { parseGuestURL } from './native-vst3-url.js';
import { invokeGuestRequest, releaseGuestRequest } from './native-vst3-request.js';
import { invokeGuestData } from './native-vst3-data.js';
import { invokeGuestSessionConfiguration } from './native-vst3-session-configuration.js';
import { invokeGuestSession, releaseGuestSession } from './native-vst3-session.js';
import { invokeGuestSessionTask, releaseGuestSessionTask } from './native-vst3-session-task.js';
import { invokeGuestURLResponse, releaseGuestURLResponse } from './native-vst3-url-response.js';

const MAX_CLASSES = 256, MAX_SELECTORS = 4096, MAX_METHODS = 16384, MAX_OBJECT = 1 << 20;
const align = (value, alignment) => Math.ceil(value / alignment) * alignment;
const encoder = new TextEncoder();
const foundationClasses = new Set(['NSString', 'NSData', 'NSMutableData', 'NSURL', 'NSURLRequest', 'NSMutableURLRequest', 'NSURLSessionConfiguration', 'NSURLSession', 'NSURLSessionTask', 'NSURLSessionDataTask', 'NSURLResponse', 'NSHTTPURLResponse', 'NSError', 'NSDictionary', 'NSEnumerator', 'NSNumber', 'NSRunLoop', 'NSOperationQueue', 'NSNotificationCenter', 'NSNotification', 'NSApplication', 'NSRunningApplication', 'NSFileManager', 'NSProcessInfo', 'NSThread']);
const foundationParents = new Map([['NSMutableURLRequest', 'NSURLRequest'], ['NSMutableData', 'NSData'], ['NSURLSessionDataTask', 'NSURLSessionTask'], ['NSHTTPURLResponse', 'NSURLResponse']]);
export const objcStringConstants = new Map([
 'NSMenuDidBeginTrackingNotification', 'NSMenuDidEndTrackingNotification',
 'NSApplicationWillTerminateNotification', 'NSApplicationDidBecomeActiveNotification', 'NSApplicationDidResignActiveNotification', 'NSApplicationWillUnhideNotification',
 'NSViewFrameDidChangeNotification', 'NSViewGlobalFrameDidChangeNotification',
 'NSWindowDidDeminiaturizeNotification', 'NSWindowDidMiniaturizeNotification', 'NSWindowDidMoveNotification', 'NSWindowWillMiniaturizeNotification',
 'NSWorkspaceDidMountNotification', 'NSWorkspaceDidUnmountNotification', 'AVPlayerItemDidPlayToEndTimeNotification', 'NSURLIsHiddenKey',
].map(name => [`_${name}`, name]));

export const objcImports = new Set([
 '_NSHomeDirectory', '_NSTemporaryDirectory',
 '_objc_autoreleasePoolPush', '_objc_autoreleasePoolPop',
 '_objc_alloc', '_objc_retain', '_objc_release', '_objc_autorelease',
 '_objc_allocateClassPair', '_objc_registerClassPair', '_objc_disposeClassPair', '_objc_getClass', '_objc_lookUpClass', '_objc_getMetaClass',
 '_object_getClass', '_object_getIndexedIvars', '_class_getSuperclass', '_class_getName', '_class_isMetaClass', '_class_getInstanceSize',
 '_class_addIvar', '_class_getInstanceVariable', '_ivar_getOffset', '_ivar_getName', '_ivar_getTypeEncoding',
 '_object_setInstanceVariable', '_object_getInstanceVariable',
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
  this.methods = new Map(); this.ivars = new Map(); this.objects = new Map(); this.protocols = new Map(); this.protocolNames = new Map(); this.root = 0; this.localPools = []; this.freePoolTokens = []; this.defaultCenter = 0; this.constants = new Map(); this.application = 0; this.applicationCell = 0; this.fileManager = 0; this.processInfo = 0; this.runningApplication = 0;
 }
 get pools() { return this.memory.threads?.current.pools ?? this.localPools; }
 threadObject(thread) {
  if (!thread.cocoaObject) {
   thread.cocoaObject = this.instance(this.foundationClass('NSThread'), 0);
   this.objects.get(thread.cocoaObject).thread = thread;
  }
  return thread.cocoaObject;
 }
 threadExited(thread) {
  if (thread.cocoaObject) { const handle = thread.cocoaObject; thread.cocoaObject = 0; this.releaseObject(handle); }
 }
 threadMessage(receiver, name, object) {
  const threads = this.memory.threads;
  if (!threads) throw new GuestObjCError('No guest thread scheduler');
  if (!object) {
   if (name === 'currentThread') return this.threadObject(threads.current);
   if (name === 'mainThread') return this.threadObject(threads.main);
   if (name === 'isMainThread') return Number(threads.current === threads.main);
   if (name === 'isMultiThreaded') return Number(threads.created > 0);
   return undefined;
  }
  const thread = object.thread;
  if (!thread) return undefined;
  if (name === 'isMainThread') return Number(thread === threads.main);
  if (name === 'isExecuting') return Number(!['exited', 'failed'].includes(thread.state));
  if (name === 'isFinished') return Number(thread.state === 'exited');
  if (name === 'isCancelled') return Number(!!thread.cancelled);
  if (name === 'cancel') { thread.cancelled = true; return 0; }
  if (name === 'name') return object.threadName || 0;
  if (name === 'setName:') {
   const source = this.memory.register('RDX'), text = source ? this.memory.core.text(source) : null;
   const copy = text === null ? 0 : this.foundationString(text), previous = object.threadName;
   object.threadName = copy; thread.name = text;
   if (previous) this.releaseObject(previous);
   return 0;
  }
  return undefined;
 }
 applicationGlobal() {
  if (!this.applicationCell) { this.applicationCell = this.memory.allocate(8); this.memory.writePointer(this.applicationCell, this.application); }
  return this.applicationCell;
 }
 foundationClass(name) { return this.klass(this.names.get(name) ?? this.memory.resolve(`_OBJC_CLASS_$_${name}`, 0, 'bind')).handle; }
 foundationString(text) {
  const handle = this.instance(this.foundationClass('NSString'), 0);
  Object.assign(this.objects.get(handle), { text, utf8: this.cstring(text) }); return handle;
 }
 constantGlobal(name) {
  if (!objcStringConstants.has(name)) throw new GuestObjCError('Unknown Objective-C string constant');
  if (!this.constants.has(name)) {
   const klass = this.foundationClass('NSString'), handle = this.instance(klass, 0), text = objcStringConstants.get(name);
   Object.assign(this.objects.get(handle), { text, utf8: this.cstring(text), references: 1, immortal: true }); this.constants.set(name, handle);
  }
  const address = this.memory.allocate(8); this.memory.writePointer(address, this.constants.get(name)); return address;
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
  const importedName = this.memory.imports.get(handle)?.name;
  const foundation = importedName?.startsWith('_OBJC_CLASS_$_') ? importedName.slice('_OBJC_CLASS_$_'.length) : null;
  if (!this.classes.has(handle) && foundationClasses.has(foundation)) {
   const root = this.rootClass(), parent = foundationParents.has(foundation) ? this.klass(this.foundationClass(foundationParents.get(foundation))) : root, meta = this.memory.allocate(40), namePointer = this.cstring(foundation);
   this.memory.write(meta, new Uint8Array(40)); this.memory.writePointer(meta, root.metaclass); this.memory.writePointer(meta + 8, parent.metaclass);
   this.classes.set(handle, { handle, name: foundation, namePointer, superclass: parent.handle, metaclass: meta, size: 8, registered: true, builtin: true, foundation, methods: new Map(), ivars: new Map(), protocols: new Set() });
   this.classes.set(meta, { handle: meta, name: foundation, namePointer, superclass: parent.metaclass, metaclass: root.metaclass, size: 40, registered: true, builtin: true, meta: true, methods: new Map(), ivars: new Map(), protocols: new Set() });
   this.names.set(foundation, handle);
  }
  const record = this.classes.get(handle);
  if (!record) {
   const imported = this.memory.imports.get(handle)?.name, className = imported?.startsWith('_OBJC_CLASS_$_') ? imported.slice('_OBJC_CLASS_$_'.length) : null;
   throw new GuestObjCError(className ? `Imported Objective-C class is not implemented: ${className}` : 'Unknown Objective-C class', { receiver: `0x${handle.toString(16)}`, ...(className ? { className } : {}) });
  }
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
  this.objects.set(object, { classHandle: handle, size, extra, references: 1 }); return object;
 }
 objectClass(receiver) {
  if (!receiver) return 0;
  if (this.memory.core?.objects.get(receiver)?.kind === 'data') return this.foundationClass('NSData');
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
  if (object.immortal) return 0;
  if (--object.references === 0) {
   if (object.utf8) this.memory.allocations.delete(object.utf8);
   this.removeObject(handle);
  }
  return 0;
 }
 retainObject(handle) {
  if (!handle) return handle;
  if (this.memory.core?.objects.has(handle)) return this.memory.core.invoke('_CFRetain', [handle]);
  const object = this.objects.get(handle);
  if (!object) throw new GuestObjCError('Cannot retain an unknown guest object');
  if (object.immortal) return handle;
  if (object.references >= 65536) throw new GuestObjCError('Objective-C reference limit exceeded');
  object.references++; return handle;
 }
 removeObject(handle) {
  this.objects.delete(handle); this.memory.allocations.delete(handle);
  for (const instance of this.objects.values()) if (instance.observers) instance.observers = instance.observers.filter(entry => entry.observer !== handle);
 }
 releaseObject(handle) {
  if (!handle) return 0;
  if (this.memory.core?.objects.has(handle)) return this.memory.core.release(handle);
  const object = this.objects.get(handle);
  if (!object) throw new GuestObjCError('Cannot release an unknown guest object');
  if (object.immortal) return 0;
  if (object.thread && object.thread.state !== 'exited' && object.references === 1) return 0;
  if (object.session?.active && object.references === 1) return 0;
  const record = this.klass(object.classHandle);
  if (record.foundation === 'NSString') return this.releaseString(handle);
  if (record.foundation === 'NSNotificationCenter') return this.centerMessage(handle, 'release', record, object);
  if (--object.references) return 0;
  const dealloc = this.lookup(record, 'dealloc'), destructor = this.lookup(record, '.cxx_destruct');
  if (dealloc) this.memory.callback(dealloc.implementation, [handle, this.selector('dealloc')]);
  else if (destructor) this.memory.callback(destructor.implementation, [handle, this.selector('.cxx_destruct')]);
  if (object.notification) for (const value of Object.values(object.notification)) this.releaseObject(value);
  if (object.threadName) this.releaseObject(object.threadName);
  if (object.request) releaseGuestRequest(this, object.request);
  if (object.session) releaseGuestSession(this, object.session);
  if (object.sessionTask) releaseGuestSessionTask(this, object.sessionTask);
  releaseGuestURLResponse(this, object);
  if (object.kind === 'data' && object.owned && object.pointer) this.memory.allocations.delete(object.pointer);
  this.removeObject(handle); return 0;
 }
 notification(name, sender, userInfo) {
  const text = this.memory.core.text(name), stringClass = this.foundationClass('NSString');
  const retained = [];
  try {
   const copy = this.instance(stringClass, 0); retained.push(copy);
   Object.assign(this.objects.get(copy), { text, utf8: this.cstring(text) });
   for (const value of [sender, userInfo]) { this.retainObject(value); retained.push(value); }
   const klass = this.foundationClass('NSNotification'), handle = this.instance(klass, 0);
   this.objects.get(handle).notification = { name: copy, object: sender, userInfo }; return handle;
  } catch (error) { for (const value of retained.reverse()) this.releaseObject(value); throw error; }
 }
 notificationMessage(receiver, name, record, object) {
  if (!object && ['notificationWithName:object:', 'notificationWithName:object:userInfo:'].includes(name)) {
   if (!this.pools.length) throw new GuestObjCError('Autorelease requires a guest pool');
   return this.autorelease(this.notification(this.memory.register('RDX'), this.memory.register('RCX'), name.endsWith('userInfo:') ? this.memory.register('R8') : 0));
  }
  if (object && name === 'initWithName:object:userInfo:') {
   const initialized = this.notification(this.memory.register('RDX'), this.memory.register('RCX'), this.memory.register('R8')), data = this.objects.get(initialized).notification;
   if (object.notification) for (const value of Object.values(object.notification)) this.releaseObject(value);
   object.notification = data; this.removeObject(initialized); return receiver;
  }
  if (object?.notification && ['name', 'object', 'userInfo'].includes(name)) return object.notification[name];
 }
 fileManagerMessage(receiver, name, record, object) {
  if (!object && name === 'defaultManager') {
   if (!this.fileManager) { this.fileManager = this.instance(record.handle, 0); this.objects.get(this.fileManager).immortal = true; }
   return this.fileManager;
  }
  if (!object) return undefined;
  const first = this.memory.register('RDX'), second = this.memory.register('RCX');
  if (['fileExistsAtPath:', 'fileExistsAtPath:isDirectory:', 'isReadableFileAtPath:', 'isWritableFileAtPath:', 'isExecutableFileAtPath:'].includes(name)) {
   const path = this.memory.core.text(first);
   if (name === 'fileExistsAtPath:isDirectory:' && second) this.memory.write(second, new Uint8Array([0]));
   try {
    const entry = this.memory.files.lookup(path);
    if (name === 'fileExistsAtPath:isDirectory:' && second) this.memory.write(second, new Uint8Array([entry.directory ? 1 : 0]));
    if (name.startsWith('is')) this.memory.files.access(path, name === 'isReadableFileAtPath:' ? 4 : name === 'isWritableFileAtPath:' ? 2 : 1);
    return 1;
   } catch (error) { if (error instanceof GuestFileError) return 0; throw error; }
  }
  if (name === 'enumeratorAtPath:') {
   if (!this.pools.length) throw new GuestObjCError('Autorelease requires a guest pool');
   let paths;
   try { paths = this.memory.files.descendants(this.memory.core.text(first)); }
   catch (error) { if (error instanceof GuestFileError) return 0; throw error; }
   const handle = this.instance(this.foundationClass('NSEnumerator'), 0);
   this.objects.get(handle).enumeration = { source: 0, paths, keys: paths.map(path => this.foundationString(path)), owned: true, position: 0, last: null };
   return this.autorelease(handle);
  }
  if (name === 'removeItemAtPath:error:') {
   const path = this.memory.core.text(first);
   try { this.memory.files.remove(path); return 1; } catch (error) {
    if (!(error instanceof GuestFileError)) throw error;
    if (second) throw new GuestObjCError('File manager NSError output is not implemented'); return 0;
   }
  }
  if (name === 'destinationOfSymbolicLinkAtPath:error:') {
   const path = this.memory.core.text(first);
   try { return this.autorelease(this.foundationString(this.memory.files.readlink(path))); } catch (error) {
    if (!(error instanceof GuestFileError)) throw error;
    if (second) throw new GuestObjCError('File manager NSError output is not implemented'); return 0;
   }
  }
 }
 postNotification(center, notification) {
  const data = this.objects.get(notification)?.notification;
  if (!data) throw new GuestObjCError('Invalid guest notification');
  const text = this.memory.core.text(data.name), observers = (center.observers || []).filter(entry => (entry.name === null || entry.name === text) && (!entry.sender || entry.sender === data.object));
  if ((this.notificationDepth || 0) >= 16) throw new GuestObjCError('Notification posting nesting limit exceeded');
  this.retainObject(notification);
  this.notificationDepth = (this.notificationDepth || 0) + 1;
  try {
   for (const entry of observers) {
    const observer = this.objects.get(entry.observer);
    if (!observer || !(center.observers || []).includes(entry)) continue;
    const method = this.lookup(this.klass(observer.classHandle), this.memory.string(entry.selector));
    if (!method) throw new GuestObjCError('Notification observer selector is not implemented');
    this.memory.callback(method.implementation, [entry.observer, entry.selector, notification]);
   }
  } finally { this.notificationDepth--; this.releaseObject(notification); }
  return 0;
 }
 centerMessage(receiver, name, record, object) {
  if (!object && name === 'defaultCenter') {
   if (!this.defaultCenter) {
    this.defaultCenter = this.instance(record.handle, 0);
    this.objects.get(this.defaultCenter).references = 1;
   }
   return this.defaultCenter;
  }
  if (!object) return undefined;
  object.references ??= 1;
  switch (name) {
   case 'postNotification:': return this.postNotification(object, this.memory.register('RDX'));
   case 'postNotificationName:object:': case 'postNotificationName:object:userInfo:': {
    const notification = this.notification(this.memory.register('RDX'), this.memory.register('RCX'), name.endsWith('userInfo:') ? this.memory.register('R8') : 0);
    try { return this.postNotification(object, notification); } finally { this.releaseObject(notification); }
   }
   case 'addObserver:selector:name:object:': {
    const observer = this.memory.register('RDX'), selector = this.memory.register('RCX'), filter = this.memory.register('R8'), sender = this.memory.register('R9');
    if (!this.objects.has(observer)) throw new GuestObjCError('Notification observer must be a live guest object');
    const operation = this.selector(this.memory.string(selector)), text = filter ? this.memory.core.text(filter) : null;
    object.observers ??= [];
    if (object.observers.length >= 4096) throw new GuestObjCError('Notification observer limit exceeded');
    object.observers.push({ observer, selector: operation, name: text, sender }); return 0;
   }
   case 'removeObserver:': case 'removeObserver:name:object:': {
    const observer = this.memory.register('RDX'), filter = name === 'removeObserver:' ? 0 : this.memory.register('RCX'), sender = name === 'removeObserver:' ? 0 : this.memory.register('R8');
    const text = filter ? this.memory.core.text(filter) : null;
    object.observers = (object.observers || []).filter(entry => !(entry.observer === observer && (text === null || entry.name === text) && (!sender || sender === entry.sender))); return 0;
   }
   case 'retain':
    if (object.references >= 65536) throw new GuestObjCError('NSNotificationCenter reference limit exceeded');
    object.references++; return receiver;
   case 'retainCount': return object.references;
   case 'release':
    if (receiver === this.defaultCenter && object.references === 1) return 0;
    if (--object.references === 0) this.removeObject(receiver);
    return 0;
   case 'autorelease': return this.autorelease(receiver);
  }
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
    if (object.immortal) return receiver;
    if (object.references >= 65536) throw new GuestObjCError('NSString reference limit exceeded');
    object.references++; return receiver;
   case 'retainCount': return object.references;
   case 'release': return this.releaseString(receiver);
   case 'autorelease': return this.autorelease(receiver);
   case 'isEqualToString:': return this.objects.get(argument)?.text === object.text ? 1 : 0;
  }
 }
 urlMessage(receiver, name, record, object) {
  if (!object && name === 'fileURLWithPath:') {
   if (!this.pools.length) throw new GuestObjCError('Autorelease requires a guest pool');
   const path = this.memory.core.text(this.memory.register('RDX')), absolute = this.memory.files.path(path);
   const handle = this.instance(record.handle, 0), encoded = absolute.split('/').map(encodeURIComponent).join('/');
   this.objects.get(handle).url = { absoluteString: `file://${encoded}`, relativeString: `file://${encoded}`, scheme: 'file', host: null, path: absolute, query: null, fragment: null };
   return this.autorelease(handle);
  }
  if (object?.url?.scheme === 'file' && name === 'getResourceValue:forKey:error:') {
   const output = this.memory.register('RDX'), key = this.memory.core.text(this.memory.register('RCX'));
   if (key !== 'NSURLIsHiddenKey') throw new GuestObjCError(`Unsupported file URL resource key: ${key}`, { className: 'NSURL', selector: name });
   if (!this.pools.length) throw new GuestObjCError('Autorelease requires a guest pool');
   const handle = this.instance(this.foundationClass('NSNumber'), 0);
   this.objects.get(handle).numberValue = object.url.path.split('/').at(-1).startsWith('.') ? 1 : 0;
   this.memory.writePointer(output, this.autorelease(handle)); return 1;
  }
  if (!object && name === 'URLWithString:' || object && name === 'initWithString:') {
   if (!object && !this.pools.length) throw new GuestObjCError('Autorelease requires a guest pool');
   let url;
   try { url = parseGuestURL(this.memory.core.text(this.memory.register('RDX'))); }
   catch (error) { throw new GuestObjCError(error.message, { className: 'NSURL', selector: name }); }
   const handle = object ? receiver : this.instance(record.handle, 0); this.objects.get(handle).url = url;
   return object ? handle : this.autorelease(handle);
  }
  if (!object?.url) return undefined;
  if (Object.hasOwn(object.url, name)) {
   if (object.url[name] === null) return 0;
   if (!this.pools.length) throw new GuestObjCError('Autorelease requires a guest pool');
   return this.autorelease(this.foundationString(object.url[name]));
  }
  if (name === 'isFileURL' || name === 'baseURL') return 0;
  if (name === 'absoluteURL') return receiver;
  if (name === 'copy' || name === 'copyWithZone:') return this.retainObject(receiver);
 }
 message(receiver, selector, start = null) {
  if (!receiver) return { rax: 0, rdx: 0, zeroVectors: true };
  const name = this.memory.string(selector), canonical = this.selector(name);
  this.memory.setRegister('RSI', canonical);
  const data = this.memory.core?.objects.get(receiver);
  if (data?.kind === 'data') {
   try { const result = invokeGuestData(this, receiver, name, { handle: this.foundationClass('NSData') }, data); if (result !== undefined) return result; }
   catch (error) { if (error instanceof WebAssembly.RuntimeError) throw error; throw new GuestObjCError(error.message, { className: 'NSData', selector: name }); }
   throw new GuestObjCError(`Unsupported Objective-C message: NSData ${name}`, { className: 'NSData', selector: name });
  }
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
  if (record.foundation === 'NSThread') { const result = this.threadMessage(receiver, name, object); if (result !== undefined) return result; }
  if (record.foundation === 'NSRunningApplication') {
   if (!object && ['currentApplication', 'runningApplicationWithProcessIdentifier:'].includes(name)) {
    if (name === 'runningApplicationWithProcessIdentifier:' && BigInt.asIntN(32, this.memory.argument64(2)) !== BigInt(this.memory.system.pid)) return 0;
    if (!this.runningApplication) { this.runningApplication = this.instance(record.handle, 0); this.objects.get(this.runningApplication).immortal = true; }
    return this.runningApplication;
   }
   if (object && receiver === this.runningApplication) {
    if (name === 'processIdentifier') return this.memory.system.pid;
    if (name === 'executableArchitecture') return 0x01000007;
    if (name === 'localizedName') {
     if (!this.pools.length) throw new GuestObjCError('Autorelease requires a guest pool');
     return this.autorelease(this.foundationString('MIDI Browser Native Guest'));
    }
   }
  }
  if (record.foundation === 'NSOperationQueue' && !object && ['currentQueue', 'mainQueue'].includes(name)) {
   if (name === 'currentQueue' && this.memory.threads.current !== this.memory.threads.main) return 0;
   if (!this.mainOperationQueue) { this.mainOperationQueue = this.instance(record.handle, 0); Object.assign(this.objects.get(this.mainOperationQueue), { immortal: true, operationQueue: { maximum: 1n, suspended: false } }); }
   return this.mainOperationQueue;
  }
  if (record.foundation === 'NSOperationQueue' && object?.operationQueue) {
   if (name === 'maxConcurrentOperationCount') return object.operationQueue.maximum;
   if (name === 'isSuspended') return Number(object.operationQueue.suspended);
   if (name === 'operationCount') return 0;
  }
  if (record.foundation === 'NSProcessInfo') {
   if (!object && name === 'processInfo') {
    if (!this.processInfo) { this.processInfo = this.instance(record.handle, 0); this.objects.get(this.processInfo).immortal = true; }
    return this.processInfo;
   }
   if (object) {
    if (name === 'processIdentifier') return this.memory.system.pid;
    if (name === 'processName') return this.autorelease(this.foundationString('MIDI Browser Native Guest'));
    if (name === 'systemUptime') {
     const milliseconds = this.memory.monotonicClock();
     if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new GuestObjCError('Invalid guest monotonic clock');
     return { rax: 0, xmm0: milliseconds / 1000 };
    }
    const node = name === 'processorCount' ? 'hw.ncpu' : name === 'activeProcessorCount' ? 'hw.activecpu' : name === 'physicalMemory' ? 'hw.memsize' : null;
    if (node) { const bytes = this.memory.system.nodes.get(node), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return bytes.length === 8 ? view.getBigUint64(0, true) : view.getUint32(0, true); }
   }
  }
  if (record.foundation === 'NSString') { const result = this.stringMessage(receiver, name, record, object); if (result !== undefined) return result; }
  if (['NSData', 'NSMutableData'].includes(record.foundation)) {
   try { const result = invokeGuestData(this, receiver, name, record, object); if (result !== undefined) return result; }
   catch (error) { if (error instanceof WebAssembly.RuntimeError) throw error; throw new GuestObjCError(error.message, { className: record.name, selector: name }); }
  }
  if (record.foundation === 'NSURL') { const result = this.urlMessage(receiver, name, record, object); if (result !== undefined) return result; }
  if (record.foundation === 'NSRunLoop') {
   if (!object && name === 'currentRunLoop') {
    if (this.memory.threads.current !== this.memory.threads.main) throw new GuestObjCError('Secondary-thread NSRunLoop is not implemented', { className: record.name, selector: name });
    if (!this.mainRunLoop) { this.mainRunLoop = this.instance(record.handle, 0); this.objects.get(this.mainRunLoop).immortal = true; }
    return this.mainRunLoop;
   }
   if (object && name === 'cancelPerformSelectorsWithTarget:') return 0;
  }
  if (record.foundation === 'NSNumber' && object?.numberValue !== undefined && ['boolValue', 'intValue', 'integerValue', 'longValue', 'longLongValue'].includes(name)) return object.numberValue;
  if (['NSURLRequest', 'NSMutableURLRequest'].includes(record.foundation)) {
   try { const result = invokeGuestRequest(this, receiver, name, record, object); if (result !== undefined) return result; }
   catch (error) { if (error instanceof WebAssembly.RuntimeError) throw error; throw new GuestObjCError(error.message, { className: record.name, selector: name }); }
  }
  if (record.foundation === 'NSURLSessionConfiguration') {
   try { const result = invokeGuestSessionConfiguration(this, receiver, name, record, object); if (result !== undefined) return result; }
   catch (error) { if (error instanceof WebAssembly.RuntimeError) throw error; throw new GuestObjCError(error.message, { className: record.name, selector: name }); }
  }
  if (record.foundation === 'NSURLSession') {
   try { const result = invokeGuestSession(this, receiver, name, record, object); if (result !== undefined) return result; }
   catch (error) { if (error instanceof WebAssembly.RuntimeError) throw error; throw new GuestObjCError(error.message, { className: record.name, selector: name }); }
  }
  if (['NSURLSessionTask', 'NSURLSessionDataTask'].includes(record.foundation)) {
   try { const result = invokeGuestSessionTask(this, receiver, name, record, object); if (result !== undefined) return result; }
   catch (error) { if (error instanceof WebAssembly.RuntimeError) throw error; throw new GuestObjCError(error.message, { className: record.name, selector: name }); }
  }
  if (['NSURLResponse', 'NSHTTPURLResponse', 'NSError', 'NSDictionary', 'NSEnumerator'].includes(record.foundation)) {
   try { const result = invokeGuestURLResponse(this, receiver, name, record, object); if (result !== undefined) return result; }
   catch (error) { if (error instanceof WebAssembly.RuntimeError) throw error; throw new GuestObjCError(error.message, { className: record.name, selector: name }); }
  }
  if (record.foundation === 'NSNotificationCenter') { const result = this.centerMessage(receiver, name, record, object); if (result !== undefined) return result; }
  if (record.foundation === 'NSFileManager') { const result = this.fileManagerMessage(receiver, name, record, object); if (result !== undefined) return result; }
  if (record.foundation === 'NSApplication' && !object && name === 'sharedApplication') {
   if (!this.application) { this.application = this.instance(record.handle, 0); this.objects.get(this.application).immortal = true; this.memory.writePointer(this.applicationGlobal(), this.application); }
   return this.application;
  }
  if (record.foundation === 'NSNotification') { const result = this.notificationMessage(receiver, name, record, object); if (result !== undefined) return result; }
  let builtin = false;
  for (let current = lookup; current; current = current.superclass ? this.klass(current.superclass) : null) if (current.builtin) builtin = true;
  if (builtin) {
   if (object && name === 'retain') return this.retainObject(receiver);
   if (object && name === 'release') return this.releaseObject(receiver);
   if (object && name === 'retainCount') return object.references;
   if (object && name === 'autorelease') return this.autorelease(receiver);
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
   case '_objc_alloc': {
    const selector = this.selector('alloc'); this.memory.setRegister('RSI', selector);
    return this.message(first, selector);
   }
   case '_objc_retain': return this.retainObject(first);
   case '_objc_release': return this.releaseObject(first);
   case '_objc_autorelease':
    if (!first) return 0;
    if (!this.objects.has(first) && !this.memory.core?.objects.has(first)) throw new GuestObjCError('Cannot autorelease an unknown guest object');
    return this.autorelease(first);
   case '_NSHomeDirectory': case '_NSTemporaryDirectory': {
    if (!this.pools.length) throw new GuestObjCError('Autorelease requires a guest pool');
    const path = name === '_NSHomeDirectory' ? this.memory.files.homeDirectory : `${this.memory.files.temporaryDirectory}/`;
    return this.autorelease(this.foundationString(path));
   }
   case '_objc_autoreleasePoolPush': {
    if (this.pools.length >= 256) throw new GuestObjCError('Autorelease pool nesting limit exceeded');
    const token = this.freePoolTokens.pop() ?? this.memory.allocate(8); this.memory.allocations.set(token, 8); this.memory.write(token, new Uint8Array(8)); this.pools.push({ token, entries: [] }); return token;
   }
   case '_objc_autoreleasePoolPop': {
    const index = this.pools.findIndex(pool => pool.token === first); if (index < 0) throw new GuestObjCError('Invalid autorelease pool token');
    for (const pool of this.pools.splice(index).reverse()) {
     for (const handle of pool.entries.reverse()) this.releaseObject(handle);
     this.freePoolTokens.push(pool.token);
    }
    return 0;
   }
   case '_objc_allocateClassPair': return this.allocate(first, string(second), third);
   case '_objc_registerClassPair': return this.register(first);
   case '_objc_disposeClassPair': return this.disposeClass(first);
   case '_objc_getClass': case '_objc_lookUpClass': case '_objc_getMetaClass': {
    const requested = string(first); if (requested === 'NSObject') this.rootClass();
    if (foundationClasses.has(requested) && !this.names.has(requested)) {
     const imported = [...this.memory.imports].find(([, entry]) => entry.name === `_OBJC_CLASS_$_${requested}`);
     this.klass(imported?.[0] ?? this.memory.resolve(`_OBJC_CLASS_$_${requested}`, 0, 'bind'));
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
   case '_object_setInstanceVariable': case '_object_getInstanceVariable': {
    const reading = name === '_object_getInstanceVariable';
    if (!first) { if (reading && third) this.memory.write(third, new Uint8Array(8)); return 0; }
    const object = this.objects.get(first); if (!object) throw new GuestObjCError('Unknown Objective-C instance');
    const variable = this.lookup(this.klass(object.classHandle), string(second), 'ivars');
    if (!variable) { if (reading && third) this.memory.write(third, new Uint8Array(8)); return 0; }
    if (variable.size !== 8 || variable.offset + 8 > object.size) throw new GuestObjCError('Named instance-variable access requires a pointer-sized guest ivar');
    if (reading) { if (third) this.memory.write(third, this.memory.read(first + variable.offset, 8)); }
    else { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, this.memory.argument64(2), true); this.memory.write(first + variable.offset, bytes); }
    return variable.handle;
   }
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
    if (first === this.defaultCenter) throw new GuestObjCError('Cannot dispose the default notification center');
    if (first === this.application) throw new GuestObjCError('Cannot dispose the shared application');
    const object = this.objects.get(first); if (!object) throw new GuestObjCError('Unknown Objective-C instance');
    if (object.immortal) throw new GuestObjCError('Cannot dispose a permanent Foundation object');
    if (object.thread) throw new GuestObjCError('Cannot dispose a managed guest thread object');
    if (object.request || object.session || object.sessionTask || object.kind === 'data') throw new GuestObjCError('Cannot directly dispose a managed Foundation object');
    if (this.lookup(this.klass(object.classHandle), '.cxx_destruct')) throw new GuestObjCError('Guest C++ Objective-C instance destructors are not implemented');
    this.removeObject(first);
    return 0;
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
