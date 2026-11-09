const maximum = 16n << 20n;
const size = value => { if (value > maximum) throw new Error('Guest NSData exceeds 16 MiB'); return Number(value); };
function installData(objc, handle, bytes, mutable) {
 const memory = objc.memory; let pointer = 0;
 try { if (bytes.length) { pointer = memory.allocate(bytes.length); memory.write(pointer, bytes); } }
 catch (error) { if (pointer) memory.allocations.delete(pointer); throw error; }
 const target = objc.objects.get(handle); if (target.kind === 'data' && target.owned && target.pointer) memory.allocations.delete(target.pointer);
 Object.assign(target, { kind: 'data', pointer, length: bytes.length, owned: true, mutableData: mutable }); return handle;
}
export function createData(objc, className, bytes) {
 const handle = objc.instance(objc.foundationClass(className), 0);
 try { return installData(objc, handle, bytes, className === 'NSMutableData'); } catch (error) { objc.releaseObject(handle); throw error; }
}

export function invokeGuestData(objc, receiver, name, record, object) {
 const memory = objc.memory, mutable = record.foundation === 'NSMutableData', factory = !object && ['data', 'dataWithBytes:length:', 'dataWithData:', ...(mutable ? ['dataWithLength:', 'dataWithCapacity:'] : [])].includes(name), initializer = object && objc.objects.has(receiver) && ['init', 'initWithBytes:length:', 'initWithData:', ...(mutable ? ['initWithLength:', 'initWithCapacity:'] : [])].includes(name);
 if (factory || initializer) {
  if (factory && !objc.pools.length) throw new Error('Autorelease requires a guest pool');
  let pointer = 0, length = 0;
  if (name.includes('WithBytes:')) { pointer = memory.register('RDX'); length = size(memory.argument64(3)); }
  if (name.includes('WithData:')) { const source = memory.core.object(memory.register('RDX'), 'data'); pointer = source.pointer; length = source.length; }
  const capacity = name.includes('WithLength:') || name.includes('WithCapacity:') ? size(memory.argument64(2)) : 0;
  const bytes = name.includes('WithLength:') ? new Uint8Array(capacity) : length ? memory.read(pointer, length) : new Uint8Array();
  return factory ? objc.autorelease(createData(objc, record.foundation, bytes)) : installData(objc, receiver, bytes, mutable);
 }
 if (object?.kind !== 'data') return undefined;
 if (name === 'length') return object.length;
 if (name === 'bytes') return object.length ? object.pointer : 0;
 if (['copy', 'copyWithZone:', 'mutableCopy', 'mutableCopyWithZone:'].includes(name)) {
  const copyingMutable = name.startsWith('mutable');
  if (!copyingMutable && !object.mutableData) return objc.retainObject(receiver);
  return createData(objc, copyingMutable ? 'NSMutableData' : 'NSData', object.length ? memory.read(object.pointer, object.length) : new Uint8Array());
 }
 if (name === 'retain') return objc.retainObject(receiver);
 if (name === 'release') return objc.releaseObject(receiver);
 if (name === 'retainCount') return object.references;
 if (name === 'autorelease') return objc.autorelease(receiver);
 if (name === 'class') return record.handle;
 if (name === 'self') return receiver;
 if (name === 'isEqualToData:') return memory.register('RDX') ? Number(memory.core.equal(receiver, memory.register('RDX'))) : 0;
 if (['getBytes:', 'getBytes:length:', 'getBytes:range:'].includes(name)) {
  let start = 0, length = object.length;
  if (name === 'getBytes:length:') length = Number(memory.argument64(3) < BigInt(length) ? memory.argument64(3) : BigInt(length));
  if (name === 'getBytes:range:') {
   const location = memory.argument64(3), size = memory.argument64(4);
   if (location + size > BigInt(length)) throw new Error('Guest NSData range exceeds its bytes'); start = Number(location); length = Number(size);
  }
  if (length) memory.write(memory.register('RDX'), memory.read(object.pointer + start, length)); return 0;
 }
 if (!object.mutableData) return undefined;
 if (name === 'mutableBytes') return object.length ? object.pointer : 0;
 const current = () => object.length ? memory.read(object.pointer, object.length) : new Uint8Array();
 const replace = (location, removed, inserted) => {
  if (location + removed > BigInt(object.length)) throw new Error('Guest NSData range exceeds its bytes');
  if (BigInt(inserted.length) === removed) { if (inserted.length) memory.write(object.pointer + Number(location), inserted); return 0; }
  const total = size(BigInt(object.length) - removed + BigInt(inserted.length)), bytes = new Uint8Array(total), previous = current(), start = Number(location), end = Number(location + removed);
  bytes.set(previous.subarray(0, start)); bytes.set(inserted, start); bytes.set(previous.subarray(end), start + inserted.length); installData(objc, receiver, bytes, true); return 0;
 };
 if (name === 'setLength:' || name === 'increaseLengthBy:') {
  const length = size(memory.argument64(2) + (name === 'increaseLengthBy:' ? BigInt(object.length) : 0n));
  if (length !== object.length) { const bytes = new Uint8Array(length); bytes.set(current().subarray(0, length)); installData(objc, receiver, bytes, true); } return 0;
 }
 if (name === 'appendBytes:length:') {
  const length = size(memory.argument64(3)); return replace(BigInt(object.length), 0n, length ? memory.read(memory.register('RDX'), length) : new Uint8Array());
 }
 if (name === 'appendData:' || name === 'setData:') {
  const source = memory.core.object(memory.register('RDX'), 'data'), bytes = source.length ? memory.read(source.pointer, source.length) : new Uint8Array();
  return name === 'appendData:' ? replace(BigInt(object.length), 0n, bytes) : replace(0n, BigInt(object.length), bytes);
 }
 if (name === 'resetBytesInRange:') {
  const location = memory.argument64(2), length = memory.argument64(3);
  if (location + length > BigInt(object.length)) throw new Error('Guest NSData range exceeds its bytes');
  if (length) memory.write(object.pointer + Number(location), new Uint8Array(Number(length))); return 0;
 }
 if (name === 'replaceBytesInRange:withBytes:' || name === 'replaceBytesInRange:withBytes:length:') {
  const location = memory.argument64(2), removed = memory.argument64(3), length = size(name.endsWith('length:') ? memory.argument64(5) : removed);
  return replace(location, removed, length ? memory.read(memory.register('R8'), length) : new Uint8Array());
 }
 return undefined;
}
