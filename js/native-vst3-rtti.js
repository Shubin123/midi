const vtableKinds = new Map([
 ['__ZTVN10__cxxabiv117__class_type_infoE', 'class'],
 ['__ZTVN10__cxxabiv120__si_class_type_infoE', 'single'],
 ['__ZTVN10__cxxabiv121__vmi_class_type_infoE', 'multiple'],
]);

export class GuestRTTI {
 constructor(memory) { this.memory = memory; this.vtables = new Map(); }
 bind(name, address) { if (vtableKinds.has(name)) this.vtables.set(address + 16, vtableKinds.get(name)); }
 offset(address) {
  const bytes = this.memory.read(address, 8), value = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(0, true));
  if (!Number.isSafeInteger(value)) throw new Error('RTTI offset exceeds guest precision'); return value;
 }
 add(address, offset) {
  const result = address + offset;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Invalid RTTI subobject address'); return result;
 }
 cast(pointer, sourceType, destinationType) {
  if (!pointer) return 0;
  const types = new Map(), nodes = new Map(), active = new Set(); let edges = 0;
  const type = address => {
   if (types.has(address)) return types.get(address);
   if (types.size >= 512) throw new Error('RTTI type graph exceeds guest limit');
   const kind = this.vtables.get(this.memory.pointer(address));
   if (!kind) throw new Error('Unsupported RTTI type-info vtable');
   const name = this.memory.string(this.memory.pointer(address + 8), 4096), record = { name, bases: [] };
   if (!name) throw new Error('Empty RTTI type name');
   types.set(address, record);
   if (kind === 'single') record.bases.push({ type: this.memory.pointer(address + 16), offset: 0, public: true, virtual: false });
   if (kind === 'multiple') {
    const bytes = this.memory.read(address + 16, 8), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint32(4, true);
    if (view.getUint32(0, true) & ~3 || count > 128) throw new Error('Unsupported or oversized RTTI multiple-inheritance metadata');
    for (let index = 0; index < count; index++) {
     const base = address + 24 + index * 16, flags = this.offset(base + 8);
     if ((flags & 255) & ~3) throw new Error('Unsupported RTTI base flags');
     record.bases.push({ type: this.memory.pointer(base), offset: Math.floor(flags / 256), public: Boolean(flags & 2), virtual: Boolean(flags & 1) });
    }
   }
   return record;
  };
  const visit = (address, typeAddress, depth = 0) => {
   if (depth > 64) throw new Error('RTTI inheritance depth exceeds guest limit');
   const record = type(typeAddress), key = `${record.name}:${address}`;
   if (active.has(key)) throw new Error('Cyclic RTTI inheritance metadata');
   if (nodes.has(key)) return nodes.get(key);
   if (nodes.size >= 1024) throw new Error('RTTI subobject graph exceeds guest limit');
   const node = { address, name: record.name, bases: [] }; nodes.set(key, node); active.add(key);
   for (const base of record.bases) {
    if (++edges > 4096) throw new Error('RTTI base graph exceeds guest limit');
    const offset = base.virtual ? this.offset(this.add(this.memory.pointer(address), base.offset)) : base.offset;
    node.bases.push({ node: visit(this.add(address, offset), base.type, depth + 1), public: base.public });
   }
   active.delete(key); return node;
  };
  const vtable = this.memory.pointer(pointer), rootAddress = this.add(pointer, this.offset(vtable - 16));
  const root = visit(rootAddress, this.memory.pointer(vtable - 8));
  const sourceName = type(sourceType).name, destinationName = type(destinationType).name;
  const source = nodes.get(`${sourceName}:${pointer}`); if (!source) return 0;
  const reachable = (derived, base) => {
   const pending = [derived], seen = new Set();
   while (pending.length) {
    const node = pending.pop(); if (node === base) return true;
    if (seen.has(node)) continue; seen.add(node);
    for (const edge of node.bases) if (edge.public) pending.push(edge.node);
   }
   return false;
  };
  const destinations = [...nodes.values()].filter(node => node.name === destinationName);
  const derived = destinations.filter(node => reachable(node, source));
  if (derived.length === 1) return derived[0].address;
  if (destinations.length === 1 && reachable(root, source) && reachable(root, destinations[0])) return destinations[0].address;
  return 0;
 }
}
