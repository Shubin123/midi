// MIDI messages in words, both ways: decode() reads the bytes a port delivers, and the encoders here build the
// few a controller is sent (clock, identity request, a note or CC for an LED). Pure, so the presets' captures are
// tested without a browser (tests/controllers.mjs).

export const CLOCK = { 0xF8: 'tick', 0xFA: 'start', 0xFB: 'continue', 0xFC: 'stop' };
// Universal SysEx: "who are you?" to every device on the port (device ID 7F).
export const IDENTITY_REQUEST = [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7];

const hex = bytes => [...bytes].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
export { hex };
// "F0 00 20 6B" or [240, 0, 32, 107] → bytes.
export const bytesOf = x => (Array.isArray(x) ? x : String(x).trim().split(/[\s,]+/).filter(Boolean).map(h => parseInt(h, 16)));

// { type, channel (1-16), ... }: noteon (note, velocity), noteoff (note, velocity), cc (number, value), bend
// (value 0-16383, 8192 at rest), pressure (value), polypressure (note, value), program (number), sysex (data),
// clock (what: tick, start, continue, stop), or other. A note-on of velocity 0 is a note-off.
export function decode(data) {
 const d = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
 const s = d[0], kind = s & 0xF0, channel = (s & 0x0F) + 1;
 if (s === 0xF0) return { type: 'sysex', data: d };
 if (s >= 0xF8) return CLOCK[s] ? { type: 'clock', what: CLOCK[s] } : { type: 'other' };
 if (kind === 0x90) return d[2] > 0 ? { type: 'noteon', channel, note: d[1], velocity: d[2] } : { type: 'noteoff', channel, note: d[1], velocity: 0 };
 if (kind === 0x80) return { type: 'noteoff', channel, note: d[1], velocity: d[2] ?? 0 };
 if (kind === 0xB0) return { type: 'cc', channel, number: d[1], value: d[2] };
 if (kind === 0xE0) return { type: 'bend', channel, value: d[1] | (d[2] << 7) };
 if (kind === 0xD0) return { type: 'pressure', channel, value: d[1] };
 if (kind === 0xA0) return { type: 'polypressure', channel, note: d[1], value: d[2] };
 if (kind === 0xC0) return { type: 'program', channel, number: d[1] };
 return { type: 'other' };
}

export const noteOn = (channel, note, velocity) => [0x90 | (channel - 1), note & 0x7F, velocity & 0x7F];
export const noteOff = (channel, note) => [0x80 | (channel - 1), note & 0x7F, 0];
export const cc = (channel, number, value) => [0xB0 | (channel - 1), number & 0x7F, value & 0x7F];

// Universal SysEx Identity Reply: F0 7E <device> 06 02 <manufacturer, 1 byte or 00 and 2 more> <family, 2>
// <member, 2> <software revision, 4> F7. Returns null for anything else.
export function parseIdentity(data) {
 const d = [...data];
 if (d[0] !== 0xF0 || d[1] !== 0x7E || d[3] !== 0x06 || d[4] !== 0x02 || d.at(-1) !== 0xF7) return null;
 const manufacturer = d[5] === 0 ? d.slice(5, 8) : d.slice(5, 6), i = 5 + manufacturer.length;
 if (d.length < i + 9) return null;
 return { device: d[2], manufacturer, family: d.slice(i, i + 2), member: d.slice(i + 2, i + 4), version: d.slice(i + 4, i + 8), firmware: d.slice(i + 4, i + 8).join('.') };
}

// How an encoder says it moved. Absolute: its value, 0 to 127. The relative codes (which way and how far, per
// message), as MIDI Control Center and Mackie Control name them:
//  binary-offset: 64 is no move, 65 one step up, 63 one step down.
//  twos-complement: 1 to 63 up, 127 (-1) to 65 down.
//  signed-bit: bit 6 is the direction (set is down), bits 0-5 how far (Mackie Control's V-pots and jog wheel).
export const RELATIVE = {
 'binary-offset': v => v - 64,
 'twos-complement': v => (v < 64 ? v : v - 128),
 'signed-bit': v => (v & 0x40 ? -(v & 0x3F) : v & 0x3F),
};
export const relativeDelta = (encoding, v) => (RELATIVE[encoding] ? RELATIVE[encoding](v) : 0);
