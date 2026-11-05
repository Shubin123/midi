import assert from 'node:assert/strict';
import { sayable } from '../js/voice.js';

// Replies are read aloud in talk mode; music notation is turned into words a speech voice says properly.
assert.equal(sayable('The ii–V–I in C is Dm7 → G7 → Cmaj7.'), 'The two, five, one in C is D minor seven, then G seven, then C major seven.');
assert.equal(sayable('Bb major uses Bb and Eb; F# minor; Bm7b5; C°7.'), 'B flat major uses B flat and E flat; F sharp minor; B minor seven flat five; C diminished seven.');
assert.equal(sayable('I-IV-V is the basis of blues.'), 'one, four, five is the basis of blues.');
assert.equal(sayable('D Dorian is A minor with a raised sixth.'), 'D Dorian is A minor with a raised sixth.', 'plain words untouched');
assert.equal(sayable('Add the blue note Eb to the A blues scale.'), 'Add the blue note E flat to the A blues scale.');
assert.equal(sayable('Strum **Am** then Gsus4.'), 'Strum A minor then G suspended 4.');

console.log('voice: all checks passed');
