const SIGNATURE = 0x54484441;
const fields = new Map([
 ['detachstate', { offset: 8, initial: 1, valid: value => [1, 2].includes(value) }],
 ['inheritsched', { offset: 12, initial: 1, valid: value => [1, 2].includes(value) }],
 ['schedpolicy', { offset: 16, initial: 1, valid: value => [1, 2, 4].includes(value) }],
 ['stacksize', { offset: 24, initial: 512 * 1024, wide: true, valid: value => value >= 8192 && value % 4096 === 0 }],
 ['guardsize', { offset: 32, initial: 4096, wide: true, valid: value => value >= 0 && value % 4096 === 0 }],
]);

export class GuestThreadAttributes {
 constructor(memory) { this.memory = memory; }
 snapshot(address) {
  if (address && this.memory.pointer(address) !== SIGNATURE) return null;
  return Object.fromEntries(Array.from(fields, ([key, field]) => {
   if (!address) return [key, field.initial];
   const bytes = this.memory.read(address + field.offset, field.wide ? 8 : 4), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
   return [key, field.wide ? Number(view.getBigUint64(0, true)) : view.getInt32(0, true)];
  }));
 }
 invoke(name, address, argument) {
  if (name === '_pthread_attr_init') {
   const bytes = new Uint8Array(64), view = new DataView(bytes.buffer);
   view.setBigUint64(0, BigInt(SIGNATURE), true);
   for (const field of fields.values()) {
    if (field.wide) view.setBigUint64(field.offset, BigInt(field.initial), true);
    else view.setInt32(field.offset, field.initial, true);
   }
   this.memory.write(address, bytes); return 0;
  }
  const operation = /^_pthread_attr_(get|set)(detachstate|inheritsched|schedpolicy|stacksize|guardsize|scope)$/.exec(name);
  if (!operation && name !== '_pthread_attr_destroy') return undefined;
  if (this.memory.pointer(address) !== SIGNATURE) return 22;
  if (name === '_pthread_attr_destroy') { this.memory.writePointer(address, 0); return 0; }
  const [, action, key] = operation;
  if (key === 'scope') {
   if (action === 'set') return argument === 1 ? 0 : argument === 2 ? 45 : 22;
   const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, 1, true);
   this.memory.write(argument, bytes); return 0;
  }
  const field = fields.get(key), length = field.wide ? 8 : 4;
  if (action === 'get') { this.memory.write(argument, this.memory.read(address + field.offset, length)); return 0; }
  if (!Number.isSafeInteger(argument) || !field.valid(argument)) return 22;
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  if (field.wide) view.setBigUint64(0, BigInt(argument), true);
  else view.setInt32(0, argument, true);
  this.memory.write(address + field.offset, bytes); return 0;
 }
}
