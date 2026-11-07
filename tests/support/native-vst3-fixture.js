export function leb(value) {
 let remaining = BigInt(value);
 const result = [];
 do { let byte = Number(remaining & 127n); remaining >>= 7n; if (remaining) byte |= 128; result.push(byte); } while (remaining);
 return result;
}

export function nativeFixture({ code = [0xb8, 42, 0, 0, 0, 0xc3], importName, importNames = [], dataImport = false, initializer = false, bundleEntry = false } = {}) {
 const bytes = new Uint8Array(0x1800), view = new DataView(bytes.buffer), encoder = new TextEncoder();
 const word = (offset, value) => view.setUint32(offset, value, true);
 const pointer = (offset, value) => view.setBigUint64(offset, BigInt(value), true);
 const name = (offset, value) => bytes.set(encoder.encode(value), offset);
 const relative = (address, prefix, target, suffix = []) => {
  bytes.set(prefix, address); view.setInt32(address + prefix.length, target - address - prefix.length - 4, true); bytes.set(suffix, address + prefix.length + 4);
 };
 word(0, 0xfeedfacf); word(4, 0x01000007); word(8, 3); word(12, 8); word(16, 4); word(20, 72 + 152 + 48 + 24);
 let command = 32;
 for (const [segmentName, address, size, fileSize, protection, sections] of [['__TEXT', 0, 0x1000, 0x1000, 5, 0], ['__DATA', 0x1000, 0x1000, 0x800, 3, 1]]) {
  word(command, 0x19); word(command + 4, sections ? 152 : 72); name(command + 8, segmentName);
  pointer(command + 24, address); pointer(command + 32, size); pointer(command + 40, address); pointer(command + 48, fileSize);
  word(command + 56, protection); word(command + 60, protection); word(command + 64, sections);
  if (sections) {
   name(command + 72, '__mod_init_func'); name(command + 88, '__DATA'); pointer(command + 104, 0x1700); pointer(command + 112, initializer ? 8 : 0); word(command + 120, 0x1700); word(command + 136, 9);
  }
  command += sections ? 152 : 72;
 }
 const rebase = [0x11, 0x21, 24, 0x53, 0x21, ...leb(0x100), 0x51, ...(initializer ? [0x21, ...leb(0x700), 0x51] : []), 0];
 bytes.set(rebase, 0x800);
 const imports = importName ? [importName, ...importNames] : importNames, bind = [];
 for (const [index, name] of imports.entries()) bind.push(0x3e, 0x40, ...encoder.encode(name), 0, 0x51, 0x71, ...leb(0x600 + index * 8), 0x90);
 if (imports.length) bind.push(0);
 const bindOffset = importNames.length ? 0xb00 : 0x880;
 bytes.set(bind, bindOffset);
 word(command, 0x80000022); word(command + 4, 48); word(command + 8, 0x800); word(command + 12, rebase.length); word(command + 16, bindOffset); word(command + 20, bind.length); command += 48;
 const symbols = [['_GetPluginFactory', 0x200], ['_probe', 0x300], ...(bundleEntry ? [['_bundleEntry', 0x380]] : [])];
 word(command, 2); word(command + 4, 24); word(command + 8, 0x900); word(command + 12, symbols.length); word(command + 16, 0xa00);
 let stringOffset = 1;
 symbols.forEach(([symbol, address], index) => {
  const offset = 0x900 + index * 16;
  word(offset, stringOffset); bytes[offset + 4] = 0xf; bytes[offset + 5] = 1; pointer(offset + 8, address);
  name(0xa00 + stringOffset, symbol); stringOffset += encoder.encode(symbol).length + 1;
 });
 word(command + 20, stringOffset);
 relative(0x200, [0x48, 0x8d, 0x05], 0x1100, [0xc3]);
 bytes.set([0x48, 0x89, 0xf7], 0x240);
 relative(0x243, [0x48, 0x8d, 0x35], 0x1200, [0xb9, 0xc4, 1, 0, 0, 0xf3, 0xa4, 0x31, 0xc0, 0xc3]);
 bytes.set([0xb8, 1, 0, 0, 0, 0xc3], 0x260);
 bytes.set([0x48, 0x89, 0xd7], 0x270);
 relative(0x273, [0x48, 0x8d, 0x35], 0x1400, [0xb9, 116, 0, 0, 0, 0xf3, 0xa4, 0x31, 0xc0, 0xc3]);
 pointer(0x1018, 0x240); pointer(0x1020, 0x260); pointer(0x1028, 0x270); pointer(0x1100, 0x1000);
 name(0x1200, 'Fixture vendor'); name(0x1240, 'fixture.invalid'); name(0x1340, 'fixture@example.invalid');
 bytes.set(Array.from({ length: 16 }, (_, index) => index + 1), 0x1400); name(0x1414, 'Audio Module Class'); name(0x1434, 'Native fixture');
 bytes.set(code, 0x300);
 if (importName) {
  if (dataImport) relative(0x300, [0x48, 0x8b, 0x05], 0x1600, [0x48, 0x8b, 0, 0xc3]);
  else { bytes.set([0xbf, 8, 0, 0, 0], 0x300); relative(0x305, [0xff, 0x25], 0x1600); }
 }
 if (initializer) { pointer(0x1700, 0x380); bytes.set(code, 0x380); }
 return bytes;
}

