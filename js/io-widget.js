// Import / Export: records or bounces the master output to WAV/AIFF, writes and reads Standard MIDI Files,
// and imports audio clips that can be auditioned, run through the effect chain and converted.
import { FORMATS, AUDIO_EXTENSIONS, encodeAudio, decodeAudioFile } from './audio-files.js';
import { writeMidi, readMidi, songFromNotes } from './midi-file.js';
import { transcribe, transcribeChords } from './listen-dsp.js';
import { pulseFromOnsets } from './timing.js';
import { listening } from './listening.js';
import { timing } from './timing-widget.js';
import { read, save } from './storage.js';
import { el, card } from './plugin-ui.js';

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Same numbering as the synth's MIDI input: "C5" is note 60, middle C.
const toMidi = note => Number(note.match(/-?\d+$/)[0]) * 12 + NAMES.indexOf(note.replace(/-?\d+$/, ''));
const toNote = midi => NAMES[midi % 12] + Math.floor(midi / 12);
const LOOPS = 4;

export function createIoWidget(sequencer) {
 const { section, content } = card('io-module', 'Import / Export');
 const stored = read('synth-io-v1', {});
 const options = (pairs, value) => { const s = el('select'); pairs.forEach(([v, t]) => s.append(el('option', { value: v, textContent: t }))); if (value !== undefined && pairs.some(([v]) => v === value)) s.value = value; return s; };
 const sources = [['seq', 'Step sequencer'], ...Array.from({ length: LOOPS }, (_, i) => [`loop${i}`, `Loop slot ${i + 1}`])];
 const format = options(Object.entries(FORMATS).map(([k, f]) => [k, f.label]), stored.format);
 const source = options([...sources, ['listen', 'Performance heard by Listening']], stored.source);
 const midiTarget = options([...sources.slice(1), sources[0]], stored.midiTarget);
 const repeats = el('input', { type: 'number', min: 1, max: 32, value: stored.repeats || 1 });
 const tail = el('input', { type: 'checkbox', checked: stored.tail ?? true });
 const throughFx = el('input', { type: 'checkbox', checked: !!stored.throughFx });
 [format, source, midiTarget].forEach((s, i) => s.setAttribute('aria-label', ['Audio export format', 'Bounce source', 'MIDI import destination'][i]));
 const persist = () => save('synth-io-v1', { format: format.value, source: source.value, midiTarget: midiTarget.value, repeats: Number(repeats.value), tail: tail.checked, throughFx: throughFx.checked });
 [format, source, midiTarget, repeats, tail, throughFx].forEach(c => c.addEventListener('change', persist));
 const status = el('span', { role: 'status', textContent: 'Drop audio or MIDI files here.' });
 const say = (text, error) => { status.textContent = text; status.classList.toggle('error', !!error); };
 const recordButton = el('button', { textContent: '● Record' }), renderButton = el('button', { textContent: 'Render audio' });
 const picker = el('input', { type: 'file', multiple: true, hidden: true, accept: '.wav,.wave,.aif,.aiff,.aifc,.flac,.mp3,.ogg,.oga,.opus,.m4a,.aac,.caf,.webm,.mid,.midi,.smf,audio/*' });
 const clips = el('div', { className: 'plugin-list' });
 content.append(
  el('div', { className: 'sequence-toolbar' }, el('strong', { textContent: 'Export' }), el('label', {}, 'Audio format ', format)),
  el('div', { className: 'sequence-toolbar io-row' }, recordButton, el('span', { className: 'module-hint', textContent: 'Records everything you play from the master output, after effects.' })),
  el('div', { className: 'sequence-toolbar io-row' }, source, el('label', {}, 'Repeats ', repeats), el('label', {}, tail, 'Release tail'), renderButton,
   el('button', { textContent: 'Export MIDI', onclick: () => exportMidi() })),
  el('p', { className: 'module-hint' }, 'Render audio plays the pattern or loop in real time and saves exactly that many bars or loop lengths, ready to drop on a DAW track. Export MIDI writes a Standard MIDI File (.mid) at the current tempo; for a performance heard by Listening, at the beat it was sung to.'),
  el('div', { className: 'sequence-toolbar io-row' }, el('strong', { textContent: 'Import' }), el('button', { textContent: '+ Import file…', onclick: () => picker.click() }), el('label', {}, 'MIDI into ', midiTarget), status, picker),
  el('p', { className: 'module-hint' }, 'Audio: WAV and AIFF at any bit depth, plus FLAC, MP3, Ogg and M4A where the browser can decode them. MIDI: .mid type 0 or 1, with its tempo map. A loop slot keeps the full timing and plays with the current patch; the step sequencer takes the first bar, snapped to sixteenths on its rows.'),
  el('div', { className: 'sequence-toolbar' }, el('strong', { textContent: 'Clips' }), el('label', {}, throughFx, 'Play through effects')),
  clips);

 // Master recorder. Blocks arrive stamped with their audio-clock frame so bounces can be cut sample-accurately.
 let recorder = null, take = null;
 const recorderNode = async ctx => {
  if (recorder?.context === ctx) return recorder;
  await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
  const node = new AudioWorkletNode(ctx, 'master-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
  const mute = new GainNode(ctx, { gain: 0 });
  node.connect(mute).connect(ctx.destination);
  node.port.onmessage = ({ data }) => {
   if (!take) return;
   if (data.started !== undefined) take.started(data.started);
   if (data.data) take.blocks.push(data);
   if (data.stopped) take.stopped();
  };
  return (recorder = { context: ctx, node });
 };
 const startTake = async () => {
  const ctx = window.synth.ensureAudio();
  await ctx.resume();
  const { node } = await recorderNode(ctx);
  window.synth.output.connect(node);
  take = { blocks: [], rate: ctx.sampleRate };
  await new Promise(resolve => { take.started = frame => { take.first = frame; resolve(); }; node.port.postMessage('start'); });
  return take;
 };
 // Returns stereo channels covering [from, to) audio-clock frames, or everything recorded when omitted.
 const stopTake = async (from, to) => {
  const t = take, { node } = recorder;
  await new Promise(resolve => { t.stopped = resolve; node.port.postMessage('stop'); });
  try { window.synth.output.disconnect(node); } catch { /* Already disconnected. */ }
  take = null;
  const last = t.blocks.length ? t.blocks.at(-1).frame + t.blocks.at(-1).data[0].length : t.first;
  const start = Math.max(t.first, from ?? t.first), end = Math.max(start, Math.min(last, to ?? last));
  const channels = [new Float32Array(end - start), new Float32Array(end - start)];
  t.blocks.forEach(({ frame, data }) => data.forEach((d, c) => {
   const a = Math.max(start, frame), b = Math.min(end, frame + d.length);
   if (b > a) channels[c].set(d.subarray(a - frame, b - frame), a - start);
  }));
  return { channels, sampleRate: t.rate };
 };
 const now = () => Math.round(window.synth.context.currentTime * window.synth.context.sampleRate);
 const wait = ms => new Promise(r => setTimeout(r, ms));
 const releaseTail = () => (window.synth.params().adsr.enabled ? window.synth.params().adsr.release : 0) + 0.25;
 // Plug-in instruments and effects (long releases, echoes, reverb) ring on past the built-in envelope, so after it
 // keep recording until the master output falls below -80 dB, for at most 10 s.
 const audible = () => { const b = take?.blocks.at(-1); return !!b && b.data.some(d => d.some(v => Math.abs(v) > 1e-4)); };
 const settle = async () => {
  await wait(releaseTail() * 1000);
  for (const end = performance.now() + 10000; audible() && performance.now() < end;) await wait(100);
 };
 const busy = on => { recordButton.disabled = renderButton.disabled = on; };

 recordButton.onclick = async () => {
  try {
   if (!take) {
    await startTake();
    busy(true); recordButton.disabled = false; recordButton.textContent = '■ Stop recording'; recordButton.classList.add('recording');
    say('Recording the master output…');
    return;
   }
   const audio = await stopTake();
   busy(false); recordButton.textContent = '● Record'; recordButton.classList.remove('recording');
   addClip(`Recording ${stamp()}`, audio);
  } catch (e) { busy(false); say(e.message, true); }
 };

 renderButton.onclick = async () => {
  const n = Math.max(1, Math.min(32, Math.round(Number(repeats.value) || 1)));
  try {
   busy(true);
   let audio, label;
   if (source.value === 'listen') throw new Error('Render audio plays the sequencer or a loop. To keep a performance as sound, record it into a loop slot with Record: Audio, or press ● Record.');
   if (source.value === 'seq') {
    if (sequencer.running) sequencer.stop();
    if (!sequencer.pattern.some(r => r.some(Boolean))) throw new Error('The step sequencer is empty.');
    await startTake();
    say(`Rendering ${n} bar${n > 1 ? 's' : ''}…`);
    let from, to;
    const steady = !sequencer.lanes.some(l => l.enabled && l.target === 'tempo');
    await sequencer.start({ bars: n, click: false, onStart: () => { from = now(); } });
    // A steady tempo gives an exact bar length; tempo automation uses the measured one.
    to = steady ? from + Math.round(n * 4 * 60 / window.synth.tempo * take.rate) : now();
    if (tail.checked) await settle(); else await wait(50);
    audio = await stopTake(from, tail.checked ? undefined : to);
    label = `Sequence ${n} bar${n > 1 ? 's' : ''}`;
   } else {
    const id = Number(source.value.slice(4)), loop = window.synth.loops()[id];
    if (!loop.events.length || loop.duration <= 0) throw new Error(`Loop slot ${id + 1} is empty.`);
    if (loop.busy) window.synth.stopLoop(id);
    await startTake();
    say(`Rendering loop slot ${id + 1}…`);
    const from = now(), to = from + Math.round(n * loop.duration / 1000 * take.rate);
    window.synth.playLoop(id);
    await wait(n * loop.duration - 5);
    window.synth.stopLoop(id);
    if (tail.checked) await settle();
    else await wait(Math.max(0, (to / take.rate - window.synth.context.currentTime) * 1000) + 50);
    audio = await stopTake(from, tail.checked ? undefined : to);
    label = `Loop ${id + 1} ×${n}`;
   }
   addClip(`${label} ${stamp()}`, audio);
  } catch (e) {
   if (take) await stopTake().catch(() => {});
   say(e.message, true);
  } finally { busy(false); }
 };

 const download = (blob, name) => {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
 };
 const fileName = name => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'export';
 const stamp = () => new Date().toTimeString().slice(0, 8).replace(/:/g, '.');

 // Notes heard in time as a song: on the beat clock's beats when one was running (so it lines up in a DAW at the
 // session tempo), else at the pulse the notes themselves have, else at the session tempo from the first note.
 const songOf = (notes, name) => {
  const c = timing.clock, first = Math.min(...notes.map(n => n.start));
  if (c.running && c.source !== 'free' && notes.every(n => n.start >= c.origin - c.period * 64)) return songFromNotes(notes, { name, bpm: c.bpm, origin: c.timeOf(Math.floor(c.beatAt(first) / c.beatsPerBar) * c.beatsPerBar) });
  const pulse = pulseFromOnsets(notes.map(n => n.start));
  if (pulse) { const k = Math.ceil((pulse.origin - first) / (60000 / pulse.bpm)); return songFromNotes(notes, { name, bpm: pulse.bpm, origin: pulse.origin - k * (60000 / pulse.bpm) }); }
  return songFromNotes(notes, { name, bpm: window.synth.tempo });
 };
 const exportMidi = () => {
  const bpm = window.synth.tempo;
  try {
   if (source.value === 'listen') {
    const notes = listening.performance();
    if (!notes.length) throw new Error('Nothing has been heard yet: press 🎙 Listen in the Listening widget and sing or play.');
    const song = songOf(notes, 'Performance');
    download(writeMidi(song), 'performance.mid');
    say(`Exported ${notes.length} notes heard by Listening as MIDI at ${song.bpm} BPM.`);
    return;
   }
   if (source.value === 'seq') {
    const n = Math.max(1, Math.round(Number(repeats.value) || 1)), pattern = sequencer.pattern;
    const notes = [];
    for (let bar = 0; bar < n; bar++) pattern.forEach((row, r) => row.forEach((on, step) => {
     if (on) notes.push({ midi: toMidi(sequencer.notes[r]), velocity: 0.65, start: bar * 4 + step / 4, end: bar * 4 + step / 4 + 0.18 });
    }));
    if (!notes.length) throw new Error('The step sequencer is empty.');
    // An enabled tempo lane becomes a tempo change on every sixteenth.
    const lane = sequencer.lanes.find(l => l.enabled && l.target === 'tempo');
    const tempos = lane && Array.from({ length: n * 16 }, (_, i) => ({ beat: i / 4, bpm: lane.points[i % 16] }));
    download(writeMidi({ name: 'Step sequence', bpm, tempos, tracks: [{ name: 'Synth', notes }] }), 'step-sequence.mid');
    say(`Exported ${notes.length} notes as MIDI.`);
    return;
   }
   const id = Number(source.value.slice(4)), loop = window.synth.loops()[id];
   if (!loop.events.length) throw new Error(`Loop slot ${id + 1} is empty.`);
   const beats = ms => ms / 1000 * bpm / 60, open = new Map(), notes = [], n = Math.max(1, Math.round(Number(repeats.value) || 1));
   for (let k = 0; k < n; k++) {
    loop.events.forEach(e => {
     const at = beats(e.time + k * loop.duration);
     if (e.type === 'noteon') { if (!open.has(e.note)) open.set(e.note, []); open.get(e.note).push({ midi: toMidi(e.note), velocity: e.velocity, start: at }); }
     else { const on = open.get(e.note)?.shift(); if (on) notes.push({ ...on, end: at }); }
    });
    open.forEach(list => list.splice(0).forEach(on => notes.push({ ...on, end: beats((k + 1) * loop.duration) })));
   }
   download(writeMidi({ name: `Loop slot ${id + 1}`, bpm, tracks: [{ name: 'Synth', notes }] }), `loop-slot-${id + 1}.mid`);
   say(`Exported ${notes.length} notes as MIDI at ${bpm} BPM.`);
  } catch (e) { say(e.message, true); }
 };

 const importMidi = (bytes, name) => {
  const song = readMidi(bytes);
  if (!song.notes.length) throw new Error(`${name} has no notes.`);
  if (midiTarget.value === 'seq') {
   const rows = sequencer.notes.map(toMidi), pattern = rows.map(() => Array(16).fill(false));
   let placed = 0;
   song.notes.forEach(n => { const step = Math.round(n.start * 4), row = rows.indexOf(n.midi); if (step < 16 && row >= 0) { pattern[row][step] = true; placed++; } });
   if (!placed) throw new Error(`None of the notes in ${name}'s first bar match the sequencer rows (${sequencer.notes.join(', ')}). Import into a loop slot instead.`);
   if (sequencer.running) sequencer.stop();
   sequencer.setPattern(pattern);
   window.synth.tempo = Math.round(song.bpm * 10) / 10;
   say(`Placed ${placed} of ${song.notes.length} notes from ${name} in the step sequencer.`);
   return;
  }
  const id = Number(midiTarget.value.slice(4)), params = window.synth.params();
  const bar = song.barBeats, lastBeat = Math.max(...song.notes.map(n => n.end));
  const duration = song.seconds(Math.max(bar, Math.ceil(lastBeat / bar - 1e-6) * bar)) * 1000;
  const events = song.notes.flatMap(n => [
   { type: 'noteon', note: toNote(n.midi), velocity: n.velocity, time: n.startSec * 1000, synthParams: params },
   { type: 'noteoff', note: toNote(n.midi), velocity: 0, time: Math.min(duration - 1, Math.max(n.startSec * 1000 + 10, n.endSec * 1000)) }
  ]).sort((a, b) => a.time - b.time || (a.type === 'noteoff' ? -1 : 1));
  window.synth.setLoop(id, events, duration);
  window.synth.tempo = Math.round(song.bpm * 10) / 10;
  say(`Imported ${song.notes.length} notes from ${name} into loop slot ${id + 1} (${(duration / 1000).toFixed(1)} s).`);
 };

 let playing = null;
 const stopPlaying = () => { if (playing) { try { playing.stop(); } catch { /* Already ended. */ } playing = null; } };
 const addClip = (name, audio) => {
  const { channels, sampleRate } = audio, seconds = channels[0].length / sampleRate;
  const play = el('button', { textContent: '▶ Play' });
  // Transcribe to MIDI: the clip's notes, heard as the Listening widget hears them (one at a time, or chords in
  // its Chords mode, by its built-in ear or Basic Pitch), into wherever MIDI goes (a loop slot or the step
  // sequencer), and a .mid to download.
  const midiLink = el('button', { textContent: 'Download .mid', hidden: true });
  const toMidi = el('button', { textContent: 'Transcribe to MIDI', title: 'Hear the notes in this clip (as the Listening widget\'s mode says: one at a time, or chords) and put them where MIDI goes' });
  toMidi.onclick = async () => {
   toMidi.disabled = true;
   try {
    say(`Listening to ${name}…`);
    await new Promise(r => setTimeout(r, 20));
    const mono = channels.length > 1 ? Float32Array.from(channels[0], (v, i) => channels.reduce((a, c) => a + c[i], 0) / channels.length) : channels[0];
    const chords = listening.settings.mode === 'chords', model = chords && listening.settings.chordEngine === 'basic-pitch';
    let heard;
    if (model) {
     try { heard = await (await import('./poly-model.js')).transcribeWithModel(mono, sampleRate, text => say(text)); }
     catch (e) { say(`Basic Pitch couldn't load (${e.message}), so the built-in ear transcribed ${name} instead.`, true); heard = transcribeChords(mono, sampleRate); }
    } else heard = chords ? transcribeChords(mono, sampleRate) : transcribe(mono, sampleRate);
    if (!heard.length) throw new Error(`No notes were heard in ${name}.`);
    const blob = writeMidi(songOf(heard, name));
    importMidi(new Uint8Array(await blob.arrayBuffer()), `${name} (transcribed)`);
    midiLink.hidden = false; midiLink.onclick = () => download(blob, `${fileName(name)}.mid`);
    box.dataset.transcribed = heard.map(n => n.midi).join(' ');
   } catch (e) { say(e.message, true); } finally { toMidi.disabled = false; }
  };
  const box = el('div', { className: 'plugin-card io-clip' },
   el('div', { className: 'sequence-toolbar' }, el('strong', { textContent: name }),
    el('span', { className: 'module-hint', textContent: `${seconds.toFixed(2)} s · ${sampleRate} Hz · ${channels.length === 1 ? 'mono' : channels.length === 2 ? 'stereo' : channels.length + ' ch'}` }),
    play,
    el('button', { textContent: 'Download', onclick: () => { const f = FORMATS[format.value]; download(encodeAudio(channels, sampleRate, format.value), `${fileName(name)}.${f.ext}`); } }),
    toMidi, midiLink,
    el('button', { textContent: 'Match this sound', title: 'Find a synth patch that sounds like this clip\'s first note (Sound match)', onclick: () => window.dispatchEvent(new CustomEvent('synth:match-sound', { detail: { channels, sampleRate, name } })) }),
    el('button', { textContent: 'Remove', onclick: () => { if (play.source) stopPlaying(); box.remove(); } })));
  play.onclick = () => {
   if (play.source && playing === play.source) { stopPlaying(); return; }
   stopPlaying();
   const ctx = window.synth.ensureAudio(), buffer = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
   channels.forEach((c, i) => buffer.copyToChannel(c, i));
   const src = playing = play.source = new AudioBufferSourceNode(ctx, { buffer });
   src.connect(throughFx.checked ? window.synth.fx.input : window.synth.output);
   play.textContent = '■ Stop';
   src.onended = () => { play.textContent = '▶ Play'; src.disconnect(); if (playing === src) playing = null; };
   ctx.resume().then(() => src.start());
  };
  clips.prepend(box);
  say(`${name}: ${seconds.toFixed(1)} s. Download saves it as ${FORMATS[format.value].label}.`);
 };

 const load = async file => {
  try {
   const bytes = new Uint8Array(await file.arrayBuffer());
   if (/\.(mid|midi|smf)$/i.test(file.name) || String.fromCharCode(...bytes.subarray(0, 4)) === 'MThd') return importMidi(bytes, file.name);
   if (!AUDIO_EXTENSIONS.test(file.name) && !file.type.startsWith('audio/')) throw new Error(`${file.name} is not an audio or MIDI file.`);
   say(`Reading ${file.name}…`);
   const audio = await decodeAudioFile(bytes, window.synth.ensureAudio()).catch(e => { throw new Error(`Could not decode ${file.name}: ${e.message || 'unsupported format in this browser'}.`); });
   addClip(file.name.replace(/\.[^.]+$/, ''), audio);
  } catch (e) { say(e.message, true); }
 };
 picker.onchange = () => { [...picker.files].forEach(load); picker.value = ''; };
 section.addEventListener('dragover', e => { e.preventDefault(); section.classList.add('drop-target'); });
 section.addEventListener('dragleave', () => section.classList.remove('drop-target'));
 section.addEventListener('drop', e => { e.preventDefault(); section.classList.remove('drop-target'); [...e.dataTransfer.files].forEach(load); });
 return section;
}
