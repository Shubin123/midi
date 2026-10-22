// Audio files DAWs exchange. WAV and AIFF are written and read here at their own sample rate and bit depth;
// MP3, FLAC, Ogg and M4A fall back to the browser's decoder.
export const FORMATS = {
 wav24: { label: 'WAV · 24-bit', ext: 'wav', bits: 24 },
 wav16: { label: 'WAV · 16-bit', ext: 'wav', bits: 16 },
 wav32f: { label: 'WAV · 32-bit float', ext: 'wav', bits: 32, float: true },
 aiff24: { label: 'AIFF · 24-bit', ext: 'aiff', bits: 24, aiff: true },
 aiff16: { label: 'AIFF · 16-bit', ext: 'aiff', bits: 16, aiff: true }
};
export const AUDIO_EXTENSIONS = /\.(wav|wave|aif|aiff|aifc|flac|mp3|ogg|oga|opus|m4a|aac|caf|webm)$/i;

export function encodeAudio(channels, sampleRate, format = 'wav24') {
 const f = FORMATS[format], count = channels.length, frames = channels[0].length, width = f.bits / 8;
 const dataBytes = frames * count * width, pad = dataBytes % 2;
 const header = f.aiff ? 54 : 44, buffer = new ArrayBuffer(header + dataBytes + pad), v = new DataView(buffer);
 const text = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
 const little = !f.aiff;
 if (f.aiff) {
  text(0, 'FORM'); v.setUint32(4, buffer.byteLength - 8); text(8, 'AIFF');
  text(12, 'COMM'); v.setUint32(16, 18); v.setUint16(20, count); v.setUint32(22, frames); v.setUint16(26, f.bits); writeExtended(v, 28, sampleRate);
  text(38, 'SSND'); v.setUint32(42, dataBytes + 8); v.setUint32(46, 0); v.setUint32(50, 0);
 } else {
  text(0, 'RIFF'); v.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, f.float ? 3 : 1, true); v.setUint16(22, count, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * count * width, true); v.setUint16(32, count * width, true); v.setUint16(34, f.bits, true);
  text(36, 'data'); v.setUint32(40, dataBytes, true);
 }
 const max = 2 ** (f.bits - 1) - 1;
 // 16-bit gets triangular dither so quiet tails fade instead of turning into distortion.
 const dither = f.bits === 16 ? () => (Math.random() - Math.random()) : () => 0;
 for (let i = 0, at = header; i < frames; i++) for (let c = 0; c < count; c++, at += width) {
  const x = channels[c][i];
  if (f.float) { v.setFloat32(at, x, true); continue; }
  const n = Math.max(-max - 1, Math.min(max, Math.round(x * max + dither())));
  if (width === 2) v.setInt16(at, n, little);
  else if (little) { v.setUint8(at, n & 255); v.setUint8(at + 1, (n >> 8) & 255); v.setInt8(at + 2, n >> 16); }
  else { v.setInt8(at, n >> 16); v.setUint8(at + 1, (n >> 8) & 255); v.setUint8(at + 2, n & 255); }
 }
 return new Blob([buffer], { type: f.aiff ? 'audio/aiff' : 'audio/wav' });
}

// AIFF stores its sample rate as an 80-bit IEEE extended float.
function writeExtended(v, at, value) {
 const exp = Math.floor(Math.log2(value));
 v.setUint16(at, exp + 16383);
 v.setUint32(at + 2, Math.floor(value * 2 ** (31 - exp)));
 v.setUint32(at + 6, Math.floor((value * 2 ** (31 - exp) % 1) * 2 ** 32));
}
const readExtended = (v, at) => {
 const e = v.getUint16(at) & 0x7fff, hi = v.getUint32(at + 2), lo = v.getUint32(at + 6);
 return e === 0 && hi === 0 && lo === 0 ? 0 : (hi * 2 ** 32 + lo) * 2 ** (e - 16383 - 63);
};

