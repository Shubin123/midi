// node tests/controllers.mjs: controller presets (js/controllers/), with no browser. Every bundled preset is
// checked against the schema, and broken ones are caught with a reason; the MiniLab 3's captures
// (tests/captures/minilab3.json) are decoded through the preset loader, every control in every program, exactly as
// the page decodes them; detection by port name and identity reply, the program and bank the device announces,
// and the SysEx sent for pad colours, the screen, the encoders and the DAW handshake match the documented bytes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../js/controllers/validate.js';
import { fill, readTemplate, matchTemplate, heard, rank, fit, variation, variationsFor, defaultProgram, indexProgram, decodeFor, programsSending, guessEncoding, learnedMessage } from '../js/controllers/preset.js';
import { decode, bytesOf, hex, parseIdentity, relativeDelta } from '../js/controllers/messages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), C = join(ROOT, 'js/controllers');
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const schema = json(join(C, 'schema.json')), index = json(join(C, 'presets/index.json'));
const presets = Object.fromEntries(index.presets.map(p => [p, json(join(C, 'presets', p))]));
const minilab = presets['arturia/minilab3.json'], captures = json(join(ROOT, 'tests/captures/minilab3.json'));
const program = id => minilab.programs.find(g => g.id === id);

let failed = 0, passed = 0;
const check = (name, fn) => { try { fn(); passed++; } catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.message.split('\n')[0]}`); } };
const copy = x => JSON.parse(JSON.stringify(x));

/* ---- The format ---- */
for (const [path, p] of Object.entries(presets)) check(`${path} is a valid preset`, () => assert.deepEqual(validate(p, schema), []));
check('every bundled preset is in index.json, with its id as its path', () => {
 for (const [path, p] of Object.entries(presets)) assert.equal(`${p.id}.json`, path);
});
check('broken presets are caught, each with where and why', () => {
 const cases = [
  [p => { delete p.controls; }, /needs controls/],
  [p => { p.format = 2; }, /format must be 1/],
  [p => { p.status = 'great'; }, /status must be one of/],
  [p => { p.controls[5].id = p.controls[4].id; }, /used twice/],
  [p => { p.programs[0].messages.nosuch = { cc: 3 }; }, /names "nosuch", which isn't one of the controls/],
  [p => { p.programs[0].messages.knob1.cc = 200; }, /knob1\.cc is above 127/],
  [p => { p.programs[0].messages.knob1.channel = 17; }, /must be 1 to 16 or "any"/],
  [p => { p.variations[0].mappings.knob1 = { do: 'page' }; }, /page knob without a slot/],
  [p => { p.variations[0].mappings.pad1 = { do: 'dance' }; }, /do must be one of/],
  [p => { p.variations[1].extends = 'nope'; }, /extends names "nope"/],
  [p => { p.feedback.pads.message = ['F0', 'ZZ', 'F7']; }, /"ZZ" \(byte 1\) is neither/],
  [p => { p.feedback.screen.widths = [10]; }, /a width for each line/],
  [p => { p.listen[0].values['1'] = 'nowhere'; }, /names program "nowhere"/],
  [p => { p.surprise = 1; }, /surprise isn't part of the format/],
  [p => { p.programs[0].messages.knob1 = { cc: 1, note: 3 }; }, /must say one of cc, note/],
 ];
 for (const [change, want] of cases) {
  const p = copy(minilab); change(p);
  const problems = validate(p, schema);
  assert.ok(problems.some(x => want.test(x)), `${want} not among: ${problems.slice(0, 3).join(' | ') || 'none'}`);
 }
});

/* ---- The MiniLab 3, from its captures ---- */
check('the captures are documented, not recorded, and say so', () => { assert.equal(captures.recorded, false); assert.match(captures.notes, /Not recorded/); });
for (const [prog, list] of Object.entries(captures.programs)) {
 check(`MiniLab 3, ${prog} program: every control in the captures decodes to itself (${list.length} messages)`, () => {
  const ix = indexProgram(program(prog));
  for (const c of list) {
   const e = decodeFor(ix, bytesOf(c.bytes));
   assert.ok(e, `${c.bytes} (${c.control}) wasn't read`);
   assert.equal(e.control, c.control, `${c.bytes} was read as ${e.control}, not ${c.control}`);
   assert.equal(e.kind, c.kind, `${c.bytes} (${c.control}) is a ${e.kind}, not a ${c.kind}`);
   if (c.delta !== undefined) assert.equal(e.delta, c.delta, `${c.bytes}: delta ${e.delta}`);
   if (c.value !== undefined) assert.ok(Math.abs(e.value - c.value) < 1e-9, `${c.bytes}: value ${e.value}`);
  }
 });
}
check('every control that sends something is in the captures of each program it sends in', () => {
 for (const prog of ['arturia', 'daw', 'user']) {
  const sent = new Set(captures.programs[prog].map(c => c.control));
  for (const id of Object.keys(program(prog).messages)) assert.ok(sent.has(id), `${prog}: ${id} has no capture`);
 }
});
check('the encoders and faders are absolute in the factory programs and relative (binary offset) in the recommended User program', () => {
 assert.deepEqual(decodeFor(indexProgram(program('arturia')), [0xB0, 74, 100]), { control: 'knob1', channel: 1, raw: 100, kind: 'value', value: 100 / 127 });
 const rel = indexProgram(program('user-relative'));
 assert.equal(decodeFor(rel, [0xB0, 74, 65]).delta, 1); assert.equal(decodeFor(rel, [0xB0, 74, 61]).delta, -3);
 assert.equal(decodeFor(rel, [0xB0, 74, 64]), null, 'no move is no event');
 assert.equal(decodeFor(rel, [0xB0, 82, 30]).kind, 'value', 'faders stay absolute');
});
check('pads: bank A and B notes on channel 10 are pads 1-16; the same notes on channel 1 are keys', () => {
 const ix = indexProgram(program('arturia'));
 assert.equal(decodeFor(ix, [0x99, 36, 90]).control, 'pad1'); assert.equal(decodeFor(ix, [0x99, 51, 90]).control, 'pad16');
 assert.equal(decodeFor(ix, [0x90, 36, 90]).control, 'keys');
 assert.equal(decodeFor(ix, [0x99, 60, 90]).control, 'keys', 'a key on channel 10 outside the pads is still a key');
 assert.deepEqual(decodeFor(ix, [0xA9, 40, 64]), { control: 'pad5', channel: 10, kind: 'pressure', value: 64 / 127, note: 40 });
});
check('which program a message comes from: the encoders\' CCs tell Arturia from DAW; the keys say nothing', () => {
 assert.deepEqual(programsSending(minilab, [0xB0, 86, 3]), ['daw']);
 assert.deepEqual(programsSending(minilab, [0xB0, 74, 3]), ['arturia']); // the User programs are templates: never guessed
 assert.deepEqual(programsSending(minilab, [0x90, 60, 3]).sort(), ['arturia', 'daw']);
});
check('what the device announces: its program (each documented value, and an undocumented one as a User program) and its pad bank', () => {
 for (const s of captures.sysex.filter(x => x.program || x.bank)) {
  const h = heard(minilab, bytesOf(s.bytes));
  assert.ok(h, `${s.bytes} wasn't understood`);
  if (s.program) assert.equal(h.program, s.program, `${s.bytes}: ${h.program}`);
  if (s.bank) assert.equal(h.bank, s.bank, `${s.bytes}: ${h.bank}`);
 }
 assert.equal(heard(minilab, bytesOf('F0 00 20 6B 7F 42 02 00 40 99 01 F7')), null);
});

