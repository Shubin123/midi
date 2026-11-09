const binary = {
 vadd: (a, b) => a + b, vmul: (a, b) => a * b, vmax: (a, b) => Math.max(a, b), vmin: (a, b) => Math.min(a, b),
 vsub: (b, a) => a - b, vdiv: (b, a) => a / b,
};
const names = ['vadd', 'vsub', 'vmul', 'vdiv', 'vma', 'vsma', 'vsadd', 'vsmul', 'vabs', 'vneg', 'vclr', 'vfill', 'vmax', 'vmin', 'vclip'];
const singles = ['dotpr', 'maxvi', 'minvi', 'meanv', 'rmsqv', 'zvabs', 'zvphas', 'ctoz', 'ztoc', 'create_fftsetup', 'destroy_fftsetup', 'fft_zrip', 'fft_zop'];
export const accelerateImports = new Set([
 ...names.flatMap(name => [`_vDSP_${name}`, `_vDSP_${name}D`]),
 ...singles.map(name => `_vDSP_${name}`), '_vvsincosf', '_vvexpf', '_vvlogf', '_vvsqrtf',
]);

function bitReverse(re, im) {
 const size = re.length;
 for (let index = 1, swap = 0; index < size; index++) {
  let bit = size >> 1;
  for (; swap & bit; bit >>= 1) swap ^= bit;
  swap ^= bit;
  if (index < swap) { [re[index], re[swap]] = [re[swap], re[index]]; [im[index], im[swap]] = [im[swap], im[index]]; }
 }
}

export function fourier(re, im, direction) {
 const size = re.length;
 bitReverse(re, im);
 for (let length = 2; length <= size; length <<= 1) {
  const half = length >> 1, step = direction * 2 * Math.PI / length;
  for (let start = 0; start < size; start += length) {
   for (let offset = 0; offset < half; offset++) {
    const angle = step * offset, wr = Math.cos(angle), wi = Math.sin(angle), k = start + offset, m = k + half;
    const tr = re[m] * wr - im[m] * wi, ti = re[m] * wi + im[m] * wr;
    re[m] = re[k] - tr; im[m] = im[k] - ti; re[k] += tr; im[k] += ti;
   }
  }
 }
}

