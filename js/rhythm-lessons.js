// A course unit on time: what tempo and rhythm are, and how the teacher's two systems split the work the same
// way. These texts are the app's own, not adapted from Open Music Theory. Like the rest of the course, the
// tasks are checked from what the student plays, here from when each key goes down (js/lessons.js Attempt),
// so no model is needed to teach or mark them.

export const RHYTHM_UNIT = 'Tempo and rhythm';

// Keys struck within 60 ms of each other are one event, a chord: it happens when its first key goes down and
// stands on its lowest note.
const CHORD_MS = 60;
export function events(notes, times) {
 const out = [];
 notes.forEach((n, i) => {
  const last = out.at(-1);
  if (last && times[i] - last.t < CHORD_MS) last.low = Math.min(last.low, n);
  else out.push({ t: times[i], low: n });
 });
 return out;
}

const sum = xs => xs.reduce((a, b) => a + b, 0);

// The same rhythm played twice at different tempos: two runs of `k` events whose gaps keep their proportions
// (each within 30%) while the whole run is at least a third faster or slower. The rhythm needs long and short
// notes, so a steady pulse at two speeds doesn't count. Returns how many times faster the second run is
// (below 1 is slower), or 0.
export function findSameRhythm(notes, times, k = 4) {
 const t = events(notes, times).map(e => e.t), gaps = t.slice(1).map((x, i) => x - t[i]), n = k - 1;
 for (let i = 0; i + n <= gaps.length; i++) {
  const a = gaps.slice(i, i + n);
  if (Math.max(...a) < 1.5 * Math.min(...a)) continue; // every note the same length: a pulse, not yet a rhythm
  for (let j = i + n + 1; j + n <= gaps.length; j++) { // the second run starts after the first one's last note
   const b = gaps.slice(j, j + n), r = sum(b) / sum(a);
   if (r > 3 / 4 && r < 4 / 3) continue; // the same tempo
   if (a.every((g, m) => Math.abs(b[m] / (g * r) - 1) <= 0.3)) return 1 / r;
  }
 }
 return 0;
}

// A steady beat of `k` events (every gap within 30% of the usual one, and no slower than 40 BPM) whose
// downbeats, every fourth event from the first, are lower than all the others. Returns { bpm } or null.
export function findMarkedBeat(notes, times, k = 8) {
 const ev = events(notes, times);
 for (let i = 0; i + k <= ev.length; i++) {
  const run = ev.slice(i, i + k), gaps = run.slice(1).map((e, m) => e.t - run[m].t);
  const usual = [...gaps].sort((x, y) => x - y)[gaps.length >> 1];
  if (usual > 1500 || gaps.some(g => Math.abs(g / usual - 1) > 0.3)) continue;
  const downs = run.filter((_, m) => m % 4 === 0), ups = run.filter((_, m) => m % 4);
  if (downs.every(d => ups.every(u => d.low < u.low))) return { bpm: Math.round(60000 / usual) };
 }
 return null;
}

/* ---- Examples ---- */

// Each step of an example is one beat (js/teacher-bridge.js _playSteps) and an empty step is a rest, so a
// rhythm is written on a grid: [notes, length in eighth notes], each eighth `stretch` steps long.
const pattern = (rhythm, stretch) => rhythm.flatMap(([notes, len]) => [notes, ...Array(len * stretch - 1).fill([])]);
// Long, short, short, long, rest; the first note is marked with a low C.
const LONG_SHORT = [[[48, 60], 2], [[60], 1], [[60], 1], [[60], 2], [[], 2]];
// A groove with its downbeats low: C3 and G3 under C4 and E4.
const BEAT = [[48], [60], [64], [60], [55], [60], [64], [60]];

/* ---- The unit ---- */

export const RHYTHM_LESSONS = [
 {
  id: 'tempo_rhythm', unit: RHYTHM_UNIT, title: 'Tempo and rhythm',
  text: 'Tempo is speed: how fast the beats go by. Rhythm is pattern: how events are arranged in time, meaning which notes are long or short, where the accents fall, and where the silences go. The same rhythm can be played at any tempo and still be recognizable. The example plays one rhythm at 60 BPM, then twice at 120.',
  // 240 steps a minute: an eighth note is two steps at 60 BPM and one at 120.
  example: { steps: [...pattern(LONG_SHORT, 2), ...pattern(LONG_SHORT, 1), ...pattern(LONG_SHORT, 1)], bpm: 240 },
  pattern: 'x...x.x.x.......', // long, short, short, long, rest: what a phrase is marked against on the sixteenth grid
  task: 'Play a rhythm of four notes or more, with long and short notes in it, then play the same rhythm again faster or slower. Any keys will do.',
  hint: 'Try long, short, short, long, as in the example. Keep the pattern and change only the speed: at least a third faster or slower the second time.',
  check: p => {
   const s = findSameRhythm(p.notes, p.times);
   return !!s && `the same rhythm, ${Math.round(Math.max(s, 1 / s) * 10) / 10} times ${s > 1 ? 'faster' : 'slower'}`;
  },
 },
 {
  id: 'two_systems', unit: RHYTHM_UNIT, title: 'System 1 and System 2: tempo and rhythm',
  text: 'System 1 (fast, a bit less capable: here, Laya) sets the tempo: it responds to each beat almost instantly and keeps the interaction moving. System 2 (slow, more capable: Qwen, or the provider you connect) shapes the rhythm: it decides which moments deserve a pause, careful reasoning or emphasis, and which can be handled quickly. Why this split? Latency. Whatever model responds first decides how often anything happens at all, and in a live interaction that\'s the fast model. A slow model can\'t keep the beat without leaving gaps. Its strength is a wider view, so it\'s better at deciding where effort should go than at filling every moment. The design takeaway: let the fast model keep the groove going, and bring in the slow model only on the downbeats that matter. This is a common design pattern, not a law: you could flip it, so the slow model plans the pacing up front and the fast model fills in the details.',
  example: { steps: [...BEAT, ...BEAT], bpm: 120 },
  pattern: 'x...x...x...x...x...x...x...x...',
  task: 'Keep the groove like System 1 and mark the downbeats like System 2: play a steady beat of eight notes, with the first and the fifth lower than the rest.',
  hint: 'Play evenly, like a clock ticking: low, high, high, high, low, high, high, high. A chord with a low note works on the downbeats too.',
  check: p => { const b = findMarkedBeat(p.notes, p.times); return !!b && `a steady beat at ${b.bpm} BPM, with its downbeats marked`; },
 },
];
