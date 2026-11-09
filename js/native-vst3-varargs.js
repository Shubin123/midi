import { checkGuestRounding } from './native-vst3-float.js';

export function guestVariadicArguments(memory, first, vaList = 0) {
 let integer = first, floating = 0, stack = memory.register('RSP') + 8, count = 0;
 const read = address => { const bytes = memory.read(address, 8); return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true); };
 return (kind = 'integer') => {
  if (++count > 64) throw new Error('Guest variadic argument limit exceeded');
  const isFloating = kind === 'float'; if (isFloating) checkGuestRounding(memory);
  if (!vaList) {
   if (!isFloating && integer < 6) return memory.argument64(integer++);
   if (isFloating && floating < 8) {
    const bytes = memory.engine.reg_read(memory.uc[`X86_REG_XMM${floating++}`], 16);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
   }
   const address = stack; stack += 8; return read(address);
  }
  const header = memory.read(vaList, 24), view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const field = isFloating ? 4 : 0, offset = view.getUint32(field, true), end = isFloating ? 176 : 48, start = isFloating ? 48 : 0, step = isFloating ? 16 : 8;
  let address;
  if (offset >= start && offset < end && (offset - start) % step === 0) {
   address = memory.pointer(vaList + 16) + offset; view.setUint32(field, offset + step, true); memory.write(vaList, header);
  } else if (offset === end) { address = memory.pointer(vaList + 8); memory.writePointer(vaList + 8, address + 8); }
  else throw new Error(`Invalid ${kind} va_list register offset`);
  return read(address);
 };
}
