export function sfntName(font, requested = 6) {
 const bytes = font.tables.get('name'), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = view.getUint16(2), storage = view.getUint16(4), matches = [];
 if (count > 1024 || 6 + count * 12 > bytes.length || storage < 6 + count * 12 || storage > bytes.length) throw new Error('Invalid font name directory');
 for (let index = 0; index < count; index++) {
  const offset = 6 + index * 12, platform = view.getUint16(offset), language = view.getUint16(offset + 4), length = view.getUint16(offset + 8), start = storage + view.getUint16(offset + 10);
  if (start + length > bytes.length) throw new Error('Invalid font name data');
  if (view.getUint16(offset + 6) !== requested || ![0, 1, 3].includes(platform)) continue;
  if ((platform === 0 || platform === 3) && length % 2) throw new Error('Invalid UTF-16 font name');
  const name = new TextDecoder(platform === 1 ? 'macintosh' : 'utf-16be', { fatal: true }).decode(bytes.subarray(start, start + length));
  matches.push({ name, priority: platform === 3 && language === 0x409 ? 0 : platform === 0 ? 1 : 2 });
 }
 return matches.sort((left, right) => left.priority - right.priority)[0]?.name || null;
}

export function readSfnt(bytes) {
 const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tables = new Map(), ranges = [];
 if (bytes.length < 12 || ![0x10000, 0x4f54544f, 0x74727565].includes(view.getUint32(0))) throw new Error('Unsupported font container');
 const count = view.getUint16(4);
 if (!count || count > 256 || 12 + count * 16 > bytes.length) throw new Error('Invalid font directory');
 for (let index = 0; index < count; index++) {
  const offset = 12 + index * 16, tag = String.fromCharCode(...bytes.subarray(offset, offset + 4)), start = view.getUint32(offset + 8), size = view.getUint32(offset + 12);
  if (tables.has(tag) || start < 12 + count * 16 || start + size > bytes.length) throw new Error('Invalid font table');
  if (size && ranges.some(range => start < range.end && start + size > range.start)) throw new Error('Overlapping font tables');
  if (size) ranges.push({ start, end: start + size });
  tables.set(tag, bytes.slice(start, start + size));
 }
 const table = (tag, minimum) => {
  const value = tables.get(tag); if (!value || value.length < minimum) throw new Error(`Missing or truncated font ${tag} table`);
  return new DataView(value.buffer, value.byteOffset, value.byteLength);
 };
 const head = table('head', 54), maxp = table('maxp', 6), hhea = table('hhea', 36), units = head.getUint16(18), glyphs = maxp.getUint16(4), metrics = hhea.getUint16(34);
 if (head.getUint32(0) !== 0x10000 || head.getUint32(12) !== 0x5f0f3cf5 || units < 16 || units > 16384 || !glyphs || !metrics || metrics > glyphs || ![0, 1].includes(head.getInt16(50))) throw new Error('Invalid font metrics');
 table('hmtx', metrics * 4 + (glyphs - metrics) * 2); table('cmap', 4); table('name', 6);
 if (tables.has('glyf')) table('loca', (glyphs + 1) * (head.getInt16(50) === 0 ? 2 : 4));
 else if (!tables.has('CFF ') && !tables.has('CFF2')) throw new Error('Missing font outlines');
 return { tables, units, glyphs, metrics, ascent: hhea.getInt16(4), descent: hhea.getInt16(6), leading: hhea.getInt16(8) };
}
