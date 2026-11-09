export const threadImports = new Set(['_pthread_create', '_pthread_join', '_pthread_detach', '_pthread_exit', '_pthread_getschedparam', '_pthread_setschedparam', '_sched_get_priority_min', '_sched_get_priority_max', '_sched_yield', '_pthread_yield_np']);

export class GuestThreads {
 constructor(memory, stackBase, stackTop, returnAddress) {
  this.memory = memory; this.returnAddress = returnAddress;
  this.main = { handle: 0, stackBase, stackTop, state: 'idle', context: 0, pools: [], errnoAddress: 0, policy: 1, priority: 31 };
  this.current = this.main; this.records = new Set([this.main]); this.created = 0; this.completed = 0; this.switches = 0;
 }
 context(thread) {
  if (!thread.context) thread.context = this.memory.engine.context_alloc();
  this.memory.engine.context_save(thread.context);
 }
 select(thread) {
  if (thread === this.current) return;
  const previous = this.current;
  if (!['exited', 'failed'].includes(previous.state)) this.context(previous);
  previous.handle = this.memory.threadStorage.current;
  this.memory.engine.context_restore(thread.context);
  this.current = thread; this.memory.threadStorage.current = thread.handle; this.switches++;
 }
 checkBlocking() {
  if ((this.memory.callDepth || 0) > 1) throw new Error('Blocking inside a synchronous guest callback is not implemented');
 }
 park(kind, resource) {
  this.checkBlocking();
  this.current.state = 'blocked'; this.current.blocked = { kind, resource }; return { threadBlocked: true };
 }
 wake(kind, resource) {
  for (const thread of this.records) if (thread.state === 'blocked' && thread.blocked.kind === kind && thread.blocked.resource === resource) {
   thread.state = 'runnable'; thread.blocked = null;
  }
 }
 contended() {
  for (const thread of this.records) if (thread !== this.current && thread.state === 'runnable') return true;
  return false;
 }
 schedule() {
  const timedWaits = this.memory.conditions?.expire();
  const sleeping = this.memory.time?.expire();
  if (this.records.size === 1 && this.current.state === 'runnable') return;
  const records = Array.from(this.records), start = records.indexOf(this.current);
  for (let offset = 1; offset <= records.length; offset++) {
   const candidate = records[(start + offset) % records.length];
   if (candidate.state === 'runnable') { this.select(candidate); return; }
  }
  if (timedWaits || sleeping) return false;
  throw new Error('Guest thread deadlock: no runnable thread');
 }
 idle(deadline) {
  if (typeof SharedArrayBuffer !== 'function' || typeof Atomics.wait !== 'function') return;
  this.idleWord ??= new Int32Array(new SharedArrayBuffer(4));
  try { Atomics.wait(this.idleWord, 0, 0, Math.max(0, Math.min(1, deadline - performance.now()))); }
  catch (error) { if (!(error instanceof TypeError)) throw error; }
 }
 create(output, attribute, entry, argument) {
  const memory = this.memory, attributes = memory.threadAttributes.snapshot(attribute);
  if (!attributes) return 22;
  if (!memory.isExecutable(entry)) throw new Error('Invalid guest thread entry point');
  if (attributes.inheritsched === 2 && attributes.schedpolicy !== 1) throw new Error('Explicit realtime guest thread scheduling is not implemented');
  const size = attributes.stacksize, guard = attributes.guardsize, reservation = size + guard;
  if (!Number.isSafeInteger(reservation) || size < 8192 || size % 4096 || guard < 0 || guard % 4096) return 22;
  const mapped = Array.from(this.records).filter(thread => thread !== this.main && !thread.stackReleased);
  if (this.records.size >= 33 || size > (8 << 20) || reservation > (32 << 20) || mapped.reduce((total, thread) => total + thread.reservation, reservation) > (32 << 20)) return 35;
  let base = 0x41000000;
  for (const thread of mapped.sort((left, right) => left.reservedBase - right.reservedBase)) {
   if (base + reservation <= thread.reservedBase) break;
   base = Math.max(base, thread.reservedBase + thread.reservation);
  }
  if (base + reservation > 0x50000000) return 35;
  memory.read(output, 8);
  this.current.handle = memory.threadStorage.identity();
  this.context(this.current);
  const parent = this.current, stackBase = base + guard, stackTop = stackBase + size;
  let handle = 0, context = 0, mappedStack = false;
  try {
   handle = memory.allocate(16);
   memory.write(handle, new Uint8Array(16)); memory.writePointer(handle, 0x54485244);
   memory.engine.mem_map(stackBase, size, memory.uc.PROT_READ | memory.uc.PROT_WRITE); mappedStack = true;
   memory.write(stackBase, new Uint8Array(size)); memory.writePointer(stackTop - 8, this.returnAddress);
   for (const name of ['RAX', 'RBX', 'RCX', 'RDX', 'RSI', 'RDI', 'RBP', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15']) memory.setRegister(name, 0);
   memory.setRegister('RSP', stackTop - 8); memory.setRegister('RIP', entry); memory.setRegister('RDI', argument); memory.setRegister('EFLAGS', 0x202);
   context = memory.engine.context_alloc(); memory.engine.context_save(context);
   memory.writePointer(output, handle);
   this.records.add({ handle, stackBase, stackTop, reservedBase: base, reservation, state: 'runnable', context, pools: [], errnoAddress: 0, detached: attributes.detachstate === 2, result: 0n, policy: parent.policy, priority: parent.priority });
   memory.threadStorage.identities.add(handle); this.created++; return 0;
  } catch (error) {
   if (context) memory.engine.context_free(context);
   if (mappedStack) memory.engine.mem_unmap(stackBase, size);
   if (handle) memory.allocations.delete(handle);
   throw error;
  } finally { memory.engine.context_restore(parent.context); }
 }
 release(thread) {
  if (!thread.stackReleased) {
   this.memory.engine.mem_unmap(thread.stackBase, thread.stackTop - thread.stackBase); thread.stackReleased = true;
  }
  if (thread.context) { this.memory.engine.context_free(thread.context); thread.context = 0; }
  if (thread.errnoAddress) { this.memory.allocations.delete(thread.errnoAddress); thread.errnoAddress = 0; }
  if (thread.threadLocal) { this.memory.allocations.delete(thread.threadLocal); thread.threadLocal = 0; }
 }
 reap(thread) {
  this.release(thread); this.records.delete(thread);
  this.memory.threadStorage.remove(thread.handle); this.memory.allocations.delete(thread.handle);
 }
 finish(result) {
  const thread = this.current, memory = this.memory;
  if (thread === this.main) throw new Error('Exiting the main guest thread is not implemented');
  if ((memory.callDepth || 0) > 1) throw new Error('Thread exit inside a synchronous guest callback is not implemented');
  memory.threadStorage.destroyValues();
  if (thread.pools.length) memory.objc.invoke('_objc_autoreleasePoolPop', [thread.pools[0].token]);
  thread.result = result; thread.state = 'exited'; this.completed++;
  memory.objc.threadExited(thread);
  this.wake('join', thread.handle); this.release(thread);
  if (thread.detached) this.reap(thread);
 }
 invoke(name, [first, second, third]) {
  const memory = this.memory;
  if (name === '_pthread_create') return this.create(first, second, third, memory.argument64(3));
  if (name === '_pthread_exit') return { threadExit: memory.argument64(0) };
  if (name === '_sched_yield' || name === '_pthread_yield_np') return 0;
  if (name === '_sched_get_priority_min') return 15;
  if (name === '_sched_get_priority_max') return 47;
  const thread = Array.from(this.records).find(record => record.handle === first && first);
  if (!thread) return 3;
  if (name === '_pthread_getschedparam') {
   if (thread.state === 'exited') return 3;
   if (second) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, thread.policy, true); memory.write(second, bytes); }
   if (third) { const bytes = thread.parameter?.slice() ?? new Uint8Array(8); new DataView(bytes.buffer).setInt32(0, thread.priority, true); memory.write(third, bytes); }
   return 0;
  }
  if (name === '_pthread_setschedparam') {
   if (thread.state === 'exited') return 3;
   if (![1, 2, 4].includes(second)) return 22;
   const bytes = memory.read(third, 8), priority = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
   if (priority < 15 || priority > 47) return 22;
   if (second !== 1 || priority !== 31) return 45;
   thread.parameter = bytes.slice(); thread.policy = second; thread.priority = priority; return 0;
  }
  if (thread.detached || thread.joiner && thread.joiner !== this.current) return 22;
  if (name === '_pthread_detach') { thread.detached = true; if (thread.state === 'exited') this.reap(thread); return 0; }
  if (name === '_pthread_join') {
   if (thread === this.current) return 11;
   if (thread.state !== 'exited') { thread.joiner = this.current; return this.park('join', first); }
   if (second) { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, thread.result), true); memory.write(second, bytes); }
   this.reap(thread); return 0;
  }
  throw new Error(`Unsupported guest thread operation ${name}`);
 }
 close() { for (const thread of this.records) if (thread.context) { this.memory.engine.context_free(thread.context); thread.context = 0; } }
 report() {
  return { created: this.created, completed: this.completed, switches: this.switches, active: Array.from(this.records).filter(thread => thread !== this.main && thread.state !== 'exited').length, blocked: Array.from(this.records).filter(thread => thread.state === 'blocked').length, stackBytes: Array.from(this.records).filter(thread => thread !== this.main && !thread.stackReleased).reduce((total, thread) => total + thread.stackTop - thread.stackBase, 0) };
 }
}
