const toFloat = fn => (...values) => Math.fround(fn(...values));
const round = value => { const whole = Math.trunc(value); return Math.abs(value - whole) >= 0.5 ? whole + Math.sign(value) : whole; };
const integer = value => Number.isFinite(value) && Math.abs(value) < 2 ** 63 ? BigInt(value) : -(1n << 63n);
const roundEven = value => {
 const floor = Math.floor(value), difference = value - floor;
 if (difference < 0.5) return floor;
 if (difference > 0.5) return floor + 1;
 return floor % 2 === 0 ? floor : floor + 1;
};
const scale = (value, exponent) => {
 let result = value, remaining = Math.max(-5000, Math.min(5000, exponent));
 while (remaining > 1000) { result *= 2 ** 1000; remaining -= 1000; }
 while (remaining < -1000) { result *= 2 ** -1000; remaining += 1000; }
 return result * 2 ** remaining;
};
const unary = new Map([
 ['_round', round], ['_sinh', Math.sinh], ['_cosh', Math.cosh], ['_tanh', Math.tanh], ['_asinh', Math.asinh], ['_acosh', Math.acosh], ['_atanh', Math.atanh],
 ['_logb', value => value === 0 ? -Infinity : !Number.isFinite(value) ? Math.abs(value) : Math.floor(Math.log2(Math.abs(value)))],
]);
const unaryFloat = new Map([
 ['_sinf', Math.sin], ['_cosf', Math.cos], ['_tanf', Math.tan], ['_atanf', Math.atan], ['_acosf', Math.acos], ['_logf', Math.log], ['_log2f', Math.log2], ['_log10f', Math.log10],
 ['_expf', Math.exp], ['_floorf', Math.floor], ['_ceilf', Math.ceil], ['_roundf', round], ['_tanhf', Math.tanh],
].map(([name, fn]) => [name, toFloat(fn)]));
const binary = new Map([['_fmod', (left, right) => left % right], ['_atan2', Math.atan2], ['_hypot', Math.hypot]]);
const binaryFloat = new Map([['_fmodf', (left, right) => left % right], ['_atan2f', Math.atan2], ['_hypotf', Math.hypot]].map(([name, fn]) => [name, toFloat(fn)]));

const stringCalls = ['_strncpy', '_strcasecmp', '_strncasecmp', '_strstr', '_strlcpy', '_strtol', '_strtoll', '_atof', '_atoll', '___memcpy_chk', '___memset_chk', '___strcat_chk', '___strlcpy_chk', '___strlcat_chk', '_getpagesize', '_memset_pattern16', '_div', '_fnmatch'];
export const libcImports = new Set([...unary.keys(), ...unaryFloat.keys(), ...binary.keys(), ...binaryFloat.keys(), '_lrint', '_lround', '_ldexp', '_ldexpf', '_scalbn', '_frexp', '_modf', ...stringCalls]);

const lower = byte => byte >= 65 && byte <= 90 ? byte + 32 : byte;
const LIMIT = 1 << 20;

function bracket(pattern, start, byte, fold) {
 let index = start + 1;
 const negate = pattern[index] === 33 || pattern[index] === 94;
 if (negate) index++;
 let matched = false, first = true;
 for (; index < pattern.length && (pattern[index] !== 93 || first); first = false) {
  let low = pattern[index++];
  if (low === 92 && index < pattern.length) low = pattern[index++];
  let high = low;
  if (pattern[index] === 45 && index + 1 < pattern.length && pattern[index + 1] !== 93) { high = pattern[index + 1]; index += 2; }
  if (byte >= low && byte <= high || fold && lower(byte) >= lower(low) && lower(byte) <= lower(high)) matched = true;
 }
 if (index >= pattern.length) return null;
 return { next: index + 1, matched: matched !== negate };
}