/* ---- Detection ---- */
const identity = parseIdentity(bytesOf(captures.sysex[0].bytes));
check('the identity reply is read, and matches the MiniLab 3 (manufacturer 00 20 6B, family 02 00, member 04 04)', () => {
 assert.deepEqual(identity.manufacturer, [0x00, 0x20, 0x6B]); assert.deepEqual(identity.family, [2, 0]); assert.deepEqual(identity.member, [4, 4]); assert.equal(identity.firmware, '1.2.0.0');
 assert.equal(fit(minilab, { name: 'Some Port', identity }).by, 'identity');
 assert.equal(fit(minilab, { name: 'X', identity: { ...identity, member: [4, 5] } }).score, 0, 'another Arturia model doesn\'t match');
});
check('port names: macOS, Windows (also a second unit) and Linux main ports; the MCU/HUI port is its DAW port, the ALV port ignored, DIN THRU not it', () => {
 for (const name of ['Minilab3 MIDI', 'Minilab3', '2- Minilab3 MIDI', 'Minilab3 Minilab3 MIDI']) assert.deepEqual([fit(minilab, { name }).role, fit(minilab, { name }).by], ['main', 'name'], name);
 assert.equal(fit(minilab, { name: 'Minilab3 MCU' }).role, 'daw'); assert.equal(fit(minilab, { name: 'Minilab3 MCU/HUI' }).role, 'daw');
 assert.equal(fit(minilab, { name: 'Minilab3 ALV' }).role, 'ignore');
 assert.equal(fit(minilab, { name: 'Minilab3 DIN THRU' }).score, 0);
 assert.equal(fit(minilab, { name: 'Minilab37 MIDI' }).score, 0, 'the MiniLab 37 is another model');
});
check('ranking: the MiniLab 3 before the generic presets for its port; an unknown keyboard gets only generic ones', () => {
 const all = Object.values(presets);
 assert.equal(rank(all, { name: 'Minilab3 MIDI' })[0].preset.id, 'arturia/minilab3');
 const unknown = rank(all, { name: 'Acme Keys 49' });
 assert.ok(unknown.length && unknown.every(r => r.preset.generic && r.by === 'generic'));
 assert.equal(rank(all, { name: 'X-Touch MCU' })[0].preset.id, 'generic/mackie');
});

