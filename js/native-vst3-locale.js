import { writeGuestString } from './native-vst3-libcpp.js';

export const localeImports = new Set([
 '__ZNSt3__16localeC1Ev', '__ZNSt3__16localeC2Ev', '__ZNSt3__16localeC1ERKS0_', '__ZNSt3__16localeC2ERKS0_',
 '__ZNSt3__16localeD1Ev', '__ZNSt3__16localeD2Ev', '__ZNSt3__16localeaSERKS0_', '__ZNSt3__16locale7classicEv',
 '__ZNKSt3__16localeeqERKS0_',
 '__ZNKSt3__16locale9use_facetERNS0_2idE', '__ZNKSt3__16locale4nameEv',
]);

export class GuestLocales {
 constructor(memory) { this.memory = memory; this.instances = new Set(); this.implementation = 0; this.classic = 0; this.references = 0; this.facets = new Map(); this.runes = 0; }
 runeLocale() {
  if (this.runes) return this.runes;
  const address = this.memory.allocate(3208), bytes = new Uint8Array(3208), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RuneMagANONE')); view.setInt32(56, 65533, true);
  for (let code = 0; code < 256; code++) {
   view.setUint32(60 + code * 4, this.characterMask(code), true);
   view.setInt32(1084 + code * 4, code >= 65 && code <= 90 ? code + 32 : code, true);
   view.setInt32(2108 + code * 4, code >= 97 && code <= 122 ? code - 32 : code, true);
  }
  this.memory.write(address, bytes); this.runes = address; return address;
 }
 characterMask(code) {
  if (code < 0 || code >= 128) return 0;
  const character = String.fromCharCode(code), alpha = /[A-Za-z]/.test(character), digit = /[0-9]/.test(character), printable = code >= 32 && code < 127;
  let mask = (alpha ? 0x100 : 0) | (code < 32 || code === 127 ? 0x200 : 0) | (digit ? 0x400 : 0) | (code > 32 && code < 127 ? 0x800 : 0);
  mask |= (/[a-z]/.test(character) ? 0x1000 : 0) | (printable && code !== 32 && !alpha && !digit ? 0x2000 : 0) | (/\s/.test(character) ? 0x4000 : 0);
  mask |= (/[A-Z]/.test(character) ? 0x8000 : 0) | (/[0-9A-Fa-f]/.test(character) ? 0x10000 | parseInt(character, 16) : 0) | (code === 9 || code === 32 ? 0x20000 : 0) | (printable ? 0x40000 : 0);
  return mask;
 }
 range(low, high) {
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || high < low || high - low > 1 << 20) throw new Error('Invalid locale byte range');
  return this.memory.read(low, high - low);
 }
 facet(kind) {
  if (this.facets.has(kind)) return this.facets.get(kind);
  const operations = kind === 'ctype' ? ['destroy', 'destroy', 'upper', 'upperRange', 'lower', 'lowerRange', 'widen', 'widenRange', 'narrow', 'narrowRange'] : ['destroy', 'destroy', 'compare', 'transform', 'hash'];
  const object = this.memory.allocate(32), table = this.memory.allocate(operations.length * 8);
  this.memory.write(object, new Uint8Array(32)); this.memory.writePointer(object, table); this.memory.writePointer(object + 8, 1);
  operations.forEach((operation, index) => this.memory.writePointer(table + index * 8, this.memory.resolve(`__midi_locale_${kind}_${operation}`, 0, 'bind')));
  if (kind === 'ctype') {
   this.memory.writePointer(object + 16, this.runeLocale() + 60);
  }
  this.facets.set(kind, object); return object;
 }
 virtual(name, args) {
  const [prefix, kind, operation] = name.match(/^__midi_locale_(ctype|collate)_(\w+)$/) || [];
  if (!prefix || !this.facets.has(kind)) throw new Error('Unknown locale facet call');
  const [first, second, third, fourth, fifth] = args, receiver = operation === 'transform' ? second : first;
  if (receiver !== this.facets.get(kind)) throw new Error('Unknown locale facet receiver');
  const convert = (byte, upper) => upper && byte >= 97 && byte <= 122 ? byte - 32 : !upper && byte >= 65 && byte <= 90 ? byte + 32 : byte;
  switch (operation) {
   case 'upper': case 'lower': return convert(second & 255, operation === 'upper');
   case 'upperRange': case 'lowerRange': {
    const bytes = this.range(second, third); for (let index = 0; index < bytes.length; index++) bytes[index] = convert(bytes[index], operation === 'upperRange');
    this.memory.write(second, bytes); return third;
   }
   case 'widen': return second & 255;
   case 'narrow': return (second & 255) < 128 ? second & 255 : third & 255;
   case 'widenRange': this.memory.write(fourth, this.range(second, third)); return third;
   case 'narrowRange': {
    const bytes = this.range(second, third); for (let index = 0; index < bytes.length; index++) if (bytes[index] >= 128) bytes[index] = fourth & 255;
    this.memory.write(fifth, bytes); return third;
   }
   case 'compare': {
    const left = this.range(second, third), right = this.range(fourth, fifth);
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
     const difference = (left[index] << 24 >> 24) - (right[index] << 24 >> 24); if (difference) return difference < 0 ? -1 : 1;
    }
    return Math.sign(left.length - right.length);
   }
   case 'transform': return writeGuestString(this.memory, first, this.range(third, fourth));
   case 'hash': {
    let hash = 0n;
    for (const byte of this.range(second, third)) { hash = BigInt.asUintN(64, (hash << 4n) + BigInt(byte << 24 >> 24)); const high = hash & 0xf000000000000000n; hash ^= high | high >> 56n; }
    return hash;
   }
   default: throw new Error('Cannot destroy a permanent classic locale facet');
  }
 }
 create(destination) {
  this.memory.read(destination, 8);
  if (this.instances.has(destination)) throw new Error('Locale constructed over a live locale');
  if (this.instances.size >= 4096) throw new Error('Guest locale instance limit exceeded');
  if (!this.implementation) {
   this.implementation = this.memory.allocate(16); this.memory.write(this.implementation, new Uint8Array(16));
  }
  this.memory.writePointer(destination, this.implementation); this.instances.add(destination); this.references++;
  this.memory.writePointer(this.implementation + 8, this.references); return destination;
 }
 check(address) {
  if (!this.instances.has(address) || this.memory.pointer(address) !== this.implementation) throw new Error('Unknown or modified guest locale');
 }
 invoke(name, [destination, source]) {
  switch (name) {
   case '__ZNSt3__16localeC1Ev': case '__ZNSt3__16localeC2Ev': return this.create(destination);
   case '__ZNSt3__16localeC1ERKS0_': case '__ZNSt3__16localeC2ERKS0_': this.check(source); return this.create(destination);
   case '__ZNSt3__16localeD1Ev': case '__ZNSt3__16localeD2Ev':
    this.check(destination);
    if (destination === this.classic) throw new Error('Cannot destroy the permanent classic locale');
    this.instances.delete(destination); this.references--; this.memory.writePointer(this.implementation + 8, this.references); return 0;
   case '__ZNSt3__16locale7classicEv':
    if (!this.classic) { this.classic = this.memory.allocate(8); this.create(this.classic); }
    return this.classic;
   case '__ZNSt3__16localeaSERKS0_': this.check(destination); this.check(source); return destination;
   case '__ZNKSt3__16localeeqERKS0_': this.check(destination); this.check(source); return 1;
   case '__ZNKSt3__16locale4nameEv': this.check(source); return writeGuestString(this.memory, destination, new Uint8Array([67]));
   case '__ZNKSt3__16locale9use_facetERNS0_2idE': {
    this.check(destination);
    const imported = this.memory.imports.get(source)?.name;
    if (imported === '__ZNSt3__15ctypeIcE2idE') return this.facet('ctype');
    if (imported === '__ZNSt3__17collateIcE2idE') return this.facet('collate');
    throw new Error(`Unsupported classic locale facet: ${imported || source}`);
   }
  }
 }
}
