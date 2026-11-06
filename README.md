# midi: Ultimate Synthesia Online

A polyphonic subtractive synthesizer that runs entirely in the browser on the
Web Audio API, with a playable on-screen keyboard, live MIDI input, a four-slot
loop recorder, a metronome, an oscilloscope, and Synthesia-style falling notes.

Part of the [project-demos](https://github.com/Shubin123/project-demos) collection.

## Status: ✅ Working

Entirely self-contained; the only external requests are the Poppins webfont and,
once you set up the AI teacher, calls to the provider you pick (or a one-time
model download for the on-device option).
Hardware MIDI input is Chromium-only; everything else works everywhere.

*Verified 2026-08-20 by requesting every external dependency this project uses over the network. The demo itself was not opened in a browser, so this reflects dependency health rather than a full functional test.*


## Signal chain

Each held note builds its own voice graph and tears it down on release:

```
Oscillator 1  ──┐
Oscillator 2  ──┤
     …        ──┼── mix ── ADSR gain ── filter ── master gain ── analyser ── output
Oscillator n  ──┘
```

| Stage | Details |
| --- | --- |
| **Oscillators** | One to eight, layered in every note (`js/oscillators.js`). Each has its own waveform (sine, square, sawtooth, triangle, pulse, white or pink noise), octave (±2), detune (±100 cents), level, start delay (0-50 ms) and pulse width, and can be switched off. **+ Add oscillator** layers another; × removes one. The bank starts as two sawtooths and a square two octaves down (the sound of the old Oscillator 1, Oscillator 2 and Sub), and is saved in the browser. Keyboard octave (2-6) and slop are shared |
| **Envelope** | Full ADSR: attack and decay to 2 s, sustain level, release to 5 s |
| **Filter** | Lowpass / highpass / bandpass / notch / allpass, cutoff 20 Hz-20 kHz on a logarithmic slider, Q up to 30 |

Two details worth calling out:

- **Pulse waves** are not a native `OscillatorNode` type. They are built from
  their Fourier series as a `PeriodicWave` (2,047 harmonics, cached per width),
  so they are band-limited and high for exactly the pulse width of each cycle,
  with no DC offset. They used to be a sawtooth through a hard-step
  `WaveShaperNode`, which assumed the sawtooth spans ±1; Web Audio's spans
  ±0.945, so the width came out wrong and reversed (0.25 gave 80% high), and
  widths near the ends were mostly DC, with no tone at all at 0.01 and 0.99.
  Width 0.5 is the same ±1 square as before.
- **Oscillator slop** applies a small random detune per voice, emulating the
  tuning drift of analogue oscillators so stacked notes beat against each other
  instead of phase-locking.

### Testing the waveforms

`node tests/waveforms.mjs` checks every sound source by measuring it. It serves
the repo, starts headless Chrome (Google Chrome, Chromium, Edge or a Playwright
Chromium; set `CHROME` for another) and drives it over the DevTools protocol
with Node's own WebSocket, so it needs nothing installed. It takes about five
seconds.

- **The lab** (`tests/waveforms.js`, also `tests/waveforms.html` in a browser)
  renders oscillators through the synth's own `buildVoice` on an
  `OfflineAudioContext`, at 375 Hz so a cycle is exactly 128 samples and each
  harmonic falls on a DFT bin. It checks each waveform's harmonics against its
  Fourier series, pulse widths (time high, no DC), pitch to a hundredth of a
  cent through octave, detune and slop, level, start delay, switching off, the
  colour of white and pink noise, and that a stack, up to a full bank of eight,
  is exactly the sum of its oscillators. A copy of the old fixed-oscillator code
  is kept as a reference: the default stack matches it sample for sample.
- **In the app** (`tests/waveforms-app.js`), the Oscillators widget is used as
  a person would: rows added up to eight and removed, every control changed,
  the bank saved, an automation lane moving the first detune. Then every
  waveform, a layered stack, a level and a pulse-width change on a held note, a
  loop slot (which keeps the sound it was recorded with) and the oscilloscope's
  sources are played through the real synth (envelope, filter, limiter) and
  measured at its output.

### Checking for regressions

`node tests/all.mjs` runs every suite in parallel (about thirty seconds, most
of it the widget drags), the ones that drive headless Chrome at most three at
a time, and fails if any does. The browser suites share
`tests/support/browser.mjs`, which serves the repo and drives headless Chrome. The waveform checks don't just look for "about right": each one
also leaves a **fingerprint** in `tests/waveforms.golden.json`, so a change
anywhere in the sound shows up even when it stays inside the checks' own
tolerances. A fingerprint is the first harmonics' amplitudes and the RMS, and
there are three kinds:

- **Each waveform, rendered offline**: deterministic, so they must match to
  0.005.
- **The whole sound path, played live** (the default sound up to 3.5 kHz, a
  resonant lowpass, a highpass, the envelope's sustain), measured as harmonic
  amplitudes of a steady note so timing doesn't matter. A live capture is
  close to, but not exactly, the same twice, so these may move by 5%; the
  regressions below move them further.
- **The settings a session starts with** (every synth control and the
  oscillator bank), exactly, so a changed default names itself.

The method was checked by breaking the code on purpose. Each of these failed
the run: the octave sign flipped; every level 2% loud; the pulse series off by
1%; oscillators past the sixth dropped; slop halved; sustain 15% low; resonance
halved; the limiter's threshold at −20 dB; the cutoff applied 30% low; the
default cutoff at 3 kHz.

`node tests/waveforms.mjs --lab` runs the offline part alone, in under a
second. When a sound changes on purpose, check that the failures name only
what you meant to change, then record the new fingerprints with
`node tests/waveforms.mjs --update` (it writes only after a clean run of the
other checks) and commit the file with the change: each check is one line, so
the diff shows exactly what moved.

## Features

### Input

Play with the mouse (including drag-across-keys glissando), touch, the computer
keyboard, or a real MIDI controller. The computer keyboard uses the standard
tracker layout (`A` is C, `W` is C♯, `S` is D, `E` is D♯, `D` is E, and so on)
and the mapped keys are labelled on the first two octaves. MIDI arrives through
`navigator.requestMIDIAccess({ sysex: false })`, with note-on velocity mapped
from the 0-127 range onto voice gain.

### Loop recorder

Four independent slots, each of which can be armed, recorded, played, and
cleared. Recording captures **note events rather than audio**: every event
stores the note, velocity and a snapshot of the full synth parameter set at the
moment it was played. That means a loop replays with the patch it was recorded
with, so you can change the synth afterwards without altering existing loops.

Recording and playback are quantised to the beat: `getTimeUntilNextBeatMs`
computes the offset to the next beat from `audioContext.currentTime`, so an
armed slot starts on the downbeat rather than the instant you clicked.

### Timing

Metronome with an LED tick, BPM from 30 to 300 via increment buttons, and a tap
tempo button that averages recent taps and discards a stale series after a 3 s
gap. The click itself is a short synthesised buffer rather than a sample,
scheduled on the audio clock a beat apart (a timer looks 100 ms ahead every
25 ms), so it lands exactly on the beat however busy the page is; armed loops
start on its beats.

### Beat, tempo and rhythm

Three layers (`js/timing.js`, drawn by `js/timing-widget.js`), the first two
with no model at all:

- **Beat.** One clock for everything, kept by whoever keeps the beat: the
  metronome (from when its first click is heard, output latency included),
  the sequencer while it plays (its tempo lane moves it without a jump), an
  incoming **MIDI clock** when **Sync to MIDI clock** is on in Metronome &
  Tempo (24 ticks a beat; tempo and beat from a line fitted through the last
  four beats of ticks, so USB jitter doesn't show; Start, Stop and Continue;
  the session tempo and a running metronome follow it), or, with none of
  those, **your own pulse**, which follows you as you speed up or slow down,
  so rubato is never held against you. Every note gets its offset from the
  nearest beat or eighth (sixteenth on Hard), using a MIDI message's own time
  stamp, and a grade: the hit line above the keys flashes green, amber or
  red. **Difficulty** (Keyboard toolbar) sets the windows: Easy ±50/100 ms,
  Normal ±30/60 ms, Hard ±15/35 ms. Under the keys, a **timing strip**
  scrolls the last two bars, a dot per note joined to the beat line it was
  nearest, and a **tempo readout** shows the target and your tempo with an
  arrow when you drift (*♩ 100 · metronome   you 107 ↑*). **Timing** in the
  toolbar switches it all off.
- **Tempo.** Your tempo comes from the gaps between notes (a chord is one
  event), each gap read as the nearest note value of the beat, so quarters
  and eighths mixed still give one tempo. Rushing or dragging beyond 4% for
  four notes running is said once, and "back" when you return. System 1 says
  it: Laya picks the words of a short nudge from written ones ("Easy, you're
  speeding up: 107 against 100."), shown under the keys and spoken in talk
  mode, at most one a bar and never closer than four seconds; without Laya,
  the first one is said.
- **Rhythm.** Playing to a beat (or for an exercise or a rhythm lesson), a
  rest of about a bar ends the phrase, and the teacher puts it on the
  sixteenth grid: a **rhythm card** shows the grid bar by bar (each hit in its
  grade's colour), the numbers (how many within the window, on average how
  early or late, which beat slips, straight or swung and by how much, how many
  syncopations, and against an exercise how many hits of the pattern), one
  thing to do about it, what keeps happening, and **Try this next**: the next
  exercise, from the same rhythm slower, quarters or eighths, the beat that
  keeps slipping, off-beats, a 3-3-2 or faster. Laya picks it from the three
  that fit. Trying it sets the tempo, switches the metronome on, plays the
  pattern from the next bar, and marks the phrases after it against it until
  it is ended. With System 2 connected, the phrase's **[RHYTHM]** summary (the
  grid and the numbers, the target, the history and System 1's step, not the
  raw notes) goes with the phrase it already explains, so there is no extra
  request; its reply can name the next exercise
  (`{"exercise": {"pattern": "x...x...x.x.x...", "bpm": 90}}`), which becomes
  its own Try this next. **Explain why** asks for it in Fast mode.

What keeps happening is kept in the browser as a small profile: each beat's
offset over the latest phrases, and how often you rush or drag. Once a beat
is off the same way in four phrases ("consistently late on beat 3") the
Course tab says so, the exercises lean on that beat, and System 2 is told.

`node tests/timing.mjs` checks the arithmetic on note times made to be exactly
as early, late, swung or rushed as each check needs: offsets exact at 60, 120
and 180 BPM; a MIDI clock with ±2 ms jitter read within 0.2 BPM and 3 ms;
tempo from mixed note values; rushing and dragging said once and an
accelerando in free play never; the grid, swing (a dotted rhythm isn't swing),
syncopation and the target; the profile and the exercises.
`node tests/timing-panel.mjs` does it in the app: the metronome, the sequencer
and a MIDI clock taking turns keeping the beat, grades on the hit line and the
strip, a nudge, a rhythm card and its exercise marked against, System 2 reading
the [RHYTHM] summary and setting an exercise, and the Course tab's profile.
Generating MIDI out to the same port, so a student can play along with
generated rhythms, is not built yet.

### Visuals

- A 2048-point FFT oscilloscope that can be pointed at the master output or
  at any one oscillator (summed over the notes playing).
- Falling notes, Synthesia style, in the Keyboard module directly above the
  keys, so each note lines up with the key that played it. They are on by
  default; the **Falling notes** switch in that module's toolbar turns them off.
- **13 UI themes**: Midnight Drive, Solarized Dark, Crimson Peak, Cyber Glow,
  Forest Calm, Ocean Depth, Autumn Warmth, Lavender Haze, Desert Sunset,
  Steampunk Gears, Vintage Library, Monochrome Noir and Pastel Dream: applied
  by swapping CSS custom properties on the root element.
- Adjustable UI scale (75-150%), driven by a `--font-scale-factor` variable
  that the whole stylesheet sizes against.

Theme, UI scale, and the falling-notes toggle persist in `localStorage`. The
theme and scale are back from the first frame on a reload: `js/themes.js` is
loaded at the top of the page (not deferred) and applies them before anything is
drawn, where they used to wait for the page to finish loading, showing the
default theme until then. A saved theme that no longer exists falls back to
Midnight Drive.

### PANIC

A dedicated button force-stops every voice, clears the loop slots' playback
timers, and rebuilds the audio graph, the standard escape hatch for when a
stuck note leaves an oscillator droning. It also stops the sequencer and the
metronome, and cuts notes that are still fading out (their release) within
50 ms. Effects' own tails, such as a delay's echoes, ring out as usual.

The same panic is **Stop all sounds** in the **☰ Settings** menu. The floating
PANIC button is off by default, to leave room; switch it on there (kept). The
panic also runs by itself whenever you come back to the tab, so nothing left
going while the tab was hidden carries on late or stuck.

### Settings

The **☰ Settings** menu at the top right holds the app's settings, then the
widget list. Clicking anywhere outside it, or Escape, closes it.

- **Sound**: Stop all sounds, and the floating PANIC button (off by default,
  for room).
- **AI teacher**: switched off, the teacher's panel, its pull tab and every
  🎓 button are hidden, its tab closes, and it stops listening, talking,
  coaching and playing examples, and doesn't load its model in the
  background. Its conversation and lessons are kept, and switched on again it
  opens as it was left.
- **🎓 buttons**: off by default, for room in the title bars. Switched on,
  every widget and plug-in window gets one that opens its guide. While the
  teacher is off they stay hidden and the switch rests, greyed out.

Every switch is kept, so the page comes back as you left it after a reload.
- **Widgets**: show and hide each widget, minimise or expand them all, and
  reset the layout.

## Modular sequencer workspace

The workspace adds a 16-step polyphonic sequencer and automation lanes for tempo
(30–300 BPM), filter cutoff, resonance, master volume, and oscillator detune.
Each target has one lane: the target menu offers the ones without a lane yet
(those with one are marked), and **+ Add lane** says when every target has one.
Enable each lane to hear it; choose linear interpolation or held step values.
Use Ramp up and Flatten to edit a whole lane, or adjust individual step values.
Tempo automation changes sequencer speed as it plays. Stop restores manual values.

The sequencer's rows follow a **Key**, **Scale** and **Octave**: every scale and
mode the AI teacher's analyser knows (the seven modes of the major scale,
harmonic and melodic minor, Phrygian dominant, Lydian dominant, altered, major
and minor pentatonic, blues, whole tone, both diminished scales) plus
chromatic, one octave from the tonic up to the tonic above. Changing the key or
octave transposes the pattern; changing the scale moves each note to the
nearest note of the new scale. The default, C major pentatonic in octave 4, is
the original grid, so patterns saved before this still load unchanged.
Playback stops when the page is hidden to avoid delayed notes on returning.
The original loop recorder still uses recorded event durations; tempo automation
does not time-stretch those recordings.

Drag a module by its header with a mouse or finger: it lifts and follows the
pointer exactly, an empty dashed outline marks the liftoff point (no label: the
open space says where it is going), and the space it will drop into is already
open and highlighted (**Drops here**) as the other modules make room; Escape
puts it back. Carried past the middle of another
module, the space moves to that module's far side, and back only when carried
back past the middle, so resting on a module never makes the space jump back
and forth. While a module is held the page doesn't scroll or shrink under it.
Plug-in windows leave the same empty outline where they were while they move.
`node tests/widgets.mjs` carries every module onto every other one, at four,
two and one columns, and checks at each step that the space is open, outlined
exactly where the module lands, empty of other modules and steady, that the
liftoff outline (a plug-in window's too) carries no words, and that every place
can be reached and no two modules overlap.

Every widget and plug-in window has a **resize grip** in its bottom-right corner.
A widget's width snaps to whole columns (one to four) and its height is free: a
widget made shorter than its content scrolls inside, keeping its title bar in
view. Plug-in windows take any size from 260 × 160 up to the window, and stay
clear of the AI teacher's panel when it is open. Double-click a grip to go back
to the natural size; with a grip focused, the arrow keys resize (a column or
40 px at a time, four times that with Shift). Sizes are saved with the layout,
and **Reset layout** clears them. The AI teacher's panel is resized by dragging
its left edge (300–720 px, kept; double-click resets). Every
header has the same buttons in the same order: **×** hide, **↔** width, **–**
minimise, then **🎓** (the teacher's guide to that widget, when 🎓 buttons are
on in Settings). Focus a header and
use arrow keys to reorder with the keyboard. The **–** button (or a double-click on
the title) minimises a module to its title bar, one column wide; **+** expands
it. The width button toggles a wide module. Modules are packed like a masonry
wall: in order, each goes to the column that currently ends highest, so short
and minimised modules fill in under tall ones instead of leaving gaps. The
layout uses four columns, two below 1100 px and one below 600 px. The **☰ Settings**
menu can hide and restore every widget, minimise or expand them all, and reset
the layout. Widget order, widths, minimised and hidden state, the sequencer's
notes, key, scale and octave, and automation lanes persist in browser
localStorage.

Source files:

- `js/synth.js`: existing synthesis, keyboard, MIDI, and loop recorder engine
- `js/sequencer.js`: sequencer transport and automation editor
- `js/timing.js`, `js/timing-widget.js`: the beat clock, tempo and rhythm, the timing strip and Sync to MIDI clock
- `js/commands.js`: requests to change a setting, read without a model
- `js/automation.js`: automation targets, interpolation, and parameter application
- `js/widgets.js`: responsive widget layout, dragging, and visibility
- `js/storage.js`: browser persistence
- `js/app.js`: module assembly
- `js/fx-chain.js`: ordered insert chain for effects and plugins
- `js/air-widget.js`, `plugins/air/`: built-in Air enhancer
- `js/archive.js`, `js/plugin-host.js`, `plugin-sw.js`: archive plugin loader
- `js/plugin-window.js`: each plugin's own window
- `js/native-id.js`, `js/plist.js`: native plugin identification
- `js/vst3-runtime.js`, `js/vst3-worklet.js`, `native/`: VST3 plug-ins compiled to WebAssembly
- `js/capture.js`, `js/capture-engine.js`: plug-in capture and its playback engine
- `js/io-widget.js`, `js/audio-files.js`, `js/midi-file.js`, `js/recorder-worklet.js`: import and export
- `js/vendor/webaudiomodules-sdk.js`: Web Audio Modules host SDK (MIT)
- `workspace.css`: responsive workspace styling

Run the interpolation checks with `node tests/automation.mjs`, and the
sequencer's scale rows and pattern moves with `node tests/sequencer.mjs`.
Serve over HTTP as below; the new JavaScript modules require a web server.

## Import and export

The **Import / Export** widget moves sounds in and out in the formats every DAW
reads.

| Direction | What | Formats |
| --- | --- | --- |
| Export audio | **Record** the master output (after effects), or **Render audio** of the step sequencer or a loop slot | WAV 24-bit, 16-bit (dithered) or 32-bit float; AIFF 24-bit or 16-bit |
| Export notes | **Export MIDI** of the step sequencer or a loop slot | Standard MIDI File (.mid), type 1, with tempo (an enabled tempo lane becomes tempo changes) |
| Import audio | Drop or pick a file; it becomes a clip you can play, run through the effect chain, and download in any export format | WAV and AIFF/AIFC at any bit depth, read at their own sample rate; FLAC, MP3, Ogg and M4A through the browser's decoder |
| Import notes | Drop a .mid into a loop slot (full timing, plays with the current patch) or the step sequencer (first bar, snapped to sixteenths) | .mid type 0 or 1, tempo map and time signature honoured |

Render audio plays in real time while recording and cuts the file to exactly
the chosen number of bars or loop lengths, so it lines up on a DAW's grid.
Tick **Release tail** to keep the last notes' release instead; recording
continues until the output falls silent (up to 10 s), so plug-in releases,
echoes and reverb tails are kept. Note numbers
match the synth's MIDI input, so 60 is middle C. Clips live in memory for the
session; download the ones you want to keep.

`node tests/formats.mjs` round-trips every format and, on macOS, checks the
files against Core Audio (`afinfo`, `afconvert`).

## AI music theory teacher

A side panel on the right (the ▶ / ◀ tab hides and shows it) follows what you
play on a MIDI controller, the computer keyboard, the mouse or touch. The step
sequencer, the looper and the teacher's own playback are left out. It works in
two layers:

- **Instant and local** (`js/pitch-analyzer.js`). Every note-on shows its name,
  MIDI number and pitch class (mod 12), plus the chord once three or more keys
  are held. When every key is up and 800 ms pass in silence, the phrase is
  matched against 18 scales and modes and 12 chord types. A full diatonic set
  fits all seven modes, so ties go to the tonic you leaned on: the phrase's
  last, first or lowest note. No network is involved.
- **Fast coaching: System 1** (`js/laya.js`, `js/coach.js`). With the on-device
  option loaded, [Laya](https://github.com/vishalmysore/layaForWeb), a small
  decision model, reads each finished phrase and picks the next step from a fixed
  menu: hear the whole scale, build the home chord, add a seventh, the main
  chords of the key, a ii–V–I, the relative major or minor, a neighbouring mode,
  the pentatonic or blues scale, an arpeggio, or replay with steady timing. Laya
  only chooses; the app writes the words and works out the example's notes from
  the key you are in, so the theory is always right, and the example plays at
  once (about 0.7 s on a laptop GPU). Steps the phrase shows you already know,
  and the last three suggested, are left out so the lesson keeps moving.
- **Thinking: System 2** (`js/ai-teacher.js`). A language model explains and
  answers questions: Qwen 3.5 on the device, or any provider below. In **Fast**
  mode it answers typed questions straight away and stays out of the way while
  you play; **Explain why** under a coaching step asks it to think that step
  through (Laya marks the steps where it judges an explanation would help). In
  **Slow** mode it also thinks every phrase through after Laya's step, building
  on it, and answers questions after thinking. On the device, thinking has a
  budget of 400 tokens: left alone, Qwen 3.5 often reasoned for over 3,000
  tokens (two to four minutes) without reaching an answer, so after the budget
  it answers from the notes it has made. If you keep playing while it answers,
  only your latest phrase is sent next.

Models name what to play, as a last line such as `{"chords": ["Dm7", "G7",
"Cmaj7"]}`, `{"scale": "A minor pentatonic"}` or `{"notes": ["C4", "E4",
"G4"]}`, and the app works out the notes (`parseChordName`, `parseScaleName` in
`js/pitch-analyzer.js`). Testing the on-device models showed why: asked for MIDI
numbers, 1–3B models got the notes right in one example out of 24, while they
name chords and scales reliably. Chords play one per beat, scales up and back
down. Every example plays through the synth (and any plug-in instrument
following it), lights the keys as they sound, and keeps a ▶ button to hear it
again; a System 2 example waits if you have started playing again.

Every example fits on a **25-key controller**: two octaves from C to C, MIDI
48–72 (C3–C5) by default, which is also the on-screen keyboard at its default
two octaves (each octave count ends on a closing C). The window follows your
controller's octave buttons: a note played outside it moves it by whole octaves.
`fitToKeys` moves the whole example by octaves when it fits, so a scale keeps its
shape, otherwise each chord or note on its own; a chord that still doesn't fit
keeps its bass at the bottom (G7/B plays as B D F G). Whatever octave a model
names, or a slash chord's bass below C3, the example stays on your keys.

### System 1 first, System 2 as fallback

Laya (System 1) answers in a third of a second and is never wrong about the app,
because it only chooses among things written in advance; a language model
(System 2) can say anything, but takes 7–11 s on the device and sometimes says
it wrong. So the teacher uses System 1 wherever it can:

- **Requests to play something** (`js/requests.js`) are met without a model:
  the key ("a g# lick", "in D minor"), chord names, Roman numerals ("ii–V–I",
  "i–♭VII–♭VI–V"), scales, mood (sad, bluesy, jazzy, epic…) and texture ("only
  chords", "a lick") are read from the words and the example is built exactly,
  as the lessons' are, and plays at once. "Again", "longer", "shorter",
  "faster", "slower", "higher" and "lower" change the last example. Laya picks
  a progression only when the words leave it open ("something dreamy").
- **Questions about the app and its plug-ins** go to Laya, which finds the
  widget and the step of its guide that answers them (words in common narrow
  the choice first, so plain questions need no model at all), lights up the
  control, and offers **Ask Qwen** (or the connected provider) for more.
- **Plug-ins are learned as they load** (`js/plugin-profile.js`): what kind of
  plug-in it is and what each control does, read from the control names, with
  Laya settling in one call (about 0.5 s) what the names don't say. The result
  is remembered per plug-in and becomes its guide, its **Next tip**s, and what
  System 2 is told about it.
- **System 2** composes what System 1 can't, answers anything else, and in
  **Slow** mode checks Laya's answers (it replies only to correct one) and
  explains the examples System 1 played.

This split comes from testing both on the same requests in Chrome, with Laya
and Qwen 3.5 4B (fast) running on an M-series GPU:

| Requests | Laya alone | Qwen 3.5 4B |
| --- | --- | --- |
| Questions about widgets, plug-ins and theory (11) | 10 right in each of two runs, 1–481 ms | 8 and 10 right, 5–10 s; asked to check Laya's answer, it confirmed it once in 22 tries, and in one run "corrected" three right answers into wrong ones |
| Composing ("only play chords play a g# lick", "the same but longer", "a sad progression in D minor", "a ii–V–I in C") | none (it can't compose) | 1 of 4 with a playable, correct example, in both runs |
| The same four through `js/requests.js` | 4 of 4, at once | |

Laya's one miss ("how do I get my pattern into my DAW?" went to the sequencer)
was fixed afterwards in the guide's words.

Models sometimes leave out the line that names what to play, or get it nearly
right. The teacher mends near-misses (curly or single quotes, a trailing comma,
a line cut off) and, when there is no usable line but the reply suggests
playing something, reads the example from the reply's own words: chord symbols
in a row, notes spelled out ("D-F-A"), or a scale by name. Controls named in a
"show" that don't exist fall back to their widget.

### Changing settings when asked

Ask the teacher to change something and it does, at once, with no model loaded
(`js/commands.js`): "set the cutoff to 800", "turn off oscillator 2", "louder",
"make the attack longer", "osc 3 to square", "switch the filter to highpass",
"set the key to D minor", "tempo 90", "turn on the metronome at 100 bpm",
"theme forest calm", "hide the oscilloscope", "turn on the panic button". The
words are matched against every control the teacher can see, so a plug-in's
controls work as soon as it loads ("set the delay feedback to 60"), and by what
the teacher learned each control does (`js/plugin-profile.js`): "more reverb"
is more of the reverb's mix, "a bigger reverb" its decay, "make the delay
wetter", "fewer repeats" its feedback, "set the delay to 500 ms" the one
control in milliseconds, in the unit the plug-in shows beside its slider. Values are
read in the control's own unit (2k is 2000 Hz, 200 ms is 0.2 s for the
envelope, 50% of a 0–1 slider is 0.5) and held to its range; "up", "down",
"brighter", "a little more" move a frequency or time by half again (or two
thirds), the tempo by 10 BPM, anything else by a tenth of its range. Each
change is listed with **Show** and **Undo**, and read aloud in talk mode.
Nothing is guessed: words that fit several controls ("set the level to 0.5")
ask which, with a button for each; a question ("how do I turn off the
filter?") goes to the guides; and requests to play something stay with the
composer. A System 2 model's own changes go through the same path.

**Tools for System 2.** A hosted model is given real tools (OpenAI-style function
calling, `js/providers.js`) while it answers: `list_widgets`, `get_controls`
(a widget's or plug-in's controls with values and ranges), `describe_plugin`
(what the plug-in is and what each control does), `set_control`,
`arrange_widget` (hide, show, minimise) and `show_control`. It may call them in
up to four rounds before it replies, and every change it makes is listed with
Show and Undo, marked as System 2's. A model or provider that won't take tools
is asked again without them, and the JSON line (`{"set": …}`) is how it changes
things from then on; Qwen on the device always uses the JSON line. A change made
with a tool isn't made again from the JSON line. The
teacher's own switch in Settings is the one setting it leaves to you.

`node tests/commands.mjs` reads over a hundred requests against the app's real
controls and the built-in Delay and Reverb (and the ones that must change
nothing); `node tests/teacher.mjs` runs the tool loop against a stubbed provider
(four rounds, then an answer; a provider that refuses tools); and
`node tests/teacher-panel.mjs` types requests into the panel in headless Chrome
with real plug-ins loaded, and has a stubbed hosted model call every tool,
checking the controls, the synth and Undo.

### The teacher and the workspace

The teacher can see and use every widget, plug-in window and the ☰ Settings menu (`js/workspace.js`):
it reads them from the page, so a new widget or a plug-in loaded later is
covered without being registered anywhere. Each widget's **🎓** button (switched on in **☰ Settings**) opens its
guide (`js/workspace-guide.js`): what it is for, and how to use it step by step,
each step with a **Show** button that brings the control into view (unhiding,
expanding or opening its window) and makes it pulse. When a question is about
the app, the model is sent a **[WORKSPACE]** summary: every widget in a line,
and the controls of the ones the question is about, with their current values
and ranges. Its reply can point at a control (`{"show": "Filter › Cutoff
(Hz)"}`) and, when the student asks for a change, set one (`{"set": {"Filter ›
Cutoff (Hz)": 800}}`, or a widget `"hidden"`, `"shown"` or `"minimised"`);
every change is listed with an **Undo**. Buttons are never pressed for the
student, and nothing outside the widgets and Settings can be changed. The
tempo set anywhere (Tap BPM, − and +, the teacher) shows in the sequencer's
Base BPM, and a metronome that is clicking keeps up with it.

### Conversations are kept

The conversation (messages, coaching steps, lessons, guides, changes, and the
model's own memory of it) is saved in the browser (`js/conversations.js`), so a
reload carries on where you were, an open lesson included. **New** starts a
fresh conversation and keeps the last one in **History**, from which it can be
reopened and continued; the latest 12 are kept. The Provider tab's **Saved in
this browser** section clears saved conversations, and deletes the downloaded
models (Laya, Qwen and the neural voices), which download again when next
loaded.

### Course: lessons from Open Music Theory

The **Course** tab starts with 14 lessons on **using the workspace** (widgets,
oscillators, the envelope, the filter, tempo, the sequencer, the loop recorder,
automation, effect and instrument plug-ins, Air, the oscilloscope and export),
each checked from the workspace itself as you work: a slider moved below a
value, a plug-in loaded, a loop recorded. Two lessons on **tempo and rhythm**
follow (`js/rhythm-lessons.js`): tempo is speed and rhythm is pattern, so the
same rhythm is recognizable at any tempo; and the teacher splits its work the
same way, with System 1 keeping the tempo (answering every beat at once) and
System 2 shaping the rhythm (the moments that deserve a pause, careful
reasoning or emphasis). Their tasks are checked from when each key goes down:
play a rhythm with long and short notes, then the same rhythm at least a third
faster or slower; and play a steady beat of eight with the first and fifth
lower than the rest. Laya sends questions such as "what's the difference
between tempo and rhythm?" or "what are System 1 and System 2?" to these
lessons. Then come 24 short lessons adapted from
[Open Music Theory](https://openmusictheory.github.io) (`js/lessons.js`), in
three units: **Fundamentals** (the keyboard, enharmonic names, half steps, the
major and minor scales, scale degrees, key signatures, relative keys,
intervals and their inversions, triads, Roman numerals, seventh chords),
**Harmony** (tonic, subdominant and dominant functions, the idealized phrase,
cadences) and **Pop and rock harmony** (the doo-wop, singer/songwriter, Puff,
lament and Pachelbel progressions, plagal and double-plagal motion, the circle
of fifths in minor, the 12-bar blues). Each lesson retells one idea from a
chapter in a few sentences, plays an example on your keys, and gives you a task
such as *play the A harmonic minor scale* or *play I–vi–IV–V in any major key*,
with a link to the chapter.

The app checks the task itself from what you play; no model is involved, so it
works offline and is always right. Chords are read from the keys held down
together rather than from timing, so a slowly rolled chord counts, and you can
pause between chords or hold a common tone into the next one. Progressions are
accepted in any key, and a pass says what you played (*I–vi–IV–V in G*).
A miss shows a hint once you stop playing. While a lesson is open, phrases are
marked instead of coached; **End lesson** goes back to coaching. With a model
connected, **Explain more** asks it to go deeper on the lesson. Finished lessons
get a tick, kept in the browser.

### Talk mode

The **🎙 Talk** button next to Ask turns on voice (`js/voice.js`, the browser's
Web Speech API). Ask a question out loud and the teacher answers aloud, then
plays its example once it has finished speaking; Laya's coaching steps are read
out too. Listening pauses while the teacher speaks so it doesn't hear itself,
and playing a note interrupts it, since that is your turn. Chord symbols are
spoken as words ("D minor seven, then G seven"). Recognition runs on the device
where the browser offers that (newer Chrome installs an on-device speech pack
the first time); otherwise the browser's own speech service does it, which in
Chrome is online, and the panel says which. Firefox has no speech recognition,
so there talk mode only reads replies aloud.

**The teacher's voice** is chosen in the Provider tab, with a **Test voice**
button. Besides the browser's own voice, three neural voice engines run in the
page, each downloaded once when first used and kept in the browser
(`js/tts-*.js`); replies are read a sentence at a time, the next one made while
the current one plays, so speech starts quickly:

| Engine | Voices | Download | Speed here (M4, Chrome) | Licences |
| --- | --- | --- | --- | --- |
| **Pocket TTS** (Kyutai, via [pocket-tts-js](https://github.com/vlapky/pocket-tts-js)) | 21 English: 10 female, 11 male | about 134 MB | 1.6–2× faster than real time, one CPU thread | code MIT; weights © Kyutai, CC BY 4.0; voices CC BY 4.0 or CC0, two non-commercial (marked) |
| **Supertonic 3** (Supertone) | 10: F1–F5, M1–M5 | about 400 MB | 15× real time on WebGPU; 2× on the CPU | sample code MIT; model OpenRAIL-M (use restrictions) |
| **Piper** (Rhasspy) | 10 English: 6 female, 4 male | about 73 MB | about 7× real time on the CPU | MIT; espeak-ng GPL-3.0; each voice its data's licence (Cori and Kristin public domain; four marked non-commercial) |

**Speed** (next to the voice, 0.5–2×, kept) makes the teacher talk slower or
faster without changing the voice's pitch: the browser's voice by its own rate,
a neural voice by time-stretching each sentence as it is made (WSOLA in
`js/voice.js`: overlapping 25 ms frames, each taken from where it best continues
the last, so nothing clicks or warbles). Saying or typing "talk slower",
"speak a little faster", "voice speed 1.5" or "talk at normal speed" sets it
too. `node tests/voice.mjs` checks that a voice-like sound stretched from 0.5×
to 2× keeps its length, pitch (within 1%), loudness and smoothness, and that
both kinds of voice read at the speed set.

The default is **Pocket TTS · Anna**. Every engine's female voices were scored
on the same three coaching lines with DNSMOS (Microsoft's speech-quality model):
Anna tied for the top with Piper's Amy (3.44 overall), ahead of Supertonic's
best (F1, 3.41) and Piper's Cori (3.37). Among the leaders Anna has a clear
licence (Amy's is unstated), a moderate download, and runs on the CPU, leaving
the GPU to Laya and Qwen. Supertonic is the fastest on a GPU; Piper the
smallest. If a voice can't load, the browser's voice reads replies instead.

### The panel

The panel has three tabs. **Lesson** is the conversation: until it starts, a
live strip shows the note you just played and the chord under your fingers
(it makes way once there is anything in the conversation, and comes back with
**New**); local analysis and the teacher's replies stack below it, each labelled with who answered (System 1 ·
Laya, or System 2 with how long it thought), and the bottom holds the **Fast /
Slow** switch (once Laya is loaded), the **Coach each phrase I play** switch and
the ask box. **Course** lists the lessons (above). **Provider** is where answers come from.
The header always says what is connected (for example *Groq · llama-3.3-70b*)
and links to the Provider tab.

### Choosing a provider: System 1 is Laya, System 2 is your choice

The teacher works in two layers, and the Provider tab lists them that way.
**System 1 is always Laya**, on this device: it answers at once, coaching each
phrase, keeping time, teaching the widgets and plug-ins and changing settings.
**System 2** thinks and explains in its own words, and is chosen from the list
below it: **None** (Laya alone, nothing leaves the browser), **Qwen** on this
device, or any hosted provider. The two mix freely: Laya with Groq, Laya with
Gemini, Laya with Qwen. Whichever System 2 is chosen, Laya keeps coaching (in
**Slow** mode the System 2 model then thinks each phrase through), and the
header names both (*Laya + Groq · llama-3.3-70b*). Each hosted provider is a
**separate, direct connection** with its own sign-in; nothing is routed through
anything else (only OpenRouter itself forwards to other model makers), and one
System 2 is active at a time. Without Laya loaded, the System 2 model coaches
phrases too.

| Layer | Provider | Sign-in | Requests go to | Cost |
| --- | --- | --- | --- | --- |
| System 1 | **Laya** | None | Nowhere: Laya (291 MB, ONNX Runtime Web) runs in the browser. It coaches each phrase, answers questions about the widgets and plug-ins from their guides, learns plug-ins as they load, and gives tips; it chooses rather than writes, so it is fast and never wrong about the app. Once downloaded it loads by itself on later visits | Free; runs on the GPU or the CPU |
| System 2 | **None** | None | Nowhere | Free |
| | **Qwen, on this device** | None | Nowhere: Qwen 3.5 4B or 2B ([WebLLM](https://github.com/mlc-ai/web-llm), `js/local-model.js`) runs in the browser, with Laya loaded beside it if it isn't yet | Free; downloaded once, then cached; needs WebGPU (desktop Chrome or Edge) |
| | **OpenRouter** | **Sign in with OpenRouter** (OAuth with PKCE, `js/ai-auth.js`), or a pasted OpenRouter key | `openrouter.ai`, which forwards to Google, Meta, OpenAI, Anthropic and others | Free models on a free account; others need credit |
| | **Groq** | Groq key | `api.groq.com` | Free tier |
| | **Cerebras** | Cerebras key | `api.cerebras.ai` | Free tier |
| | **Google Gemini** | Google AI Studio key | `generativelanguage.googleapis.com` | Free tier |
| | **Mistral** | Mistral key | `api.mistral.ai` | Free tier |
| | **OpenAI** | OpenAI key | `api.openai.com` | Paid |
| | **Custom endpoint** | Base URL and key | Any OpenAI-compatible `/chat/completions` that allows browser requests (LM Studio, Ollama with CORS enabled, a self-hosted gateway...) | Depends on the service |

**Connect** checks the key by listing the provider's models (a free request;
nothing is generated), so a wrong key is reported at once and is not saved. The
model dropdown then shows that provider's real chat models, with speech,
embedding and image models left out, and picks a sensible default you can
change. Every option was checked to accept requests straight from a web page,
so there is no server of ours and GitHub Pages hosting works unchanged; the
hosted ones share one OpenAI-compatible request shape (`js/providers.js`).

Keys, the chosen provider and each provider's model are kept in cookies scoped
to the app's path (`SameSite=Lax`, and `Secure` over HTTPS), so a reload comes
back connected. **Forget key** (or **Sign out** for OpenRouter) removes one. A
page can only read cookies its own domain set, so this cannot reuse a claude.ai
or chatgpt.com login; the OpenRouter sign-in and the on-device model are the
ways in that need no pasted key. Claude is available through OpenRouter.

Requests send the last 15 exchanges for context; each analysed phrase is one
request, so turn **Auto** off to only ask typed questions. Free tiers have rate
limits; the panel says so and you can switch provider in **Settings**.

`node tests/teacher.mjs` checks scale, mode and chord detection, phrase
tracking, note and chord suggestion parsing, the shared provider request and its
error handling, key checks and model listing per provider, model choice,
cookie-backed settings, and the OpenRouter sign-in exchange
(against stubs, so no account or download is needed).

## Plugins and effects

Two widgets add effects to the master output, between master volume and the
limiter (`js/fx-chain.js` keeps them in order):

```
synth ── master gain ── Air ── plugins ── limiter ── output
```

Everything runs in the browser. Once the page has loaded, nothing is
processed on a server and nothing is downloaded at runtime.

### Air (built in)

An original presence and high-end enhancer made from native Web Audio nodes:
a peaking boost around 2.8 kHz (Mid Air), a high shelf around 9.5 kHz, and a
saturated top-octave exciter blended back in (High Air), plus a trim. It is
not a copy of any commercial plugin. The source is `plugins/air/index.js`.

### Plugins

Drop a file, a folder, or a `.zip`, `.tar`, `.tar.gz` or `.tgz` on the
widget, or pick one with **Load file**. Archives are decompressed in memory
with `DecompressionStream`, and web plugins' files are stored in the
browser's Cache API. `plugin-sw.js`, a service worker running in the browser,
serves them under `plugin-fs/<id>/`, so a plugin's relative imports,
AudioWorklet modules and `fetch` calls resolve as they would on a web server.
Installed plugins and their settings come back after a reload.

Every plugin, VST3 and captured ones included, gets its own window
(`js/plugin-window.js`) with its controls, as plug-in editors open in a DAW.
A new plugin opens its window at the top right. Drag the title bar (or focus
it and use the arrow keys) to move it, drag the corner to resize it, and click
a window to bring it to the front. **×** or Escape closes the window; the
plugin keeps running, and its row in the Plugins widget has **Open**,
**Bypass** and **Remove**. Each window's position and whether it is open come
back after a reload.

**The plug-in's own editor, or its generic controls.** A window shows the
plug-in's own editor where it has one (`js/plugin-editor.js`), and its generic
controls always: they are built first, so they are there whatever happens to
the editor. **Editor / Generic** in every window's title bar switches between
them, and the choice is kept per plug-in. A change in either reaches the
processor and moves the other. The window falls back to the generic controls
by itself, saying *Editor unavailable, showing generic controls* and why, when
the plug-in has no editor, when its GUI framework can't be shown yet, when the
editor throws or its WebAssembly traps while opening, when it draws no first
frame within 2 s or a blank one, or when it fails later (it is torn down).
None of that can touch the sound: the editor runs apart from the AudioWorklet
that plays the plug-in. Every GUI framework sits behind one adapter interface
(open on a canvas, size and resize, pointer, wheel and keyboard input, a frame
loop, parameter edits both ways), with shared services for all of them: the
canvas at the screen's pixel ratio, input, the frame loop and a blank-frame
check. A Web Audio Module's own HTML GUI is one more adapter.
`node tests/plugin-editor.mjs` loads a real VST3 into the chain while a note
plays and forces every one of those failures with stand-in editors, checking
each time that the generic controls show with the notice, that their Gain
still reaches the processor, and that the sound is unchanged; and with a
working stand-in, the switch, the kept choice and edits both ways.

Web plugins that load and run:

- **Web Audio Modules 2.0**: an archive with `index.js` (default export is the
  WAM class) and usually `descriptor.json`. Plugins from the
  [WAM community gallery](https://www.webaudiomodules.com/community/) load
  this way and show their own UI. The WAM host SDK is vendored in
  `js/vendor/`.
- **Web plugin**: `plugin.json` (`{ "name", "main" }`) plus an ES module whose
  default export is `createPlugin(audioContext)` returning
  `{ name, input, output, params, setParam, destroy }`. `params` entries are
  `{ id, label, min, max, step, value, unit }`, and the widget generates
  sliders for them.

**Built-in effects** (**Add built-in**): Air, Reverb, Delay, Compressor,
Saturator and Chorus. They live in `plugins/<name>/` and ship as zips built by
`tools/pack-plugins.sh`, so they load through the same path as any other
plugin.

### VST3 plug-ins (WebAssembly)

VST3 bundles that contain a WebAssembly build load and play like any other
plug-in. Drop the zipped `.vst3` bundle on the widget. Effects process the
synth. Instruments play from the keyboard, MIDI, the sequencer and the
looper, replacing the built-in synth's voices unless **Layer built-in synth**
is ticked. They play into master volume ahead of the effect chain, so
effects (VST3 or built-in), **Record**, **Render audio** and the scope all
include them, and clips played through effects are not muted. Tempo-synced
plug-ins follow the session tempo. Modules with several plug-ins get a
picker, and parameters show the plug-in's own value text.

How it works: `native/vst3web/vst3web.cpp` is a small VST3 host written
against the official [VST3 SDK](https://github.com/steinbergmedia/vst3sdk)
hosting classes (`HostApplication`, `HostProcessData`, `ParameterChanges`,
`EventList`). It is compiled into the same WebAssembly module as the
plug-in, where it drives the plug-in through the real VST3 interfaces
(`IPluginFactory`, `IComponent`, `IAudioProcessor`, `IEditController`,
`IConnectionPoint`). The browser runs that module in an AudioWorklet
(`js/vst3-worklet.js`) through `js/vst3-runtime.js`. The bundle uses the
standard VST3 layout, with `wasm32-web` as the architecture folder:

```
Name.vst3/Contents/wasm32-web/Name.wasm
Name.vst3/Contents/Resources/VST3-SDK-LICENSE.txt
```

The SDK is ported with Emscripten's CMake toolchain. `native/CMakeLists.txt`
loads the SDK's own CMake modules under `emcmake`, which build its `base`,
`pluginterfaces`, `sdk_common`, `sdk` and `sdk_hosting` libraries for
WebAssembly (the SDK sees Emscripten as Linux). Each plug-in is then linked
with those libraries and vst3web into one `.wasm` and zipped as a bundle.
`native/build.sh` fetches the SDK at a pinned commit and runs:

```sh
emcmake cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/build
```

To build another plug-in, add a `vst3web_add_plugin(Name sources...)` call,
listing the sources its own CMakeLists.txt passes to `smtg_add_vst3plugin`,
to `native/CMakeLists.txt` or to a file passed as
`native/build.sh -DVST3WEB_EXTRA=path/to/plugins.cmake`.

The bundled builds are listed under **Add built-in**:

- **Steinberg AGain (with its own editor)**: a gain with a VU meter, and its
  VSTGUI editor (see *Plug-in editors* below)
- **Steinberg ADelay**
- **Steinberg AGain Sample Accurate**: sample-accurate gain, plus the SDK's
  Advanced Tutorial class
- **Steinberg SyncDelay**: a delay synced to the host tempo
- **The MDA collection**: 30 effects, the DX10, JX10, Piano and ePiano
  instruments, and a test-tone generator.
- **VST3 instrument: MDA JX10, DX10, Piano, ePiano**: the collection's
  instruments as their own entries, ready to play.

`node tests/vst3-wasm.mjs` opens all 40 classes, processes audio through
each one or plays a note on it, and checks the output. Every bundle must say
which editor it has, and for every class with a VSTGUI editor it opens the
editor, draws a frame that must not be blank, drags across it until a control
moves, and checks the processor hears it (AGain's output falls to silence).
`node tests/plugin-editor.mjs` does it all in Chrome with AGain's real editor:
drawn at its size, its slider dragged (the sound and the generic Gain follow,
and its VU meter moves with the level), the generic Gain moving its slider,
−6 dB typed into its field (the keys don't play the synth), its **Send!**
message reaching the processor in the worklet, the fallback forced, and again
at a 2× pixel ratio. AGain Sample
Accurate starts at 0% gain, SyncDelay's default whole-note delay is longer
than the test, and TestTone starts switched off, so those three are silent
until their parameters are changed.

#### Plug-in editors

A plug-in with an editor shows it in its window, drawn and played as on a
desktop, with its generic controls always behind it (see *The plug-in's own
editor, or its generic controls* below). **VST3: Steinberg AGain (with its own
editor)** under **Add built-in** is Steinberg's AGain sample with its VSTGUI
editor: the gain slider, a dB field you can type into, a VU meter fed by the
processor, and a text field and **Send!** button that send a message from the
controller to the processor.

How it works:

- **VSTGUI in the browser.** VSTGUI has backends for macOS, Windows and Linux
  (X11 or Wayland with Cairo). `native/vstgui-web` adds one for the browser:
  a platform factory, frame, drawing context, paths, gradients, bitmaps,
  fonts, timers and resources, about 1,000 lines. It draws with the page's
  Canvas 2D (`js/vstgui-web.js`) rather than Cairo compiled to WebAssembly:
  Cairo would bring pixman, FreeType, fontconfig and Pango (several MB, and
  fonts to ship), where the browser already draws antialiased paths,
  gradients, images and text. VSTGUI's own state (clip, transform, colours,
  line style) is kept on its side and set on the canvas around each call, as
  its Cairo backend does around each Cairo call, with the same pixel
  alignment. Bitmaps are the PNGs in the bundle's `Contents/Resources`,
  decoded by the browser before the editor opens; the `.uidesc` is read from
  there too. Text edits and option menus are VSTGUI's own generic ones, typed
  into from the page's keys. The editor draws at the screen's pixel ratio
  (a 2× screen gets twice the pixels) and can ask to be resized.
- **The host.** `vst3web.cpp` calls `createView`, offers the platform type
  `HTMLCanvas` (and, for VSTGUI editors that only know desktop types, the X11
  one, which the web platform stands in for), `attached`, `onSize` and
  `removed`, gives the view an `IPlugFrame` for resize requests, and forwards
  pointer, wheel and keyboard events and window activation.
- **Controller and processor apart.** The processor runs in the AudioWorklet
  (role *audio*); the editor runs in its own instance of the same module on
  the page's thread (role *editor*), so an editor that fails takes nothing
  else with it. The controller's edits (`IComponentHandler`'s `beginEdit`,
  `performEdit`, `endEdit`) go to the processor and move the generic
  controls; the processor's output parameters (meters) come back about 30
  times a second; and `IConnectionPoint` messages cross between the two,
  serialized with all their attributes. The editor's controller starts from
  the processor's state and the current values.

Building one: list its sources, then `GUI vstgui` and its `RESOURCES` (the
`.uidesc` and its bitmaps):

```cmake
vst3web_add_plugin(AGain
    ${S}/again/source/again.cpp ${S}/again/source/againcontroller.cpp
    ${S}/again/source/againentry.cpp ${S}/again/source/againsidechain.cpp
    GUI vstgui
    RESOURCES ${R}/again.uidesc ${R}/background.png ${R}/slider_background.png ...
)
```

`native/build.sh` fetches the SDK's `vstgui4` submodule with the rest, and
`native/CMakeLists.txt` compiles VSTGUI's own sources (all but its platform
folder) with the web platform. Every bundle says which editor it has in
`Contents/Resources/editor.json` (`{"framework": "vstgui"}` or `"none"`),
which is how the page picks the adapter that shows it, and a bundle with a
VSTGUI editor carries VSTGUI's license (`VSTGUI-LICENSE.txt`). Plug-ins with
no editor keep building as before: AGain Sample Accurate, SyncDelay and the
MDA plug-ins have none, and ADelay's is for iOS only. (AGain Sample Accurate
has no VSTGUI editor; AGain is the SDK sample that does.)

| Editor framework | Status here | How it would be built | What it needs, and limits |
| --- | --- | --- | --- |
| **VSTGUI** (Steinberg's samples, many open-source plug-ins) | Supported | `GUI vstgui` | Text edits and option menus are VSTGUI's generic ones; no OpenGL views, drag and drop, or file selectors; the clipboard takes copied text; bitmaps packed inside a compressed `.uidesc` aren't decoded (ship them as files in Resources) |
| **iPlug2** | Generic controls | not yet | Its IGraphics already draws to a canvas in its WAM builds (NanoVG over WebGL, or Canvas); an adapter would link that backend into the vst3web module in place of its WAM glue and route its parameter calls through `IComponentHandler` |
| **DPF** | Generic controls | not yet | DGL has an Emscripten and WebGL path; its VST3 wrapper would be built with vst3web, and its UI-to-DSP calls (`setParameterValue`, `editParameter`, `sendNote`, `setState`) bridged as the editor's edits and messages are |
| **JUCE** | Generic controls | not yet | No browser backend upstream: an Emscripten `ComponentPeer` (JUCE's software renderer into an image put on a canvas), browser events mapped to JUCE's mouse and key events, and a message loop driven by `requestAnimationFrame`. JUCE is GPL or commercial, which decides which plug-ins may be built and shipped |
| **Dear ImGui, NanoVG, raw OpenGL** | Generic controls | not yet | Their GL calls mapped to WebGL2 through Emscripten's GLES3 support |
| **Cocoa, Win32 or X11 directly** | Generic controls only | — | Drawn with an operating system's own windows: can't be ported generically |

The adapter interface is the same for all of them (`js/plugin-editor.js`), so
each one is a module that registers itself; a framework without one falls
back to the generic controls, saying which framework it is.

### Native plug-ins: identified, not run

A VST3, Audio Unit, VST2, CLAP or AAX file that only contains macOS,
Windows or Linux machine code can't run in a browser. Browsers execute
only JavaScript and WebAssembly, and the binary also depends on its
operating system's frameworks. For these files, `js/native-id.js` reads
what the plug-in says about itself, entirely in the browser:

| Source | What it reads |
| --- | --- |
| `Contents/Info.plist` (XML or binary) | name, bundle ID, version, minimum macOS, Audio Unit type and vendor |
| `Contents/Resources/moduleinfo.json` | VST3 class name, vendor, version, SDK version, sub-categories |
| Binaries (Mach-O, PE, ELF, WebAssembly headers) | platform and CPU architectures |
| Strings inside binaries | VST3 sub-categories, VST SDK version, framework (JUCE, iPlug2, DPF, ...) |
| `.pkg` installers (xar) | each component's `PackageInfo` and gzip cpio `Payload` |
| Nested archives, `.dmg`, `.exe`, `.msi` | nested archives are opened; the others are flagged with next steps |

Each card then offers three routes: rebuild from source with
`native/build.sh` (`vst3web_add_plugin`), **Capture its sound**, or a
quick built-in stand-in.

### Capturing a plug-in's sound

When there's no source code, a plug-in's behavior can be measured instead.
**Capture a plugin** generates a test signal: an exponential sine sweep
plus stepped-level 100 Hz tones. Run it through the plug-in in any DAW,
export the result, and drop it back on the widget. `js/capture.js` then
fits one general model:

- an impulse response, from regularized FFT deconvolution of the sweep;
- a level curve, from the stepped tones, kept only if it improves the fit.

It also reports the plug-in's latency and how closely the model matches.
`js/capture-engine.js` runs the model as a plug-in with Input, Mix and
Output controls, and **Export .zip** shares it.

Tone, EQ, filtering, reverb, delay and saturation carry over. Modulation
and compressor timing are approximated, and the score says so.
`tests/capture.html` checks the method against reference effects:

| Reference effect | Match |
| --- | --- |
| Linear EQ, reverb, latency + shelf | 100% |
| Saturation | 99% |
| Compressor | 98% |
| Chorus | 80% (flagged "Rough") |

### Licensing

The VST3 SDK is MIT-licensed (`LICENSES/VST3-SDK.txt`), and its license
ships inside every built bundle. The MDA plug-ins, ADelay, AGain, AGain Sample
Accurate and SyncDelay are SDK samples under the same license. VSTGUI, which
draws AGain's editor, is under the BSD 3-Clause license (`LICENSES/VSTGUI.txt`),
which ships inside every bundle built with a VSTGUI editor;
`native/vstgui-web`, its browser platform, is under the same license. VST is a
trademark of Steinberg Media Technologies GmbH; this project only uses the
name to describe the format.

The AI teacher's on-device models load at runtime from CDNs and are not
bundled: Laya by ConvAI Innovations, in the browser port
[layaForWeb](https://github.com/vishalmysore/layaForWeb) (both Apache-2.0;
`laya-core.js` is loaded from jsDelivr pinned to a commit, the weights from
Hugging Face pinned to a revision), ONNX Runtime Web (MIT),
`@huggingface/tokenizers` (Apache-2.0), WebLLM (Apache-2.0), and Qwen 3.5 under
its own model licence.

The neural voices load at runtime and are not bundled: Pocket TTS model weights
and voices © Kyutai (CC BY 4.0, some voices CC0, two marked non-commercial),
run through pocket-tts-js (MIT); Supertonic 3 by Supertone (sample code MIT,
weights OpenRAIL-M); Piper voices from rhasspy/piper-voices (MIT, each voice
under its training data's licence) with espeak-ng (GPL-3.0) for phonemes.

The course's lesson texts are adapted from *Open Music Theory* by Kris Shaffer,
Bryn Hughes, Brian Moseley and contributors (Hybrid Pedagogy Publishing),
licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); the
adapted texts in `js/lessons.js` are shared under the same license
(`LICENSES/OpenMusicTheory-CC-BY-SA-4.0.txt`). The Course tab credits it too.

The service worker needs `https://` or `http://localhost`. Tests (Node 22 or
later, nothing to install; see *Running it*):

- `node tests/all.mjs`: every suite below, in parallel, with one answer (see *Checking for regressions*)
- `node tests/waveforms.mjs`: every waveform rendered by the browser's own Web Audio and measured, then the Oscillators widget used and played through the synth in the app, all compared with recorded fingerprints (headless Chrome, no dependencies; see *Testing the waveforms*)
- `node tests/widgets.mjs`: every widget dragged onto every other one, at three widths: the space it will drop into is open, outlined, empty and steady, and it lands there (headless Chrome)
- `node tests/settings.mjs`: the Settings menu (clicking off closes it); the PANIC and 🎓 buttons off by default and switched on; switching the AI teacher off and on; stopping every sound from Settings or the PANIC button; the panic on coming back to the tab; and every switch kept after a reload (headless Chrome)
- `node tests/themes.mjs`: every UI theme, and the UI scale, chosen and then back after a reload by the time the page is parsed and at its first frame; switching back to the default; a retired theme name (headless Chrome)
- `node tests/oscillators.mjs`: the oscillator bank's settings
- `node tests/archive.mjs`: archive reading and writing
- `node tests/formats.mjs`: WAV, AIFF and MIDI reading and writing
- `node tests/sequencer.mjs`: sequencer scales and pattern transposition
- `node tests/coach.mjs`: chord and scale names to notes, every coaching step in every key, and fitting examples onto 25 keys
- `node tests/lessons.mjs`: every course lesson's task, played right and wrong, including the rhythm lessons' timing
- `node tests/workspace.mjs`: widget guides, workspace lessons, System 1's answers and tips, plug-in learning, System 2 supervising, saved conversations, clearing downloaded models
- `node tests/requests.mjs`: requests to play something met by System 1, and System 2's examples read reliably
- `node tests/voice.mjs`: how talk mode reads music notation aloud
- `node tests/teacher.mjs`: the AI teacher's analysis and API requests
- `node tests/native-id.mjs`: identification (macOS; uses `clang`, `pkgbuild` and `productbuild`)
- `node tests/vst3-wasm.mjs`: the WebAssembly VST3 builds, and their VSTGUI editors opened, drawn and dragged
- `node tests/plugin-editor.mjs`: plug-in windows' editors and generic controls, every way an editor can fail forced, and AGain's real VSTGUI editor used (headless Chrome)
- `node tests/commands.mjs` and `node tests/teacher-panel.mjs`: settings changed by the teacher when asked, tools for System 2, the panel (headless Chrome for the panel)
- `node tests/timing.mjs` and `node tests/timing-panel.mjs`: beat, tempo and rhythm (headless Chrome for the app)
- `tests/capture.html` in a browser: capture accuracy

## Running it

Static HTML, CSS, and JavaScript modules, no build step and no bundler. The only external dependency
is the Poppins webfont from Google Fonts (plus whichever AI provider you pick for
the teacher, if any).

```sh
python -m http.server 8000
# then open http://localhost:8000/
```

Node is not needed to run the app. It is used only by the test suites in
`tests/`, which need Node 22 or later (for its built-in WebSocket) and import
nothing but Node's own modules, so there is nothing to `npm install`. There is
no `package.json`; the committed `package-lock.json` is empty and unused.

Browsers require a user gesture before audio can start, so the `AudioContext`
is created lazily on the first interaction and resumed if it is suspended. Web
MIDI additionally requires a secure context, `https://` or `http://localhost`.

## Layout

```
index.html     synth markup and module entry points
js/            synthesis, sequencer, automation, widgets, plugins, and persistence modules
plugin-sw.js   service worker that serves files from loaded plugin archives
plugins/       built-in effects (source and zip)
tools/         plugin packaging script
native/        VST3 SDK host shim, VSTGUI's browser platform (vstgui-web) and WebAssembly build script
LICENSES/      third-party licenses
stylemain.css  themeable synth styling
workspace.css  responsive modular workspace
robots.txt     crawl policy and sitemap pointer
```

## Browser support

Web Audio is universal, but **Web MIDI is Chromium-only**; Firefox and Safari
do not implement `navigator.requestMIDIAccess`. The code degrades gracefully:
it checks for the API and logs `No MIDI support.` rather than throwing, so
everything except hardware controller input still works.

## Credits

Built by [jamubc](https://github.com/jamubc) and
[shubin123](https://github.com/shubin123); both are credited in the badge in
the bottom-right corner of the running page.

## Known limitations

- **The metronome uses `setInterval`.** `startMetronome` schedules ticks on a
  JavaScript timer rather than against the audio clock. Timer callbacks drift
  and are throttled in background tabs, so the click will wander relative to
  quantised loop playback, which *is* scheduled on `audioContext.currentTime`.
  The usual fix is a lookahead scheduler that queues clicks slightly ahead of
  the audio clock.
- **Computer-key labels only appear on the first two octaves** (`o < 2` in
  `createKeyboard`), so selecting three or four octaves leaves the higher keys
  unlabelled even though the mapping continues.
- The sequencer uses an audio-clock-driven timer; timing can still be affected by
  heavy main-thread load. Existing loop recordings retain their original timing.
