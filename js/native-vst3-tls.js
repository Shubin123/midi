export const tlsImports = new Set(['_pthread_key_create', '_pthread_key_delete', '_pthread_getspecific', '_pthread_setspecific']);

export class GuestThreadStorage {
 constructor(memory) { this.memory = memory; this.keys = new Map(); }
 invoke(name, first, second) {
  if (name === '_pthread_key_create') {
   if (second && !this.memory.isExecutable(second)) throw new Error('Invalid thread-local destructor');
   let key = 0; while (this.keys.has(key) && key < 512) key++;
   if (key === 512) return 35;
   this.memory.writePointer(first, key); this.keys.set(key, { destructor: second, value: 0n }); return 0;
  }
  const record = this.keys.get(first);
  if (name === '_pthread_key_delete') { if (!record) return 22; this.keys.delete(first); return 0; }
  if (name === '_pthread_getspecific') return record?.value || 0n;
  if (name === '_pthread_setspecific') { if (!record) return 22; record.value = this.memory.argument64(1); return 0; }
  throw new Error('Unsupported thread-local operation');
 }
}