export function nativeSelectorFixture() {
 const bytes = nativeFixture({ initializer: true }), view = new DataView(bytes.buffer), encoder = new TextEncoder();
 bytes.fill(0, 176, 192); bytes.set(encoder.encode('__objc_selrefs'), 176); view.setUint32(240, 0, true);
 view.setBigUint64(0x1700, 0x1500n, true); bytes.set(encoder.encode('value:\0'), 0x1500);
 return bytes;
}

export function nativeObjCFixture() {
 const importNames = ['_objc_getClass', '_objc_allocateClassPair', '_class_addMethod', '_objc_registerClassPair', '_class_createInstance', '_sel_registerName', '_objc_msgSend'];
 const bytes = nativeFixture({ importNames, initializer: true }), view = new DataView(bytes.buffer), encoder = new TextEncoder();
 let offset = 0x380;
 const emit = values => { bytes.set(values, offset); offset += values.length; };
 const relative = (prefix, address) => { emit(prefix); view.setInt32(offset, address - offset - 4, true); offset += 4; };
 const call = index => relative([0xff, 0x15], 0x1600 + index * 8);
 emit([0x41, 0x54, 0x41, 0x55, 0x41, 0x56]);
 relative([0x48, 0x8d, 0x3d], 0x1500); call(0);
 emit([0x48, 0x89, 0xc7]); relative([0x48, 0x8d, 0x35], 0x1520); emit([0x31, 0xd2]); call(1); emit([0x49, 0x89, 0xc4]);
 relative([0x48, 0x8d, 0x3d], 0x1540); call(5); emit([0x49, 0x89, 0xc5]);
 emit([0x4c, 0x89, 0xe7, 0x4c, 0x89, 0xee]); relative([0x48, 0x8d, 0x15], 0x600); relative([0x48, 0x8d, 0x0d], 0x1560); call(2);
 emit([0x4c, 0x89, 0xe7]); call(3);
 emit([0x4c, 0x89, 0xe7, 0x31, 0xf6]); call(4); emit([0x49, 0x89, 0xc6]);
 emit([0x4c, 0x89, 0xf7, 0x4c, 0x89, 0xee, 0xba, 37, 0, 0, 0]); call(6);
 relative([0x89, 0x05], 0x1400); emit([0x41, 0x5e, 0x41, 0x5d, 0x41, 0x5c, 0xc3]);
 bytes.set([0x48, 0x8d, 0x42, 5, 0xc3], 0x600);
 for (const [address, value] of [[0x1500, 'NSObject'], [0x1520, 'BrowserNativeFixture'], [0x1540, 'increment:'], [0x1560, 'Q@:Q']]) bytes.set(encoder.encode(`${value}\0`), address);
 return bytes;
}

