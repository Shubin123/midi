import assert from 'node:assert/strict';
import { GuestHeap } from '../js/native-vst3-heap.js';

const memory = { heapTop: 0x30000000 }, heap = new GuestHeap(memory, memory.heapTop, 8192);
const first = heap.allocate(17), second = heap.allocate(32);
const sentinel = heap.allocate(16);
assert.equal(heap.capacity(first), 32);
assert.equal(second, first + 32);
assert.equal(heap.delete(first), true);
assert.equal(heap.delete(first), false);
assert.equal(heap.allocate(16), first);
assert.equal(heap.allocate(16), first + 16);
heap.delete(first); heap.delete(first + 16); heap.delete(second);
assert.equal(heap.freeBlocks.length, 1);
assert.equal(heap.allocate(64), first);
const aligned = heap.allocate(16, 4096);
assert.equal(aligned % 4096, 0);
const empty = heap.allocate(0); assert.equal(empty, first + 80);
assert.throws(() => heap.allocate(-1), /exceeds/);
assert.throws(() => heap.allocate(8193), /exceeds/);
assert.throws(() => heap.allocate(1, 24), /alignment/);
assert.throws(() => heap.set(first, 65), /resize/);
heap.set(first, 1); assert.equal(heap.get(first), 1); assert.equal(heap.capacity(first), 64);
assert.throws(() => heap.allocate(8192), /exhausted/);
assert.equal(heap.get(first), 1);
assert.equal(heap.report().allocatedBytes, 112); assert.equal(heap.report().liveAllocations, 4);
heap.delete(aligned); assert.equal(memory.heapTop, first + 96);
heap.delete(empty); heap.delete(sentinel); heap.delete(first);
assert.equal(memory.heapTop, first); assert.equal(heap.freeBlocks.length, 0);
assert.equal(heap.report().largestFreeBytes, 8192); assert.equal(heap.report().highWaterBytes, 4112);
const tinyMemory = { heapTop: 4096 }, tiny = new GuestHeap(tinyMemory, 4096, 128);
const head = tiny.allocate(48), tail = tiny.allocate(48); tiny.delete(tail);
assert.equal(tiny.allocate(80), head + 48); assert.equal(tiny.report().freeBytes, 0);
{
 const modelMemory = { heapTop: 0x10000 }, real = new GuestHeap(modelMemory, modelMemory.heapTop, 1 << 26);
 const model = { top: 0x10000, free: [] }, live = [];
 let seed = 12345; const random = limit => (seed = seed * 1103515245 + 12345 & 0x7fffffff) % limit;
 const release = (address, size) => {
  model.free.push({ address, size }); model.free.sort((a, b) => a.address - b.address);
  for (let index = model.free.length - 1; index > 0; index--) if (model.free[index - 1].address + model.free[index - 1].size === model.free[index].address) { model.free[index - 1].size += model.free[index].size; model.free.splice(index, 1); }
  const tail = model.free.at(-1); if (tail && tail.address + tail.size === model.top) { model.top = tail.address; model.free.pop(); }
 };
 const take = (capacity, alignment) => {
  for (let index = 0; index < model.free.length; index++) {
   const block = model.free[index], aligned = Math.ceil(block.address / alignment) * alignment;
   if (aligned + capacity > block.address + block.size) continue;
   model.free.splice(index, 1); if (aligned > block.address) release(block.address, aligned - block.address); if (block.address + block.size > aligned + capacity) release(aligned + capacity, block.address + block.size - aligned - capacity); return aligned;
  }
  const address = Math.ceil(model.top / alignment) * alignment; if (address > model.top) release(model.top, address - model.top); model.top = address + capacity; return address;
 };
 for (let step = 0; step < 60000; step++) {
  if (!live.length || live.length < 500 && random(100) < 60) {
   const size = [16, 32, 48, 64, 160, 4000, 70000][random(7)] - random(8), alignment = random(50) === 0 ? 4096 : 16, capacity = Math.ceil(Math.max(1, size) / 16) * 16;
   const address = real.allocate(size, alignment); assert.equal(address, take(capacity, alignment), `allocation at step ${step}`); live.push({ address, capacity });
  } else { const [entry] = live.splice(random(live.length), 1); real.delete(entry.address); release(entry.address, entry.capacity); }
  if (step % 5000 === 0) { assert.deepEqual(real.freeBlocks, model.free); assert.equal(modelMemory.heapTop, model.top); }
 }
 assert.deepEqual(real.freeBlocks, model.free); assert.equal(modelMemory.heapTop, model.top);
}
console.log('native heap: reuse, coalescing, alignment, zero-sized allocations, bounds and first-fit equivalence passed');
