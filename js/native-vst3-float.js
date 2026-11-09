const SIGN = 1n << 63n, INFINITY = 0x7ff0000000000000n, MIN_NORMAL = 1n << 52n;
const bitsOf = value => { const bytes = new ArrayBuffer(8), view = new DataView(bytes); view.setFloat64(0, value, true); return view.getBigUint64(0, true); };
const exponent = value => value ? Math.max(-1000000, Math.min(1000000, Number(value))) : 0;

export function checkGuestRounding(memory) {
 const sse = memory.engine.reg_read(memory.uc.X86_REG_MXCSR, 4), x87 = memory.engine.reg_read(memory.uc.X86_REG_FPCW, 2);
 if (sse[1] & 0x60 || x87[1] & 0x0c) throw new Error('Unsupported guest floating-point rounding mode');
}

export function formatGuestFixed(bits, precision, alternate = false) {
 if (!Number.isSafeInteger(precision) || precision < 0 || precision > 4096) throw new Error('printf floating precision exceeds limit');
 const negative = Boolean(bits & SIGN), absolute = bits & ~SIGN, magnitude = Number(absolute >> 52n), fraction = absolute & 0xfffffffffffffn;
 if (magnitude === 2047) return { negative, digits: fraction ? 'nan' : 'inf', special: true };
 const significand = magnitude ? MIN_NORMAL | fraction : fraction, power = (magnitude ? magnitude - 1075 : -1074) + precision;
 const rounded = roundedShift(significand * 5n ** BigInt(precision), -power).value.toString();
 const digits = rounded.padStart(precision + 1, '0');
 return { negative, digits: precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}` : digits + (alternate ? '.' : ''), special: false };
}

function roundedShift(value, shift) {
 if (shift <= 0) return { value: value << BigInt(-shift), exact: true };
 if (shift > value.toString(2).length + 1) return { value: 0n, exact: false };
 const places = BigInt(shift), remainder = value & ((1n << places) - 1n), half = 1n << places - 1n;
 let result = value >> places;
 if (remainder > half || remainder === half && result & 1n) result++;
 return { value: result, exact: remainder === 0n };
}

function hexadecimal(token) {
 const match = token.match(/^0x([^p]+)(?:p([+-]?\d+))?$/i), parts = match[1].split('.');
 const digits = parts.join(''), significand = BigInt(`0x${digits}`), power = exponent(match[2]) - (parts[1]?.length ?? 0) * 4;
 if (!significand) return { bits: 0n, range: false };
 const length = significand.toString(2).length; let magnitude = length - 1 + power;
 if (magnitude > 1023) return { bits: INFINITY, range: true };
 if (magnitude < -1022) {
  const rounded = roundedShift(significand, -1074 - power);
  return { bits: rounded.value, range: rounded.value < MIN_NORMAL && !rounded.exact };
 }
 let rounded = roundedShift(significand, length - 53).value;
 if (rounded === 1n << 53n) { rounded >>= 1n; magnitude++; }
 if (magnitude > 1023) return { bits: INFINITY, range: true };
 return { bits: BigInt(magnitude + 1023) << 52n | rounded - MIN_NORMAL, range: false };
}

function decimal(token) {
 const value = Number(token), bits = bitsOf(value);
 if (!Number.isFinite(value)) return { bits, range: true };
 if (bits >= MIN_NORMAL) return { bits, range: false };
 const parts = token.split(/[eE]/), fraction = parts[0].split('.'), digits = fraction.join('');
 const significand = BigInt(digits), power = exponent(parts[1]) - (fraction[1]?.length ?? 0);
 if (!significand) return { bits, range: false };
 if (!bits) return { bits, range: true };
 const places = -power, fives = 5n ** BigInt(places);
 const exact = places <= 1074 ? significand << BigInt(1074 - places) : significand;
 const represented = places <= 1074 ? bits * fives : bits * fives << BigInt(places - 1074);
 return { bits, range: exact !== represented };
}

export function parseGuestFloat(input) {
 const whitespace = input.match(/^[\t\n\v\f\r ]*/)[0].length, rest = input.slice(whitespace);
 const token = rest.match(/^[+-]?(?:inf(?:inity)?|nan(?:\([a-z0-9_]*\))?)/i)?.[0]
  ?? rest.match(/^[+-]?0x(?:[0-9a-f]+(?:\.[0-9a-f]*)?|\.[0-9a-f]+)(?:p[+-]?\d+)?/i)?.[0]
  ?? rest.match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i)?.[0];
 if (!token) return { bits: 0n, consumed: 0, range: false };
 if (token.length > 4096) throw new Error('Guest floating-point token exceeds 4096 bytes');
 const negative = token[0] === '-', unsigned = token.replace(/^[+-]/, ''); let result;
 if (/^inf/i.test(unsigned)) result = { bits: INFINITY, range: false };
 else if (/^nan/i.test(unsigned)) {
  const payload = unsigned.match(/^nan\((0x[0-9a-f]+|[0-9]+)\)$/i)?.[1];
  result = { bits: 0x7ff8000000000000n | (payload ? BigInt(payload) & 0x7ffffffffffffn : 0n), range: false };
 } else result = /^0x/i.test(unsigned) ? hexadecimal(unsigned) : decimal(unsigned);
 return { ...result, bits: result.bits | (negative ? SIGN : 0n), consumed: whitespace + token.length };
}