// Returns { channels: Float32Array[], sampleRate }.
export async function decodeAudioFile(bytes, ctx) {
 const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tag = at => String.fromCharCode(...bytes.subarray(at, at + 4));
 if (bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE') { const r = readWav(v, tag); if (r) return r; }
 if (bytes.length >= 12 && tag(0) === 'FORM' && /^AIF[FC]$/.test(tag(8))) return readAiff(v, tag, tag(8) === 'AIFC');
 const decoded = await ctx.decodeAudioData(bytes.slice().buffer);
 return { channels: Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i)), sampleRate: decoded.sampleRate };
}

function chunks(v, tag, start, little) {
 const out = {};
 for (let at = start; at + 8 <= v.byteLength;) {
  const size = v.getUint32(at + 4, little);
  out[tag(at)] ??= { at: at + 8, size: Math.min(size, v.byteLength - at - 8) };
  at += 8 + size + (size % 2);
 }
 return out;
}

// Returns null for compressed WAV codecs so the browser can try them.
function readWav(v, tag) {
 const c = chunks(v, tag, 12, true);
 if (!c['fmt '] || !c.data) throw new Error('This WAV file has no fmt or data chunk.');
 const f = c['fmt '].at;
 let code = v.getUint16(f, true);
 const count = v.getUint16(f + 2, true), sampleRate = v.getUint32(f + 4, true), bits = v.getUint16(f + 14, true);
 if (code === 0xfffe) code = v.getUint16(f + 24, true);
 if (code !== 1 && code !== 3) return null;
 return { channels: deinterleave(v, c.data.at, c.data.size, count, bits, code === 3, true), sampleRate };
}

function readAiff(v, tag, compressed) {
 const c = chunks(v, tag, 12, false);
 if (!c.COMM || !c.SSND) throw new Error('This AIFF file has no COMM or SSND chunk.');
 const m = c.COMM.at, count = v.getUint16(m), bits = v.getUint16(m + 6), sampleRate = readExtended(v, m + 8);
 const kind = compressed ? tag(m + 18) : 'NONE';
 const codecs = { NONE: [false, false], twos: [false, false], sowt: [false, true], fl32: [true, false], FL32: [true, false], fl64: [true, false], FL64: [true, false] };
 if (!codecs[kind]) throw new Error(`AIFF-C compression “${kind.trim()}” is not supported. Export uncompressed AIFF or WAV.`);
 const [float, little] = codecs[kind], start = c.SSND.at + 8 + v.getUint32(c.SSND.at);
 return { channels: deinterleave(v, start, c.SSND.size - 8, count, bits, float, little), sampleRate: Math.round(sampleRate) };
}

function deinterleave(v, start, size, count, bits, float, little) {
 const width = Math.ceil(bits / 8), frames = Math.floor(size / (width * count));
 const channels = Array.from({ length: count }, () => new Float32Array(frames));
 // AIFF and WAV left-justify odd bit depths, so every integer width scales by its container size.
 const scale = 1 / 2 ** (width * 8 - 1);
 const read = float ? (width === 8 ? at => v.getFloat64(at, little) : at => v.getFloat32(at, little))
  : width === 1 ? (little ? at => (v.getUint8(at) - 128) / 128 : at => v.getInt8(at) / 128)
  : width === 2 ? at => v.getInt16(at, little) * scale
  : width === 3 ? (little ? at => ((v.getInt8(at + 2) << 16) | (v.getUint8(at + 1) << 8) | v.getUint8(at)) * scale : at => ((v.getInt8(at) << 16) | (v.getUint8(at + 1) << 8) | v.getUint8(at + 2)) * scale)
  : at => v.getInt32(at, little) * scale;
 for (let i = 0, at = start; i < frames; i++) for (let ch = 0; ch < count; ch++, at += width) channels[ch][i] = read(at);
 return channels;
}
