const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const MAX_PIXELS = 32 << 20;

function huffman(lengths) {
 const count = new Uint16Array(16), offsets = new Uint16Array(16), symbols = new Uint16Array(lengths.length);
 for (const length of lengths) count[length]++;
 count[0] = 0;
 for (let bits = 1; bits < 15; bits++) offsets[bits + 1] = offsets[bits] + count[bits];
 lengths.forEach((length, symbol) => { if (length) symbols[offsets[length]++] = symbol; });
 return { count, symbols };
}

let fixedTables;
function fixed() {
 if (fixedTables) return fixedTables;
 const literals = new Uint8Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
 return fixedTables = [huffman([...literals]), huffman(new Array(30).fill(5))];
}

export function inflate(source, size) {
 const output = new Uint8Array(size);
 let position = 0, written = 0, buffer = 0, available = 0;
 const bits = need => {
  while (available < need) {
   if (position >= source.length) throw new Error('Truncated deflate stream');
   buffer |= source[position++] << available; available += 8;
  }
  const value = buffer & (1 << need) - 1; buffer >>>= need; available -= need; return value;
 };
 const symbol = table => {
  let code = 0, first = 0, index = 0;
  for (let length = 1; length <= 15; length++) {
   code |= bits(1);
   const count = table.count[length];
   if (code - count < first) return table.symbols[index + code - first];
   index += count; first = first + count << 1; code <<= 1;
  }
  throw new Error('Invalid deflate code');
 };
 for (let last = 0; !last;) {
  last = bits(1);
  const type = bits(2);
  if (type === 0) {
   buffer = 0; available = 0;
   if (position + 4 > source.length) throw new Error('Truncated deflate stream');
   const length = source[position] | source[position + 1] << 8; position += 4;
   if (position + length > source.length || written + length > size) throw new Error('Invalid stored deflate block');
   output.set(source.subarray(position, position + length), written); position += length; written += length;
   continue;
  }
  if (type === 3) throw new Error('Invalid deflate block');
  let tables;
  if (type === 1) tables = fixed();
  else {
   const literalCount = bits(5) + 257, distanceCount = bits(5) + 1, codeCount = bits(4) + 4, codeLengths = new Array(19).fill(0);
   for (let index = 0; index < codeCount; index++) codeLengths[CODE_ORDER[index]] = bits(3);
   const codes = huffman(codeLengths), lengths = [];
   while (lengths.length < literalCount + distanceCount) {
    const code = symbol(codes);
    if (code < 16) { lengths.push(code); continue; }
    if (code === 16 && !lengths.length) throw new Error('Invalid deflate length repeat');
    const value = code === 16 ? lengths.at(-1) : 0, repeat = code === 16 ? 3 + bits(2) : code === 17 ? 3 + bits(3) : 11 + bits(7);
    for (let index = 0; index < repeat; index++) lengths.push(value);
   }
   if (lengths.length !== literalCount + distanceCount) throw new Error('Invalid deflate code lengths');
   tables = [huffman(lengths.slice(0, literalCount)), huffman(lengths.slice(literalCount))];
  }
  for (;;) {
   const code = symbol(tables[0]);
   if (code === 256) break;
   if (code < 256) { if (written >= size) throw new Error('Deflate output exceeds its declared size'); output[written++] = code; continue; }
   if (code > 285) throw new Error('Invalid deflate length');
   const length = LENGTH_BASE[code - 257] + bits(LENGTH_EXTRA[code - 257]), distanceCode = symbol(tables[1]);
   if (distanceCode > 29) throw new Error('Invalid deflate distance');
   const distance = DISTANCE_BASE[distanceCode] + bits(DISTANCE_EXTRA[distanceCode]);
   if (distance > written || written + length > size) throw new Error('Invalid deflate copy');
   for (let index = 0; index < length; index++, written++) output[written] = output[written - distance];
  }
 }
 if (written !== size) throw new Error('Deflate output is shorter than declared');
 return output;
}

