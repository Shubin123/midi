import assert from 'node:assert/strict';
import { SCALES, SCALE_GROUPS, scaleNotes, remapPattern } from '../js/sequencer.js';

// The default rows are the ones patterns were saved with before keys and scales existed.
assert.deepEqual(scaleNotes(0, 'Major Pentatonic', 4), ['C4', 'D4', 'E4', 'G4', 'A4', 'C5']);
assert.deepEqual(scaleNotes(2, 'Dorian', 4), ['D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5', 'D5']);
assert.deepEqual(scaleNotes(9, 'Aeolian (Minor)', 3), ['A3', 'B3', 'C4', 'D4', 'E4', 'F4', 'G4', 'A4']);
assert.deepEqual(scaleNotes(10, 'Blues', 4), ['A#4', 'C#5', 'D#5', 'E5', 'F5', 'G#5', 'A#5']);
assert.equal(scaleNotes(0, 'Chromatic', 4).length, 13);

// Every scale runs from its tonic to the tonic an octave up, and each one is offered exactly once.
const midi = n => Number(n.match(/\d+$/)[0]) * 12 + ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(n.replace(/\d+$/, ''));
for (const name of Object.keys(SCALES)) {
 for (let key = 0; key < 12; key++) {
  const rows = scaleNotes(key, name, 4).map(midi);
  assert.equal(rows.at(-1) - rows[0], 12, `${name} in key ${key}`);
  rows.slice(1).forEach((m, i) => assert.ok(m > rows[i], `${name} rows ascend`));
 }
}
const offered = SCALE_GROUPS.flatMap(([, names]) => names);
assert.deepEqual([...offered].sort(), Object.keys(SCALES).sort());
assert.equal(new Set(offered).size, offered.length);

const empty = rows => rows.map(() => Array(16).fill(false));
const on = (rows, cells) => { const p = empty(rows); cells.forEach(([r, s]) => { p[r][s] = true; }); return p; };
const cellsOf = p => p.flatMap((row, r) => row.flatMap((v, s) => (v ? [[r, s]] : [])));

// Changing the key within the same scale transposes exactly: every note keeps its row.
{
 const c = scaleNotes(0, 'Major Pentatonic', 4), d = scaleNotes(2, 'Major Pentatonic', 4);
 const p = on(c, [[0, 0], [2, 4], [5, 15]]);
 assert.deepEqual(cellsOf(remapPattern(c, p, d, 2)), [[0, 0], [2, 4], [5, 15]]);
}
// Changing the octave moves the pattern by 12 semitones, again row for row.
{
 const a = scaleNotes(9, 'Dorian', 3), b = scaleNotes(9, 'Dorian', 4);
 const p = on(a, [[1, 1], [7, 2]]);
 assert.deepEqual(cellsOf(remapPattern(a, p, b, 12)), [[1, 1], [7, 2]]);
}
// Changing the scale snaps each note to the nearest degree of the new one.
{
 const pent = scaleNotes(0, 'Major Pentatonic', 4), major = scaleNotes(0, 'Ionian (Major)', 4);
 // C D E G A C  ->  rows C D E F G A B C
 const p = on(pent, [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
 assert.deepEqual(cellsOf(remapPattern(pent, p, major, 0)), [[0, 0], [1, 1], [2, 2], [4, 3], [5, 4], [7, 5]]);
 // C minor's Eb sits between D and E of C major pentatonic; a tie goes to the lower row.
 const minor = scaleNotes(0, 'Aeolian (Minor)', 4);
 assert.deepEqual(cellsOf(remapPattern(minor, on(minor, [[2, 6]]), pent, 0)), [[1, 6]]);
}
// Rows that land on the same note merge, and the result always has the new row count and 16 steps.
{
 const chrom = scaleNotes(0, 'Chromatic', 4), pent = scaleNotes(0, 'Major Pentatonic', 4);
 const out = remapPattern(chrom, on(chrom, [[0, 3], [1, 3], [1, 9]]), pent, 0);
 assert.equal(out.length, pent.length);
 assert.ok(out.every(row => row.length === 16));
 assert.deepEqual(cellsOf(out), [[0, 3], [0, 9]]);
}

console.log('sequencer: all checks passed');
