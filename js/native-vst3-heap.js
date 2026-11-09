// A freed address keeps its entry: heavily reused keys would otherwise pile deleted entries into V8's hash chains.
const FREED = -1;

export class GuestHeap extends Map {
 constructor(memory, start, size) { super(); this.memory = memory; this.start = start; this.end = start + size; this.highWater = start; this.label = size >= 1 << 20 ? `${size / (1 << 20)} MiB` : `${size} byte`; this.blocks = new Map(); this.freeBlocks = []; this.live = 0; }
 get size() { return this.live; }
 has(address) { const value = super.get(address); return value !== undefined && value !== FREED; }
 get(address) { const value = super.get(address); return value === FREED ? undefined : value; }
 insertFree(address, size) {
  if (!size) return;
  let index = this.freeBlocks.findIndex(block => block.address > address); if (index < 0) index = this.freeBlocks.length;
  this.freeBlocks.splice(index, 0, { address, size });
  if (index > 0 && this.freeBlocks[index - 1].address + this.freeBlocks[index - 1].size === address) {
   this.freeBlocks[index - 1].size += size; this.freeBlocks.splice(index, 1); index--;
  }
  const block = this.freeBlocks[index], next = this.freeBlocks[index + 1];
  if (next && block.address + block.size === next.address) { block.size += next.size; this.freeBlocks.splice(index + 1, 1); }
  const tail = this.freeBlocks.at(-1);
  if (tail && tail.address + tail.size === this.memory.heapTop) { this.memory.heapTop = tail.address; this.freeBlocks.pop(); }
 }
 allocate(size, alignment = 16) {
  if (!Number.isSafeInteger(size) || size < 0 || size > this.end - this.start) throw new Error(`Guest allocation exceeds ${this.label} heap`);
  if (!Number.isSafeInteger(alignment) || alignment < 16 || alignment > 1 << 20 || (alignment & alignment - 1)) throw new Error('Invalid guest allocation alignment');
  const capacity = Math.ceil(Math.max(1, size) / 16) * 16;
  let address;
  for (let index = 0; index < this.freeBlocks.length; index++) {
   const block = this.freeBlocks[index], aligned = Math.ceil(block.address / alignment) * alignment;
   if (aligned + capacity > block.address + block.size) continue;
   this.freeBlocks.splice(index, 1);
   this.insertFree(block.address, aligned - block.address); this.insertFree(aligned + capacity, block.address + block.size - aligned - capacity);
   address = aligned; break;
  }
  if (address === undefined) {
   address = Math.ceil(this.memory.heapTop / alignment) * alignment;
   if (address + capacity > this.end) throw new Error(`Guest exhausted the ${this.label} heap`);
   this.insertFree(this.memory.heapTop, address - this.memory.heapTop); this.memory.heapTop = address + capacity;
  }
  this.highWater = Math.max(this.highWater, this.memory.heapTop); this.blocks.set(address, capacity); super.set(address, size); this.live++; return address;
 }
 set(address, size) {
  if (!this.blocks.get(address) || !Number.isSafeInteger(size) || size < 0 || size > this.blocks.get(address)) throw new Error('Invalid guest allocation resize');
  return super.set(address, size);
 }
 delete(address) {
  if (!this.has(address)) return false;
  const capacity = this.blocks.get(address); super.set(address, FREED); this.blocks.set(address, 0); this.live--;
  this.memory.zones?.forget(address); this.insertFree(address, capacity); return true;
 }
 capacity(address) { return this.blocks.get(address) || 0; }
 report() {
  let allocatedBytes = 0, requestedBytes = 0, largestFreeBytes = this.end - this.memory.heapTop;
  for (const capacity of this.blocks.values()) allocatedBytes += capacity;
  for (const size of super.values()) if (size !== FREED) requestedBytes += size;
  for (const block of this.freeBlocks) largestFreeBytes = Math.max(largestFreeBytes, block.size);
  return { limitBytes: this.end - this.start, highWaterBytes: this.highWater - this.start, liveAllocations: this.live, allocatedBytes, requestedBytes, freeBytes: this.end - this.start - allocatedBytes, largestFreeBytes };
 }
}
