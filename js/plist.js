// Minimal XML reader plus Apple property list decoding (XML and binary "bplist00").
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = s => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) =>
 e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : entities[e] ?? m);

// Returns a tree of { name, attrs, children, text }.
export function parseXml(source) {
 const root = { name: '#root', attrs: {}, children: [], text: '' }, stack = [root];
 const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
 for (const m of source.matchAll(token)) {
  const top = stack.at(-1);
  if (m[1] !== undefined) top.text += m[1];
  else if (m[3]) {
   if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
   const attrs = {};
   for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescape(a[2] ?? a[3]);
   const el = { name: m[3], attrs, children: [], text: '' };
   top.children.push(el);
   if (!m[5]) stack.push(el);
  } else if (m[6]) top.text += unescape(m[6]);
 }
 return root;
}

export function parsePlist(bytes) {
 if (String.fromCharCode(...bytes.subarray(0, 8)) === 'bplist00') return parseBinary(bytes);
 const plist = parseXml(new TextDecoder().decode(bytes)).children.find(c => c.name === 'plist');
 return plist?.children[0] ? xmlValue(plist.children[0]) : null;
}

function xmlValue(el) {
 switch (el.name) {
  case 'dict': { const out = {}; for (let i = 0; i + 1 < el.children.length; i += 2) out[el.children[i].text] = xmlValue(el.children[i + 1]); return out; }
  case 'array': return el.children.map(xmlValue);
  case 'integer': case 'real': return Number(el.text);
  case 'true': return true;
  case 'false': return false;
  default: return el.text.trim();
 }
}

function parseBinary(bytes) {
 const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
 const t = bytes.length - 32;
 const offsetSize = bytes[t + 6], refSize = bytes[t + 7];
 const count = Number(view.getBigUint64(t + 8)), top = Number(view.getBigUint64(t + 16)), table = Number(view.getBigUint64(t + 24));
 const uint = (at, size) => { let v = 0; for (let i = 0; i < size; i++) v = v * 256 + bytes[at + i]; return v; };
 const offsets = Array.from({ length: count }, (_, i) => uint(table + i * offsetSize, offsetSize));
 const read = (ref, depth = 0) => {
  if (depth > 64) throw new Error('Property list nests too deeply.');
  const at = offsets[ref], marker = bytes[at], type = marker >> 4;
  let length = marker & 15, start = at + 1;
  if (length === 15 && [4, 5, 6, 10, 13].includes(type)) { const size = 1 << (bytes[at + 1] & 15); length = uint(at + 2, size); start = at + 2 + size; }
  switch (type) {
   case 0: return marker === 9 ? true : marker === 8 ? false : null;
   case 1: return uint(at + 1, 1 << length);
   case 2: return length === 3 ? view.getFloat64(at + 1) : view.getFloat32(at + 1);
   case 3: return new Date((view.getFloat64(at + 1) + 978307200) * 1000).toISOString();
   case 4: return bytes.subarray(start, start + length);
   case 5: return String.fromCharCode(...bytes.subarray(start, start + length));
   case 6: return new TextDecoder('utf-16be').decode(bytes.subarray(start, start + length * 2));
   case 10: return Array.from({ length }, (_, i) => read(uint(start + i * refSize, refSize), depth + 1));
   case 13: {
    const out = {};
    for (let i = 0; i < length; i++) out[read(uint(start + i * refSize, refSize), depth + 1)] = read(uint(start + (length + i) * refSize, refSize), depth + 1);
    return out;
   }
   default: return null;
  }
 };
 return read(top);
}
