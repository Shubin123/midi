// Checks run inside the app by node tests/controller-panel.mjs, with a mock Web MIDI device
// (tests/support/mock-midi.js): plain MIDI from an unknown keyboard (channels, routing, the pedal, unplugged
// mid-note); then an Arturia MiniLab 3 playing every widget through its preset, as tests/captures/minilab3.json
// says it sends: keys, knobs with pick-up, Shift, faders, the main encoder, the pads on the looper, the
// sequencer and the transport, automation recorded from a knob; its DAW port kept from playing; SysEx refused,
// then allowed: detection by identity, the DAW program from its reply, pad colours, the screen and the encoders
// written (only what changed), variations switched cleanly, let go and unplugged cleanly; its arpeggiator and
// chord mode; MIDI clock out; the Generic 8-knob preset and MIDI learn into a saved, exported and imported
// preset. Returns { checks }.
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const t = performance.now(); while (performance.now() - t < ms) { if (fn()) return true; await wait(15); } return !!fn(); };
const $ = s => document.querySelector(s);

export async function runControllers() {
 const checks = [];
 const check = async (name, fn) => {
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message} ${err.stack?.split('\n')[1]?.trim() || ''}`); }
  checks.push({ name, ok: !problems.length, problems });
 };
 const { controllers } = await import('../js/controllers/runtime.js');
 const { midi } = await import('../js/controllers/midi.js');
 const { timing } = await import('../js/timing-widget.js');
 const { hex } = await import('../js/controllers/messages.js');
 const M = window.__midi, synth = window.synth, seq = () => window.workspaceApi.sequencer;
 const captures = await (await fetch('tests/captures/minilab3.json')).json();
 const cap = (prog, control, kind) => captures.programs[prog].find(c => c.control === control && (!kind || c.kind === kind)).bytes;
 await controllers.ready; await until(() => midi.state === 'ready');
 const notes = [];
 window.addEventListener('synth:note', e => notes.push(e.detail));
 const since = n => notes.slice(n);
 const dev = name => controllers.devices.find(d => d.port.name === name);
 const cc = (n, v, ch = 1) => [0xB0 | (ch - 1), n, v];
 const tap = async (name, press, release, ms = 30) => { M.send(name, press); await wait(ms); M.send(name, release); await wait(20); };
 // An absolute knob swept from 0 to `to`, slowly enough for pick-up to catch it on the way.
 const sweep = async (name, n, to, ch = 1) => { for (let v = 0; v <= to; v += 4) M.send(name, cc(n, v, ch)); M.send(name, cc(n, to, ch)); await wait(20); };
 const sweepDown = async (name, n, to, ch = 1) => { for (let v = 127; v >= to; v -= 4) M.send(name, cc(n, v, ch)); M.send(name, cc(n, to, ch)); await wait(20); };

 /* ---- Plain MIDI ---- */
 await check('an unknown keyboard plays as plain MIDI: notes light their keys, the pedal holds them, channel 10 plays the drum kit, Omni or one channel', async ok => {
  M.plug('Acme Keys 49');
  ok(await until(() => dev('Acme Keys 49')), 'no device for the keyboard');
  const d = dev('Acme Keys 49');
  ok(d && !d.use && d.preset.generic, `it should be offered a generic preset, not use one (${d?.preset.id}, use ${d?.use})`);
  let n = notes.length;
  M.send('Acme Keys 49', [0x90, 60, 100]); await wait(20);
  ok(since(n).some(e => e.on && e.midi === 60 && e.source === 'midi'), 'note 60 didn\'t play');
  ok($('#keyboard [data-midi="60"]')?.classList.contains('active'), 'its key isn\'t lit');
  M.send('Acme Keys 49', cc(64, 127)); M.send('Acme Keys 49', [0x80, 60, 0]); await wait(20);
  ok(!since(n).some(e => !e.on && e.midi === 60), 'the pedal didn\'t hold the note');
  M.send('Acme Keys 49', cc(64, 0)); await wait(20);
  ok(since(n).some(e => !e.on && e.midi === 60), 'lifting the pedal didn\'t stop it');
  n = notes.length; M.send('Acme Keys 49', [0x99, 38, 100]); await wait(20);
  ok(since(n).some(e => e.on && e.source === 'midi-drum' && e.drum === 38) && !since(n).some(e => e.source === 'midi'), 'channel 10 didn\'t go to the drum kit');
  midi.set({ channel: 2 }); n = notes.length; M.send('Acme Keys 49', [0x90, 62, 100]); M.send('Acme Keys 49', [0x80, 62, 0]); await wait(20);
  ok(!since(n).length, 'listening to channel 2, channel 1 still played');
  midi.set({ channel: 'omni' });
  ok(/channel 1/.test($('#controllers-module .ctl-plain').textContent), 'the channel heard isn\'t shown');
 });
 await check('unplugged mid-note (and with the pedal down), nothing is left sounding', async ok => {
  const n = notes.length;
  M.send('Acme Keys 49', cc(64, 127)); M.send('Acme Keys 49', [0x90, 64, 90]); await wait(20);
  M.unplug('Acme Keys 49'); await wait(40);
  ok(since(n).some(e => !e.on && e.midi === 64), 'note 64 is stuck');
  ok(!synth.midi.sustained, 'the pedal is stuck down');
  ok(!dev('Acme Keys 49'), 'the device is still listed');
 });

 /* ---- The MiniLab 3, Arturia program, no SysEx yet ---- */
 const ML = 'Minilab3 MIDI';
 await check('a MiniLab 3 is found by its port name and uses its Performance preset in the Arturia program; its MCU and ALV ports are kept with it and play nothing', async ok => {
  M.plug(ML); M.plug('Minilab3 MCU'); M.plug('Minilab3 ALV');
  ok(await until(() => dev(ML)?.others.length === 2), `its other ports weren't kept with it (${dev(ML)?.others.map(p => p.name)})`);
  const d = dev(ML);
  ok(d?.preset.id === 'arturia/minilab3' && d.by === 'name' && d.use, `found as ${d?.preset.id} by ${d?.by}`);
  ok(d?.programId === 'arturia' && d.variationId === 'performance', `${d?.programId} / ${d?.variationId}`);
  ok(/Arturia MiniLab 3 detected/.test($('#controllers-module').textContent), 'the widget doesn\'t say it was detected');
  const n = notes.length;
  M.send('Minilab3 MCU', [0x90, 0x5E, 0x7F]); M.send('Minilab3 ALV', [0x90, 60, 0x7F]); await wait(20);
  ok(!since(n).length, 'a note from its MCU or ALV port played');
 });
 await check('its keys play (on any channel); a note below the keys on screen moves them down, as its Octave buttons do', async ok => {
  let n = notes.length;
  M.send(ML, cap('arturia', 'keys', 'note')); M.send(ML, [0x80, 60, 0]); M.send(ML, [0x92, 64, 80]); M.send(ML, [0x82, 64, 0]); await wait(20);
  ok(since(n).filter(e => e.on && e.source === 'midi').map(e => e.midi).join() === '60,64', `played ${since(n).filter(e => e.on).map(e => e.midi)}`);
  const was = synth.octave;
  M.send(ML, [0x90, 36, 80]); await wait(20);
  ok(synth.octave === 3 && synth.keyRange[0] <= 36, `the keys stayed at octave ${synth.octave} (was ${was})`);
  ok($('#keyboard [data-midi="36"]')?.classList.contains('active'), 'the low key isn\'t lit after the keys moved');
  M.send(ML, [0x80, 36, 0]); await wait(20);
  synth.showOctave(4);
 });
 await check('knob 5 is the cutoff: it waits until it reaches the cutoff (pick-up), then follows; the widget shows K5 on it', async ok => {
  const cut = $('#filterCutoff'); cut.value = 5000; cut.dispatchEvent(new Event('input', { bubbles: true }));
  const d = dev(ML);
  M.send(ML, cc(93, 127)); await wait(20);
  ok(Number(cut.value) === 5000, `the cutoff jumped to ${cut.value} before the knob reached it`);
  ok(/turn down/.test(d.transient?.value || ''), `the screen should say which way to turn (${d.transient?.value})`);
  await sweep(ML, 93, 127);
  ok(Number(cut.value) === 20000, `swept past it to 127, the cutoff is ${cut.value}`);
  await until(() => cut.closest('label')?.dataset.hw?.includes('K5'));
  ok(cut.closest('label')?.dataset.hw?.includes('K5'), `the cutoff's badge says "${cut.closest('label')?.dataset.hw}"`);
  cut.value = 5000; cut.dispatchEvent(new Event('input', { bubbles: true }));
 });
 await check('Shift (CC 9) + knob 1 moves the second eight (decay); fader 1 the volume; fader 4 has no noise oscillator to move and says so', async ok => {
  const d = dev(ML), decay = $('#decay'), was = Number(decay.value);
  M.send(ML, cc(9, 127)); await wait(10);
  ok(d.shift, 'Shift didn\'t register');
  await sweep(ML, 74, 127); M.send(ML, cc(9, 0)); await wait(10);
  ok(Number(decay.value) === 2 && was !== 2, `decay is ${decay.value}`);
  ok(Number($('#levelOsc1').value) !== 2, 'Shift + knob 1 moved oscillator 1 too');
  await sweep(ML, 82, 127); await sweepDown(ML, 82, 64);
  ok(Math.abs(Number($('#masterVolume').value) - 0.5) < 0.02, `volume ${$('#masterVolume').value}`);
  M.send(ML, cc(17, 40)); await wait(10);
  ok(/Not mapped/.test(d.transient?.value || ''), `fader 4: ${d.transient?.value}`);
  decay.value = was; decay.dispatchEvent(new Event('input', { bubbles: true }));
 });
 await check('the main encoder browses widgets, its click puts the knobs on one; Shift + turn is the tempo; Shift + click the next preset', async ok => {
  const d = dev(ML), t = synth.tempo;
  for (let i = 0; i < 3; i++) M.send(ML, cc(114, 0x41));
  await wait(10);
  const item = (await import('../js/controllers/actions.js')).browseList(d)[d.browse.index];
  M.send(ML, cc(115, 127)); M.send(ML, cc(115, 0)); await wait(20);
  ok(d.focus === item.id && d.page.from === 'focus', `focus ${d.focus}, wanted ${item.id}; page ${d.page?.name}`);
  M.send(ML, cc(112, 0x41)); M.send(ML, cc(112, 0x41)); await wait(10);
  ok(synth.tempo === t + 2, `tempo ${synth.tempo}, was ${t}`);
  synth.tempo = t;
  M.send(ML, cc(113, 127)); M.send(ML, cc(113, 0)); await wait(20);
  ok(d.variationId === 'sound-design', `Shift + click: ${d.variationId}`);
  d.setVariation('performance'); d.setPage('synth');
 });
 await check('pads bank A: pad 1 records loop slot 1, then plays it, then stops it; held, it clears it; pad 5 the metronome', async ok => {
  const P1 = [cap('arturia', 'pad1', 'press'), cap('arturia', 'pad1', 'release')].map(b => b.split(' ').map(h => parseInt(h, 16)));
  await tap(ML, P1[0], P1[1]);
  ok(await until(() => synth.loops()[0].recording), 'slot 1 isn\'t recording');
  M.send(ML, [0x90, 60, 90]); await wait(120); M.send(ML, [0x80, 60, 0]); await wait(120);
  await tap(ML, P1[0], P1[1]);
  ok(await until(() => synth.loops()[0].playing && synth.loops()[0].events.length), `slot 1: ${JSON.stringify({ ...synth.loops()[0], events: synth.loops()[0].events.length })}`);
  await tap(ML, P1[0], P1[1]);
  ok(await until(() => !synth.loops()[0].playing), 'slot 1 didn\'t stop');
  M.send(ML, P1[0]); await wait(600); M.send(ML, P1[1]); await wait(20);
  ok(!synth.loops()[0].events.length, 'holding pad 1 didn\'t clear slot 1');
  const was = $('#metronomeToggle').checked;
  await tap(ML, [0x99, 40, 90], [0x89, 40, 0]);
  ok($('#metronomeToggle').checked !== was, 'pad 5 didn\'t switch the metronome');
  if ($('#metronomeToggle').checked !== was) $('#metronomeToggle').click();
 });
 await check('pads bank B: a key picks the sequencer row, pad 1 of bank B toggles its step 1; held, a pad shows steps 9-16; the bank shows', async ok => {
  const d = dev(ML), s = seq(), was = s.pattern.map(r => [...r]);
  const rowNote = s.notes[1], midiOf = n => Number(n.match(/-?\d+$/)[0]) * 12 + ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(n.replace(/-?\d+$/, ''));
  M.send(ML, [0x90, midiOf(rowNote), 80]); M.send(ML, [0x80, midiOf(rowNote), 0]); await wait(10);
  const before = s.pattern[1][0];
  await tap(ML, [0x99, 44, 90], [0x89, 44, 0]);
  ok(s.pattern[1][0] === !before, `step 1 of ${rowNote} is ${s.pattern[1][0]}`);
  ok(d.bank === 'B', `bank ${d.bank}`);
  M.send(ML, [0x99, 45, 90]); await wait(600); M.send(ML, [0x89, 45, 0]); await wait(10);
  ok(d.stepPage === 1, 'holding a step pad didn\'t show steps 9-16');
  await tap(ML, [0x99, 44, 90], [0x89, 44, 0]);
  ok(s.pattern[1][8] === !was[1][8], 'on steps 9-16, bank B pad 1 should toggle step 9');
  d.stepPage = 0; s.setPattern(was);
 });
 await check('transport: Play (Shift + Pad 6) runs the sequencer; Record while it plays writes knob 5 into the cutoff lane; Stop stops it and switches the lane on', async ok => {
  const d = dev(ML);
  M.send(ML, cc(107, 127)); M.send(ML, cc(107, 0));
  ok(await until(() => seq().running), 'the sequencer isn\'t playing');
  M.send(ML, cc(108, 127)); M.send(ML, cc(108, 0)); await wait(10);
  ok(d.recording, 'Record while playing should record knob moves');
  await sweep(ML, 93, 127); // the cutoff (5000 Hz) is 80% up the knob: a log scale, as the ear hears it
  for (let i = 0; i < 40; i++) { M.send(ML, cc(93, 127 - i * 2)); await wait(25); }
  M.send(ML, cc(106, 127)); M.send(ML, cc(106, 0)); await wait(30);
  ok(!seq().running, 'Stop didn\'t stop the sequencer');
  const lane = seq().lanes.find(l => l.target === 'filterCutoff');
  ok(lane && new Set(lane.points).size > 3, `the cutoff lane has ${lane ? new Set(lane.points).size : 'no'} different values`);
  ok(!d.recording && lane?.enabled, `recording ${d.recording}, lane on ${lane?.enabled}`);
  const box = [...document.querySelectorAll('#automation .automation-lane')].find(b => /Filter cutoff/.test(b.textContent));
  [...box.querySelectorAll('button')].find(b => b.textContent === 'Remove')?.click();
 });

 /* ---- SysEx refused, then allowed ---- */
 await check('SysEx refused: the controls still work, no SysEx is sent, and the widget says why', async ok => {
  M.denySysex = true; M.clear(ML);
  await midi.start({ sysex: true });
  ok(!midi.sysex && midi.state === 'ready' && /SysEx was not allowed/.test(midi.note), `sysex ${midi.sysex}, state ${midi.state}, note ${midi.note}`);
  const n = notes.length; M.send(ML, [0x90, 67, 80]); M.send(ML, [0x80, 67, 0]); await wait(30);
  ok(since(n).some(e => e.on && e.midi === 67), 'the keys stopped working');
  ok(!M.sentHex(ML).some(h => h.startsWith('F0')), `SysEx went out: ${M.sentHex(ML).find(h => h.startsWith('F0'))}`);
  ok(/SysEx was not allowed/.test($('#controllers-module .ctl-status').textContent), 'the widget doesn\'t say SysEx was refused');
  M.denySysex = false;
 });
 await check('SysEx allowed: found by its identity reply, the DAW program from its reply to the program request; the DAW handshake, every pad\'s colour and the screen are sent', async ok => {
  M.unplug(ML); M.unplug('Minilab3 MCU'); M.unplug('Minilab3 ALV'); await wait(30);
  await midi.start({ sysex: true });
  ok(midi.sysex, 'SysEx wasn\'t granted');
  const idReply = captures.sysex.find(s => s.means === 'identity').bytes, dawReply = captures.sysex.find(s => s.why.startsWith('reply to the program request: DAW')).bytes;
  M.plug('USB MIDI Device', { identity: idReply, replies: { 'F0 00 20 6B 7F 42 01 00 40 01 F7': dawReply, 'F0 00 20 6B 7F 42 01 00 40 03 F7': 'F0 00 20 6B 7F 42 02 00 40 63 00 F7' } });
  ok(await until(() => dev('USB MIDI Device')?.preset.id === 'arturia/minilab3'), `a MiniLab 3 under another port name wasn't found by its identity (${dev('USB MIDI Device')?.preset.id})`);
  const d = dev('USB MIDI Device');
  ok(await until(() => d.programId === 'daw'), `program ${d.programId}`);
  ok(d.bank === 'A', `bank ${d.bank}`);
  await until(() => M.sentHex('USB MIDI Device').filter(h => h.startsWith('F0 00 20 6B 7F 42 02 02 16')).length >= 24, 1500);
  const sent = M.sentHex('USB MIDI Device');
  ok(sent.includes('F0 00 20 6B 7F 42 02 02 40 6A 21 F7'), 'no DAW handshake');
  ok(new Set(sent.filter(h => h.startsWith('F0 00 20 6B 7F 42 02 02 16')).map(h => h.split(' ')[9])).size === 24, 'not every pad was coloured');
  ok(sent.some(h => h.startsWith('F0 00 20 6B 7F 42 04 02 60 01')), 'the screen wasn\'t written');
  ok(sent.filter(h => h.startsWith('F0 00 20 6B 7F 42 21 10 00')).length >= 8, 'the encoders weren\'t told their values');
 });
 await check('feedback: nothing is resent while nothing changes; a loop slot recording turns its pad red; turning a knob shows its name and value on the screen', async ok => {
  const N = 'USB MIDI Device', d = dev(N);
  await wait(120); M.clear(N); await wait(200);
  ok(M.sent(N).length <= 2, `${M.sent(N).length} messages went out with nothing changing: ${M.sentHex(N).slice(0, 3).join(' | ')}`);
  await tap(N, [0x99, 36, 90], [0x89, 36, 0]); await wait(120);
  ok(synth.loops()[0].recording, 'pad 1 didn\'t record');
  const pad1 = M.sentHex(N).filter(h => h.startsWith('F0 00 20 6B 7F 42 02 02 16 34'));
  ok(pad1.some(h => /16 34 (7F|33) 00 00 F7$/.test(h)), `pad 1 wasn't red: ${pad1.join(' | ')}`);
  await tap(N, [0x99, 36, 90], [0x89, 36, 0]); await wait(40);
  if (synth.loops()[0].playing) await tap(N, [0x99, 36, 90], [0x89, 36, 0]);
  M.send(N, [0x99, 36, 90]); await wait(600); M.send(N, [0x89, 36, 0]);
  M.clear(N); M.send(N, cc(110, 80)); M.send(N, cc(110, 81)); await wait(100);
  const screen = M.sentHex(N).filter(h => h.startsWith('F0 00 20 6B 7F 42 04 02 60')).map(h => String.fromCharCode(...h.split(' ').slice(10, -1).map(x => parseInt(x, 16)).filter(b => b > 2)));
  ok(screen.some(s => s.startsWith('Cutoff')), `the screen showed ${screen.join(' / ')}`);
  ok(M.sent(N).length < 12, `${M.sent(N).length} messages for two knob moves`);
  void d;
 });
 await check('switching the variation lets go of held notes and redraws every pad', async ok => {
  const N = 'USB MIDI Device', d = dev(N), n = notes.length;
  M.send(N, [0x90, 72, 90]); await wait(20); M.clear(N);
  d.setVariation('looper-drums'); await wait(150);
  ok(since(n).some(e => !e.on && e.midi === 72), 'the held note wasn\'t let go');
  ok(new Set(M.sentHex(N).filter(h => h.startsWith('F0 00 20 6B 7F 42 02 02 16')).map(h => h.split(' ')[9])).size === 24, 'not every pad was redrawn');
  const k = notes.length; await tap(N, [0x99, 36, 100], [0x89, 36, 0]);
  ok(since(k).some(e => e.source === 'midi-drum' && e.drum === 36), 'in Looper & drums, pad 1 should play the kick');
  d.setVariation('performance');
 });
 await check('the preset switched off: pads dark, screen clear, the DAW goodbye; and back on, the hello', async ok => {
  const N = 'USB MIDI Device', d = dev(N);
  M.clear(N); d.setUse(false); await wait(60);
  const sent = M.sentHex(N);
  ok(sent.filter(h => /^F0 00 20 6B 7F 42 02 02 16 .. 00 00 00 F7$/.test(h)).length === 24, 'not every pad went dark');
  ok(sent.includes('F0 00 20 6B 7F 42 04 02 60 01 00 02 00 F7'), 'the screen wasn\'t cleared');
  ok(sent.includes('F0 00 20 6B 7F 42 02 02 40 6A 20 F7'), 'no DAW goodbye');
  M.clear(N); await wait(150);
  ok(!M.sent(N).length, 'feedback went out with the preset off');
  d.setUse(true); await wait(80);
  ok(M.sentHex(N).includes('F0 00 20 6B 7F 42 02 02 40 6A 21 F7'), 'no hello when switched back on');
 });
 await check('its arpeggiator: notes at a machine\'s even spacing become the arpeggiator\'s (not graded as the player\'s); chord mode\'s notes are one onset', async ok => {
  const N = 'USB MIDI Device', d = dev(N), t0 = performance.now() + 5, n = notes.length;
  for (let i = 0; i < 9; i++) { M.send(N, [0x90, 60 + (i % 3) * 4, 90], t0 + i * 125); M.send(N, [0x80, 60 + (i % 3) * 4, 0], t0 + i * 125 + 60); }
  await wait(20);
  const played = since(n).filter(e => e.on);
  ok(played.slice(-3).every(e => e.source === 'arp'), `the last notes came as ${played.map(e => e.source).join(',')}`);
  ok(!timing.onsets.some(o => o.time > t0 + 6 * 125), 'the arpeggiator\'s notes were graded');
  M.send(N, [0x90, 60, 90], t0 + 2000); await wait(5);
  const t = performance.now() + 3000, k = timing.onsets.length;
  [60, 64, 67].forEach(m => M.send(N, [0x90, m, 90], t)); [60, 64, 67].forEach(m => M.send(N, [0x80, m, 0], t + 200)); await wait(20);
  const chord = timing.onsets.slice(k).filter(o => Math.abs(o.time - t) < 1);
  ok(chord.length === 3 && chord.filter(o => !o.chord).length === 1, `the chord's notes: ${chord.length}, ${chord.filter(o => !o.chord).length} graded alone`);
  ok(!d._arp.on, 'a chord should end the arpeggiator');
 });
 await check('MIDI clock out: with Send MIDI clock on, Start and 24 ticks a beat go to the controller while the metronome runs, and Stop', async ok => {
  const N = 'USB MIDI Device';
  midi.set({ clockOut: [N] }); M.clear(N);
  $('#metronomeToggle').click(); await wait(600);
  const ticks = M.sent(N).filter(x => x.bytes[0] === 0xF8);
  ok(M.sent(N).some(x => x.bytes[0] === 0xFA), 'no Start');
  const span = ticks.length > 1 ? ticks.at(-1).time - ticks[0].time : 0, perTick = span / (ticks.length - 1);
  ok(ticks.length > 20 && Math.abs(perTick - 60000 / synth.tempo / 24) < 1, `${ticks.length} ticks, ${perTick.toFixed(2)} ms apart at ${synth.tempo} BPM`);
  $('#metronomeToggle').click(); await wait(30);
  ok(M.sent(N).some(x => x.bytes[0] === 0xFC), 'no Stop');
  midi.set({ clockOut: [] });
 });
 await check('unplugged mid-note: the note stops, and nothing more is sent to it', async ok => {
  const N = 'USB MIDI Device', n = notes.length;
  M.send(N, [0x90, 65, 90]); M.send(N, cc(64, 127)); await wait(20);
  M.unplug(N); await wait(80);
  ok(since(n).some(e => !e.on && e.midi === 65), 'note 65 is stuck');
  ok(!synth.midi.sustained && !synth.midi.held.length, `held ${synth.midi.held}, pedal ${synth.midi.sustained}`);
  ok(!dev(N), 'still listed');
 });
 await check('plugged back in, it keeps its choices (the variation picked)', async ok => {
  M.plug(ML); await until(() => dev(ML));
  dev(ML).setVariation('practice');
  M.unplug(ML); await wait(30); M.plug(ML); await until(() => dev(ML));
  ok(dev(ML)?.variationId === 'practice', `came back as ${dev(ML)?.variationId}`);
  dev(ML).setVariation('performance');
 });

 await check('an official preset\'s hooks get a limited API (send to its device, read its state) for SysEx the JSON doesn\'t read and for each frame', async ok => {
  const d = dev(ML), seen = [];
  d.preset._hooks = { sysex: (api, data) => seen.push(['sysex', Object.keys(api).sort().join(), data.length]), frame: api => { if (!seen.some(x => x[0] === 'frame')) seen.push(['frame', typeof api.state().preset]); return [[0xF0, 0x00, 0x20, 0x6B, 0x7F, 0x42, 0x55, 0xF7]]; } };
  M.clear(ML); M.send(ML, [0xF0, 0x00, 0x20, 0x6B, 0x7F, 0x42, 0x77, 0x01, 0xF7]); await wait(120);
  ok(seen.some(x => x[0] === 'sysex' && x[1] === 'program,send,state' && x[2] === 9), `sysex hook: ${JSON.stringify(seen)}`);
  ok(seen.some(x => x[0] === 'frame' && x[1] === 'string'), 'frame hook not called with the state');
  ok(Object.isFrozen(controllers.hookApi(d)), 'the API can be changed by a hook');
  delete d.preset._hooks;
 });
 await check('the app\'s arpeggiator: held keys play one at a time on the grid as source arp (an armed loop records them), the chord held is told once as midi-held', async ok => {
  const { arp } = await import('../js/arpeggiator.js');
  arp.set({ on: true, rate: '1/16', mode: 'up' });
  const n = notes.length;
  [60, 64, 67].forEach(m => M.send(ML, [0x90, m, 90])); await wait(700);
  [60, 64, 67].forEach(m => M.send(ML, [0x80, m, 0])); await wait(60);
  arp.set({ on: false });
  const played = since(n).filter(e => e.on && e.source === 'arp').map(e => e.midi), told = since(n).filter(e => e.on && e.source === 'midi-held').map(e => e.midi);
  ok(played.length >= 8 && played.slice(0, 6).join() === '60,64,67,60,64,67', `played ${played.join(',')}`);
  ok(told.join() === '60,64,67', `the chord told as ${told.join(',')}`);
  ok(!synth.midi.held.length, `left holding ${synth.midi.held}`);
 });

 /* ---- Generic presets and MIDI learn ---- */
 await check('Generic 8-knob: the first CCs a knob box sends become knobs 1 and 2, in order, and move the page', async ok => {
  M.plug('Knob Box'); await until(() => dev('Knob Box'));
  const d = controllers.choosePreset(dev('Knob Box'), 'generic/knobs');
  for (const v of [10, 20, 30, 40]) M.send('Knob Box', cc(21, v));
  for (const v of [10, 20, 30]) M.send('Knob Box', cc(25, v));
  await wait(20);
  ok(d.overlay.learned.learned?.knob1?.cc === 21 && d.overlay.learned.learned?.knob2?.cc === 25, `learned ${JSON.stringify(d.overlay.learned)}`);
  await sweep('Knob Box', 21, 127);
  ok(Number($('#levelOsc1').value) === Number($('#levelOsc1').max), `knob 1 should move oscillator 1's level (${$('#levelOsc1').value})`);
  $('#levelOsc1').value = 0.3; $('#levelOsc1').dispatchEvent(new Event('input', { bubbles: true }));
 });
 await check('MIDI learn: click Resonance, move an unknown CC: it moves Resonance; saved as a preset, exported and imported back', async ok => {
  const d = dev('Knob Box');
  d.startLearn({ param: 'filterResonance' });
  for (const v of [5, 50, 90, 100]) M.send('Knob Box', cc(70, v));
  await wait(450);
  const learned = Object.entries(d.overlay.learned[d.programId] || {}).find(([, m]) => m.cc === 70);
  ok(learned && d.variation.mappings[learned[0]]?.param === 'filterResonance', `learned ${JSON.stringify(learned)}, mapped ${JSON.stringify(learned && d.variation.mappings[learned[0]])}`);
  await sweep('Knob Box', 70, 127);
  ok(Number($('#filterResonance').value) > 29.9, `resonance ${$('#filterResonance').value}`);
  const p = controllers.presetFrom(d, 'My knob box');
  controllers.savePreset(p);
  ok(controllers.preset('user/my-knob-box')?.status === 'user', 'not saved');
  const text = controllers.exportPreset(controllers.preset('user/my-knob-box'));
  controllers.deletePreset('user/my-knob-box');
  const back = controllers.importPreset(text);
  ok(back.id === 'user/my-knob-box' && back.programs[0].messages[learned[0]].cc === 70, 'the import lost what was learned');
  let refused = ''; try { controllers.importPreset('{"format":1,"id":"x/y"}'); } catch (err) { refused = err.message; }
  ok(/isn't valid/.test(refused), `a broken file was ${refused || 'accepted'}`);
  const fresh = controllers.choosePreset(d, 'user/my-knob-box');
  await sweepDown('Knob Box', 70, 2);
  ok(Number($('#filterResonance').value) < 1, `with the saved preset, CC 70 should still move Resonance (${$('#filterResonance').value})`);
  controllers.deletePreset('user/my-knob-box'); void fresh;
  $('#filterResonance').value = 2; $('#filterResonance').dispatchEvent(new Event('input', { bubbles: true }));
  M.unplug('Knob Box');
 });
 return { checks };
}
