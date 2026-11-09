export const encodingImports = new Set(['_CreateTextEncoding', '_GetTextEncodingBase', '_GetTextEncodingVariant', '_GetTextEncodingFormat', '_CreateUnicodeToTextInfo', '_ConvertFromUnicodeToText', '_DisposeUnicodeToTextInfo']);
const utf16 = text => {
 const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer);
 for (let index = 0; index < text.length; index++) view.setUint16(index * 2, text.charCodeAt(index), true);
 return bytes;
};

export class GuestTextEncodings {
 constructor(memory) { this.memory = memory; this.converters = new Map(); }
 create(mapping, output) {
  const bytes = this.memory.read(mapping, 12), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const input = view.getUint32(0, true), encoding = view.getUint32(4, true), version = view.getInt32(8, true);
  this.memory.writePointer(output, 0);
  if (input !== 0x100 || ![0x20100, 0x30100].includes(encoding) || version !== -1) return -8738;
  if (this.converters.size >= 256) throw new Error('Unicode converter limit exceeded');
  const handle = this.memory.allocate(8); this.memory.writePointer(handle, 0);
  this.converters.set(handle, { normalization: encoding === 0x30100 ? 'NFC' : 'NFD' }); this.memory.writePointer(output, handle); return 0;
 }
 convert([handle, length, input, flags, offsetCount]) {
  const converter = this.converters.get(handle);
  if (!converter) throw new Error('Invalid Unicode converter');
  if (!Number.isSafeInteger(length) || length < 0 || length > 1 << 20 || length % 2) return -50;
  if (flags & ~1 || offsetCount) throw new Error('Stateful Unicode conversion flags and offset mapping are not implemented');
  const [countOutput, offsetsOutput, capacity, inputRead, outputLength, output] = Array.from({ length: 6 }, (_, index) => Number(this.memory.argument64(index + 6)));
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 1 << 20) return -50;
  if (offsetsOutput) throw new Error('Unicode output offset mapping is not implemented');
  const bytes = length ? this.memory.read(input, length) : new Uint8Array();
  let text;
  try { text = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return -8753; }
  const normalized = utf16(text.normalize(converter.normalization));
  let converted = normalized, consumed = length;
  if (normalized.length > capacity) {
   consumed = 0; const chunks = []; let size = 0;
   for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)) {
    const chunk = utf16(segment.normalize(converter.normalization)); if (size + chunk.length > capacity) break;
    chunks.push(chunk); size += chunk.length; consumed += segment.length * 2;
   }
   converted = new Uint8Array(size); let offset = 0;
   for (const chunk of chunks) { converted.set(chunk, offset); offset += chunk.length; }
  }
  if (converted.length) this.memory.read(output, converted.length);
  this.memory.read(inputRead, 8); this.memory.read(outputLength, 8); if (countOutput) this.memory.read(countOutput, 8);
  if (converted.length) this.memory.write(output, converted);
  this.memory.writePointer(inputRead, consumed); this.memory.writePointer(outputLength, converted.length); if (countOutput) this.memory.writePointer(countOutput, 0);
  return consumed < length ? -8785 : 0;
 }
 invoke(name, [base, variant, format]) {
  switch (name) {
   case '_CreateTextEncoding': return ((base & 0xffff) | (variant & 0x3ff) << 16 | (format & 15) << 26) >>> 0;
   case '_GetTextEncodingBase': return base & 0xffff;
   case '_GetTextEncodingVariant': return base >>> 16 & 0x3ff;
   case '_GetTextEncodingFormat': return base >>> 26 & 15;
   case '_CreateUnicodeToTextInfo': return this.create(base, variant);
   case '_ConvertFromUnicodeToText': return this.convert(Array.from({ length: 6 }, (_, index) => Number(this.memory.argument64(index))));
   case '_DisposeUnicodeToTextInfo': {
    const handle = this.memory.pointer(base);
    if (!this.converters.delete(handle)) throw new Error('Invalid Unicode converter disposal');
    this.memory.allocations.delete(handle); this.memory.writePointer(base, 0); return 0;
   }
   default: throw new Error('Unsupported guest text encoding operation');
  }
 }
}
