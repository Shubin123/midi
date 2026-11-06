// Controller presets (js/controllers/schema.json) as the runtime reads them: which preset fits a port, what a
// message from the device means in the program it is in, a variation with what it extends filled in, and SysEx
// built from a preset's templates. Pure: no Web MIDI and no page, so every preset's captures are decoded in
// tests/controllers.mjs exactly as they are here.
import { bytesOf, decode, relativeDelta } from './messages.js';

/* ---- SysEx templates ---- */

// A template is a list of bytes ("F0", 0x7F, 127) and placeholders: {name} (a value, 0 to 127), {text:name}
// or {text:name:16} (ASCII, cut to a length), {bytes:name} (a list of values). Returns the parts, or throws with
// what is wrong.
export function readTemplate(template) {
 return template.map((t, i) => {
  if (Number.isInteger(t)) { if (t < 0 || t > 255) throw new Error(`byte ${i} (${t}) isn't a byte`); return { byte: t }; }
  const s = String(t).trim(), m = /^\{(?:(text|bytes):)?([a-zA-Z][\w]*)(?::(\d+))?\}$/.exec(s);
  if (m) return { kind: m[1] || 'value', name: m[2], length: m[3] ? Number(m[3]) : null };
  if (/^[0-9a-fA-F]{1,2}$/.test(s)) return { byte: parseInt(s, 16) };
  throw new Error(`"${s}" (byte ${i}) is neither a hex byte nor a {placeholder}`);
 });
}
// ASCII the device can show: anything else becomes "?", and SysEx data bytes stay under 128.
export const ascii = s => [...String(s ?? '')].map(ch => { const c = ch.charCodeAt(0); return c >= 32 && c < 127 ? c : ch === '♯' ? 35 : ch === '♭' ? 98 : ch === '·' || ch === '›' ? 32 : 63; });
export function fill(template, vars = {}) {
 const out = [];
 for (const p of readTemplate(template)) {
  if (p.byte !== undefined) { out.push(p.byte); continue; }
  const v = vars[p.name];
  if (p.kind === 'text') out.push(...ascii(v).slice(0, p.length ?? Infinity));
  else if (p.kind === 'bytes') out.push(...(v || []).map(b => b & 0x7F));
  else out.push(Math.max(0, Math.min(127, Math.round(Number(v) || 0))));
 }
 return out;
}

// The values of a message's placeholders if it fits the template (its {name}s one byte each), else null.
export function matchTemplate(template, data) {
 const parts = readTemplate(template), d = [...data];
 if (parts.length !== d.length) return null;
 const vars = {};
 for (let i = 0; i < parts.length; i++) {
  if (parts[i].byte !== undefined) { if (parts[i].byte !== d[i]) return null; }
  else if (parts[i].kind === 'value') vars[parts[i].name] = d[i];
  else return null;
 }
 return vars;
}
// What the device says about itself in a SysEx message ({ program } or { bank }), from the preset's listen list.
export function heard(preset, data) {
 for (const a of preset.listen || []) {
  const v = matchTemplate(a.message, data);
  if (!v) continue;
  const value = a.values?.[String(v.value)] ?? a.otherwise ?? null;
  if (value !== null) return { [a.means]: value, raw: v.value };
 }
 return null;
}

/* ---- Variations ---- */

// A variation with the one it extends under it: mappings merged (its own win), pages its own if it has any.
export function variation(preset, id) {
 const list = preset.variations, v = list.find(x => x.id === id) || list.find(x => x.default) || list[0];
 const base = v.extends && v.extends !== v.id ? variation(preset, v.extends) : null;
 return { ...base, ...v, pages: v.pages || base?.pages || [], mappings: { ...base?.mappings, ...v.mappings }, programs: v.programs || base?.programs || null, drums: v.drums || base?.drums || 'kit' };
}
export const defaultProgram = preset => preset.programs.find(g => g.default) || preset.programs[0];
// The variations for a program, the default one first.
export function variationsFor(preset, programId) {
 const all = preset.variations.map(v => variation(preset, v.id)).filter(v => !v.programs || v.programs.includes(programId));
 return all.sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0));
}

/* ---- Which preset fits a device ---- */

