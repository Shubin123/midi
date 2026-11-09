import { decodePng } from './native-vst3-png.js';

export const imageImports = new Set(['_CGDataProviderCreateWithData', '_CGImageSourceCreateWithDataProvider', '_CGImageSourceCreateImageAtIndex', '_CGImageGetWidth', '_CGImageGetHeight', '_CGImageGetAlphaInfo', '_CGImageRetain', '_CGImageRelease', '_CGColorSpaceCreateWithName', '_CGColorSpaceRelease', '_CGBitmapContextCreate', '_CGContextDrawImage', '_CGContextFlush', '_CGContextRelease']);

const ALPHA_PREMULTIPLIED_FIRST_LITTLE = 8194, ALPHA_SKIP_FIRST_LITTLE = 8198;

export class GuestImages {
 constructor(memory) { this.memory = memory; this.decoded = 0; }
 providerBytes(provider) {
  const memory = this.memory;
  if (provider.retained) { const data = memory.core.object(provider.retained, 'data'); return memory.read(data.pointer, data.length); }
  return memory.read(provider.pointer, provider.length);
 }
 invoke(name, [first, second, third, fourth, fifth, sixth]) {
  const memory = this.memory, core = memory.core;
  switch (name) {
   case '_CGDataProviderCreateWithData': {
    if (!Number.isSafeInteger(third) || third < 0 || third > 16 << 20) throw new Error('Guest data provider size exceeds limit');
    const release = fourth;
    if (release && !memory.isExecutable(release)) throw new Error('Invalid guest data provider callback');
    return core.create('provider', { pointer: second, length: third, finalize: release ? () => memory.callback(release, [first, second, third]) : null });
   }
   case '_CGImageSourceCreateWithDataProvider': {
    core.object(first, 'provider');
    if (second) throw new Error('Image source options are not implemented');
    const handle = core.create('imageSource', { retained: first }); core.invoke('_CFRetain', [first]); return handle;
   }
   case '_CGImageSourceCreateImageAtIndex': {
    const source = core.object(first, 'imageSource');
    if (second !== 0 || third) throw new Error('Image source index/options are not implemented');
    let image;
    try { image = decodePng(this.providerBytes(core.object(source.retained, 'provider'))); }
    catch (error) { if (error instanceof WebAssembly.RuntimeError) throw error; return 0; }
    if (!image) throw new Error('Only PNG image decoding is implemented');
    this.decoded++; return core.create('image', image);
   }
   case '_CGImageGetWidth': return first ? core.object(first, 'image').width : 0;
   case '_CGImageGetHeight': return first ? core.object(first, 'image').height : 0;
   case '_CGImageGetAlphaInfo': return first ? core.object(first, 'image').hasAlpha ? 3 : 0 : 0;
   case '_CGImageRetain': return first ? (core.object(first, 'image'), core.invoke('_CFRetain', [first])) : 0;
   case '_CGImageRelease': if (first) { core.object(first, 'image'); core.release(first); } return 0;
   case '_CGColorSpaceCreateWithName': return core.create('colorSpace', { name: core.text(first) });
   case '_CGColorSpaceRelease': if (first) { core.object(first, 'colorSpace'); core.release(first); } return 0;
   case '_CGBitmapContextCreate': {
    const [data, width, height, bits, stride, space] = [first, second, third, fourth, fifth, sixth], info = Number(BigInt.asUintN(32, memory.argument64(6)));
    if (bits !== 8 || !width || !height || stride < width * 4 || !space) throw new Error('Unsupported guest bitmap context');
    if (![ALPHA_PREMULTIPLIED_FIRST_LITTLE, ALPHA_SKIP_FIRST_LITTLE].includes(info)) throw new Error(`Unsupported guest bitmap format ${info}`);
    core.object(space, 'colorSpace');
    if (!data) throw new Error('Host-allocated bitmap contexts are not implemented');
    return core.create('bitmap', { data, width, height, stride, info });
   }
   case '_CGContextDrawImage': {
    const context = core.object(first, 'bitmap'), image = core.object(second, 'image');
    const bytes = memory.read(memory.register('RSP') + 8, 32), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rect = [0, 8, 16, 24].map(offset => view.getFloat64(offset, true));
    if (rect[0] !== 0 || rect[1] !== 0 || rect[2] !== image.width || rect[3] !== image.height || image.width !== context.width || image.height !== context.height) throw new Error('Scaled or offset image drawing is not implemented');
    const row = new Uint8Array(image.width * 4), opaque = context.info === ALPHA_SKIP_FIRST_LITTLE;
    for (let y = 0; y < image.height; y++) {
     const address = context.data + y * context.stride, existing = memory.read(address, row.length);
     for (let x = 0; x < image.width; x++) {
      const source = (y * image.width + x) * 4, target = x * 4, alpha = image.pixels[source + 3], inverse = 255 - alpha;
      for (const [channel, byte] of [[0, 2], [1, 1], [2, 0]]) row[target + byte] = Math.round(image.pixels[source + channel] * alpha / 255 + existing[target + byte] * inverse / 255);
      row[target + 3] = opaque ? 255 : alpha + Math.round(existing[target + 3] * inverse / 255);
     }
     memory.write(address, row);
    }
    return 0;
   }
   case '_CGContextFlush': core.object(first, 'bitmap'); return 0;
   case '_CGContextRelease': if (first) { core.object(first, 'bitmap'); core.release(first); } return 0;
  }
  throw new Error(`Unsupported guest image operation ${name}`);
 }
 report() { return { decoded: this.decoded }; }
}
