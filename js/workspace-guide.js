// What the teacher knows about the workspace: a guide to every widget and built-in plug-in (what it is for,
// and how to use it, each step pointing at its control), and a course unit that teaches the widgets with
// tasks checked from the workspace's own state (js/workspace.js state()). The guides are keyed by widget
// title; plug-ins by name, or by what was learned about them (js/plugin-profile.js).
import { guideFromProfile } from './plugin-profile.js';

// how: [text, control to point at ("Widget › Control", a widget title, or an element id)]
export const GUIDES = {
 'Keyboard': {
  what: 'Play notes with the mouse, touch, your computer keyboard (A is C, W is C♯, S is D, and so on) or a MIDI controller. Falling notes show above the keys as you play.',
  how: [['Click or tap a key to play it; drag across keys for a glissando.', 'Keyboard'], ['Turn the falling notes on or off.', 'synthesiaToggle'], ['Change how many octaves show in Master & Settings › Keyboard Octaves; two octaves are 25 keys, like a 25-key controller.', 'numOctavesSelect']],
  keywords: ['keys', 'piano', 'falling notes', 'midi controller', 'computer keyboard'],
 },
 'Listening': {
  what: 'Audio In: sing, hum, whistle or play an instrument into the microphone (or an audio interface) and the app plays along as if from a keyboard. The notes light the keys, fall, are recorded by an armed loop slot and reach the teacher and the beat clock. The tuner shows the note and how many cents off it is.',
  how: [['Press 🎙 Listen and allow the microphone; the red Mic on pill at the top says it is open.', 'listen-toggle'], ['Choose the input: a microphone or an audio interface\'s input.', 'listen-device'], ['Tick Snap to the sequencer\'s key and scale so every note lands in the key.', 'listen-snap'], ['With headphones on, tick I\'m wearing headphones, then Play what I sing through the synth to hear it as the patch.', 'listen-headphones'], ['Raise the noise gate if the room is heard as notes.', 'listen-gate'], ['Calibrate latency once, so notes land on the beat you sang them on.', 'listen-calibrate'], ['Mode: Melody, Chords (a piano or guitar, approximate), Rhythm only (claps), or Speech (talk to the teacher). The teacher\'s 🎙 Talk listens to talk and singing together.', 'listen-mode']],
  keywords: ['listen', 'listening', 'microphone', 'mic', 'sing', 'singing', 'hum', 'whistle', 'voice', 'tuner', 'audio in', 'latency', 'headphones', 'in tune', 'cents'],
 },
 'Step sequencer': {
  what: 'A 16-step pattern player. Each row is a note of the chosen key and scale; each column is a sixteenth note.',
  how: [['Click cells to turn steps on.', 'Step sequencer'], ['Choose the key, scale and octave the rows follow; changing them moves the pattern with them.', 'seq-scale'], ['Set the speed with Base BPM.', 'seq-bpm'], ['Press ▶ Play to hear it, ■ Stop to stop.', 'seq-play'], ['Clear notes empties the grid.', 'seq-clear'], ['● Record from audio: sing or play one bar into the microphone after a bar of count-in, and it becomes the pattern, on sixteenths, in the key and scale.', 'seq-record']],
  keywords: ['sequencer', 'pattern', 'steps', 'grid', 'beat'],
 },
 'Automation': {
  what: 'Lanes that change a setting over the 16 steps while the sequencer plays: tempo, filter cutoff, resonance, volume or detune.',
  how: [['Pick a target and press + Add lane.', 'automation-target'], ['Tick a lane to switch it on; it only moves while the sequencer plays.', 'Automation'], ['Ramp up and Flatten reshape a whole lane; or drag single step values.', 'Automation › Ramp up'], ['Linear glides between steps; hold keeps each value until the next step.', 'Automation'], ['From the microphone: + Add mapping lets your voice move a control as you sing (brightness opening the filter, loudness the volume); ● Record lane writes a feature of what you sing over one bar into a lane.', 'listen-map-add']],
  keywords: ['automation', 'lane', 'ramp', 'automate'],
 },
 'Oscillators': {
  what: 'The sound sources, layered in every note: as many oscillators as you like, each with its own waveform (sine is pure, triangle soft, square hollow, sawtooth bright and buzzy, pulse nasal, or white or pink noise), octave, detune, level and start delay. It starts with two sawtooths and a square two octaves down.',
  how: [['Choose an oscillator\'s waveform.', 'waveformOsc1'], ['+ Add oscillator layers another one; × removes one.', 'addOscillator'], ['Octave shifts an oscillator up or down; −1 or −2 makes it a sub oscillator, for weight.', 'octaveOsc1'], ['Detune one oscillator a few cents against another for a thicker, chorused sound.', 'detuneOsc1'], ['Level sets how loud each oscillator is in the mix.', 'levelOsc1'], ['Choose Pulse as a waveform and its Pulse width slider shapes it, from thin to square.', 'waveformOsc1'], ['Keyboard Octave moves the on-screen keyboard up or down.', 'baseOctave'], ['Oscillator Slop adds a little random detune per note, like an analogue synth.', 'oscSlop']],
  keywords: ['oscillator', 'oscillators', 'osc', 'waveform', 'wave', 'sawtooth', 'square', 'sine', 'triangle', 'pulse', 'detune', 'tone', 'sub', 'noise', 'layer', 'thick', 'slop'],
 },
 'Envelope (ADSR)': {
  what: 'How each note\'s volume moves over time: Attack (fade in), Decay (fall to the sustain level), Sustain (the level while held) and Release (fade out after you let go).',
  how: [['Attack: how slowly each note fades in. Short for a pluck, long for a slow swell.', 'attack'], ['Decay and Sustain: the level a held note settles to; a low sustain makes it die away while you hold it.', 'sustain'], ['Release: how long a note rings on after you let go.', 'release']],
  keywords: ['envelope', 'adsr', 'attack', 'decay', 'sustain', 'release', 'fade', 'swell', 'pluck'],
 },
 'Metronome & Tempo': {
  what: 'The session tempo, used by the sequencer, the loop recorder and tempo-synced plug-ins, and a metronome to play along with.',
  how: [['Switch the metronome on.', 'metronomeToggle'], ['Nudge the tempo with − and +.', 'bpmIncrement'], ['Tap BPM a few times in time to set the tempo by ear.', 'tapTempoButton']],
  keywords: ['metronome', 'tempo', 'bpm', 'click', 'tap'],
 },
 'Filter': {
  what: 'Shapes the tone by removing frequencies. A lowpass filter cuts the highs: lower the cutoff and the sound gets darker. Resonance boosts the frequencies right at the cutoff for a sharper, vocal sound.',
  how: [['Choose the type: lowpass, highpass, bandpass, notch or allpass.', 'filterType'], ['Cutoff: lower it to make the sound darker, raise it to make it brighter.', 'filterCutoff'], ['Resonance (Q): the peak at the cutoff.', 'filterResonance']],
  keywords: ['filter', 'cutoff', 'resonance', 'lowpass', 'highpass', 'bandpass', 'darker', 'brighter'],
 },
 'Master & Settings': {
  what: 'Overall volume and how the app looks: the number of keyboard octaves, what the oscilloscope shows, the colour theme and the size of the interface.',
  how: [['Volume sets the master level.', 'masterVolume'], ['Keyboard Octaves: how many octaves the on-screen keyboard shows.', 'numOctavesSelect'], ['Visualizer Source: the master output or one oscillator.', 'visualizerSourceSelect'], ['UI Theme and UI Scale change colours and size.', 'uiTheme'], ['Input gain sets how loud the Listening widget hears the microphone; with headphones, Hear the input through Air and the plug-ins lets you hear yourself through the effects.', 'listen-input-gain']],
  keywords: ['volume', 'theme', 'scale', 'settings', 'octaves', 'master'],
 },
 'Loop recorder': {
  what: 'Four slots that record what you play as notes, with the sound you played them with, and loop it. Recording starts and stops on the beat.',
  how: [['To record a loop, press Arm on a slot, play, then press Arm again to finish recording.', 'Loop recorder › Arm 1'], ['Play loops a slot you have recorded; press it again to stop.', 'Loop recorder › Play 1'], ['Clear empties a slot.', 'Loop recorder › Clear 1'], ['Record: Notes keeps what you play or sing as notes, played back with their sound; Audio keeps the sound itself, as the Listening widget hears it.', 'looper-record-kind']],
  keywords: ['loop', 'looper', 'record a loop', 'slot', 'arm', 'overdub'],
 },
 'Oscilloscope': {
  what: 'Draws the sound wave as it plays, so you can see what the waveform, filter and effects do to it.',
  how: [['Play a note and watch the wave.', 'Oscilloscope'], ['Choose what it shows in Master & Settings › Visualizer Source: the output, one oscillator, or Input (Listening), the microphone with the note it hears.', 'visualizerSourceSelect']],
  keywords: ['oscilloscope', 'scope', 'wave', 'visualizer', 'visualiser'],
 },
 'Air': {
  what: 'A built-in enhancer after the filter and volume: Mid Air adds presence around 2.8 kHz, High Air adds a shelf and sparkle above 6 kHz, and Trim balances the level.',
  how: [['Enable it.', 'Air › Enabled'], ['Raise High Air for sparkle, Mid Air for presence.', 'Air › High Air'], ['Use Trim to keep the level the same with it on and off.', 'Air › Trim']],
  keywords: ['air', 'presence', 'sparkle', 'enhancer', 'exciter'],
 },
 'Plugins': {
  what: 'Adds effect and instrument plug-ins. Effects run in the order loaded, after the synth; instruments replace the built-in voices (or layer with them). Each plug-in opens its own window with its controls.',
  how: [['Choose a built-in effect or instrument and press Add built-in.', 'Plugins › Built-in effect'], ['Load your own Web Audio Module or web plug-in archive with + Load file…, or drop it on the widget.', 'Plugins › + Load file…'], ['Each row has Bypass, Open (its window) and Remove.', 'Plugins'], ['Capture a plugin… measures a native plug-in\'s sound in your DAW and rebuilds it here.', 'Plugins › Capture a plugin…']],
  keywords: ['plugin', 'plug-in', 'plugins', 'effect', 'effects', 'vst', 'vst3', 'wam', 'reverb', 'delay', 'compressor', 'chorus', 'saturator', 'instrument'],
 },
 'Import / Export': {
  what: 'Gets your work into a DAW and back: export MIDI, render the sequencer or a loop to WAV or AIFF, record the output, and import audio or MIDI files.',
  how: [['Record captures everything you hear, after effects.', 'Import / Export › ● Record'], ['Render audio plays the sequencer or a loop slot and saves exactly that many bars.', 'Import / Export › Render audio'], ['Export MIDI saves the notes for any DAW.', 'Import / Export › Export MIDI'], ['Import a .mid into a loop slot or the sequencer, or an audio file as a clip.', 'Import / Export › + Import file…'], ['A clip\'s Transcribe to MIDI hears its notes and puts them where MIDI goes, with a .mid to download.', 'Import / Export › MIDI import destination'], ['Choose Performance heard by Listening, then Export MIDI, to save what you sang or played into the microphone.', 'Import / Export › Bounce source']],
  keywords: ['export', 'import', 'render', 'wav', 'aiff', 'mid', 'midi file', 'bounce', 'download', 'daw', 'my daw', 'a daw', 'into my', 'ableton', 'logic', 'fl studio', 'save'],
 },
 'Settings': {
  what: 'The ☰ Settings menu at the top right: stop every sound, the floating PANIC button, the AI teacher and its 🎓 buttons, and which widgets show.',
  how: [['Stop all sounds is the panic: every note, loop, the sequencer and the metronome stop.', 'settings-panic'], ['Switch on the floating PANIC button to keep the panic on the page.', 'settings-panic-button'], ['Switch on 🎓 buttons and every widget gets one that opens its guide.', 'settings-teach-buttons']],
  keywords: ['settings', 'menu', 'panic', 'stop all sounds', '🎓', 'teach buttons', 'guide buttons'],
 },
};

