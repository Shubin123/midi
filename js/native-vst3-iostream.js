const prefix = name => `__ZNSt3__1${name}`;
const STREAMBUF = 'basic_streambufIcNS_11char_traitsIcEEE';
const OSTREAM = '13basic_ostreamIcNS_11char_traitsIcEEE';
const names = {
 streambufCtor: prefix(`15${STREAMBUF}C2Ev`), streambufDtor: prefix(`15${STREAMBUF}D2Ev`),
 imbue: prefix(`15${STREAMBUF}5imbueERKNS_6localeE`), setbuf: prefix(`15${STREAMBUF}6setbufEPcl`), sync: prefix(`15${STREAMBUF}4syncEv`),
 showmanyc: prefix(`15${STREAMBUF}9showmanycEv`), underflow: prefix(`15${STREAMBUF}9underflowEv`), uflow: prefix(`15${STREAMBUF}5uflowEv`),
 pbackfail: prefix(`15${STREAMBUF}9pbackfailEi`), overflow: prefix(`15${STREAMBUF}8overflowEi`), xsputn: prefix(`15${STREAMBUF}6xsputnEPKcl`),
 getloc: `__ZNKSt3__18ios_base6getlocEv`, iosInit: prefix('8ios_base4initEPv'), iosClear: prefix('8ios_base5clearEj'), iosDtor: prefix('9basic_iosIcNS_11char_traitsIcEEED2Ev'),
 ostreamD1: prefix(`${OSTREAM}D1Ev`), ostreamD2: prefix(`${OSTREAM}D2Ev`),
 double: prefix(`${OSTREAM}lsEd`), int: prefix(`${OSTREAM}lsEi`), uint: prefix(`${OSTREAM}lsEj`), long: prefix(`${OSTREAM}lsEl`), ulong: prefix(`${OSTREAM}lsEm`), ullong: prefix(`${OSTREAM}lsEy`),
 sentryCtor: prefix(`${OSTREAM}6sentryC1ERS3_`), sentryDtor: prefix(`${OSTREAM}6sentryD1Ev`),
 put: prefix(`${OSTREAM}3putEc`), write: prefix(`${OSTREAM}5writeEPKcl`), flush: prefix(`${OSTREAM}5flushEv`),
};
export const ostreamVtable = `__ZTVNSt3__1${OSTREAM}E`;
export const iostreamImports = new Set(Object.values(names));

const FLAGS = { dec: 0x2, fixed: 0x4, hex: 0x8, internal: 0x10, left: 0x20, oct: 0x40, right: 0x80, scientific: 0x100, showbase: 0x200, showpoint: 0x400, showpos: 0x800, unitbuf: 0x2000, uppercase: 0x4000 };
const IOS = { flags: 8, precision: 16, width: 24, state: 32, exceptions: 36, rdbuf: 40, locale: 48 };
const BUF = { locale: 8, pbase: 40, pptr: 48, epptr: 56 };
const VIRTUAL = { xsputn: 12, overflow: 13, sync: 6 };

function exactDigits(value) {
 const bytes = new DataView(new ArrayBuffer(8)); bytes.setFloat64(0, Math.abs(value));
 const bits = bytes.getBigUint64(0), biased = Number(bits >> 52n), fraction = bits & (1n << 52n) - 1n;
 const mantissa = biased ? fraction | 1n << 52n : fraction, exponent = (biased || 1) - 1075;
 if (exponent >= 0) { const digits = (mantissa << BigInt(exponent)).toString(); return { digits, point: digits.length }; }
 const digits = (mantissa * 5n ** BigInt(-exponent)).toString();
 return { digits, point: digits.length + exponent };
}

