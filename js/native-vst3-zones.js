export const zoneImports = new Set([
 '_malloc_create_zone', '_malloc_destroy_zone', '_malloc_default_zone', '_malloc_zone_from_ptr',
 '_malloc_zone_malloc', '_malloc_zone_calloc', '_malloc_zone_valloc', '_malloc_zone_realloc',
 '_malloc_zone_memalign', '_malloc_zone_free', '_malloc_set_zone_name', '_malloc_get_zone_name',
 '_malloc_size', '_malloc_good_size',
]);

const callbacks = new Map([[16, 'size'], [24, 'malloc'], [32, 'calloc'], [40, 'valloc'], [48, 'free'], [56, 'realloc'], [64, 'destroy'], [112, 'memalign'], [120, 'free_definite_size']]);

export class GuestZones {
 constructor(memory) { this.memory = memory; this.zones = new Map(); this.owners = new Map(); this.defaultZone = 0; }
 errno(value) {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, value, true); this.memory.write(this.memory.errorPointer(), bytes); return 0;
 }
 create(startSize, flags) {
  if (!Number.isSafeInteger(startSize) || startSize < 0) throw new Error('Invalid malloc zone size hint');
  if (flags) throw new Error('Unsupported malloc zone debug flags');
  if (this.zones.size >= 64) return this.errno(12);
  const address = this.memory.allocate(128);
  try {
   this.memory.write(address, new Uint8Array(128));
   for (const [offset, operation] of callbacks) this.memory.writePointer(address + offset, this.memory.resolve(`__midi_zone_${operation}`, 0, 'bind'));
   const version = new Uint8Array(4); new DataView(version.buffer).setUint32(0, 6, true); this.memory.write(address + 104, version);
   this.zones.set(address, { address, name: 0, members: new Set() }); return address;
  } catch (error) { this.memory.allocations.delete(address); throw error; }
 }
 default() {
  if (!this.defaultZone) this.defaultZone = this.create(0, 0);
  return this.defaultZone;
 }
 record(address) {
  const zone = this.zones.get(address); if (!zone) throw new Error('Unknown malloc zone'); return zone;
 }
 forget(pointer) {
  const owner = this.owners.get(pointer);
  if (owner !== undefined) { this.zones.get(owner)?.members.delete(pointer); this.owners.delete(pointer); }
 }
 adopt(pointer, zone) {
  const record = this.record(zone); this.forget(pointer); this.owners.set(pointer, zone); record.members.add(pointer); return pointer;
 }
 owner(pointer) { return this.memory.allocations.has(pointer) ? this.owners.get(pointer) ?? this.default() : 0; }
 owns(zone, pointer) {
  this.record(zone); return this.memory.allocations.has(pointer) && (this.owners.get(pointer) ?? this.defaultZone) === zone;
 }
 allocate(zone, size, alignment = 16, clear = false) {
  this.record(zone);
  if (!Number.isSafeInteger(size) || size < 0 || size > this.memory.allocations.end - this.memory.allocations.start) return this.errno(12);
  let pointer;
  try { pointer = this.memory.allocate(size, alignment); }
  catch (error) { if (/exhausted.*heap|allocation exceeds/.test(error.message)) return this.errno(12); throw error; }
  if (clear) this.memory.write(pointer, new Uint8Array(this.memory.allocations.capacity(pointer)));
  return this.adopt(pointer, zone);
 }
 free(zone, pointer, definiteSize) {
  this.record(zone); if (!pointer) return 0;
  if (!this.owns(zone, pointer)) throw new Error('Pointer does not belong to malloc zone');
  if (definiteSize !== undefined && definiteSize !== this.memory.allocations.capacity(pointer)) throw new Error('Incorrect malloc zone definite size');
  this.memory.allocations.delete(pointer); return 0;
 }
 realloc(zone, pointer, size) {
  this.record(zone); if (!pointer) return this.allocate(zone, size);
  if (!this.owns(zone, pointer)) throw new Error('Pointer does not belong to malloc zone');
  if (!Number.isSafeInteger(size) || size < 0 || size > this.memory.allocations.end - this.memory.allocations.start) return this.errno(12);
  if (size && size <= this.memory.allocations.capacity(pointer)) { this.memory.allocations.set(pointer, size); return pointer; }
  const replacement = this.allocate(zone, size); if (!replacement) return 0;
  if (size) this.memory.write(replacement, this.memory.read(pointer, Math.min(size, this.memory.allocations.capacity(pointer))));
  this.memory.allocations.delete(pointer); return replacement;
 }
 destroy(zone) {
  const record = this.record(zone); if (zone === this.defaultZone) throw new Error('Cannot destroy the default malloc zone');
  for (const pointer of record.members) this.memory.allocations.delete(pointer);
  if (record.name) this.memory.allocations.delete(record.name);
  this.zones.delete(zone); this.memory.allocations.delete(zone); return 0;
 }
 invoke(name, [first, second, third]) {
  if (name.startsWith('__midi_zone_')) name = `_malloc_zone_${name.slice('__midi_zone_'.length)}`;
  switch (name) {
   case '_malloc_create_zone': return this.create(first, second);
   case '_malloc_default_zone': return this.default();
   case '_malloc_destroy_zone': case '_malloc_zone_destroy': return this.destroy(first);
   case '_malloc_zone_from_ptr': return this.owner(first);
   case '_malloc_size': return this.memory.allocations.capacity(first);
   case '_malloc_good_size': {
    const requested = this.memory.argument64(0), rounded = requested ? (requested + 15n) & ~15n : 16n;
    return rounded <= 0xffffffffffffffffn ? rounded : 0;
   }
   case '_malloc_zone_size': return this.owns(first, second) ? this.memory.allocations.capacity(second) : 0;
   case '_malloc_zone_malloc': return this.allocate(first, second);
   case '_malloc_zone_calloc': return this.allocate(first, second * third, 16, true);
   case '_malloc_zone_valloc': return this.allocate(first, second, 4096, true);
   case '_malloc_zone_memalign': {
    this.record(first);
    if (!Number.isSafeInteger(second) || second < 8 || !Number.isInteger(Math.log2(second))) return this.errno(22);
    if (second > 1 << 20) throw new Error('Malloc zone alignment exceeds guest limit');
    return this.allocate(first, third, Math.max(16, second));
   }
   case '_malloc_zone_free': return this.free(first, second);
   case '_malloc_zone_free_definite_size': return this.free(first, second, third);
   case '_malloc_zone_realloc': return this.realloc(first, second, third);
   case '_malloc_get_zone_name': return this.record(first).name;
   case '_malloc_set_zone_name': {
    const record = this.record(first), bytes = second ? this.memory.stringBytes(second, 4096) : null;
    const name = bytes ? this.memory.allocate(bytes.length + 1) : 0;
    if (name) { const storage = new Uint8Array(bytes.length + 1); storage.set(bytes); this.memory.write(name, storage); }
    const previous = record.name; record.name = name; this.memory.writePointer(first + 72, name);
    if (previous) this.memory.allocations.delete(previous); return 0;
   }
   default: throw new Error(`Unsupported malloc zone operation ${name}`);
  }
 }
}