export const PLUGIN_GUIDES = {
 Reverb: { what: 'Simulates a room or hall: the sound keeps ringing after each note.', how: [['Decay: how long the room rings.', 'Decay'], ['Pre-delay: a gap before the reverb starts, keeping notes clear.', 'Pre-delay'], ['Tone: darker or brighter reflections.', 'Tone'], ['Mix: how much reverb against the dry sound.', 'Mix']] },
 Delay: { what: 'Repeats the sound as echoes.', how: [['Time: the gap between echoes.', 'Time'], ['Feedback: how many echoes before they die away.', 'Feedback'], ['Tone: darker echoes sit further back.', 'Tone'], ['Mix: how loud the echoes are.', 'Mix']] },
 Compressor: { what: 'Evens out the level: loud parts are turned down, so the sound is steadier and can be made louder overall.', how: [['Threshold: the level where it starts working.', 'Threshold'], ['Ratio: how strongly it turns loud parts down.', 'Ratio'], ['Attack and Release: how fast it reacts and lets go.', 'Attack'], ['Makeup: gain to bring the level back up.', 'Makeup']] },
 Saturator: { what: 'Adds warmth and grit by driving the sound into soft distortion.', how: [['Drive: how hard it is pushed.', 'Drive'], ['Tone: the colour of the distortion.', 'Tone'], ['Mix: blend with the clean sound.', 'Mix'], ['Output: match the level.', 'Output']] },
 Chorus: { what: 'Thickens the sound with slightly detuned, moving copies, like several players at once.', how: [['Rate: how fast the copies move.', 'Rate'], ['Depth: how far they drift.', 'Depth'], ['Mix: how much of the effect.', 'Mix']] },
 Air: { what: 'Adds presence and sparkle.', how: [['Mid Air: presence around 2.8 kHz.', 'Mid Air'], ['High Air: shelf and sparkle above 6 kHz.', 'High Air'], ['Trim: level.', 'Trim']] },
};
const INSTRUMENT = { what: 'A plug-in instrument: it plays from the keyboard, your controller, the sequencer and the loop recorder in place of the built-in synth (or layered with it).', how: [['Play the keys to hear it.', 'Keyboard'], ['Change its sound with the controls in its window.', null], ['Layer built-in synth plays both at once.', 'Layer built-in synth']] };
const EFFECT = { what: 'An effect plug-in in the chain after the synth. Its window lists its controls; Bypass compares the sound with and without it.', how: [['Change its controls in its window and play to hear them.', null], ['Bypass switches it off without removing it.', 'Bypass']] };