export function decodePng(bytes) {
 const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
 if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return null;
 let width = 0, height = 0, depth = 0, color = 0, palette = null, transparency = null, compressedLength = 0;
 const parts = [];
 for (let offset = 8; offset + 8 <= bytes.length;) {
  const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), start = offset + 8;
  if (start + length + 4 > bytes.length) throw new Error('Truncated PNG chunk');
  if (type === 'IHDR') {
   width = view.getUint32(start); height = view.getUint32(start + 4); depth = bytes[start + 8]; color = bytes[start + 9];
   if (bytes[start + 12] !== 0) throw new Error('Interlaced PNG decoding is not implemented');
  } else if (type === 'PLTE') palette = bytes.subarray(start, start + length);
  else if (type === 'tRNS') transparency = bytes.subarray(start, start + length);
  else if (type === 'IDAT') { parts.push(bytes.subarray(start, start + length)); compressedLength += length; }
  else if (type === 'IEND') break;
  offset = start + length + 4;
 }
 const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
 if (!width || !height || !channels || ![1, 2, 4, 8, 16].includes(depth) || width * height * 4 > MAX_PIXELS || compressedLength < 7) throw new Error('Unsupported PNG image');
 const compressed = new Uint8Array(compressedLength);
 let cursor = 0;
 for (const part of parts) { compressed.set(part, cursor); cursor += part.length; }
 const stride = Math.ceil(width * channels * depth / 8), filterStep = Math.max(1, channels * depth >> 3);
 const raw = inflate(compressed.subarray(2), (stride + 1) * height), pixels = new Uint8Array(width * height * 4);
 let previous = new Uint8Array(stride), current = new Uint8Array(stride);
 for (let row = 0; row < height; row++) {
  const base = row * (stride + 1), filter = raw[base];
  if (filter > 4) throw new Error('Invalid PNG filter');
  for (let index = 0; index < stride; index++) {
   const left = index >= filterStep ? current[index - filterStep] : 0, up = previous[index], corner = index >= filterStep ? previous[index - filterStep] : 0;
   let predicted = 0;
   if (filter === 1) predicted = left;
   else if (filter === 2) predicted = up;
   else if (filter === 3) predicted = left + up >> 1;
   else if (filter === 4) {
    const estimate = left + up - corner, a = Math.abs(estimate - left), b = Math.abs(estimate - up), c = Math.abs(estimate - corner);
    predicted = a <= b && a <= c ? left : b <= c ? up : corner;
   }
   current[index] = raw[base + 1 + index] + predicted;
  }
  for (let column = 0; column < width; column++) {
   const target = (row * width + column) * 4;
   const sample = channel => {
    if (depth === 16) return current[(column * channels + channel) * 2];
    if (depth === 8) return current[column * channels + channel];
    const bit = column * depth;
    return current[bit >> 3] >> 8 - depth - (bit & 7) & (1 << depth) - 1;
   };
   const scale = value => depth < 8 && color !== 3 ? value * 255 / ((1 << depth) - 1) : value;
   if (color === 3) {
    const entry = sample(0);
    if (!palette || entry * 3 + 2 >= palette.length) throw new Error('Invalid PNG palette index');
    pixels[target] = palette[entry * 3]; pixels[target + 1] = palette[entry * 3 + 1]; pixels[target + 2] = palette[entry * 3 + 2]; pixels[target + 3] = transparency && entry < transparency.length ? transparency[entry] : 255;
   } else if (color === 0 || color === 4) {
    const gray = scale(sample(0)); pixels[target] = pixels[target + 1] = pixels[target + 2] = gray;
    pixels[target + 3] = color === 4 ? sample(1) : transparency && gray === transparency[1] ? 0 : 255;
   } else {
    for (let channel = 0; channel < 3; channel++) pixels[target + channel] = sample(channel);
    pixels[target + 3] = color === 6 ? sample(3) : transparency && pixels[target] === transparency[1] && pixels[target + 1] === transparency[3] && pixels[target + 2] === transparency[5] ? 0 : 255;
   }
  }
  [previous, current] = [current, previous];
 }
 return { width, height, pixels, hasAlpha: color === 4 || color === 6 || Boolean(transparency) };
}