function roundDigits(digits, keep) {
 if (keep < 0) return { digits: '', carry: false };
 if (keep >= digits.length) return { digits: digits.padEnd(keep, '0'), carry: false };
 const head = digits.slice(0, keep), next = digits[keep], tail = digits.slice(keep + 1);
 const up = next > '5' || next === '5' && (/[1-9]/.test(tail) || (head.length ? (head.charCodeAt(head.length - 1) - 48) % 2 === 1 : false));
 if (!up) return { digits: head, carry: false };
 const list = [...head];
 for (let index = list.length - 1; index >= 0; index--) {
  if (list[index] !== '9') { list[index] = String.fromCharCode(list[index].charCodeAt(0) + 1); return { digits: list.join(''), carry: false }; }
  list[index] = '0';
 }
 return { digits: `1${list.join('')}`, carry: true };
}

const stripped = digits => digits.replace(/^0+(?=.)/, '');

function fixedText(value, precision, alternate) {
 const { digits, point } = exactDigits(value);
 const padded = point > 0 ? digits : `${'0'.repeat(1 - point)}${digits}`, position = point > 0 ? point : 1;
 const rounded = roundDigits(padded, position + precision);
 const whole = rounded.digits.slice(0, rounded.carry ? position + 1 : position), fraction = rounded.digits.slice(rounded.carry ? position + 1 : position);
 return `${stripped(whole) || '0'}${precision || alternate ? '.' : ''}${fraction}`;
}

function scientificParts(value, precision) {
 if (value === 0) return { digits: '0'.repeat(precision + 1), exponent: 0 };
 const { digits, point } = exactDigits(value), first = digits.search(/[1-9]/), significant = digits.slice(first);
 let exponent = point - first - 1;
 const rounded = roundDigits(significant, precision + 1);
 if (rounded.carry) exponent++;
 return { digits: rounded.digits.slice(0, precision + 1), exponent };
}