// What has been learned about each loaded plug-in (js/plugin-profile.js), by window title.
export const profiles = new Map();

// The guide for a widget, by title. A plug-in window gets its plug-in's written guide if it has one, else the
// guide made from what was learned about it, else a general one; its steps name its own controls.
export function guideFor(w) {
 if (!w.plugin) return GUIDES[w.title] || null;
 const known = PLUGIN_GUIDES[w.title.replace(/^VST3:\s*/, '')];
 const bypass = ['Bypass switches it off without removing it, so you can compare the sound with and without it.', `${w.title} › Bypass`];
 const withBypass = g => (g.how.some(([, t]) => /Bypass$/.test(t || '')) ? g : { ...g, how: [...g.how, bypass] });
 if (!known && profiles.has(w.title)) return withBypass(guideFromProfile(profiles.get(w.title), w.title));
 const g = known || (/Instrument/.test(w.el.textContent) ? INSTRUMENT : EFFECT);
 return withBypass({ ...g, how: g.how.map(([text, target]) => [text, target && `${w.title} › ${target}`]) });
}
export const KEYWORDS = Object.fromEntries(Object.entries(GUIDES).map(([title, g]) => [title, g.keywords || []]));

/* ---- Course unit: using the workspace ---- */

// Each lesson names the widget it teaches and the controls to point at; check(p, ws) gets what was played
// (js/lessons.js Attempt) and the workspace state, and is run as the student works.
export const WORKSPACE_UNIT = 'Using the workspace';
const played = p => p.notes.length > 0;
export const WORKSPACE_LESSONS = [
 {
  id: 'ws_widgets', unit: WORKSPACE_UNIT, widget: 'Oscilloscope', title: 'Your workspace',
  text: 'Every panel here is a widget. Drag one by its title bar to move it, use – to minimise it to its title, ↔ to make it wide and × to hide it. The ☰ Settings menu at the top shows hidden widgets again and can reset the layout. Your layout is saved.',
  task: 'Minimise the Oscilloscope with its – button.', hint: 'The – button is on the right of the Oscilloscope\'s title bar.',
  show: ['Oscilloscope'], check: (p, ws) => ws.minimized.includes('scope-module'),
 },
 {
  id: 'ws_oscillators', unit: WORKSPACE_UNIT, widget: 'Oscillators', title: 'Oscillators: the raw sound',
  text: 'A synth starts with oscillators. The waveform decides the basic tone: sine is pure, triangle soft, square hollow, sawtooth bright. Every note layers all the oscillators in the bank: + Add oscillator stacks another, a few cents of detune between two makes the sound thicker, and one an octave or two down adds weight.',
  task: 'Set the first oscillator\'s waveform to Square, then play a note.', hint: 'Use the Waveform menu of Oscillator 1, in the Oscillators widget.',
  show: ['waveformOsc1'], check: (p, ws) => ws.value('waveformOsc1') === 'square' && played(p),
 },
 {
  id: 'ws_envelope', unit: WORKSPACE_UNIT, widget: 'Envelope (ADSR)', title: 'The envelope: attack and release',
  text: 'The envelope shapes each note over time. Attack is how long it takes to fade in, decay and sustain set the level while you hold the key, and release is how long it rings after you let go. A slow attack turns a pluck into a swell.',
  task: 'Set Attack to half a second or more, then play a note and hear it fade in.', hint: 'Drag the Attack (s) slider in Envelope (ADSR) to 0.5 or more.',
  show: ['attack'], check: (p, ws) => Number(ws.value('attack')) >= 0.5 && played(p),
 },
 {
  id: 'ws_filter', unit: WORKSPACE_UNIT, widget: 'Filter', title: 'The filter: brighter and darker',
  text: 'The filter removes part of the sound. A lowpass filter lets the lows through and cuts the highs, so lowering the cutoff makes the sound darker. Resonance adds a peak at the cutoff, which gives the classic synth "wah" when the cutoff moves.',
  task: 'Lower the Cutoff below 1000 Hz, then play a note.', hint: 'Drag the Cutoff (Hz) slider in Filter to the left.',
  show: ['filterCutoff'], check: (p, ws) => Number(ws.value('filterCutoff')) < 1000 && played(p),
 },
 {
  id: 'ws_tempo', unit: WORKSPACE_UNIT, widget: 'Metronome & Tempo', title: 'Metronome and tempo',
  text: 'The tempo, in beats per minute, drives the sequencer, the loop recorder and tempo-synced plug-ins. Tap BPM a few times in time to set it by ear, or nudge it with − and +. The metronome clicks each beat for you to play along with.',
  task: 'Switch the metronome on.', hint: 'Tick Metronome in the Metronome & Tempo widget.',
  show: ['metronomeToggle'], check: (p, ws) => ws.value('metronomeToggle') === true,
 },
 {
  id: 'ws_sequencer', unit: WORKSPACE_UNIT, widget: 'Step sequencer', title: 'The step sequencer',
  text: 'The step sequencer plays a 16-step pattern on a loop. Each row is a note of the key and scale you choose, each column a sixteenth note. Click cells to turn them on; change the key or scale and the pattern follows.',
  task: 'Turn on at least four steps, then press ▶ Play.', hint: 'Click cells in the grid, then the ▶ Play button above it.',
  show: ['Step sequencer', 'seq-play'], check: (p, ws) => ws.seqSteps >= 4 && ws.seqPlaying,
 },
 {
  id: 'ws_looper', unit: WORKSPACE_UNIT, widget: 'Loop recorder', title: 'The loop recorder',
  text: 'The loop recorder records what you play as notes, along with the sound you played them with, and loops it. Recording starts and ends on the beat, so loops stay in time. Record a bass line in one slot and play over it.',
  task: 'Record a loop in slot 1: press Arm, play a few notes, then press it again to finish.', hint: 'Press Arm on the first slot, play, and press the same button again.',
  show: ['Loop recorder › Arm 1'], check: (p, ws) => ws.loops[0] === true,
 },
 {
  id: 'ws_automation', unit: WORKSPACE_UNIT, widget: 'Automation', title: 'Automation lanes',
  text: 'Automation changes a setting step by step while the sequencer plays: speed up the tempo, open the filter over a bar, or fade the volume. Add a lane for a target, switch it on and shape it.',
  task: 'Switch on an automation lane and press Ramp up to shape it.', hint: 'Tick the lane\'s checkbox, then press Ramp up in that lane.',
  show: ['Automation › Ramp up'], check: (p, ws) => ws.lanesOn > 0 && ws.automationShaped,
 },
 {
  id: 'ws_plugins', unit: WORKSPACE_UNIT, widget: 'Plugins', title: 'Adding an effect plug-in',
  text: 'Effects change the sound after the synth: delay repeats it, reverb puts it in a room, chorus thickens it, compression evens it out. Effects run in the order you add them, and each opens its own window with its controls.',
  task: 'Add the built-in Delay: choose Delay and press Add built-in.', hint: 'In the Plugins widget, pick Delay in the menu, then press Add built-in.',
  show: ['Plugins › Built-in effect'], check: (p, ws) => ws.plugins.some(n => /delay/i.test(n)),
 },
 {
  id: 'ws_plugin_controls', unit: WORKSPACE_UNIT, widget: 'Plugins', title: 'A plug-in\'s controls',
  text: 'Each plug-in has its own window; Open in its row brings it back if you closed it. Change a control while you play to hear what it does, and use Bypass to compare the sound with and without the plug-in.',
  task: 'Open a plug-in\'s window and change one of its controls.', hint: 'Press Open on a plug-in\'s row in Plugins, then move a slider in its window.',
  show: ['Plugins'], check: (p, ws) => ws.plugins.length > 0 && ws.pluginEdits,
 },
 {
  id: 'ws_instrument', unit: WORKSPACE_UNIT, widget: 'Plugins', title: 'Plug-in instruments',
  text: 'Instrument plug-ins replace the built-in synth: they play from the keys, your controller, the sequencer and the loop recorder. The MDA Piano, ePiano, JX10 and DX10 are built in. Tick Layer built-in synth to hear both at once.',
  task: 'Add the VST3 instrument MDA Piano, then play a few notes.', hint: 'In Plugins, choose "VST3 instrument: MDA Piano" and press Add built-in.',
  show: ['Plugins › Built-in effect'], check: (p, ws) => ws.plugins.some(n => /piano/i.test(n)) && played(p),
 },
 {
  id: 'ws_air', unit: WORKSPACE_UNIT, widget: 'Air', title: 'Air: presence and sparkle',
  text: 'Air is a gentle enhancer at the end of the chain. Mid Air brings the sound forward, High Air adds sparkle at the top. Small amounts go a long way; Trim keeps the level fair when you compare.',
  task: 'Enable Air and raise High Air.', hint: 'Tick Enabled in the Air widget, then move High Air to the right.',
  show: ['Air › Enabled', 'Air › High Air'], check: (p, ws) => ws.value('Air › Enabled') === true && Number(ws.value('Air › High Air')) > 0,
 },
 {
  id: 'ws_scope', unit: WORKSPACE_UNIT, widget: 'Oscilloscope', title: 'Seeing the sound',
  text: 'The oscilloscope draws the wave as it plays. Point it at one oscillator to see its waveform on its own, then back at the master output to see what the filter and effects do.',
  task: 'Set Visualizer Source to Oscillator 1, then play a note.', hint: 'Visualizer Source is in Master & Settings.',
  show: ['visualizerSourceSelect'], check: (p, ws) => ws.value('visualizerSourceSelect') === 'osc1' && played(p),
 },
 {
  id: 'ws_export', unit: WORKSPACE_UNIT, widget: 'Import / Export', title: 'Taking it to a DAW',
  text: 'Import / Export moves your work out: Export MIDI saves the notes of the sequencer or a loop slot for any DAW, Render audio records them to WAV or AIFF cut to the bar, and Record captures everything you hear. Import brings MIDI and audio files in.',
  task: 'Press Export MIDI to save the sequencer\'s notes as a .mid file.', hint: 'Export MIDI is in the Import / Export widget.',
  show: ['Import / Export › Export MIDI'], check: (p, ws) => ws.pressed.includes('Export MIDI'),
 },
];
