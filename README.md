# midi: Ultimate Synthesia Online

A polyphonic subtractive synthesizer that runs entirely in the browser on the
Web Audio API, with a playable on-screen keyboard, live MIDI input, a four-slot
loop recorder, a metronome, an oscilloscope, and Synthesia-style falling notes.

Part of the [project-demos](https://github.com/Shubin123/project-demos) collection.

## Status: ✅ Working

Entirely self-contained; the only external request is the Poppins webfont.
Hardware MIDI input is Chromium-only; everything else works everywhere.

*Verified 2026-08-20 by requesting every external dependency this project uses over the network. The demo itself was not opened in a browser, so this reflects dependency health rather than a full functional test.*


## Signal chain

Each held note builds its own voice graph and tears it down on release:

```
Osc 1  ──┐
Osc 2  ──┤
Sub    ──┼── mix ── ADSR gain ── filter ── master gain ── analyser ── output
Noise  ──┘
```

| Stage | Details |
| --- | --- |
| **Oscillator 1** | Sine / square / sawtooth / triangle / pulse, base octave 2-6, ±100 cents detune, level |
| **Oscillator 2** | Same waveforms, ±2 octave offset, ±100 cents fine tune, 0-50 ms start delay, level |
| **Sub oscillator** | Sine / square / triangle, one or two octaves down |
| **Noise** | White, or an approximated pink |
| **Envelope** | Full ADSR: attack and decay to 2 s, sustain level, release to 5 s |
| **Filter** | Lowpass / highpass / bandpass / notch / allpass, cutoff 20 Hz-20 kHz on a logarithmic slider, Q up to 30 |

Two details worth calling out:

- **Pulse waves** are not a native `OscillatorNode` type. They are produced by
  running a sawtooth through a `WaveShaperNode` whose 256-point curve is a hard
  step positioned by the pulse-width control. That is the classic trick for
getting a
  variable-width square out of Web Audio.
- **Oscillator slop** applies a small random detune per voice, emulating the
  tuning drift of analogue oscillators so stacked notes beat against each other
  instead of phase-locking.

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
gap. The click itself is a short synthesised buffer rather than a sample.

### Visuals

- A 2048-point FFT oscilloscope that can be pointed at the master output,
  oscillator 1's sum, or oscillator 2's sum.
- Optional falling-note display over the keyboard, Synthesia style.
- **13 UI themes**: Midnight Drive, Solarized Dark, Crimson Peak, Cyber Glow,
  Forest Calm, Ocean Depth, Autumn Warmth, Lavender Haze, Desert Sunset,
  Steampunk Gears, Vintage Library, Monochrome Noir and Pastel Dream: applied
  by swapping CSS custom properties on the root element.
- Adjustable UI scale (75-150%), driven by a `--font-scale-factor` variable
  that the whole stylesheet sizes against.

Theme, UI scale, and the falling-notes toggle persist in `localStorage`.

### PANIC

A dedicated button force-stops every voice, clears the loop slots' playback
timers, and rebuilds the audio graph, the standard escape hatch for when a
stuck note leaves an oscillator droning.

## Modular sequencer workspace

The workspace adds a 16-step polyphonic sequencer and automation lanes for tempo
(30–300 BPM), filter cutoff, resonance, master volume, and oscillator detune.
Enable each lane to hear it; choose linear interpolation or held step values.
Use Ramp up and Flatten to edit a whole lane, or adjust individual step values.
Tempo automation changes sequencer speed as it plays. Stop restores manual values.
Playback stops when the page is hidden to avoid delayed notes on returning.
The original loop recorder still uses recorded event durations; tempo automation
does not time-stretch those recordings.

Drag a module by its header with a mouse or finger. Focus its header and use
arrow keys to reorder with the keyboard. The width button toggles a wide module;
mobile screens stack modules into one column. The hamburger menu can hide and
restore every widget and reset the layout. Widget order, widths, visibility,
sequence notes, and automation lanes persist in browser localStorage.

Source files:

- `js/synth.js`: existing synthesis, keyboard, MIDI, and loop recorder engine
- `js/sequencer.js`: sequencer transport and automation editor
- `js/automation.js`: automation targets, interpolation, and parameter application
- `js/widgets.js`: responsive widget layout, dragging, and visibility
- `js/storage.js`: browser persistence
- `js/app.js`: module assembly
- `workspace.css`: responsive workspace styling

Run the interpolation checks with `node tests/automation.mjs`.
Serve over HTTP as below; the new JavaScript modules require a web server.

## Running it

Static HTML, CSS, and JavaScript modules, no build step and no bundler. The only external dependency
is the Poppins webfont from Google Fonts.

```sh
python -m http.server 8000
# then open http://localhost:8000/
```

Browsers require a user gesture before audio can start, so the `AudioContext`
is created lazily on the first interaction and resumed if it is suspended. Web
MIDI additionally requires a secure context, `https://` or `http://localhost`.

## Layout

```
index.html     synth markup and module entry points
js/            synthesis, sequencer, automation, widgets, and persistence modules
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
- Disabling the sub-oscillator or noise section silently forces its level slider
  to 0, so re-enabling it comes back muted rather than at the previous level.
- The sequencer uses an audio-clock-driven timer; timing can still be affected by
  heavy main-thread load. Existing loop recordings retain their original timing.
