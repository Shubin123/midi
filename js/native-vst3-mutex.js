const ATTRIBUTE_SIGNATURE = 0x4d545841, MUTEX_SIGNATURE = 0x4d555458;
const STATIC_TYPES = new Map([[0x32aaaba7, 0], [0x32aaaba1, 1], [0x32aaaba2, 2], [0x32aaaba3, 0]]);
const INVALID = 22, BUSY = 16, PERMISSION = 1, DEADLOCK = 11, AGAIN = 35;
export const cppMutexImports = new Map([
 ['__ZNSt3__15mutex4lockEv', '_pthread_mutex_lock'], ['__ZNSt3__15mutex6unlockEv', '_pthread_mutex_unlock'],
 ['__ZNSt3__15mutex8try_lockEv', '_pthread_mutex_trylock'], ['__ZNSt3__15mutexD1Ev', '_pthread_mutex_destroy'], ['__ZNSt3__15mutexD2Ev', '_pthread_mutex_destroy'],
]);

export class GuestMutexes {
 constructor(memory) { this.memory = memory; this.attributes = new Map(); this.mutexes = new Map(); }
 signature(address) { return this.memory.pointer(address); }
 attribute(address) { return this.signature(address) === ATTRIBUTE_SIGNATURE ? this.attributes.get(address) : undefined; }
 mutex(address) {
  const signature = this.signature(address);
  if (STATIC_TYPES.has(signature)) this.initialize(address, STATIC_TYPES.get(signature));
  return this.signature(address) === MUTEX_SIGNATURE ? this.mutexes.get(address) : undefined;
 }
 initialize(address, type) {
  this.memory.write(address, new Uint8Array(64)); this.memory.writePointer(address, MUTEX_SIGNATURE);
  const state = { type, depth: 0, owner: null }; this.mutexes.set(address, state); return state;
 }
 invokeCpp(name, address) {
  const operation = cppMutexImports.get(name), result = this.invoke(operation, address, 0);
  if (typeof result === 'object') return result;
  if (operation === '_pthread_mutex_trylock') return Number(result === 0);
  if (result !== 0) throw new Error(`libc++ mutex operation failed (${result}); C++ exception unwinding is not implemented`);
  return 0;
 }
 invoke(name, address, argument) {
  switch (name) {
   case '_pthread_mutexattr_init':
    this.memory.write(address, new Uint8Array(16)); this.memory.writePointer(address, ATTRIBUTE_SIGNATURE);
    this.attributes.set(address, { type: 0, protocol: 0 }); return 0;
   case '_pthread_mutexattr_setprotocol': {
    const attribute = this.attribute(address);
    if (!attribute || ![0, 1, 2].includes(argument)) return INVALID;
    if (argument === 2) throw new Error('Priority-ceiling mutexes require a guest priority scheduler');
    attribute.protocol = argument; return 0;
   }
   case '_pthread_mutexattr_getprotocol': {
    const attribute = this.attribute(address);
    if (!attribute) return INVALID;
    const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, attribute.protocol, true);
    this.memory.write(argument, bytes); return 0;
   }
   case '_pthread_mutexattr_settype': {
    const attribute = this.attribute(address);
    if (!attribute || ![0, 1, 2].includes(argument)) return INVALID;
    attribute.type = argument; return 0;
   }
   case '_pthread_mutexattr_gettype': {
    const attribute = this.attribute(address);
    if (!attribute) return INVALID;
    const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, attribute.type, true);
    this.memory.write(argument, bytes); return 0;
   }
   case '_pthread_mutexattr_destroy':
    if (!this.attribute(address)) return INVALID;
    this.attributes.delete(address); this.memory.writePointer(address, 0); return 0;
   case '_pthread_mutex_init': {
    const attribute = argument ? this.attribute(argument) : { type: 0 };
    if (!attribute) return INVALID;
    if (this.mutexes.has(address) && this.signature(address) === MUTEX_SIGNATURE) return BUSY;
    this.initialize(address, attribute.type); return 0;
   }
   case '_pthread_mutex_lock': case '_pthread_mutex_trylock': {
    const mutex = this.mutex(address);
    if (!mutex) return INVALID;
    const owner = this.memory.threads?.current ?? this;
    if (mutex.depth && mutex.owner !== owner) {
     if (name === '_pthread_mutex_trylock') return BUSY;
     return this.memory.threads.park('mutex', address);
    }
    if (mutex.depth && mutex.type !== 2) {
     if (name === '_pthread_mutex_trylock') return BUSY;
     if (mutex.type === 1) return DEADLOCK;
     throw new Error('Normal mutex relock would deadlock the calling guest thread');
    }
    if (mutex.depth === 65535) return AGAIN;
    mutex.owner = owner; mutex.depth++; return 0;
   }
   case '_pthread_mutex_unlock': {
    const mutex = this.mutex(address);
    if (!mutex) return INVALID;
    if (!mutex.depth || mutex.owner !== (this.memory.threads?.current ?? this)) return PERMISSION;
    mutex.depth--;
    if (!mutex.depth) { mutex.owner = null; this.memory.threads?.wake('mutex', address); }
    return 0;
   }
   case '_pthread_mutex_destroy': {
    const mutex = this.mutex(address);
    if (!mutex) return INVALID;
    if (mutex.depth) return BUSY;
    this.mutexes.delete(address); this.memory.writePointer(address, 0); return 0;
   }
  }
 }
}