export class GuestAccelerate {
 constructor(memory) { this.memory = memory; this.setups = new Map(); }
 size(name) { return name.endsWith('D') ? 8 : 4; }
 stride(index) { return Number(BigInt.asIntN(64, this.memory.argument64(index))); }
 count(index) {
  const value = this.memory.argument64(index);
  if (value > 1n << 24n) throw new Error('Accelerate vector length exceeds limit');
  return Number(value);
 }
 pointer(index) { return Number(this.memory.argument64(index)); }
 read(address, stride, count, size) {
  const output = size === 4 ? new Float32Array(count) : new Float64Array(count);
  if (!count) return output;
  const last = address + (count - 1) * stride * size, low = Math.min(address, last), span = Math.abs(last - address) + size;
  const bytes = this.memory.read(low, span), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index++) {
   const offset = address + index * stride * size - low;
   output[index] = size === 4 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
  }
  return output;
 }
 write(address, stride, values, size) {
  const count = values.length;
  if (!count) return;
  const last = address + (count - 1) * stride * size, low = Math.min(address, last), span = Math.abs(last - address) + size;
  const bytes = stride === 1 ? new Uint8Array(span) : this.memory.read(low, span), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index++) {
   const offset = address + index * stride * size - low;
   if (size === 4) view.setFloat32(offset, values[index], true); else view.setFloat64(offset, values[index], true);
  }
  this.memory.write(low, bytes);
 }
 scalar(address, size) { return this.read(address, 1, 1, size)[0]; }
 split(address) { return [this.memory.pointer(address), this.memory.pointer(address + 8)]; }
 setup(handle, log2) {
  const setup = this.setups.get(handle);
  if (!setup || log2 > setup.log2) throw new Error('Invalid guest FFT setup');
 }
 realFourier(log2, stride, packed, direction) {
  const [realp, imagp] = this.split(packed), halfSize = 1 << log2 - 1, size = halfSize * 2;
  const real = this.read(realp, stride, halfSize, 4), imag = this.read(imagp, stride, halfSize, 4);
  const re = new Float64Array(size), im = new Float64Array(size);
  if (direction > 0) {
   for (let index = 0; index < halfSize; index++) { re[index * 2] = real[index]; re[index * 2 + 1] = imag[index]; }
   fourier(re, im, -1);
   const outReal = new Float32Array(halfSize), outImag = new Float32Array(halfSize);
   outReal[0] = re[0] * 2; outImag[0] = re[halfSize] * 2;
   for (let index = 1; index < halfSize; index++) { outReal[index] = re[index] * 2; outImag[index] = im[index] * 2; }
   this.write(realp, stride, outReal, 4); this.write(imagp, stride, outImag, 4);
  } else {
   re[0] = real[0]; re[halfSize] = imag[0];
   for (let index = 1; index < halfSize; index++) { re[index] = real[index]; im[index] = imag[index]; re[size - index] = real[index]; im[size - index] = -imag[index]; }
   fourier(re, im, 1);
   const outReal = new Float32Array(halfSize), outImag = new Float32Array(halfSize);
   for (let index = 0; index < halfSize; index++) { outReal[index] = re[index * 2]; outImag[index] = re[index * 2 + 1]; }
   this.write(realp, stride, outReal, 4); this.write(imagp, stride, outImag, 4);
  }
 }
 invoke(name) {
  const memory = this.memory, base = name.replace(/^_vDSP_/, '').replace(/D$/, ''), size = this.size(name);
  const p = index => this.pointer(index), s = index => this.stride(index), n = index => this.count(index);
  if (name === '_vvsincosf') {
   const count = memory.read(p(3), 4), length = new DataView(count.buffer, count.byteOffset, count.byteLength).getInt32(0, true), input = this.read(p(2), 1, length, 4);
   this.write(p(0), 1, input.map(Math.sin), 4); this.write(p(1), 1, input.map(Math.cos), 4); return 0;
  }
  if (['_vvexpf', '_vvlogf', '_vvsqrtf'].includes(name)) {
   const count = memory.read(p(2), 4), length = new DataView(count.buffer, count.byteOffset, count.byteLength).getInt32(0, true), input = this.read(p(1), 1, length, 4);
   this.write(p(0), 1, input.map({ _vvexpf: Math.exp, _vvlogf: Math.log, _vvsqrtf: Math.sqrt }[name]), 4); return 0;
  }
  switch (base) {
   case 'vadd': case 'vmul': case 'vmax': case 'vmin': case 'vsub': case 'vdiv': {
    const count = n(6), first = this.read(p(0), s(1), count, size), second = this.read(p(2), s(3), count, size);
    this.write(p(4), s(5), first.map((value, index) => binary[base](value, second[index])), size); return 0;
   }
   case 'vma': {
    const count = n(8), a = this.read(p(0), s(1), count, size), b = this.read(p(2), s(3), count, size), c = this.read(p(4), s(5), count, size);
    this.write(p(6), s(7), a.map((value, index) => value * b[index] + c[index]), size); return 0;
   }
   case 'vsma': {
    const count = n(7), a = this.read(p(0), s(1), count, size), scalar = this.scalar(p(2), size), c = this.read(p(3), s(4), count, size);
    this.write(p(5), s(6), a.map((value, index) => value * scalar + c[index]), size); return 0;
   }
   case 'vsadd': case 'vsmul': {
    const count = n(5), a = this.read(p(0), s(1), count, size), scalar = this.scalar(p(2), size);
    this.write(p(3), s(4), a.map(value => base === 'vsadd' ? value + scalar : value * scalar), size); return 0;
   }
   case 'vabs': case 'vneg': {
    const count = n(4), a = this.read(p(0), s(1), count, size);
    this.write(p(2), s(3), a.map(base === 'vabs' ? Math.abs : value => -value), size); return 0;
   }
   case 'vclr': this.write(p(0), s(1), size === 4 ? new Float32Array(n(2)) : new Float64Array(n(2)), size); return 0;
   case 'vfill': {
    const count = n(3), value = this.scalar(p(0), size), filled = size === 4 ? new Float32Array(count).fill(value) : new Float64Array(count).fill(value);
    this.write(p(1), s(2), filled, size); return 0;
   }
   case 'vclip': {
    const count = n(6), a = this.read(p(0), s(1), count, size), low = this.scalar(p(2), size), high = this.scalar(p(3), size);
    this.write(p(4), s(5), a.map(value => value < low ? low : value > high ? high : value), size); return 0;
   }
   case 'dotpr': {
    const count = n(5), a = this.read(p(0), s(1), count, 4), b = this.read(p(2), s(3), count, 4);
    let total = 0;
    for (let index = 0; index < count; index++) total += a[index] * b[index];
    this.write(p(4), 1, Float32Array.of(total), 4); return 0;
   }
   case 'maxvi': case 'minvi': {
    const count = n(4), stride = s(1), a = this.read(p(0), stride, count, 4);
    let best = base === 'maxvi' ? -Infinity : Infinity, found = 0;
    for (let index = 0; index < count; index++) if (base === 'maxvi' ? a[index] > best : a[index] < best) { best = a[index]; found = index; }
    this.write(p(2), 1, Float32Array.of(best), 4); memory.writePointer(p(3), found * stride); return 0;
   }
   case 'meanv': case 'rmsqv': {
    const count = n(3), a = this.read(p(0), s(1), count, 4);
    let total = 0;
    for (const value of a) total += base === 'meanv' ? value : value * value;
    this.write(p(2), 1, Float32Array.of(count ? base === 'meanv' ? total / count : Math.sqrt(total / count) : NaN), 4); return 0;
   }
   case 'zvabs': case 'zvphas': {
    const count = n(4), [realp, imagp] = this.split(p(0)), stride = s(1), re = this.read(realp, stride, count, 4), im = this.read(imagp, stride, count, 4);
    this.write(p(2), s(3), re.map((value, index) => base === 'zvabs' ? Math.hypot(value, im[index]) : Math.atan2(im[index], value)), 4); return 0;
   }
   case 'ctoz': {
    const count = n(4), [realp, imagp] = this.split(p(2)), stride = s(3), source = p(0), step = s(1) * 4;
    const pair = offset => Float32Array.from({ length: count }, (_, index) => this.scalar(source + index * step + offset, 4));
    this.write(realp, stride, pair(0), 4); this.write(imagp, stride, pair(4), 4); return 0;
   }
   case 'ztoc': {
    const count = n(4), [realp, imagp] = this.split(p(0)), re = this.read(realp, s(1), count, 4), im = this.read(imagp, s(1), count, 4), target = p(2), stride = s(3);
    for (let index = 0; index < count; index++) this.write(target + index * stride * 4, 1, Float32Array.of(re[index], im[index]), 4);
    return 0;
   }
   case 'create_fftsetup': {
    if (p(0) > 20 || p(1) !== 0) throw new Error('Unsupported guest FFT setup');
    const handle = memory.allocate(16); this.setups.set(handle, { log2: p(0) }); return handle;
   }
   case 'destroy_fftsetup': if (p(0)) { this.setups.delete(p(0)); memory.allocations.delete(p(0)); } return 0;
   case 'fft_zrip': {
    const log2 = p(3), direction = Number(BigInt.asIntN(32, memory.argument64(4)));
    this.setup(p(0), log2); this.realFourier(log2, s(2), p(1), direction); return 0;
   }
   case 'fft_zop': {
    const log2 = n(5), direction = Number(BigInt.asIntN(32, memory.argument64(6))), count = 1 << log2;
    this.setup(p(0), log2);
    const [inReal, inImag] = this.split(p(1)), [outReal, outImag] = this.split(p(3));
    const re = Float64Array.from(this.read(inReal, s(2), count, 4)), im = Float64Array.from(this.read(inImag, s(2), count, 4));
    fourier(re, im, direction > 0 ? -1 : 1);
    this.write(outReal, s(4), Float32Array.from(re), 4); this.write(outImag, s(4), Float32Array.from(im), 4); return 0;
   }
  }
  throw new Error(`Unsupported guest Accelerate call ${name}`);
 }
}
