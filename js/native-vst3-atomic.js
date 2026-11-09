export const atomicImports = new Map();
for (const barrier of ['', 'Barrier']) {
 for (const [suffix, bits] of [['32', 32], ['64', 64], ['Int', 32], ['Long', 64], ['Ptr', 64]]) atomicImports.set(`_OSAtomicCompareAndSwap${suffix}${barrier}`, { operation: 'compare', bits });
 for (const bits of [32, 64]) for (const operation of ['Add', 'Increment', 'Decrement']) atomicImports.set(`_OSAtomic${operation}${bits}${barrier}`, { operation: operation.toLowerCase(), bits });
 for (const operation of ['And', 'Or', 'Xor']) for (const original of ['', 'Orig']) atomicImports.set(`_OSAtomic${operation}32${original}${barrier}`, { operation: operation.toLowerCase(), bits: 32, original: Boolean(original) });
}
atomicImports.set('_OSMemoryBarrier', { operation: 'barrier' });

export function invokeGuestAtomic(memory, name) {
 const { operation, bits, original } = atomicImports.get(name);
 if (operation === 'barrier') return 0;
 const unary = operation === 'increment' || operation === 'decrement';
 const index = operation === 'compare' ? 2 : unary ? 0 : 1;
 const pointer = Number(memory.argument64(index));
 if (!Number.isSafeInteger(pointer) || !pointer || pointer % (bits / 8)) throw new Error('Invalid or unaligned guest atomic pointer');
 const bytes = memory.read(pointer, bits / 8), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
 const previous = bits === 64 ? view.getBigUint64(0, true) : BigInt(view.getUint32(0, true));
 const argument = BigInt.asUintN(bits, memory.argument64(0));
 if (operation === 'compare' && previous !== argument) return 0;
 let result;
 switch (operation) {
  case 'compare': result = memory.argument64(1); break;
  case 'add': result = previous + argument; break;
  case 'increment': result = previous + 1n; break;
  case 'decrement': result = previous - 1n; break;
  case 'and': result = previous & argument; break;
  case 'or': result = previous | argument; break;
  case 'xor': result = previous ^ argument; break;
  default: throw new Error('Unsupported guest atomic operation');
 }
 result = BigInt.asUintN(bits, result);
 if (bits === 64) view.setBigUint64(0, result, true); else view.setUint32(0, Number(result), true);
 memory.write(pointer, bytes);
 return operation === 'compare' ? 1 : BigInt.asIntN(bits, original ? previous : result);
}
