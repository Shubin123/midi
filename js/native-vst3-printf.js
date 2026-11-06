const LIMIT = 1 << 20;

export function formatGuestPrintf(format, nextArgument, readString) {
 const source = String.fromCharCode(...format), chunks = [];
 let length = 0;
 const append = value => {
  const bytes = typeof value === 'string' ? Uint8Array.from(value, character => character.charCodeAt(0)) : value;
  length += bytes.length;
  if (length > LIMIT) throw new Error('printf output exceeds limit');
  chunks.push(bytes);
 };
 const number = value => {
  if (!Number.isSafeInteger(value) || Math.abs(value) > LIMIT) throw new Error('printf field exceeds limit');
  return value;
 };
 for (let offset = 0; offset < source.length;) {
  if (source[offset] !== '%') {
   const end = source.indexOf('%', offset), stop = end < 0 ? source.length : end;
   append(source.slice(offset, stop)); offset = stop; continue;
  }
  const match = /^%([-+ #0]*)(\*|\d*)(?:\.(\*|\d*))?(hh|ll|[hljzt])?([diuoxXscp%])/.exec(source.slice(offset));
  if (!match) throw new Error('Unsupported printf conversion');
  offset += match[0].length;
  let [, flags, widthText, precisionText, modifier, conversion] = match;
  let width = number(widthText === '*' ? Number(BigInt.asIntN(32, nextArgument())) : Number(widthText || 0));
  let precision = precisionText === undefined ? null : number(precisionText === '*' ? Number(BigInt.asIntN(32, nextArgument())) : Number(precisionText || 0));
  if (width < 0) { flags += '-'; width = -width; }
  if (precision < 0) precision = null;
  let bytes, prefix = '', digits = '';
  if (conversion === '%') {
   if (match[0] !== '%%') throw new Error('Unsupported printf percent modifiers');
   append('%'); continue;
  }
  const argument = nextArgument();
  if (conversion === 's' || conversion === 'c') {
   if (modifier) throw new Error('Unsupported printf wide character conversion');
   bytes = conversion === 'c' ? new Uint8Array([Number(argument & 255n)]) : readString(argument, precision);
  } else {
   if (conversion === 'p' && (modifier || precision !== null)) throw new Error('Unsupported printf pointer modifiers');
   const bits = modifier === 'hh' ? 8 : modifier === 'h' ? 16 : modifier ? 64 : 32;
   const signed = conversion === 'd' || conversion === 'i';
   let value = signed ? BigInt.asIntN(bits, argument) : BigInt.asUintN(conversion === 'p' ? 64 : bits, argument);
   if (value < 0n) { prefix = '-'; value = -value; }
   else if (signed) prefix = flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
   const radix = conversion === 'o' ? 8 : 'xXp'.includes(conversion) ? 16 : 10;
   digits = value === 0n && precision === 0 ? '' : value.toString(radix);
   if (conversion === 'X') digits = digits.toUpperCase();
   if (precision !== null) digits = digits.padStart(precision, '0');
   if (conversion === 'p') prefix = '0x';
   else if (flags.includes('#') && conversion === 'o' && !digits.startsWith('0')) prefix = '0';
   else if (flags.includes('#') && value !== 0n && 'xX'.includes(conversion)) prefix = conversion === 'X' ? '0X' : '0x';
   if (flags.includes('0') && !flags.includes('-') && precision === null) digits = digits.padStart(Math.max(0, width - prefix.length), '0');
   bytes = Uint8Array.from(prefix + digits, character => character.charCodeAt(0));
  }
  const padding = new Uint8Array(Math.max(0, width - bytes.length)).fill(32);
  if (!flags.includes('-')) append(padding);
  append(bytes);
  if (flags.includes('-')) append(padding);
 }
 const result = new Uint8Array(length);
 let offset = 0;
 for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
 return result;
}
