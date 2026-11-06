// What a controller shows: the colour of each pad from what its mapping does and what that is doing now (a loop
// slot empty, armed, recording or playing; a sequencer step on or off and the playhead; the metronome flashing on
// the beat; a drum pad lit as it is hit), lights a lesson or the teacher put on pads, flashes for how well each
// hit was timed, and the screen's lines: the knob just turned and its value, a teacher hint, or the variation,
// page, tempo and chord. Colours are 0 to 1 per channel; the device scales them to what its message takes.
import { timing } from '../timing-widget.js';

export const COLORS = {
 off: [0, 0, 0], dim: [0.05, 0.05, 0.05], white: [1, 1, 1],
 empty: [0.04, 0.04, 0.04], armed: [1, 0.45, 0], recording: [1, 0, 0], playing: [0, 1, 0], stopped: [0, 0.22, 0],
 stepOn: [0, 0.35, 1], stepOff: [0.02, 0.02, 0.06], playhead: [1, 1, 1], playheadOn: [0.6, 0.85, 1],
 metronome: [0, 0.5, 0.5], beat: [0, 1, 1], tap: [0.35, 0.1, 0.5], record: [0.3, 0, 0], panic: [0.25, 0, 0],
 drum: [1, 0.35, 0], drumHit: [1, 0.8, 0.3], transport: [0.15, 0.15, 0.15], page: [0.1, 0, 0.3], pageOn: [0.6, 0, 1],
 good: [0, 1, 0], ok: [1, 0.6, 0], late: [1, 0, 0], cue: [0, 0.6, 1],
};
export const GRADE_COLOR = { good: COLORS.good, ok: COLORS.ok, off: COLORS.late };
export const rgbKey = c => c.map(v => Math.round(v * 1000)).join(',');

const seq = () => window.workspaceApi?.sequencer;
const loops = () => window.synth?.loops() || [];
const armed = i => document.getElementById(`loop-slot-arm-${i}`)?.textContent === 'Record';

// The colour a pad mapped to `a` has now, before lights and flashes.
export function stateColor(dev, a, now = performance.now()) {
 if (!a) return COLORS.off;
 switch (a.do) {
  case 'loop': {
   const l = loops()[a.slot - 1];
   if (!l) return COLORS.off;
   if (l.recording) return now % 500 < 250 ? COLORS.recording : [0.4, 0, 0];
   if (armed(a.slot - 1)) return COLORS.armed;
   if (l.playing) return COLORS.playing;
   return l.events.length || l.audio ? COLORS.stopped : COLORS.empty;
  }
  case 'step': {
   const s = seq();
   if (!s) return COLORS.off;
   const step = (a.index - 1 + dev.stepPage * 8) % 16, row = dev.seqRow(), on = !!s.pattern[row]?.[step];
   if (s.step === step) return on ? COLORS.playheadOn : COLORS.playhead;
   return on ? COLORS.stepOn : COLORS.stepOff;
  }
  case 'step-page': return dev.stepPage ? COLORS.pageOn : COLORS.page;
  case 'metronome': {
   if (!window.synth?.metronome) return COLORS.dim;
   const c = timing.clock;
   return c.running && (now - c.timeOf(Math.floor(c.beatAt(now)))) < 90 ? COLORS.beat : COLORS.metronome;
  }
  case 'tap': return COLORS.tap;
  case 'record': return loops().some(l => l.recording) || dev.recording ? COLORS.recording : COLORS.record;
  case 'panic': return COLORS.panic;
  case 'play': return seq()?.running ? COLORS.playing : COLORS.transport;
  case 'stop': return COLORS.transport;
  case 'loop-toggle': return loops().some(l => l.playing) ? COLORS.playing : COLORS.transport;
  case 'drum': case 'note': return COLORS.drum;
  case 'set-page': return dev.page?.id === a.page ? COLORS.pageOn : COLORS.page;
  case 'arp': return dev.hub.arp?.on ? COLORS.pageOn : COLORS.page;
  default: return COLORS.off;
 }
}

// The colour a pad shows: a short flash (a hit, its timing) over a lesson's light over its state.
export function padColor(dev, id, now = performance.now()) {
 const f = dev.flashes.get(id);
 if (f && f.until > now) return f.rgb;
 const l = dev.lights.get(id);
 if (l && (!l.until || l.until > now)) return l.blink && now % 400 < 200 ? COLORS.off : l.rgb;
 return stateColor(dev, dev.mappingFor(id), now);
}

// The screen's lines: a moment's message (a knob turned, a pad pressed), else the teacher's hint, else the
// variation and page, and the tempo with the chord held.
export function screenLines(dev, now = performance.now()) {
 if (dev.transient && dev.transient.until > now) return [dev.transient.title, dev.transient.value];
 if (dev.note && (!dev.note.until || dev.note.until > now)) return dev.note.lines;
 const chord = dev.hub.chord?.() || '';
 return [`${dev.variation.name} ${dev.page ? `· ${dev.page.name}` : ''}`.trim(), `${window.synth?.tempo ?? 120} BPM${chord ? ` ${chord}` : ''}`];
}
