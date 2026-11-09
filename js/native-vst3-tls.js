export const tlsImports = new Set(['_pthread_key_create', '_pthread_key_delete', '_pthread_getspecific', '_pthread_setspecific', '_pthread_self', '_pthread_equal']);

export class GuestThreadStorage {
 constructor(memory) { this.memory = memory; this.keys = new Map(); this.current = 0; this.identities = new Set(); }
 identity() {
  if (!this.current) {
   this.current = this.memory.allocate(16); this.memory.write(this.current, new Uint8Array(16)); this.identities.add(this.current);
   if (this.memory.threads) this.memory.threads.current.handle = this.current;
  }
  return this.current;
 }
 remove(handle) { for (const record of this.keys.values()) record.values.delete(handle); this.identities.delete(handle); }
 destroyValues() {
  for (let iteration = 0; iteration < 4; iteration++) {
   let invoked = false;
   for (const [key, record] of Array.from(this.keys)) {
    if (this.keys.get(key) !== record) continue;
    const value = record.values.get(this.current);
    record.values.delete(this.current);
    if (value && record.destructor) { invoked = true; this.memory.callback(record.destructor, [value]); }
   }
   if (!invoked) break;
  }
  for (const record of this.keys.values()) record.values.delete(this.current);
 }
 invoke(name, first, second) {
  if (name === '_pthread_self') {
   return this.identity();
  }
  if (name === '_pthread_equal') {
   if (!this.identities.has(first) || !this.identities.has(second)) throw new Error('Unknown guest thread identity');
   return Number(first === second);
  }
  if (name === '_pthread_key_create') {
   if (second && !this.memory.isExecutable(second)) throw new Error('Invalid thread-local destructor');
   let key = 0; while (this.keys.has(key) && key < 512) key++;
   if (key === 512) return 35;
   this.memory.writePointer(first, key); this.keys.set(key, { destructor: second, values: new Map() }); return 0;
  }
  const record = this.keys.get(first);
  if (name === '_pthread_key_delete') { if (!record) return 22; this.keys.delete(first); return 0; }
  if (name === '_pthread_getspecific') return record?.values.get(this.current) || 0n;
  if (name === '_pthread_setspecific') { if (!record) return 22; record.values.set(this.identity(), this.memory.argument64(1)); return 0; }
  throw new Error('Unsupported thread-local operation');
 }
}
