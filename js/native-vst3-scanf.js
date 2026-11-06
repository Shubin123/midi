const LIMIT = 1 << 20;
const whitespace = character => character !== undefined && ' \t\n\r\v\f'.includes(character);

export function scanGuestIntegers(inputBytes, formatBytes, assign) {
 if (inputBytes.length > LIMIT || formatBytes.length > 4096) throw new Error('scanf input exceeds limit');
 const input = Array.from(inputBytes, byte => String.fromCharCode(byte)).join('');
 const format = String.fromCharCode(...formatBytes), directives = [];
 for (let offset = 0; offset < format.length;) {
  const character = format[offset];
  if (whitespace(character)) {
   while (whitespace(format[offset])) offset++;
   directives.push({ whitespace: true }); continue;
  }
  if (character !== '%') { directives.push({ literal: character }); offset++; continue; }
  if (format[offset + 1] === '%') { directives.push({ literal: '%', skipWhitespace: true }); offset += 2; continue; }
  const match = /^%(\*)?(\d*)(hh|ll|[hljzt])?([diuoxX])/.exec(format.slice(offset));
  if (!match) throw new Error('Unsupported scanf conversion');
  const width = match[2] ? Number(match[2]) : LIMIT;
  if (!Number.isSafeInteger(width) || width <= 0 || width > LIMIT) throw new Error('scanf field exceeds limit');
  directives.push({ suppressed: !!match[1], width, modifier: match[3], conversion: match[4] });
  offset += match[0].length;
 }
 let offset = 0, assignments = 0, completed = false;
 const inputFailure = () => completed ? assignments : -1;
 for (const directive of directives) {
  if (directive.whitespace) { while (whitespace(input[offset])) offset++; continue; }
  if (directive.literal !== undefined) {
   if (directive.skipWhitespace) while (whitespace(input[offset])) offset++;
   if (offset === input.length) return inputFailure();
   if (input[offset] !== directive.literal) return assignments;
   offset++; continue;
  }
  while (whitespace(input[offset])) offset++;
  if (offset === input.length) return inputFailure();
  const end = Math.min(input.length, offset + directive.width);
  let negative = false;
  if (input[offset] === '-' || input[offset] === '+') { negative = input[offset] === '-'; offset++; }
  let radix = directive.conversion === 'o' ? 8 : 'xX'.includes(directive.conversion) ? 16 : 10;
  if (directive.conversion === 'i') radix = input[offset] === '0' ? 8 : 10;
  if ((radix === 16 || directive.conversion === 'i') && offset + 1 < end && input[offset] === '0' && 'xX'.includes(input[offset + 1])) {
   radix = 16; offset += 2;
  }
  const begin = offset;
  let value = 0n;
  while (offset < end) {
   const digit = '0123456789abcdef'.indexOf(input[offset].toLowerCase());
   if (digit < 0 || digit >= radix) break;
   value = value * BigInt(radix) + BigInt(digit);
   if (value > 0xffffffffffffffffn) throw new Error('scanf integer exceeds supported range');
   offset++;
  }
  if (offset === begin) return assignments;
  const bits = directive.modifier === 'hh' ? 8 : directive.modifier === 'h' ? 16 : directive.modifier ? 64 : 32;
  const signed = 'di'.includes(directive.conversion);
  if (negative) value = -value;
  const maximum = (1n << BigInt(bits - (signed ? 1 : 0))) - 1n;
  const minimum = signed ? -(1n << BigInt(bits - 1)) : -maximum;
  if (value < minimum || value > maximum) throw new Error('scanf integer exceeds destination range');
  if (!directive.suppressed) { assign(BigInt.asUintN(bits, value), bits); assignments++; }
  completed = true;
 }
 return assignments;
}