function fnmatch(pattern, text, flags) {
 const noEscape = flags & 1, pathname = flags & 2, period = flags & 4, fold = flags & 16;
 const leading = position => period && text[position] === 46 && (position === 0 || pathname && text[position - 1] === 47);
 let p = 0, t = 0, starP = -1, starT = -1;
 const backtrack = () => { if (starP < 0 || pathname && text[starT] === 47) return false; t = ++starT; p = starP; return true; };
 while (t < text.length || p < pattern.length) {
  if (p >= pattern.length) { if (!backtrack()) return 1; continue; }
  const code = pattern[p];
  if (code === 42) {
   if (t < text.length && leading(t) || t >= text.length && false) return 1;
   p++; starP = p; starT = t; continue;
  }
  if (t >= text.length) return 1;
  let matched, next = p + 1;
  if (code === 63) matched = !(pathname && text[t] === 47) && !leading(t);
  else if (code === 91) {
   const result = !(pathname && text[t] === 47) && !leading(t) ? bracket(pattern, p, text[t], fold) : { next: p + 1, matched: false };
   if (result === null) return 2;
   matched = result.matched; next = result.next;
  } else {
   let literal = code;
   if (code === 92 && !noEscape && p + 1 < pattern.length) { literal = pattern[p + 1]; next = p + 2; }
   matched = fold ? lower(literal) === lower(text[t]) : literal === text[t];
  }
  if (matched) { p = next; t++; continue; }
  if (!backtrack()) return 1;
 }
 return 0;
}

function parseInteger(memory, text, end, base) {
 const bytes = memory.stringBytes(text, LIMIT);
 const finish = (value, consumed, errno) => {
  if (end) memory.writePointer(end, text + consumed);
  if (errno) { const output = new Uint8Array(4); new DataView(output.buffer).setInt32(0, errno, true); memory.write(memory.errorPointer(), output); }
  return value;
 };
 if (base !== 0 && (base < 2 || base > 36)) return finish(0n, 0, 22);
 let index = 0, negative = false;
 while ([9, 10, 11, 12, 13, 32].includes(bytes[index])) index++;
 if (bytes[index] === 43 || bytes[index] === 45) negative = bytes[index++] === 45;
 const hexadecimal = bytes[index] === 48 && lower(bytes[index + 1]) === 120 && (base === 0 || base === 16);
 const digit = byte => byte >= 48 && byte <= 57 ? byte - 48 : lower(byte) >= 97 && lower(byte) <= 122 ? lower(byte) - 87 : 99;
 if (hexadecimal && digit(bytes[index + 2]) < 16) { index += 2; base = 16; }
 else if (base === 0) base = bytes[index] === 48 ? 8 : 10;
 const start = index, limit = negative ? 1n << 63n : (1n << 63n) - 1n;
 let value = 0n, overflow = false;
 while (index < bytes.length && digit(bytes[index]) < base) {
  value = value * BigInt(base) + BigInt(digit(bytes[index++]));
  if (value > limit) overflow = true;
 }
 if (index === start) return finish(0n, 0, 22);
 if (overflow) return finish(negative ? -(1n << 63n) : (1n << 63n) - 1n, index, 34);
 return finish(negative ? -value : value, index, 0);
}