/* ---- Variations ---- */
check('variations: Performance is the default; the others extend it and change only what they say', () => {
 assert.equal(defaultProgram(minilab).id, 'arturia');
 assert.deepEqual(variationsFor(minilab, 'daw').map(v => v.id), ['performance', 'sound-design', 'looper-drums', 'practice']);
 const perf = variation(minilab, 'performance'), sd = variation(minilab, 'sound-design'), drums = variation(minilab, 'looper-drums');
 assert.equal(perf.mappings.knob5.slot, 5); assert.equal(perf.pages[0].params[4], 'filterCutoff', 'knob 5 is the cutoff, so "turn knob 5 to brighten the sound" holds');
 assert.deepEqual(sd.mappings.fader1, { do: 'param', param: 'attack' }); assert.deepEqual(sd.mappings.keys, perf.mappings.keys); assert.deepEqual(sd.pages, perf.pages);
 assert.equal(drums.mappings.pad1.do, 'drum'); assert.equal(drums.mappings.pad9.do, 'loop'); assert.equal(drums.mappings.pad9.hold.do, 'clear');
 for (const v of minilab.variations) { const m = variation(minilab, v.id).mappings; for (const c of minilab.controls) if (Object.values(minilab.programs[0].messages)[0] && minilab.programs[0].messages[c.id] && !['shift-pad1', 'shift-pad2', 'shift-pad3'].includes(c.id)) assert.ok(m[c.id], `${v.id}: ${c.id} does nothing`); }
});

