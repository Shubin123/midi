import { readSfnt, sfntName } from './native-vst3-font.js';

export const coreStringConstants = new Map([['_kCTFontFamilyNameKey', 'CTFontFamilyName'], ['_kCTFontStyleNameKey', 'CTFontSubFamilyName'], ['_kCTFontPostScriptNameKey', 'CTFontPostScriptName'], ['_kCTFontAttributeName', 'NSFont'], ['_kCTLigatureAttributeName', 'NSLigature'], ['_kCTKernAttributeName', 'NSKern']]);
export const coreCallbackConstants = new Set(['_kCFTypeDictionaryKeyCallBacks', '_kCFTypeDictionaryValueCallBacks', '_kCFTypeArrayCallBacks']);
coreStringConstants.set('_kCFRunLoopDefaultMode', 'kCFRunLoopDefaultMode');
coreStringConstants.set('_kCGColorSpaceSRGB', 'kCGColorSpaceSRGB');
coreStringConstants.set('_kCFRunLoopCommonModes', 'kCFRunLoopCommonModes');

export const coreImports = new Set(['_CFDataCreate', '_CFDataCreateWithBytesNoCopy', '_CFDataGetLength', '_CFDataGetBytePtr', '_CFDataCreateCopy', '_CFRetain', '_CFGetRetainCount', '_CGDataProviderCreateWithCFData', '_CGDataProviderRetain', '_CGDataProviderRelease', '_CGFontCreateWithDataProvider', '_CGFontRetain', '_CGFontRelease', '_CTFontManagerRegisterGraphicsFont', '_CTFontManagerUnregisterGraphicsFont', '_CFErrorGetCode', '_CTFontCreateWithGraphicsFont', '_CTFontGetAscent', '_CTFontGetDescent', '_CTFontGetLeading', '_CTFontGetSize', '_CTFontGetUnitsPerEm', '_CTFontGetGlyphCount', '_CTFontCopyName', '_CTFontCopyFamilyName', '_CTFontCopyPostScriptName', '_CGFontCopyPostScriptName', '_CGFontCopyFullName', '_CFStringGetLength', '_CFStringGetCString', '_CFStringGetCStringPtr', '_CFStringGetCharacters', '_CFStringGetMaximumSizeForEncoding', '_CFStringCreateWithCString']);
coreImports.add('_CFStringGetBytes');
for (const name of ['_CFNumberCreate', '_CFNumberGetValue', '_CFNumberGetType', '_CFNumberGetByteSize', '_CFNumberIsFloatType']) coreImports.add(name);
for (const name of ['_CFDictionaryCreate', '_CFDictionaryGetValue', '_CFDictionaryGetCount', '_CFEqual', '_CFHash']) coreImports.add(name);
const numberTypes = new Map([[1, [1, false]], [2, [2, false]], [3, [4, false]], [4, [8, false]], [5, [4, true]], [6, [8, true]], [7, [1, false]], [8, [2, false]], [9, [4, false]], [10, [8, false]], [11, [8, false]], [12, [4, true]], [13, [8, true]], [14, [8, false]], [15, [8, false]], [16, [8, true]]]);

