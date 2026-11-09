import assert from 'node:assert/strict';
import { GuestConditions, cppTimedWait } from '../js/native-vst3-conditions.js';
import { GuestMutexes } from '../js/native-vst3-mutex.js';

const bytes = new Uint8Array(512), view = new DataView(bytes.buffer);
const first = { state: 'runnable' }, second = { state: 'runnable' }, poster = { state: 'runnable' };
const threads = {
 current: first,
 checkBlocking() { if (this.callback) throw new Error('Callback blocking unsupported'); },
 park(kind, resource) { this.checkBlocking(); this.current.state = 'blocked'; this.current.blocked = { kind, resource }; return { threadBlocked: true }; },
 wake(kind, resource) { for (const thread of [first, second, poster]) if (thread.state === 'blocked' && thread.blocked.kind === kind && thread.blocked.resource === resource) { thread.state = 'runnable'; thread.blocked = null; } },
};
const memory = {
 threads,
 pointer: address => Number(view.getBigUint64(address, true)),
 writePointer: (address, value) => view.setBigUint64(address, BigInt(value), true),
 read: (address, length) => bytes.slice(address, address + length),
 write: (address, source) => bytes.set(source, address),
};
memory.mutexes = new GuestMutexes(memory);
const conditions = new GuestConditions(memory), mutex = 64, condition = 144;
const invoke = (name, argument = 0) => conditions.invoke(`_pthread_cond_${name}`, condition, argument);
memory.writePointer(mutex, 0x32aaaba7); memory.writePointer(condition, 0x3cb0b1bb);
assert.equal(invoke('signal'), 0); assert.equal(invoke('wait', mutex), 1);
assert.equal(memory.mutexes.invoke('_pthread_mutex_lock', mutex, 0), 0);
threads.callback = true;
assert.throws(() => invoke('wait', mutex), /Callback/); assert.equal(memory.mutexes.mutex(mutex).depth, 1);
assert.equal(conditions.condition(condition).waiters.length, 0); threads.callback = false;
assert.deepEqual(invoke('wait', mutex), { threadBlocked: true }); assert.equal(memory.mutexes.mutex(mutex).depth, 0);
threads.current = second;
memory.writePointer(320, 0x32aaaba7); memory.mutexes.invoke('_pthread_mutex_lock', 320, 0);
assert.equal(invoke('wait', 320), 22); memory.mutexes.invoke('_pthread_mutex_unlock', 320, 0);
memory.mutexes.invoke('_pthread_mutex_lock', mutex, 0);
assert.deepEqual(invoke('wait', mutex), { threadBlocked: true });
assert.equal(invoke('destroy'), 16);
threads.current = poster; memory.mutexes.invoke('_pthread_mutex_lock', mutex, 0);
assert.equal(invoke('signal'), 0); assert.equal(first.state, 'runnable'); assert.equal(second.state, 'blocked');
threads.current = first; assert.deepEqual(invoke('wait', mutex), { threadBlocked: true }); assert.equal(first.blocked.kind, 'mutex');
threads.current = poster; memory.mutexes.invoke('_pthread_mutex_unlock', mutex, 0);
threads.current = first; assert.equal(invoke('wait', mutex), 0); assert.equal(memory.mutexes.mutex(mutex).owner, first);
memory.mutexes.invoke('_pthread_mutex_unlock', mutex, 0);
threads.current = poster; assert.equal(invoke('broadcast'), 0); assert.equal(second.state, 'runnable');
threads.current = second; assert.equal(invoke('wait', mutex), 0); assert.equal(second.conditionWait, null);
memory.mutexes.invoke('_pthread_mutex_unlock', mutex, 0);
assert.equal(invoke('destroy'), 0); assert.equal(invoke('signal'), 22);
assert.equal(invoke('init'), 0); assert.equal(invoke('init'), 16);
memory.mutexes.initialize(320, 2); memory.mutexes.invoke('_pthread_mutex_lock', 320, 0); memory.mutexes.invoke('_pthread_mutex_lock', 320, 0);
assert.equal(invoke('wait', 320), 22); assert.equal(memory.mutexes.mutex(320).depth, 2);
assert.throws(() => invoke('init', 256), /attributes/);
assert.equal(conditions.invokeCpp('__ZNSt3__118condition_variable10notify_allEv', condition, 0), 0);
memory.writePointer(400, mutex); bytes[408] = 0;
assert.throws(() => conditions.invokeCpp('__ZNSt3__118condition_variable4waitERNS_11unique_lockINS_5mutexEEE', condition, 400), /owned unique_lock/);
assert.equal(conditions.invokeCpp('__ZNSt3__118condition_variableD1Ev', condition, 0), 0);
let milliseconds = 2, deadline = 4000000n;
memory.wallClock = () => milliseconds; memory.argument64 = () => deadline;
threads.current = first; first.state = 'runnable';
assert.equal(invoke('init'), 0); memory.mutexes.invoke('_pthread_mutex_lock', mutex, 0); bytes[408] = 1;
assert.deepEqual(conditions.invokeCpp(cppTimedWait, condition, 400), { threadBlocked: true });
assert.equal(memory.mutexes.mutex(mutex).depth, 0); assert.equal(conditions.expire(), true); assert.equal(first.state, 'blocked');
threads.current = second; memory.mutexes.invoke('_pthread_mutex_lock', mutex, 0);
milliseconds = 4; assert.equal(conditions.expire(), false); assert.equal(first.state, 'runnable'); assert.equal(first.conditionWait.expired, true);
threads.current = first; assert.deepEqual(conditions.invokeCpp(cppTimedWait, condition, 400), { threadBlocked: true }); assert.equal(first.blocked.kind, 'mutex');
threads.current = second; memory.mutexes.invoke('_pthread_mutex_unlock', mutex, 0);
threads.current = first; assert.equal(conditions.invokeCpp(cppTimedWait, condition, 400), 0); assert.equal(memory.mutexes.mutex(mutex).owner, first); assert.equal(first.conditionWait, null);
deadline = 10000000n; assert.deepEqual(conditions.invokeCpp(cppTimedWait, condition, 400), { threadBlocked: true });
threads.current = poster; invoke('signal'); milliseconds = 20; assert.equal(conditions.expire(), false);
threads.current = first; assert.equal(conditions.invokeCpp(cppTimedWait, condition, 400), 0); assert.equal(memory.mutexes.mutex(mutex).owner, first);
deadline = -1n; assert.throws(() => conditions.invokeCpp(cppTimedWait, condition, 400), /failed \(22\)/); assert.equal(memory.mutexes.mutex(mutex).owner, first);
deadline = 0x7fffffffffffffffn; assert.deepEqual(conditions.invokeCpp(cppTimedWait, condition, 400), { threadBlocked: true }); assert.equal(first.conditionWait.deadline, 0x59682f000000e941n);
milliseconds = NaN; assert.throws(() => conditions.expire(), /Invalid guest wall clock/);
milliseconds = 20; threads.current = poster; invoke('signal'); threads.current = first; conditions.invokeCpp(cppTimedWait, condition, 400); memory.mutexes.invoke('_pthread_mutex_unlock', mutex, 0);
assert.equal(invoke('destroy'), 0);
console.log('native conditions: FIFO signal/broadcast, real deadline expiration, timeout mutex reacquisition, signaled deadlines, libc++ timeout handling, busy destruction and callback limits passed');