/* ---- What is sent ---- */
check('pad colours: one pad at a time in the DAW program, R G B 0-127; pad ids 0x34-0x3B (bank A), 0x44-0x4B (bank B), 0x54-0x5B (the Shift layer)', () => {
 const f = minilab.feedback.pads;
 assert.equal(hex(fill(f.message, { index: f.index.pad1, r: 127, g: 0, b: 0 })), 'F0 00 20 6B 7F 42 02 02 16 34 7F 00 00 F7');
 assert.equal(hex(fill(f.message, { index: f.index.pad16, r: 0, g: 63.5, b: 127 })), 'F0 00 20 6B 7F 42 02 02 16 4B 00 40 7F F7');
 assert.equal(hex(fill(f.message, { index: f.index.play, r: 0, g: 127, b: 0 })), 'F0 00 20 6B 7F 42 02 02 16 59 00 7F 00 F7');
 assert.deepEqual(f.programs, ['daw']);
 assert.deepEqual(Object.values(f.index).sort((a, b) => a - b), [...Array(8).keys()].map(i => 0x34 + i).concat([...Array(8).keys()].map(i => 0x44 + i), [...Array(8).keys()].map(i => 0x54 + i)));
});
check('the screen: two lines of ASCII, cut to 10 and 18 characters, unknown characters as "?"', () => {
 const f = minilab.feedback.screen;
 assert.equal(hex(fill(f.message, { line1: 'Cutoff', line2: '5000' })), 'F0 00 20 6B 7F 42 04 02 60 01 43 75 74 6F 66 66 00 02 35 30 30 30 00 F7');
 const long = fill(f.message, { line1: 'Performance · Synth', line2: '120 BPM C♯ major é chord' });
 const text = long.slice(10, long.indexOf(0, 10)); assert.equal(String.fromCharCode(...text), 'Performanc');
 const two = long.slice(long.indexOf(2, 10) + 1, -2); assert.equal(two.length, 18); assert.ok(two.every(b => b < 128));
 assert.ok(String.fromCharCode(...two).includes('C# major ?'));
});
check('the encoders\' values (DAW program): 21 10 00, encoder 7-14, the value', () => {
 const f = minilab.feedback.encoders;
 assert.equal(hex(fill(f.message, { index: f.index.knob5, value: 100 })), 'F0 00 20 6B 7F 42 21 10 00 0B 00 64 F7');
});
check('the DAW program says hello and goodbye (Bitwig, FL, Logic, Cubase): 02 02 40 6A 21 / 20; the queries ask for the program and the bank', () => {
 assert.equal(hex(fill(program('daw').enter[0])), 'F0 00 20 6B 7F 42 02 02 40 6A 21 F7');
 assert.equal(hex(fill(program('daw').exit[0])), 'F0 00 20 6B 7F 42 02 02 40 6A 20 F7');
 assert.deepEqual(minilab.queries.map(q => hex(fill(q))), ['F0 00 20 6B 7F 42 01 00 40 01 F7', 'F0 00 20 6B 7F 42 01 00 40 03 F7']);
});

