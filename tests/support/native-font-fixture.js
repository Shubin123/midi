export function nativeFontFixture() {
 const tables = new Map([['head', new Uint8Array(54)], ['maxp', new Uint8Array(32)], ['hhea', new Uint8Array(36)], ['hmtx', new Uint8Array(4)], ['cmap', new Uint8Array(274)], ['name', new Uint8Array(84)], ['glyf', new Uint8Array(10)], ['loca', new Uint8Array(4)]]);
 const table = name => new DataView(tables.get(name).buffer);
 table('head').setUint32(0, 0x10000); table('head').setUint32(12, 0x5f0f3cf5); table('head').setUint16(18, 1000);
 table('maxp').setUint32(0, 0x10000); table('maxp').setUint16(4, 1);
 table('hhea').setUint32(0, 0x10000); table('hhea').setInt16(4, 800); table('hhea').setInt16(6, -200); table('hhea').setUint16(34, 1);
 table('hmtx').setUint16(0, 500); table('loca').setUint16(2, 5);
 table('cmap').setUint16(2, 1); table('cmap').setUint16(4, 3); table('cmap').setUint16(6, 1); table('cmap').setUint32(8, 12); table('cmap').setUint16(14, 262);
 const names = table('name'); names.setUint16(2, 3); names.setUint16(4, 42);
 for (const [index, value] of ['Fixture', 'Regular', 'Fixture'].entries()) {
  const offset = 6 + index * 12; names.setUint16(offset, 3); names.setUint16(offset + 2, 1); names.setUint16(offset + 4, 0x409); names.setUint16(offset + 6, [1, 2, 6][index]); names.setUint16(offset + 8, 14); names.setUint16(offset + 10, index * 14);
  for (let character = 0; character < 7; character++) names.setUint16(42 + index * 14 + character * 2, value.charCodeAt(character));
 }
 const header = 12 + tables.size * 16, bytes = new Uint8Array(header + [...tables.values()].reduce((sum, bytes) => sum + Math.ceil(bytes.length / 4) * 4, 0)), view = new DataView(bytes.buffer);
 view.setUint32(0, 0x10000); view.setUint16(4, tables.size);
 let index = 0, offset = header;
 for (const [name, data] of tables) {
  const entry = 12 + index++ * 16; bytes.set(new TextEncoder().encode(name), entry); view.setUint32(entry + 8, offset); view.setUint32(entry + 12, data.length);
  bytes.set(data, offset); offset += Math.ceil(data.length / 4) * 4;
 }
 return bytes;
}
