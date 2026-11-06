// Standard MIDI Files (.mid). Times are in beats (quarter notes); note numbers use this synth's numbering, where 60 is middle C.
const PPQ = 480;

// song: { name, bpm, tempos?: [{ beat, bpm }], tracks: [{ name, notes: [{ midi, velocity (0-1), start, end }] }] }
export function writeMidi(song) {
 const tick = beat => Math.max(0, Math.round(beat * PPQ));
 const conductor = [
  { at: 0, bytes: meta(3, text(song.name || 'Untitled')) },
  { at: 0, bytes: meta(0x58, [4, 2, 24, 8]) },
  ...(song.tempos?.length ? song.tempos : [{ beat: 0, bpm: song.bpm }]).map(t => {
   const us = Math.round(60e6 / t.bpm);
   return { at: tick(t.beat), bytes: meta(0x51, [us >> 16, (us >> 8) & 255, us & 255]) };
  })
 ];
 const tracks = [conductor, ...song.tracks.map((t, i) => {
  const ch = i % 16;
  return [{ at: 0, bytes: meta(3, text(t.name || `Track ${i + 1}`)) },
   ...t.notes.flatMap(n => {
    const key = Math.max(0, Math.min(127, n.midi)), vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
    const on = tick(n.start);
    return [{ at: on, bytes: [0x90 | ch, key, vel] }, { at: Math.max(on + 1, tick(n.end)), bytes: [0x80 | ch, key, 0], off: true }];
   })];
 })];
 const chunk = (id, body) => [...text(id), ...u32(body.length), ...body];
 const out = chunk('MThd', [0, 1, ...u16(tracks.length), ...u16(PPQ)]);
 tracks.forEach(events => {
  // At the same tick, note-offs go first so repeated notes retrigger instead of being cut.
  events.sort((a, b) => a.at - b.at || (b.off ? 1 : 0) - (a.off ? 1 : 0));
  const body = []; let last = 0;
  events.forEach(e => { body.push(...varLen(e.at - last), ...e.bytes); last = e.at; });
  body.push(0, 0xff, 0x2f, 0);
  out.push(...chunk('MTrk', body));
 });
 return new Blob([new Uint8Array(out)], { type: 'audio/midi' });
}

// A song from notes heard in time (transcribed or sung: [{ midi, velocity, start, end }] in ms), at `bpm`, beat 0
// at `origin` ms (a beat at or before the first note, so the notes keep their place in the bar). Without an
// origin the first note is beat 0.
export function songFromNotes(notes, { name = 'Performance', bpm = 120, origin = null, track = 'Heard' } = {}) {
 const first = Math.min(...notes.map(n => n.start)), zero = origin ?? first, beat = 60000 / bpm;
 const at = ms => (ms - zero) / beat;
 return { name, bpm: Math.round(bpm * 10) / 10, tracks: [{ name: track, notes: notes.map(n => ({ midi: n.midi, velocity: n.velocity ?? 0.7, start: Math.max(0, at(n.start)), end: Math.max(at(n.start) + 1 / 64, at(n.end)) })) }] };
}

// Returns { name, bpm, barBeats, notes: [{ midi, velocity, start, end, startSec, endSec, track, channel }], endBeat, seconds(beat) }.
export function readMidi(bytes) {
 const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), tag = at => String.fromCharCode(...bytes.subarray(at, at + 4));
 if (bytes.length < 14 || tag(0) !== 'MThd') throw new Error('Not a Standard MIDI File (missing MThd header).');
 const trackCount = v.getUint16(10), division = v.getInt16(12);
 // SMPTE timing counts ticks per second; treat it as 120 BPM so a beat is half a second.
 const ppq = division > 0 ? division : (-(division >> 8)) * (division & 255) / 2;
 const tempos = [], open = new Map(), notes = [];
 let name = '', barBeats = 0, endTick = 0;
 for (let at = 8 + v.getUint32(4), track = 0; track < trackCount && at + 8 <= bytes.length; track++) {
  const end = Math.min(bytes.length, at + 8 + v.getUint32(at + 4));
  if (tag(at) !== 'MTrk') { at = end; track--; continue; }
  let p = at + 8, t = 0, status = 0;
  const vlq = () => { let n = 0, b; do { b = bytes[p++]; n = n * 128 + (b & 127); } while (b & 128 && p < end); return n; };
  while (p < end) {
   t += vlq();
   if (bytes[p] & 0x80) status = bytes[p++];
   const type = status & 0xf0, ch = status & 15;
   if (status === 0xff) {
    const kind = bytes[p++], len = vlq(), data = bytes.subarray(p, p + len); p += len;
    if (kind === 0x51 && len === 3) tempos.push({ tick: t, us: (data[0] << 16) | (data[1] << 8) | data[2] });
    else if (kind === 0x58 && len >= 2 && !barBeats) barBeats = data[0] * 4 / 2 ** data[1];
    else if (kind === 3 && !name) name = new TextDecoder().decode(data).trim();
    else if (kind === 0x2f) break;
   } else if (status === 0xf0 || status === 0xf7) { const len = vlq(); p += len; }
   else if (type === 0xc0 || type === 0xd0) p += 1;
   else if (type === 0x90 || type === 0x80) {
    const key = bytes[p++], vel = bytes[p++], id = `${track}:${ch}:${key}`;
    if (type === 0x90 && vel > 0) { if (!open.has(id)) open.set(id, []); open.get(id).push({ midi: key, velocity: vel / 127, tick: t, track, channel: ch }); }
    else { const n = open.get(id)?.shift(); if (n) notes.push({ ...n, endTick: t }); }
   } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) p += 2;
   else throw new Error(`Unreadable MIDI data in track ${track + 1}.`);
   endTick = Math.max(endTick, t);
  }
  open.forEach(list => list.forEach(n => notes.push({ ...n, endTick: endTick }))); open.clear();
  at = end;
 }
 tempos.sort((a, b) => a.tick - b.tick);
 const map = []; let sec = 0, prevTick = 0, us = 500000;
 tempos.forEach(tp => { sec += (tp.tick - prevTick) / ppq * us / 1e6; prevTick = tp.tick; us = tp.us; map.push({ tick: tp.tick, sec, us }); });
 const seconds = beat => {
  const tk = beat * ppq; let s = 0, from = 0, rate = 500000;
  for (const m of map) { if (m.tick > tk) break; s = m.sec; from = m.tick; rate = m.us; }
  return s + (tk - from) / ppq * rate / 1e6;
 };
 return {
  name, barBeats: barBeats || 4, bpm: 60e6 / (tempos[0]?.us || 500000), endBeat: endTick / ppq, seconds,
  notes: notes.map(n => ({ midi: n.midi, velocity: n.velocity, track: n.track, channel: n.channel, start: n.tick / ppq, end: n.endTick / ppq, startSec: seconds(n.tick / ppq), endSec: seconds(n.endTick / ppq) }))
   .sort((a, b) => a.start - b.start || a.midi - b.midi)
 };
}

const text = s => [...new TextEncoder().encode(s)];
const u16 = n => [(n >> 8) & 255, n & 255];
const u32 = n => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const meta = (kind, data) => [0xff, kind, ...varLen(data.length), ...data];
function varLen(n) {
 const out = [n & 127];
 while ((n = Math.floor(n / 128)) > 0) out.unshift((n & 127) | 128);
 return out;
}
