import assert from 'node:assert/strict';
import { meetRequest, readKey, chordList, exampleFromProse, PROGRESSIONS } from '../js/requests.js';
import { parsePlayCommand } from '../js/ai-teacher.js';
import { detectChord } from '../js/pitch-analyzer.js';

const names = steps => steps.map(s => detectChord(s, Math.min(...s))[0]?.chordName);
const pcs = steps => [...new Set(steps.flat().map(n => n % 12))].sort((a, b) => a - b);

/* ---- Reading the key ---- */
assert.deepEqual(readKey('only play chords play a g# lick'), { tonic: 8, minor: false, flats: false }, '"a" is an article, g# the key');
assert.deepEqual(readKey('a sad progression in D minor'), { tonic: 2, minor: true, flats: true });
assert.equal(readKey('A minor pentatonic').tonic, 9, 'but "A minor" is a key');
assert.equal(readKey('play something in Bb').flats, true, 'spelled the way it was asked for');
assert.equal(readKey('E flat major please').tonic, 3);
assert.equal(readKey('how do I make it darker?'), null);

/* ---- Requests System 1 meets on its own, exactly ---- */
const meet = q => meetRequest(q, {});
{
 const r = await meet('only play chords play a g# lick');
 assert.ok(r.steps.every(s => s.length >= 3), 'only chords');
 assert.deepEqual(names(r.steps).slice(0, 4), ['G#7', 'C#7', 'G#7', 'D#7'], 'a G# blues in chords, spelled in sharps as asked');
 const longer = await meetRequest('play the same lick but longer', { last: r });
 assert.equal(longer.steps.length, r.steps.length * 2, 'longer: the same lick twice');
 assert.deepEqual(longer.steps.slice(0, r.steps.length), r.steps);
 assert.equal((await meetRequest('play it faster', { last: r })).bpm, 80);
 assert.deepEqual((await meetRequest('play it an octave higher', { last: r })).steps[0], r.steps[0].map(n => n + 12));
 assert.equal(await meetRequest('make the cutoff lower', { last: r }), null, 'a change to a control is not a change to the example');
}
assert.deepEqual(names((await meet('play me a sad chord progression in D minor')).steps), ['Dmin', 'A#maj', 'Fmaj', 'Cmaj'], 'i–VI–III–VII in D minor');
assert.match((await meet('play me a sad chord progression in D minor')).say, /Dm → Bb → F → C/, 'spelled with flats in D minor');
assert.deepEqual(names((await meet('What is a ii-V-I in C? Play it for me.')).steps), ['Dmin', 'Gmaj', 'Cmaj']);
assert.deepEqual(names((await meet('play I - IV - V - I in G')).steps), ['Gmaj', 'Cmaj', 'Dmaj', 'Gmaj']);
assert.deepEqual(names((await meet('play ii7 - V7 - Imaj7 in F')).steps), ['Gmin7', 'C7', 'Fmaj7'], 'sevenths from the numerals');
assert.deepEqual(names((await meet('play i - bVII - bVI - V in A minor')).steps), ['Amin', 'Gmaj', 'Fmaj', 'Emaj'], 'flat numerals and a major V in minor');
assert.deepEqual(names((await meet('play Dm7, G7, Cmaj7')).steps), ['Dmin7', 'G7', 'Cmaj7'], 'chords named outright');
assert.deepEqual(pcs((await meet('play the A minor pentatonic scale')).steps), [0, 2, 4, 7, 9]);
assert.ok(pcs((await meet('give me a bluesy lick in E')).steps).every(pc => [4, 7, 9, 10, 11, 2].includes(pc)), 'an E blues lick stays on the E blues scale');
assert.ok((await meet('give me a bluesy lick in E')).steps.every(s => s.length === 1), 'and a lick is single notes');
assert.match((await meet('play something jazzy in Bb')).say, /Cm7 → F7 → Bbmaj7/);
for (const q of ['how do I make the sound darker?', 'what is a perfect fifth?', 'how do I record a loop?', 'make the echoes louder', 'what does feedback do?']) assert.equal(await meet(q), null, `"${q}" is a question, not a request to play`);

// When the words leave it open, Laya chooses the progression, only from the written ones.
{
 let offered = null;
 const r = await meetRequest('play something dreamy', { pick: async (s, i, options) => { offered = options; return { choice: 'epic' }; } });
 assert.deepEqual(Object.keys(offered), Object.keys(PROGRESSIONS));
 assert.deepEqual(names(r.steps), ['Amin', 'Fmaj', 'Cmaj', 'Gmaj']);
}

/* ---- System 2's examples always land ---- */
assert.deepEqual(chordList('Try the G# blues: G#7, B7, C#7, A7.'), ['G#7', 'B7', 'C#7', 'A7']);
assert.equal(chordList('C major and A minor share notes.'), null, 'two keys named in a sentence are not a progression');
const play = r => parsePlayCommand(r).play;
assert.equal(play('Try the G# blues: G#7, B7, C#7, A7.').label, 'G#7 → B7 → C#7 → A7', 'no JSON line: the chords named in the reply play');
assert.equal(play('Here: {"chords": ["G#7", "C#7", "D#7"').label, 'G#7 → C#7 → D#7', 'a line cut off mid-way is closed and read');
assert.deepEqual(parsePlayCommand('Try this {“chords”: [“Dm7”, “G7”, “Cmaj7”],}'), { text: 'Try this', play: { steps: [[50, 53, 57, 60], [55, 59, 62, 65], [48, 52, 55, 59]], bpm: 60, label: 'Dm7 → G7 → Cmaj7' } }, 'curly quotes and a trailing comma');
assert.deepEqual(parsePlayCommand("Lower it. {'show': 'Filter › Cutoff (Hz)'}").actions, { show: ['Filter › Cutoff (Hz)'], set: [] }, 'single quotes');
assert.deepEqual(play('The ii is D-F-A, the V is G-B-D-F, and I is C-E-G. Play them in order.').steps, [[50, 53, 57], [55, 59, 62, 65], [48, 52, 55]], 'notes spelled out with dashes');
assert.equal(play('Try playing the A minor pentatonic scale next.').label, 'A minor pentatonic');
assert.equal(play('The relative minor of C major is A minor.'), null, 'an explanation with nothing to play plays nothing');
assert.equal(exampleFromProse('Play the D minor chord.'), null, 'a key named in passing is not a scale to play');

console.log('requests: all checks passed');