/* ---- The loader's pieces ---- */
check('templates: placeholders read, matched and filled; bad ones refused', () => {
 assert.deepEqual(readTemplate(['F0', '{v}', '{text:t:3}', 7]).map(x => x.kind || x.byte), [0xF0, 'value', 'text', 7]);
 assert.deepEqual(matchTemplate(['F0', '01', '{value}', 'F7'], [0xF0, 1, 9, 0xF7]), { value: 9 });
 assert.equal(matchTemplate(['F0', '01', '{value}', 'F7'], [0xF0, 2, 9, 0xF7]), null);
 assert.deepEqual(fill(['{bytes:x}', '{v}'], { x: [1, 200], v: 300 }), [1, 72, 127]);
 assert.throws(() => readTemplate(['F0', '{9}']));
});
check('relative encodings: binary offset, two\'s complement, signed bit', () => {
 assert.deepEqual([65, 63, 70].map(v => relativeDelta('binary-offset', v)), [1, -1, 6]);
 assert.deepEqual([1, 127, 120].map(v => relativeDelta('twos-complement', v)), [1, -1, -8]);
 assert.deepEqual([1, 65, 3, 67].map(v => relativeDelta('signed-bit', v)), [1, -1, 3, -3]);
 assert.equal(guessEncoding([65, 66, 65]), 'binary-offset'); assert.equal(guessEncoding([1, 2, 127]), 'twos-complement'); assert.equal(guessEncoding([1, 66, 2]), 'signed-bit'); assert.equal(guessEncoding([10, 40, 90]), 'absolute'); assert.equal(guessEncoding([60, 61, 62]), 'absolute'); assert.equal(guessEncoding([2, 1, 0]), 'absolute');
 assert.deepEqual(learnedMessage(decode([0xB3, 21, 9]), { relative: 'binary-offset' }), { cc: 21, channel: 4, encoding: 'binary-offset' });
});
check('Mackie Control: V-Pots signed bit, faders 14-bit pitch bend on their own channels, transport notes', () => {
 const ix = indexProgram(presets['generic/mackie.json'].programs[0]);
 assert.deepEqual([decodeFor(ix, [0xB0, 16, 0x41]).control, decodeFor(ix, [0xB0, 16, 0x41]).delta], ['vpot1', -1]);
 assert.equal(decodeFor(ix, [0xB0, 23, 0x05]).delta, 5);
 const f = decodeFor(ix, [0xE2, 0x7F, 0x7F]); assert.equal(f.control, 'fader3'); assert.equal(f.value, 1);
 assert.equal(decodeFor(ix, [0xE8, 0, 0x40]).control, 'master');
 assert.equal(decodeFor(ix, [0x90, 0x5E, 0x7F]).control, 'play'); assert.equal(decodeFor(ix, [0xB0, 60, 0x01]).control, 'jog');
});
check('decode: note-on of velocity 0 is a note-off; clock; SysEx; pitch bend centre', () => {
 assert.equal(decode([0x91, 60, 0]).type, 'noteoff'); assert.equal(decode([0xF8]).what, 'tick'); assert.equal(decode([0xF0, 1, 0xF7]).type, 'sysex');
 assert.equal(decode([0xE0, 0, 0x40]).value, 8192);
});

/* ---- Workspace backups (js/backup.js) ---- */
const { makeBackup, restoreBackup, isBackup, isAppKey } = await import('../js/backup.js');
const store = entries => { const m = new Map(entries); return { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null, getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m }; };
check('a backup has the app\'s keys (controller presets and choices among them), not another page\'s or a sign-in verifier', () => {
 const st = store([['controller-presets-v1', '[{"id":"user/x"}]'], ['controller-choices-v1', '{}'], ['synth-layout-v1', '{}'], ['teacher-course-v1', '[]'], ['synthTheme', 'forest-calm'], ['other-demo-score', '9'], ['openrouter_pkce_verifier', 'secret']]);
 const b = JSON.parse(makeBackup(st, new Date('2026-11-06T10:00:00Z')));
 assert.deepEqual(Object.keys(b.keys).sort(), ['controller-choices-v1', 'controller-presets-v1', 'synth-layout-v1', 'synthTheme', 'teacher-course-v1']);
 assert.equal(b.saved, '2026-11-06T10:00:00.000Z'); assert.ok(isBackup(JSON.stringify(b))); assert.ok(!isBackup('{"format":1}'));
 assert.ok(!isAppKey('openrouter_pkce_verifier') && isAppKey('midi-settings-v1') && isAppKey('listen-mappings-v1'));
});
check('restoring a backup puts its keys back, drops the app\'s keys it didn\'t have, leaves other pages\' alone, and refuses anything else', () => {
 const text = makeBackup(store([['controller-presets-v1', '[1]'], ['synth-air-v1', '{"a":1}']]));
 const st = store([['controller-presets-v1', '[]'], ['timing-on-v1', 'false'], ['other-demo-score', '9']]);
 assert.equal(restoreBackup(text, st), 2);
 assert.deepEqual(Object.fromEntries(st.map), { 'controller-presets-v1': '[1]', 'synth-air-v1': '{"a":1}', 'other-demo-score': '9' });
 assert.throws(() => restoreBackup('{"keys":{}}', st), /isn't a workspace backup/);
 assert.throws(() => restoreBackup('not json', st), /isn't a backup/);
});

console.log(`\n${failed ? `${failed} failed, ${passed} passed` : `controller presets: all ${passed} checks passed`}`);
process.exit(failed ? 1 : 0);