export function nativeLimitFixture() {
 const bytes = nativeFixture({ importName: '_getrlimit', initializer: true });
 const view = new DataView(bytes.buffer);
 bytes.set([0x48, 0x83, 0xec, 8, 0xbf, 8, 0, 0, 0, 0x48, 0x8d, 0x35], 0x380);
 view.setInt32(0x38c, 0x1400 - 0x390, true);
 bytes.set([0xff, 0x15], 0x390); view.setInt32(0x392, 0x1600 - 0x396, true);
 bytes.set([0x48, 0x83, 0xc4, 8, 0xc3], 0x396);
 return bytes;
}

export function nativeMutexFixture() {
 const bytes = nativeFixture({ importName: '_pthread_mutex_lock', initializer: true });
 const view = new DataView(bytes.buffer);
 bytes.set([0x48, 0x83, 0xec, 8, 0x48, 0x8d, 0x3d], 0x380);
 view.setInt32(0x387, 0x1500 - 0x38b, true);
 bytes.set([0xff, 0x15], 0x38b); view.setInt32(0x38d, 0x1600 - 0x391, true);
 bytes.set([0x48, 0x83, 0xc4, 8, 0xc3], 0x391);
 view.setBigUint64(0x1500, 0x32aaaba7n, true);
 return bytes;
}

export function nativeScanFixture() {
 const bytes = nativeFixture({ importName: '_sscanf', initializer: true });
 const view = new DataView(bytes.buffer), encoder = new TextEncoder();
 let offset = 0x380;
 const relative = (prefix, target) => {
  bytes.set(prefix, offset); offset += prefix.length;
  view.setInt32(offset, target - offset - 4, true); offset += 4;
 };
 bytes.set([0x48, 0x83, 0xec, 8], offset); offset += 4;
 relative([0x48, 0x8d, 0x3d], 0x1500);
 relative([0x48, 0x8d, 0x35], 0x1540);
 relative([0x48, 0x8d, 0x15], 0x1400);
 relative([0xff, 0x15], 0x1600);
 bytes.set([0x48, 0x83, 0xc4, 8, 0xc3], offset);
 bytes.set(encoder.encode('12345678\0'), 0x1500);
 bytes.set(encoder.encode('%08X\0'), 0x1540);
 return bytes;
}

export async function nativePackage(binary, { modern = false, truncated = false } = {}) {
 const encoder = new TextEncoder();
 const entry = (path, content, mode = 0o100644) => {
  const name = encoder.encode(`${path}\0`);
  if (modern) {
   const fields = [0, mode, 0, 0, 1, 0, content.length, 0, 0, 0, 0, name.length, 0].map(value => value.toString(16).padStart(8, '0')).join('');
   const header = encoder.encode(`070701${fields}`), namePadding = -(header.length + name.length) & 3, dataPadding = -content.length & 3;
   return [header, name, new Uint8Array(namePadding), content, new Uint8Array(dataPadding)];
  }
  const fields = [0, 0, mode, 0, 0, 1, 0].map(value => value.toString(8).padStart(6, '0')).join('');
  const header = encoder.encode(`070707${fields}${'0'.repeat(11)}${name.length.toString(8).padStart(6, '0')}${content.length.toString(8).padStart(11, '0')}`);
  return [header, name, content];
 };
 const entries = [...entry('Samples/skip', new Uint8Array(300000).fill(23)), ...entry('Test.vst3/Contents/MacOS/Test', binary), ...entry('TRAILER!!!', new Uint8Array(0), 0)];
 const raw = await new Blob(entries).arrayBuffer();
 const payload = new Uint8Array(await new Response(new Blob([truncated ? raw.slice(0, raw.byteLength - binary.length - 100) : raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
 const toc = encoder.encode(`<xar><toc><file><name>Test-VST3.pkg</name><file><name>Payload</name><data><offset>0</offset><length>${payload.length}</length></data></file></file></toc></xar>`);
 const packed = new Uint8Array(await new Response(new Blob([toc]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
 const header = new Uint8Array(28), view = new DataView(header.buffer);
 header.set(encoder.encode('xar!')); view.setUint16(4, 28); view.setUint16(6, 1); view.setBigUint64(8, BigInt(packed.length)); view.setBigUint64(16, BigInt(toc.length));
 return new Blob([header, packed, payload]);
}