export class GuestCoreFoundation {
 constructor(memory) { this.memory = memory; this.objects = new Map(); this.nullAllocator = 0; this.fonts = new Map(); this.constants = new Map(); this.callbacks = new Map(); }
 callbacksGlobal(name) {
  if (this.callbacks.has(name)) return this.callbacks.get(name);
  const operations = ['retain', 'release', 'description', 'equal', ...(name === '_kCFTypeDictionaryKeyCallBacks' ? ['hash'] : [])], address = this.memory.allocate((operations.length + 1) * 8);
  this.memory.write(address, new Uint8Array((operations.length + 1) * 8));
  operations.forEach((operation, index) => this.memory.writePointer(address + (index + 1) * 8, this.memory.resolve(`__midi_cf_${operation}`, 0, 'bind')));
  this.callbacks.set(name, address); return address;
 }
 equal(first, second) {
  if (first === second) return true;
  const left = this.object(first), right = this.object(second);
  if (left.kind !== right.kind) return false;
  if (left.kind === 'string') return left.text === right.text;
  if (left.kind === 'number') {
   if (typeof left.value === typeof right.value) return left.value === right.value || typeof left.value === 'number' && Number.isNaN(left.value) && Number.isNaN(right.value);
   const integer = typeof left.value === 'bigint' ? left.value : right.value, floating = typeof left.value === 'number' ? left.value : right.value;
   return Number.isFinite(floating) && Number.isInteger(floating) && BigInt(floating) === integer;
  }
  if (left.kind === 'data') {
   if (left.length !== right.length) return false;
   const bytes = this.memory.read(left.pointer, left.length), other = this.memory.read(right.pointer, right.length); return bytes.every((byte, index) => byte === other[index]);
  }
  if (['dictionary', 'array'].includes(left.kind)) throw new Error('Composite CoreFoundation equality is not implemented');
  return false;
 }
 string(value, immortal = false) {
  const bytes = new TextEncoder().encode(`${value}\0`), pointer = this.memory.allocate(bytes.length); this.memory.write(pointer, bytes);
  return this.create('string', { text: value, pointer, owned: true, immortal });
 }
 text(handle) {
  const record = this.objects.get(handle) || this.memory.objc.objects.get(handle);
  if (typeof record?.text !== 'string') throw new Error('Unsupported CoreFoundation string');
  return record.text;
 }
 constantGlobal(name) {
  if (!this.constants.has(name)) this.constants.set(name, this.string(coreStringConstants.get(name), true));
  const address = this.memory.allocate(8); this.memory.writePointer(address, this.constants.get(name)); return address;
 }
 nullAllocatorGlobal() {
  if (!this.nullAllocator) { this.nullAllocator = this.memory.allocate(16); this.memory.write(this.nullAllocator, new Uint8Array(16)); }
  const address = this.memory.allocate(8); this.memory.writePointer(address, this.nullAllocator); return address;
 }
 create(kind, properties) {
  if (this.objects.size >= 4096) throw new Error('CoreFoundation object limit exceeded');
  const handle = this.memory.allocate(16); this.memory.write(handle, new Uint8Array(16));
  this.objects.set(handle, { kind, references: 1, ...properties }); return handle;
 }
 object(handle, kind) {
  const cocoa = this.memory.objc?.objects.get(handle), record = this.objects.get(handle) || (cocoa?.kind === 'data' ? cocoa : null);
  if (!record || kind && record.kind !== kind) throw new Error(`Invalid CoreFoundation ${kind || 'object'}`);
  return record;
 }
 release(handle) {
  if (!this.objects.has(handle) && this.memory.objc?.objects.get(handle)?.kind === 'data') return this.memory.objc.releaseObject(handle);
  const record = this.object(handle);
  if (record.immortal) return 0;
  if (--record.references === 0) {
   record.finalize?.();
   if (record.owned) this.memory.allocations.delete(record.pointer);
   if (record.retained) this.release(record.retained);
   if (record.retainedMany) for (const child of record.retainedMany) this.release(child);
   this.objects.delete(handle); this.memory.allocations.delete(handle);
  }
  return 0;
 }
 invoke(name, [first, second, third, fourth]) {
  switch (name) {
   case '__midi_cf_retain': return this.invoke('_CFRetain', [second]);
   case '__midi_cf_release': return this.release(second);
   case '__midi_cf_equal': case '_CFEqual': return this.equal(first, second) ? 1 : 0;
   case '__midi_cf_hash': case '_CFHash': {
    const record = this.object(first);
    if (record.kind !== 'string') throw new Error('Hashing this CoreFoundation object type is not implemented');
    let hash = 14695981039346656037n; for (const byte of new TextEncoder().encode(record.text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n); return hash;
   }
   case '__midi_cf_description': {
    const record = this.object(first); if (record.kind !== 'string') throw new Error('Description of this CoreFoundation object type is not implemented');
    return this.string(record.text);
   }
   case '_CFDictionaryCreate': {
    const count = fourth, keyCallbacks = Number(this.memory.argument64(4)), valueCallbacks = Number(this.memory.argument64(5));
    if (first !== 0 || !Number.isSafeInteger(count) || count < 0 || count > 4096) throw new Error('Invalid dictionary allocator or count');
    if (keyCallbacks && keyCallbacks !== this.callbacks.get('_kCFTypeDictionaryKeyCallBacks') || valueCallbacks && valueCallbacks !== this.callbacks.get('_kCFTypeDictionaryValueCallBacks')) throw new Error('Custom dictionary callbacks are not implemented');
    const entries = [], retainedMany = [];
    for (let index = 0; index < count; index++) {
     const key = this.memory.pointer(second + index * 8), value = this.memory.pointer(third + index * 8);
     if (entries.some(entry => keyCallbacks ? this.equal(entry.key, key) : entry.key === key)) throw new Error('Duplicate dictionary keys are unsupported');
     if (keyCallbacks) { this.invoke('_CFRetain', [key]); retainedMany.push(key); }
     if (valueCallbacks) { this.invoke('_CFRetain', [value]); retainedMany.push(value); }
     entries.push({ key, value });
    }
    return this.create('dictionary', { entries, keyCallbacks: !!keyCallbacks, retainedMany });
   }
   case '_CFDictionaryGetCount': return this.object(first, 'dictionary').entries.length;
   case '_CFDictionaryGetValue': {
    const record = this.object(first, 'dictionary'); return record.entries.find(entry => record.keyCallbacks ? this.equal(entry.key, second) : entry.key === second)?.value || 0;
   }
   case '_CFNumberCreate': {
    if (first !== 0 || !numberTypes.has(second)) throw new Error('Unsupported CFNumber allocator or type');
    const [size, floating] = numberTypes.get(second), bytes = this.memory.read(third, size), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const value = floating ? size === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true) : size === 8 ? view.getBigInt64(0, true) : BigInt(size === 1 ? view.getInt8(0) : size === 2 ? view.getInt16(0, true) : view.getInt32(0, true));
    return this.create('number', { value, numberType: second, size, floating });
   }
   case '_CFNumberGetType': return this.object(first, 'number').numberType;
   case '_CFNumberGetByteSize': return this.object(first, 'number').size;
   case '_CFNumberIsFloatType': return this.object(first, 'number').floating ? 1 : 0;
   case '_CFNumberGetValue': {
    const record = this.object(first, 'number'); if (!numberTypes.has(second)) throw new Error('Unsupported CFNumber output type');
    const [size, floating] = numberTypes.get(second), bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    let exact;
    if (floating) {
     const value = size === 4 ? Math.fround(Number(record.value)) : Number(record.value);
     exact = typeof record.value === 'bigint' ? Number.isFinite(value) && BigInt(value) === record.value : Object.is(value, record.value);
     if (size === 4) view.setFloat32(0, value, true); else view.setFloat64(0, value, true);
    } else {
     if (typeof record.value === 'number' && !Number.isFinite(record.value)) throw new Error('Non-finite CFNumber integer conversion is unsupported');
     const value = typeof record.value === 'bigint' ? record.value : BigInt(Math.trunc(record.value)), bits = BigInt(size * 8);
     if (value < -(1n << bits - 1n) || value >= 1n << bits - 1n) throw new Error('CFNumber integer conversion exceeds output range');
     exact = typeof record.value === 'bigint' || Number(value) === record.value;
     if (size === 8) view.setBigInt64(0, value, true); else if (size === 4) view.setInt32(0, Number(value), true); else if (size === 2) view.setInt16(0, Number(value), true); else view.setInt8(0, Number(value));
    }
    this.memory.write(third, bytes); return exact ? 1 : 0;
   }
   case '_CTFontCopyName': case '_CTFontCopyFamilyName': case '_CTFontCopyPostScriptName': case '_CGFontCopyPostScriptName': case '_CGFontCopyFullName': {
    const record = this.object(first, name.startsWith('_CT') ? 'ctfont' : 'font');
    const keys = new Map([['CTFontFamilyName', 1], ['CTFontSubFamilyName', 2], ['CTFontPostScriptName', 6]]);
    const identifier = name === '_CTFontCopyName' ? keys.get(this.text(second)) : name === '_CTFontCopyFamilyName' ? 1 : name === '_CGFontCopyFullName' ? 4 : 6;
    if (identifier === undefined) throw new Error('Unsupported CoreText name key');
    const value = sfntName(record.font, identifier); return value === null ? 0 : this.string(value);
   }
   case '_CFStringGetLength': return this.text(first).length;
   case '_CFStringGetBytes': {
    const text = this.text(first), encoding = fourth, loss = Number(this.memory.argument64(4)), external = this.memory.argument64(5);
    const buffer = Number(this.memory.argument64(6)), maximum = Number(this.memory.argument64(7)), used = Number(this.memory.argument64(8));
    if (!Number.isSafeInteger(second) || !Number.isSafeInteger(third) || second < 0 || third < 0 || second + third > text.length || third > 1 << 20) throw new Error('Invalid string conversion range');
    if (![0x08000100, 0x600].includes(encoding) || external || loss < 0 || loss > 255) throw new Error('Unsupported string conversion encoding or options');
    if (![buffer, maximum, used].every(value => Number.isSafeInteger(value) && value >= 0) || maximum > 32 << 20) throw new Error('Invalid string conversion buffer');
    const capacity = buffer ? maximum : third * 3, output = new Uint8Array(Math.min(capacity, third * 3));
    let converted = 0, written = 0;
    while (converted < third) {
     let point = text.codePointAt(second + converted), units = point > 0xffff ? 2 : 1, replacement = false;
     if (converted + units > third || point >= 0xd800 && point <= 0xdfff || encoding === 0x600 && point > 127) {
      if (!loss) break; point = loss; replacement = true; units = converted + units > third ? 1 : units;
     }
     const bytes = replacement || point < 128 ? [point] : point < 2048 ? [0xc0 | point >> 6, 0x80 | point & 63] : point < 65536 ? [0xe0 | point >> 12, 0x80 | point >> 6 & 63, 0x80 | point & 63] : [0xf0 | point >> 18, 0x80 | point >> 12 & 63, 0x80 | point >> 6 & 63, 0x80 | point & 63];
     if (written + bytes.length > capacity) break;
     output.set(bytes, written); written += bytes.length; converted += units;
    }
    if (buffer && written) this.memory.write(buffer, output.subarray(0, written));
    if (used) this.memory.writePointer(used, written); return converted;
   }
   case '_CFStringGetMaximumSizeForEncoding':
    if (!Number.isSafeInteger(first) || first < 0 || first > 1 << 20 || ![0x08000100, 0x600].includes(second)) throw new Error('Unsupported string sizing request');
    return first * (second === 0x08000100 ? 3 : 1);
   case '_CFStringCreateWithCString': {
    if (first !== 0 || ![0x08000100, 0x600].includes(third)) throw new Error('Unsupported string allocator or encoding');
    const bytes = this.memory.stringBytes(second, 1 << 20);
    if (third === 0x600 && bytes.some(byte => byte > 127)) throw new Error('Invalid ASCII string');
    return this.string(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
   }
   case '_CFStringGetCStringPtr': {
    this.text(first); if (second !== 0x08000100) return 0;
    return this.objects.get(first)?.pointer || this.memory.objc.objects.get(first)?.utf8 || 0;
   }
   case '_CFStringGetCString': {
    const text = this.text(first);
    if (![0x08000100, 0x600].includes(fourth)) throw new Error('Unsupported string output encoding');
    if (!Number.isSafeInteger(third) || third < 0 || third > 1 << 20) throw new Error('Invalid string output capacity');
    if (fourth === 0x600 && [...text].some(character => character.codePointAt(0) > 127)) return 0;
    const bytes = new TextEncoder().encode(`${text}\0`); if (bytes.length > third) return 0;
    this.memory.write(second, bytes); return 1;
   }
   case '_CFStringGetCharacters': {
    const text = this.text(first);
    if (!Number.isSafeInteger(second) || !Number.isSafeInteger(third) || second < 0 || third < 0 || second + third > text.length || third > 1 << 20) throw new Error('Invalid string character range');
    const bytes = new Uint8Array(third * 2), view = new DataView(bytes.buffer);
    for (let index = 0; index < third; index++) view.setUint16(index * 2, text.charCodeAt(second + index), true);
    this.memory.write(fourth, bytes); return 0;
   }
   case '_CTFontCreateWithGraphicsFont': {
    const record = this.object(first, 'font'), size = this.memory.floatingRegister();
    if (!Number.isFinite(size) || size < 0 || size > 1e6) throw new Error('Invalid CoreText font size');
    if (second || third) throw new Error('Custom CoreText matrices and descriptors are not implemented');
    const result = this.create('ctfont', { font: record.font, size: size || 12, retained: first }); this.invoke('_CFRetain', [first]); return result;
   }
   case '_CTFontGetUnitsPerEm': return this.object(first, 'ctfont').font.units;
   case '_CTFontGetGlyphCount': return this.object(first, 'ctfont').font.glyphs;
   case '_CTFontGetSize': return { rax: 0, xmm0: this.object(first, 'ctfont').size };
   case '_CTFontGetAscent': case '_CTFontGetDescent': case '_CTFontGetLeading': {
    const record = this.object(first, 'ctfont'), value = name === '_CTFontGetAscent' ? record.font.ascent : name === '_CTFontGetDescent' ? -record.font.descent : record.font.leading;
    return { rax: 0, xmm0: value * record.size / record.font.units };
   }
   case '_CTFontManagerRegisterGraphicsFont': case '_CTFontManagerUnregisterGraphicsFont': {
    const record = this.object(first, 'font'), postscript = sfntName(record.font);
    const fail = code => { if (second) { this.memory.read(second, 8); this.memory.writePointer(second, this.create('error', { code, domain: 'com.apple.CoreText.CTFontManagerErrorDomain' })); } return 0; };
    if (!postscript) return fail(104);
    if (name === '_CTFontManagerRegisterGraphicsFont') {
     if (this.fonts.has(postscript)) return fail(105);
     if (this.fonts.size >= 256) throw new Error('Guest font registration limit exceeded');
     this.invoke('_CFRetain', [first]); this.fonts.set(postscript, first); return 1;
    }
    if (this.fonts.get(postscript) !== first) return fail(201);
    this.fonts.delete(postscript); this.release(first); return 1;
   }
   case '_CFErrorGetCode': return this.object(first, 'error').code;
   case '_CGDataProviderCreateWithCFData': {
    this.object(first, 'data'); const result = this.create('provider', { retained: first }); this.invoke('_CFRetain', [first]); return result;
   }
   case '_CGDataProviderRetain': case '_CGFontRetain':
    if (!first) return 0;
    this.object(first, name === '_CGFontRetain' ? 'font' : 'provider'); return this.invoke('_CFRetain', [first]);
   case '_CGDataProviderRelease': case '_CGFontRelease':
    if (!first) return 0;
    this.object(first, name === '_CGFontRelease' ? 'font' : 'provider'); return this.release(first);
   case '_CGFontCreateWithDataProvider': {
    const provider = this.object(first, 'provider'), data = this.object(provider.retained, 'data');
    const bytes = this.memory.read(data.pointer, data.length);
    let font;
    try { font = readSfnt(bytes); } catch { return 0; }
    const result = this.create('font', { font, retained: first }); this.invoke('_CFRetain', [first]); return result;
   }
   case '_CFDataCreate': case '_CFDataCreateWithBytesNoCopy': {
    if (first !== 0) throw new Error('Custom CoreFoundation allocators are not supported');
    if (!Number.isSafeInteger(third) || third < 0 || third > 16 << 20) throw new Error('CoreFoundation data size exceeds limit');
    const bytes = third ? this.memory.read(second, third) : new Uint8Array();
    if (name === '_CFDataCreateWithBytesNoCopy') {
     if (fourth !== 0 && fourth !== this.nullAllocator) throw new Error('Custom byte deallocators are not supported');
     if (fourth === 0 && !this.memory.allocations.has(second)) throw new Error('Default byte deallocator requires a guest allocation');
     return this.create('data', { pointer: second, length: third, owned: fourth === 0 });
    }
    const pointer = this.memory.allocate(third); this.memory.write(pointer, bytes); return this.create('data', { pointer, length: third, owned: true });
   }
   case '_CFDataCreateCopy': {
    const record = this.object(second, 'data'); return this.invoke('_CFDataCreate', [first, record.pointer, record.length]);
   }
   case '_CFDataGetLength': return this.object(first, 'data').length;
   case '_CFDataGetBytePtr': return this.object(first, 'data').pointer;
   case '_CFRetain': {
    const record = this.object(first); if (record.immortal) return first;
    if (record.references >= 65536) throw new Error('CoreFoundation reference limit exceeded'); record.references++; return first;
   }
   case '_CFGetRetainCount': return this.object(first).references;
  }
 }
}