const sameBytes = (want, have) => !want || bytesOf(want).every((b, i) => have?.[i] === b);
// How well a preset fits a port: 3 its identity reply matches, 2 its name, 0.5 a generic preset, 0 not at all.
// `role` says which of the device's ports it is (main, or its DAW port).
export function fit(preset, { name = '', identity = null } = {}) {
 const id = preset.detect?.identity;
 if (identity && id && sameBytes(id.manufacturer, identity.manufacturer) && sameBytes(id.family, identity.family) && sameBytes(id.member, identity.member)) return { score: 3, role: roleOf(preset, name) || 'main', by: 'identity' };
 const role = roleOf(preset, name);
 if (role) return { score: 2, role, by: 'name' };
 return preset.generic ? { score: 0.5, role: 'main', by: 'generic' } : { score: 0, role: null, by: null };
}
const roleOf = (preset, name) => { const p = (preset.detect?.ports || []).find(x => new RegExp(x.name, 'i').test(name)); return p ? p.role || 'main' : null; };
// The presets for a device, best first.
export const rank = (presets, port) => presets.map(p => ({ preset: p, ...fit(p, port) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

/* ---- What a message means ---- */

const keyOf = (type, channel, number = '') => `${type}:${channel === 'any' || channel === undefined ? '*' : channel}:${number}`;
// A program's messages, indexed for decoding: Map of key → { control, message }, and ranges of keys.
export function indexProgram(program, learned = {}) {
 const index = new Map(), ranges = [];
 const messages = { ...program.messages, ...learned };
 for (const [control, m] of Object.entries(messages)) {
  if (m.learn) continue;
  const entry = { control, message: m };
  if (m.cc !== undefined) index.set(keyOf('cc', m.channel, m.cc), entry);
  else if (m.note !== undefined) { index.set(keyOf('note', m.channel, m.note), entry); if (m.pressure) index.set(keyOf('poly', m.channel, m.note), entry); }
  else if (m.notes) ranges.push({ ...entry, lo: m.notes[0], hi: m.notes[1] });
  else if (m.bend) index.set(keyOf('bend', m.channel), entry);
  else if (m.pressure) index.set(keyOf('pressure', m.channel), entry);
 }
 return { index, ranges, program };
}
const lookup = (ix, type, channel, number = '') => ix.index.get(keyOf(type, channel, number)) || ix.index.get(keyOf(type, 'any', number));
const inRange = (ix, m) => ix.ranges.find(r => m.note >= r.lo && m.note <= r.hi && (r.message.channel === undefined || r.message.channel === 'any' || r.message.channel === m.channel));

// The event a message is for one of the program's controls, or null:
//  value (an absolute knob or fader, 0 to 1), turn (a relative encoder: delta steps), press / release (a pad
//  or button: velocity 0 to 1), note (keys: note, velocity, on), pressure (0 to 1, with the note for poly),
//  bend (-1 to 1).
export function decodeFor(ix, data) {
 const m = data.type ? data : decode(data);
 if (m.type === 'cc') {
  const e = lookup(ix, 'cc', m.channel, m.number);
  if (!e) return null;
  const enc = e.message.encoding || 'absolute', base = { control: e.control, channel: m.channel, raw: m.value };
  if (enc === 'absolute') return { ...base, kind: 'value', value: m.value / 127 };
  if (enc === 'button') return { ...base, kind: m.value >= 64 ? 'press' : 'release', velocity: m.value / 127 };
  if (enc === 'toggle') return { ...base, kind: 'toggle', on: m.value >= 64 };
  const delta = relativeDelta(enc, m.value);
  return delta ? { ...base, kind: 'turn', delta } : null;
 }
 if (m.type === 'noteon' || m.type === 'noteoff') {
  const e = lookup(ix, 'note', m.channel, m.note);
  if (e) return { control: e.control, channel: m.channel, kind: m.type === 'noteon' ? 'press' : 'release', velocity: m.velocity / 127, note: m.note };
  const r = inRange(ix, m);
  if (r) return { control: r.control, channel: m.channel, kind: 'note', note: m.note, velocity: m.velocity / 127, on: m.type === 'noteon' };
  return null;
 }
 if (m.type === 'polypressure') {
  const e = lookup(ix, 'poly', m.channel, m.note);
  if (e) return { control: e.control, channel: m.channel, kind: 'pressure', value: m.value / 127, note: m.note };
  const r = inRange(ix, m);
  return r ? { control: r.control, channel: m.channel, kind: 'pressure', value: m.value / 127, note: m.note } : null;
 }
 if (m.type === 'bend') {
  const e = lookup(ix, 'bend', m.channel);
  if (!e) return null;
  return e.message.encoding === 'absolute' ? { control: e.control, channel: m.channel, kind: 'value', value: m.value / 16383 } : { control: e.control, channel: m.channel, kind: 'bend', value: (m.value - 8192) / 8192 };
 }
 if (m.type === 'pressure') {
  const e = lookup(ix, 'pressure', m.channel);
  return e ? { control: e.control, channel: m.channel, kind: 'pressure', value: m.value / 127 } : null;
 }
 return null;
}

// The programs a message could have come from, by their ids: what the device is set to, read from what it sends.
// A message every program sends alike (the keys) says nothing and returns them all.
export function programsSending(preset, data, learned = {}) {
 return preset.programs.filter(g => !g.template && decodeFor(indexProgram(g, learned[g.id]), data)).map(g => g.id);
}

// The message a control sends in a program, as MIDI learn writes it: from a decoded message.
export function learnedMessage(m, { relative = null } = {}) {
 if (m.type === 'cc') return { cc: m.number, channel: m.channel, encoding: relative || 'absolute' };
 if (m.type === 'noteon' || m.type === 'noteoff') return { note: m.note, channel: m.channel };
 if (m.type === 'bend') return { bend: true, channel: m.channel };
 if (m.type === 'pressure') return { pressure: true, channel: m.channel };
 return null;
}
// Guesses whether a CC that just moved is a relative encoder from its first few values: they stay by 64 (binary
// offset), or by 0 and 127 (two's complement or signed bit), and repeat as it turns (65, 65, 66), where a knob's
// run one way a step at a time (60, 61, 62).
export function guessEncoding(values) {
 if (values.length < 3) return 'absolute';
 const steps = values.slice(1).map((v, i) => v - values[i]);
 if ((steps.every(d => d > 0) || steps.every(d => d < 0)) && steps.every(d => Math.abs(d) <= 8)) return 'absolute';
 if (values.every(v => v >= 56 && v <= 72 && v !== 64)) return 'binary-offset';
 if (values.every(v => v <= 8 || v >= 120) && values.some(v => v >= 120)) return 'twos-complement';
 if (values.every(v => (v >= 1 && v <= 8) || (v >= 65 && v <= 72))) return 'signed-bit';
 return 'absolute';
}