export function invokeGuestLibc(memory, name, [first, second, third]) {
 const float = index => memory.floatingRegister(index, 32), double = index => memory.floatingRegister(index);
 if (unary.has(name)) return { rax: 0, xmm0: unary.get(name)(double(0)) };
 if (unaryFloat.has(name)) return { rax: 0, xmm0f: unaryFloat.get(name)(float(0)) };
 if (binary.has(name)) return { rax: 0, xmm0: binary.get(name)(double(0), double(1)) };
 if (binaryFloat.has(name)) return { rax: 0, xmm0f: binaryFloat.get(name)(float(0), float(1)) };
 switch (name) {
  case '_lrint': return integer(roundEven(double(0)));
  case '_lround': return integer(round(double(0)));
  case '_ldexp': case '_scalbn': return { rax: 0, xmm0: scale(double(0), Number(BigInt.asIntN(32, BigInt(first)))) };
  case '_ldexpf': return { rax: 0, xmm0f: Math.fround(scale(float(0), Number(BigInt.asIntN(32, BigInt(first))))) };
  case '_frexp': {
   const value = double(0), output = new Uint8Array(4), view = new DataView(output.buffer);
   if (value === 0 || !Number.isFinite(value)) { memory.write(first, output); return { rax: 0, xmm0: value }; }
   const exponent = Math.max(-1023, Math.floor(Math.log2(Math.abs(value)))) + 1;
   let mantissa = scale(value, -exponent), adjusted = exponent;
   while (Math.abs(mantissa) >= 1) { mantissa /= 2; adjusted++; }
   while (Math.abs(mantissa) < 0.5) { mantissa *= 2; adjusted--; }
   view.setInt32(0, adjusted, true); memory.write(first, output); return { rax: 0, xmm0: mantissa };
  }
  case '_modf': {
   const value = double(0), whole = Number.isFinite(value) ? Math.trunc(value) : value, output = new Uint8Array(8);
   new DataView(output.buffer).setFloat64(0, whole, true); memory.write(first, output);
   return { rax: 0, xmm0: Number.isFinite(value) ? Math.sign(value) < 0 || Object.is(value, -0) ? -Math.abs(value - whole) : Math.abs(value - whole) : Number.isNaN(value) ? value : Math.sign(value) * 0 };
  }
  case '_strncpy': {
   const source = memory.stringBytes(second, LIMIT), output = new Uint8Array(third);
   output.set(source.subarray(0, third)); if (third) memory.write(first, output); return first;
  }
  case '_strcasecmp': case '_strncasecmp': {
   const left = memory.stringBytes(first, LIMIT), right = memory.stringBytes(second, LIMIT), count = name === '_strncasecmp' ? third : LIMIT;
   for (let index = 0; index < count; index++) {
    const a = lower(left[index] ?? 0), b = lower(right[index] ?? 0);
    if (a !== b) return a - b;
    if (!a) return 0;
   }
   return 0;
  }
  case '_strstr': {
   const haystack = memory.stringBytes(first, LIMIT), needle = memory.stringBytes(second, LIMIT);
   search: for (let index = 0; index + needle.length <= haystack.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) if (haystack[index + offset] !== needle[offset]) continue search;
    return first + index;
   }
   return 0;
  }
  case '_strlcpy': case '___strlcpy_chk': {
   const source = memory.stringBytes(second, LIMIT);
   if (third) { const count = Math.min(source.length, third - 1), output = new Uint8Array(count + 1); output.set(source.subarray(0, count)); memory.write(first, output); }
   return source.length;
  }
  case '___strlcat_chk': {
   const existing = memory.stringBytes(first, third), source = memory.stringBytes(second, LIMIT), room = third - existing.length - 1;
   if (room >= 0) { const count = Math.min(source.length, room), output = new Uint8Array(count + 1); output.set(source.subarray(0, count)); memory.write(first + existing.length, output); }
   return existing.length + source.length;
  }
  case '___strcat_chk': {
   const existing = memory.stringBytes(first, LIMIT), source = memory.stringBytes(second, LIMIT), output = new Uint8Array(source.length + 1);
   output.set(source); memory.write(first + existing.length, output); return first;
  }
  case '___memcpy_chk': if (third) memory.write(first, memory.read(second, third)); return first;
  case '___memset_chk': if (third) memory.write(first, new Uint8Array(third).fill(second & 255)); return first;
  case '_strtol': case '_strtoll': return parseInteger(memory, first, second, Number(BigInt.asIntN(32, BigInt(third))));
  case '_atoll': return parseInteger(memory, first, 0, 10);
  case '_atof': {
   const text = memory.string(first, LIMIT), match = /^[\t\n\v\f\r ]*[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(text);
   return { rax: 0, xmm0: match ? Number(match[0]) : 0 };
  }
  case '_getpagesize': return 4096;
  case '_fnmatch': return fnmatch(memory.stringBytes(first, LIMIT), memory.stringBytes(second, LIMIT), Number(BigInt.asIntN(32, BigInt(third))));
  case '_div': {
   const numerator = Number(BigInt.asIntN(32, BigInt(first))), denominator = Number(BigInt.asIntN(32, BigInt(second)));
   if (!denominator) throw new Error('Guest division by zero');
   const quotient = Math.trunc(numerator / denominator), remainder = numerator - quotient * denominator;
   return BigInt.asUintN(32, BigInt(quotient)) | BigInt.asUintN(32, BigInt(remainder)) << 32n;
  }
  case '_memset_pattern16': {
   if (!third) return 0;
   const pattern = memory.read(second, 16), output = new Uint8Array(third);
   for (let index = 0; index < third; index++) output[index] = pattern[index % 16];
   memory.write(first, output); return 0;
  }
 }
 throw new Error(`Unsupported guest libc call ${name}`);
}
