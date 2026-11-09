import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
let clock = 10;
const fixture = nativeFixture(); fixture.set([0x48, 0x89, 0xf8, 0xc3], 0x500);
const guest = new NativeVst3Guest(uc, fixture, { monotonicClock: () => clock });
try {
 const input = guest.allocate(16), remainder = guest.allocate(16), bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
 const interval = (seconds, nanoseconds) => { view.setBigInt64(0, seconds, true); view.setBigInt64(8, nanoseconds, true); guest.write(input, bytes); };
 const address = guest.resolve('_nanosleep', 0, 'bind');
 const call = source => guest.call(address, [source, remainder]);
 interval(0n, 0n); guest.write(remainder, new Uint8Array(16).fill(0xa5));
 assert.equal(call(input), 0);
 for (const [seconds, nanoseconds] of [[-1n, 0n], [0n, -1n], [0n, 1000000000n]]) {
  interval(seconds, nanoseconds); assert.equal(call(input), Number(0xffffffffffffffffn));
  assert.equal(new DataView(guest.read(guest.errorPointer(), 4).buffer).getInt32(0, true), 22);
 }
 for (const source of [0, 1]) {
  assert.equal(call(source), Number(0xffffffffffffffffn));
  assert.equal(new DataView(guest.read(guest.errorPointer(), 4).buffer).getInt32(0, true), 14);
 }
 const thread = guest.threads.current;
 thread.state = 'runnable'; interval(0n, 1000001n);
 assert.deepEqual(guest.time.invoke('_nanosleep', [input, remainder]), { threadBlocked: true });
 assert.equal(thread.sleepDeadline, 11000001n);
 interval(0n, 0n);
 clock = 11; assert.equal(guest.time.expire(), true); assert.equal(thread.state, 'blocked');
 clock = 11.000001; assert.equal(guest.time.expire(), false); assert.equal(thread.state, 'runnable');
 assert.equal(guest.time.invoke('_nanosleep', [input, remainder]), 0); assert.equal(thread.sleepDeadline, undefined);
 assert.ok(guest.read(remainder, 16).every(byte => byte === 0xa5));
 interval(0x7fffffffffffffffn, 999999999n);
 guest.time.sleep(input); assert.ok(thread.sleepDeadline > BigInt(Number.MAX_SAFE_INTEGER));
 assert.equal(guest.threads.schedule(), false);
 delete thread.sleepDeadline; thread.blocked = null; thread.state = 'idle';
 guest.monotonicClock = () => performance.now();
 interval(0n, 5000000n);
 const started = performance.now(); assert.equal(call(input), 0); assert.ok(performance.now() - started >= 5);
 assert.ok(guest.read(remainder, 16).every(byte => byte === 0xa5));
 const output = guest.allocate(16), create = guest.resolve('_pthread_create', 0, 'bind');
 assert.equal(guest.call(create, [output, 0, guest.slide + 0x500, 123]), 0);
 const child = guest.pointer(output);
 assert.equal(call(input), 0);
 assert.equal(guest.call(guest.resolve('_pthread_join', 0, 'bind'), [child, output + 8]), 0);
 assert.equal(guest.threads.report().completed, 1);
 assert.equal(guest.pointer(output + 8), 123);
 guest.monotonicClock = () => 1000000;
 assert.throws(() => guest.call(address, [input, remainder], { milliseconds: 10 }), error => error.details.kind === 'execution-limit' && error.details.reason === 'wall-clock');
 console.log('native nanosleep: real deadlines, copied timespec, nanosecond boundary, huge intervals, errno, unchanged remainder and scheduler wake passed');
} finally { guest.close(); }
