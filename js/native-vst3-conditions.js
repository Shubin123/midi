const SIGNATURE = 0x434f4e44, STATIC_SIGNATURE = 0x3cb0b1bb;
export const cppTimedWait = '__ZNSt3__118condition_variable15__do_timed_waitERNS_11unique_lockINS_5mutexEEENS_6chrono10time_pointINS5_12system_clockENS5_8durationIxNS_5ratioILl1ELl1000000000EEEEEEE';
export const conditionImports = new Set(['_pthread_cond_init', '_pthread_cond_destroy', '_pthread_cond_wait', '_pthread_cond_signal', '_pthread_cond_broadcast']);
export const cppConditionImports = new Map([
 ['__ZNSt3__118condition_variable10notify_allEv', '_pthread_cond_broadcast'],
 ['__ZNSt3__118condition_variable10notify_oneEv', '_pthread_cond_signal'],
 ['__ZNSt3__118condition_variable4waitERNS_11unique_lockINS_5mutexEEE', '_pthread_cond_wait'],
 [cppTimedWait, '_pthread_cond_timedwait'],
 ['__ZNSt3__118condition_variableD1Ev', '_pthread_cond_destroy'], ['__ZNSt3__118condition_variableD2Ev', '_pthread_cond_destroy'],
]);

export class GuestConditions {
 constructor(memory) { this.memory = memory; this.conditions = new Map(); }
 initialize(address) {
  this.memory.write(address, new Uint8Array(48)); this.memory.writePointer(address, SIGNATURE);
  const condition = { waiters: [] }; this.conditions.set(address, condition); return condition;
 }
 condition(address) {
  const signature = this.memory.pointer(address);
  if (signature === STATIC_SIGNATURE) return this.initialize(address);
  return signature === SIGNATURE ? this.conditions.get(address) : undefined;
 }
 awaken(waiter) {
  if (waiter.thread.state === 'blocked' && waiter.thread.blocked.kind === 'condition') {
   waiter.thread.state = 'runnable'; waiter.thread.blocked = null;
  }
 }
 expire() {
  const timed = Array.from(this.conditions.values()).flatMap(condition => condition.waiters).filter(waiter => !waiter.notified && waiter.deadline !== undefined);
  if (!timed.length) return false;
  const milliseconds = this.memory.wallClock();
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > Number.MAX_SAFE_INTEGER / 1000) throw new Error('Invalid guest wall clock');
  const now = BigInt(Math.floor(milliseconds * 1000)) * 1000n;
  let pending = false;
  for (const waiter of timed) {
   if (now < waiter.deadline) { pending = true; continue; }
   waiter.notified = true; waiter.expired = true; this.awaken(waiter);
  }
  return pending;
 }
 invoke(name, address, argument, deadline) {
  const memory = this.memory;
  if (name === '_pthread_cond_init') {
   if (argument) throw new Error('Guest condition attributes are not implemented');
   if (this.conditions.has(address) && memory.pointer(address) === SIGNATURE) return 16;
   this.initialize(address); return 0;
  }
  const condition = this.condition(address);
  if (!condition) return 22;
  if (name === '_pthread_cond_destroy') {
   if (condition.waiters.length) return 16;
   this.conditions.delete(address); memory.writePointer(address, 0); return 0;
  }
  if (name === '_pthread_cond_signal' || name === '_pthread_cond_broadcast') {
   for (const waiter of condition.waiters) {
    if (waiter.notified) continue;
    waiter.notified = true;
    this.awaken(waiter);
    if (name === '_pthread_cond_signal') break;
   }
   return 0;
  }
  if (name !== '_pthread_cond_wait' && name !== '_pthread_cond_timedwait') throw new Error(`Unsupported condition operation ${name}`);
  if (name === '_pthread_cond_timedwait' && (typeof deadline !== 'bigint' || deadline < 0n)) return 22;
  const thread = memory.threads.current, existing = thread.conditionWait;
  if (existing) {
   if (existing.address !== address || existing.mutex !== argument || !existing.notified) throw new Error('Invalid condition wait continuation');
   const result = memory.mutexes.invoke('_pthread_mutex_lock', argument, 0);
   if (typeof result === 'object') return result;
   condition.waiters.splice(condition.waiters.indexOf(existing), 1); thread.conditionWait = null; return result || (existing.expired ? 60 : 0);
  }
  const mutex = memory.mutexes.mutex(argument);
  if (!mutex || !mutex.depth || mutex.owner !== thread) return 1;
  if (mutex.depth !== 1 || condition.waiters.some(waiter => waiter.mutex !== argument)) return 22;
  memory.threads.checkBlocking();
  const waiter = { address, mutex: argument, thread, notified: false, deadline };
  condition.waiters.push(waiter); thread.conditionWait = waiter;
  memory.mutexes.invoke('_pthread_mutex_unlock', argument, 0);
  return memory.threads.park('condition', address);
 }
 invokeCpp(name, address, uniqueLock) {
  const operation = cppConditionImports.get(name);
  let mutex = 0;
  if (operation === '_pthread_cond_wait' || operation === '_pthread_cond_timedwait') {
   mutex = this.memory.pointer(uniqueLock);
   if (!mutex || this.memory.read(uniqueLock + 8, 1)[0] !== 1) throw new Error('libc++ condition wait requires an owned unique_lock');
  }
  let deadline;
  if (operation === '_pthread_cond_timedwait') {
   deadline = BigInt.asIntN(64, this.memory.argument64(2));
   if (deadline > 0x59682f000000e941n) deadline = 0x59682f000000e941n;
  }
  const result = this.invoke(operation, address, mutex, deadline);
  if (typeof result === 'object') return result;
  if (result && !(operation === '_pthread_cond_timedwait' && result === 60)) throw new Error(`libc++ condition operation failed (${result}); C++ exception unwinding is not implemented`);
  return 0;
 }
}
