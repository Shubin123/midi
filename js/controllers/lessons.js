// A course unit for a MIDI controller (js/teacher-bridge.js runs it with the rest of the course). Lessons are
// written against roles ("{pad 1}", "{knob 5}"), which become the connected controller's own names when they
// are shown or said ("Pad 1", "Knob 5 (Cutoff)", or "Select 1" on a Mackie Control), so they work with any
// preset that has those roles. Each can set the controller up (setup: the practice variation, pads lit to show
// what to play) and is checked from what the controller and the app did since it started (check(attempt,
// state) with state = { device, since, hits, value(id), loops }), every 700 ms like a workspace lesson.
import { controllers, describe } from './runtime.js';
import { COLORS } from './feedback.js';

export const CONTROLLER_UNIT = 'Your controller';
const dev = () => controllers.active[0] || null;
// "{knob 5}" → "Knob 5 (Cutoff)", from the device in use; without one, the role itself.
export function words(text, d = dev()) {
 return text.replace(/\{([a-z ]+\d*)\}/g, (_, role) => {
  const c = d?.controls.find(x => x.role === role);
  if (!c) return role.replace(/^./, ch => ch.toUpperCase());
  const a = d.variation.mappings[c.id], p = a?.do === 'page' ? d.slotParam(a.slot) : null;
  return `${c.label}${p ? ` (${p.name})` : a && a.do !== 'notes' ? ` (${describe(d, a)})` : ''}`;
 });
}
const idOf = (d, role) => d?.controls.find(x => x.role === role)?.id;
// The pad hits since the lesson started, each with its grade once the beat clock has graded it.
const hitsOf = s => s.hits.filter(h => h.time >= s.since && h.device === s.device);
const moved = (s, role) => s.device?.log.some(e => e.time >= s.since && e.control === idOf(s.device, role) && /^(value|turn)$/.test(e.kind));
const lesson = l => ({ unit: CONTROLLER_UNIT, controller: true, get text() { return words(l.say); }, get task() { return words(l.todo); }, get hint() { return words(l.tip); }, ...l });

export const CONTROLLER_LESSONS = [
 lesson({
  id: 'ctl_brighten', title: 'Knob 5 brightens the sound',
  say: 'Your controller plays the whole workspace: the keys play, the knobs move the page shown on its screen, and the pads run the loops and the sequencer. On the Synth page {knob 5} is the filter cutoff: the higher it is, the more of the bright harmonics get through.',
  todo: 'Hold a key and turn {knob 5} up until the cutoff is above 8000 Hz. (If nothing moves at first, keep turning: the knob picks the cutoff up when it reaches it.)',
  tip: 'Turn {knob 5} clockwise. On the controller\'s screen an arrow says which way to turn until it catches the cutoff.',
  setup: d => d.setPage('synth'),
  check: (p, s) => moved(s, 'knob 5') && s.value('filterCutoff') > 8000 && 'the filter opened with knob 5',
 }),
 lesson({
  id: 'ctl_shape', title: 'Shaping a sound with the knobs',
  say: 'Two knobs change a sound\'s character more than any others: the cutoff ({knob 5}) sets how bright it is, the attack ({knob 7}) how slowly it starts. A pad for strings is dark and slow; a pluck is bright and fast.',
  todo: 'Make a soft pad: turn {knob 5} down below 1500 Hz and {knob 7} up above 0.3 s, then play a chord to hear it.',
  tip: 'Down with {knob 5}, up with {knob 7}. Hold a chord while you turn to hear it change.',
  setup: d => d.setPage('synth'),
  check: (p, s) => moved(s, 'knob 5') && moved(s, 'knob 7') && s.value('filterCutoff') < 1500 && s.value('attack') > 0.3 && 'a dark, slow pad from two knobs',
 }),
 lesson({
  id: 'ctl_pad_beat', title: 'Pad drumming: kick and snare',
  say: 'A rock beat in its plainest form: the kick on beats 1 and 3, the snare on 2 and 4. On your controller {pad 1} is lit blue for the kick and {pad 2} amber for the snare; each hit flashes green when it is on the beat, amber when a little early or late, red when it is off.',
  todo: 'With the metronome, play {pad 1}, {pad 2}, {pad 1}, {pad 2}, one on each beat, eight hits in a row, most of them green.',
  tip: 'Count "one, two, three, four" with the click: {pad 1} on one and three, {pad 2} on two and four. Play with the click, not ahead of it.',
  setup: d => {
   if (d.variations().some(v => v.id === 'practice')) d.setVariation('practice');
   d.light([idOf(d, 'pad 1')].filter(Boolean), COLORS.cue); d.light([idOf(d, 'pad 2')].filter(Boolean), COLORS.ok);
   if (!window.synth.metronome) document.getElementById('metronomeToggle')?.click();
  },
  teardown: d => { d.light([idOf(d, 'pad 1'), idOf(d, 'pad 2')].filter(Boolean), null); },
  check: (p, s) => {
   const a = idOf(s.device, 'pad 1'), b = idOf(s.device, 'pad 2'), h = hitsOf(s).filter(x => x.control === a || x.control === b).slice(-8);
   if (h.length < 8 || !h.every((x, i) => i === 0 || x.control !== h[i - 1].control)) return false;
   const good = h.filter(x => x.grade === 'good' || x.grade === 'ok').length;
   return good >= 6 && `kick and snare in turn, ${good} of 8 on the beat`;
  },
 }),
 lesson({
  id: 'ctl_pad_loop', title: 'A loop from the pads',
  say: 'The pads run the loop recorder without the mouse: {pad 1} arms and records loop slot 1, pressed again it plays what it took, again it stops; held for half a second it clears the slot.',
  todo: 'Press {pad 1}, play a few notes on the keys, and press {pad 1} again so the loop plays.',
  tip: 'One press to record, one to play. The pad turns red while it records and green while it plays.',
  setup: d => { if (d.variationId !== 'performance' && d.variations().some(v => v.id === 'performance')) d.setVariation('performance'); },
  check: (p, s) => hitsOf(s).filter(h => h.control === idOf(s.device, 'pad 1')).length >= 2 && s.loops()[0]?.playing && s.loops()[0].events.length > 0 && 'loop slot 1 recorded and playing, from pad 1',
 }),
];

// What a controller lesson's check reads.
export function lessonState(since) {
 return { device: dev(), since, hits: controllers.padHits, loops: () => window.synth.loops(), value: id => Number(document.getElementById(id)?.value) };
}