function scientificText({ digits, exponent }, alternate, uppercase) {
 const body = `${digits[0]}${digits.length > 1 || alternate ? '.' : ''}${digits.slice(1)}`;
 return `${body}${uppercase ? 'E' : 'e'}${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

export function formatDouble(value, flags, precision) {
 const uppercase = Boolean(flags & FLAGS.uppercase), showpoint = Boolean(flags & FLAGS.showpoint), field = flags & (FLAGS.fixed | FLAGS.scientific);
 const sign = value < 0 || Object.is(value, -0) ? '-' : flags & FLAGS.showpos ? '+' : '';
 if (Number.isNaN(value)) return `${sign === '-' ? '-' : flags & FLAGS.showpos ? '+' : ''}${uppercase ? 'NAN' : 'nan'}`;
 if (!Number.isFinite(value)) return `${sign}${uppercase ? 'INF' : 'inf'}`;
 if (field === (FLAGS.fixed | FLAGS.scientific)) throw new Error('Hexadecimal float stream output is not implemented');
 const places = precision < 0 ? 6 : precision;
 if (field === FLAGS.fixed) return sign + fixedText(value, places, showpoint);
 if (field === FLAGS.scientific) return sign + scientificText(scientificParts(value, places), showpoint, uppercase);
 const significant = places || 1, parts = scientificParts(value, significant - 1);
 if (parts.exponent >= -4 && parts.exponent < significant) {
  const text = fixedText(value, significant - 1 - parts.exponent, showpoint);
  return sign + (showpoint || !text.includes('.') ? text : text.replace(/\.?0+$/, ''));
 }
 const trimmed = showpoint ? parts.digits : parts.digits.replace(/0+$/, '') || '0';
 return sign + scientificText({ digits: trimmed, exponent: parts.exponent }, showpoint, uppercase);
}

export function formatInteger(value, flags) {
 const base = flags & FLAGS.hex ? 16n : flags & FLAGS.oct ? 8n : 10n, negative = base === 10n && value < 0n, magnitude = negative ? -value : value;
 let text = magnitude.toString(Number(base));
 if (flags & FLAGS.uppercase) text = text.toUpperCase();
 if (flags & FLAGS.showbase && magnitude !== 0n) text = `${base === 16n ? flags & FLAGS.uppercase ? '0X' : '0x' : base === 8n ? '0' : ''}${text}`;
 return `${negative ? '-' : base === 10n && flags & FLAGS.showpos ? '+' : ''}${text}`;
}

export class GuestIostream {
 constructor(memory) { this.memory = memory; this.vtable = 0; }
 int32(address) { const bytes = this.memory.read(address, 4); return new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true); }
 setInt32(address, value) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, value, true); this.memory.write(address, bytes); }
 int64(address) { const bytes = this.memory.read(address, 8); return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true); }
 setInt64(address, value) { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, value, true); this.memory.write(address, bytes); }
 ostreamTable() {
  if (this.vtable) return this.vtable;
  const memory = this.memory, table = memory.allocate(80), bytes = new Uint8Array(80), view = new DataView(bytes.buffer);
  const stub = name => BigInt(memory.resolve(name, 0, 'bind'));
  view.setBigInt64(0, 8n, true); view.setBigInt64(40, -8n, true); view.setBigInt64(48, -8n, true);
  view.setBigUint64(24, stub(names.ostreamD1), true); view.setBigUint64(32, stub(`__ZNSt3__1${OSTREAM}D0Ev`), true);
  view.setBigUint64(64, stub(`__ZTv0_n24_NSt3__1${OSTREAM}D1Ev`), true); view.setBigUint64(72, stub(`__ZTv0_n24_NSt3__1${OSTREAM}D0Ev`), true);
  memory.write(table, bytes); return this.vtable = table;
 }
 ios(stream) { return stream + Number(this.int64(this.memory.pointer(stream) - 24)); }
 locale(name, address, source) { return this.memory.locales.invoke(name, [address, source]); }
 virtual(object, slot) { return this.memory.pointer(this.memory.pointer(object) + slot * 8); }
 setState(ios, state) {
  const current = this.memory.pointer(ios + IOS.rdbuf) ? state : state | 1;
  this.setInt32(ios + IOS.state, current);
  if (current & this.int32(ios + IOS.exceptions)) throw new Error('Guest iostream exceptions are not implemented');
 }
 bufferWrite(buffer, bytes) {
  const memory = this.memory; let written = 0;
  while (written < bytes.length) {
   const next = memory.pointer(buffer + BUF.pptr), room = memory.pointer(buffer + BUF.epptr) - next;
   if (room > 0) {
    const count = Math.min(room, bytes.length - written);
    memory.write(next, bytes.subarray(written, written + count)); memory.writePointer(buffer + BUF.pptr, next + count); written += count;
    continue;
   }
   const overflow = this.virtual(buffer, VIRTUAL.overflow), code = bytes[written];
   if (memory.imports.get(overflow)?.name === names.overflow) break;
   if (Number(BigInt.asIntN(32, BigInt(memory.callback(overflow, [buffer, code])))) === -1) break;
   written++;
  }
  return written;
 }
 output(ios, bytes) {
  const memory = this.memory, buffer = memory.pointer(ios + IOS.rdbuf);
  if (!buffer) return false;
  const method = this.virtual(buffer, VIRTUAL.xsputn);
  if (memory.imports.get(method)?.name === names.xsputn) return this.bufferWrite(buffer, bytes) === bytes.length;
  const copy = memory.allocate(Math.max(bytes.length, 1));
  try { memory.write(copy, bytes); return BigInt.asIntN(64, BigInt(memory.callback(method, [buffer, copy, bytes.length]))) === BigInt(bytes.length); }
  finally { memory.allocations.delete(copy); }
 }
 formatted(stream, text) {
  const ios = this.ios(stream);
  if (this.int32(ios + IOS.state) !== 0) { this.setState(ios, this.int32(ios + IOS.state) | 4); return stream; }
  const flags = this.int32(ios + IOS.flags), width = Number(this.int64(ios + IOS.width));
  const missing = Math.max(0, width - text.length), fill = ' '.repeat(missing);
  let padded;
  if (flags & FLAGS.left) padded = text + fill;
  else if (flags & FLAGS.internal && /^[+-]/.test(text)) padded = text[0] + fill + text.slice(1);
  else padded = fill + text;
  this.setInt64(ios + IOS.width, 0n);
  if (!this.output(ios, Uint8Array.from(padded, character => character.charCodeAt(0)))) this.setState(ios, this.int32(ios + IOS.state) | 1);
  return stream;
 }
 invoke(name, [first, second, third]) {
  const memory = this.memory;
  switch (name) {
   case names.streambufCtor: {
    memory.write(first + 8, new Uint8Array(56));
    this.locale('__ZNSt3__16localeC1Ev', first + BUF.locale);
    return first;
   }
   case names.streambufDtor: this.locale('__ZNSt3__16localeD1Ev', first + BUF.locale); return first;
   case names.imbue: return 0;
   case names.setbuf: return first;
   case names.sync: case names.showmanyc: return 0;
   case names.underflow: case names.uflow: case names.pbackfail: case names.overflow: return -1;
   case names.xsputn: return this.bufferWrite(first, third ? memory.read(second, third) : new Uint8Array());
   case names.iosInit: {
    memory.writePointer(first + IOS.rdbuf, second);
    this.setInt32(first + IOS.state, second ? 0 : 1); this.setInt32(first + IOS.exceptions, 0);
    this.setInt32(first + IOS.flags, 0x1002); this.setInt64(first + IOS.width, 0n); this.setInt64(first + IOS.precision, 6n);
    memory.write(first + 56, new Uint8Array(80));
    this.locale('__ZNSt3__16localeC1Ev', first + IOS.locale);
    return 0;
   }
   case names.getloc: this.locale('__ZNSt3__16localeC1ERKS0_', first, second + IOS.locale); return first;
   case names.iosClear: this.setState(first, second); return 0;
   case names.iosDtor: this.locale('__ZNSt3__16localeD1Ev', first + IOS.locale); return first;
   case names.ostreamD1: this.locale('__ZNSt3__16localeD1Ev', this.ios(first) + IOS.locale); return first;
   case names.ostreamD2: return first;
   case names.double: {
    const ios = this.ios(first);
    return this.formatted(first, formatDouble(memory.floatingRegister(), this.int32(ios + IOS.flags), Number(this.int64(ios + IOS.precision))));
   }
   case names.int: return this.formatted(first, formatInteger(BigInt.asIntN(32, memory.argument64(1)), this.int32(this.ios(first) + IOS.flags)));
   case names.long: return this.formatted(first, formatInteger(BigInt.asIntN(64, memory.argument64(1)), this.int32(this.ios(first) + IOS.flags)));
   case names.uint: return this.formatted(first, formatInteger(BigInt.asUintN(32, memory.argument64(1)), this.int32(this.ios(first) + IOS.flags)));
   case names.ulong: case names.ullong: return this.formatted(first, formatInteger(BigInt.asUintN(64, memory.argument64(1)), this.int32(this.ios(first) + IOS.flags)));
   case names.sentryCtor: memory.write(first, new Uint8Array([this.int32(this.ios(second) + IOS.state) === 0 ? 1 : 0])); memory.writePointer(first + 8, second); return first;
   case names.sentryDtor: return first;
   case names.put: { if (!this.output(this.ios(first), new Uint8Array([second & 255]))) this.setState(this.ios(first), this.int32(this.ios(first) + IOS.state) | 1); return first; }
   case names.write: { if (!this.output(this.ios(first), third ? memory.read(second, third) : new Uint8Array())) this.setState(this.ios(first), this.int32(this.ios(first) + IOS.state) | 1); return first; }
   case names.flush: return first;
  }
  throw new Error(`Unsupported guest iostream call ${name}`);
 }
}
