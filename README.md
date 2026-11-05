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

Run the interpolation checks with `node tests/automation.mjs`.
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
- **The model** (`js/ai-teacher.js`). With **Auto** on, each phrase of three or
  more notes is summarised (the notes in order, pitch classes, best local match,
  chords) and sent to the model, which names what you played, explains it in a
  few sentences and suggests what to try next. If you keep playing while it
  answers, only your latest phrase is sent next. Type in the box at the bottom
  to ask anything else.

The model can end a reply with a line like
`{"play": [48, [60,64,67], [65,69,72]], "bpm": 90}`. Each item is one beat: a
number is a single note, and an array is a chord struck together, so the
teacher can demonstrate progressions, not just melodies. The panel plays them
through the synth (and any plug-in instrument following it), lights the keys as
they sound, and keeps a ▶ button to play them again.

### The panel

The panel has two tabs. **Lesson** is the conversation: a live strip shows the
note you just played and the chord under your fingers, local analysis and the
teacher's replies stack below it, and the ask box sits at the bottom with the
**Explain each phrase I play** switch. **Provider** is where answers come from.
The header always says what is connected (for example *Groq · llama-3.3-70b*)
and links to the Provider tab.

### Choosing a provider

Each provider is a **separate, direct connection** with its own sign-in;
nothing is routed through anything else (only OpenRouter itself forwards to
other model makers), and one is active at a time. The Provider tab lists them by
how you sign in:

| Group | Provider | Sign-in | Requests go to | Cost |
| --- | --- | --- | --- | --- |
| No sign-in | **On your device** | None | Nowhere: runs in the browser via [WebLLM](https://github.com/mlc-ai/web-llm) (`js/local-model.js`) | Free; 0.9–2.3 GB first download; needs WebGPU (desktop Chrome or Edge) |
| Sign in | **OpenRouter** | **Sign in with OpenRouter** (OAuth with PKCE, `js/ai-auth.js`), or a pasted OpenRouter key | `openrouter.ai`, which forwards to Google, Meta, OpenAI, Anthropic and others | Free models on a free account; others need credit |
| Your own API key | **Groq** | Groq key | `api.groq.com` | Free tier |
| | **Cerebras** | Cerebras key | `api.cerebras.ai` | Free tier |
| | **Google Gemini** | Google AI Studio key | `generativelanguage.googleapis.com` | Free tier |
| | **Mistral** | Mistral key | `api.mistral.ai` | Free tier |
| | **OpenAI** | OpenAI key | `api.openai.com` | Paid |
| Advanced | **Custom endpoint** | Base URL and key | Any OpenAI-compatible `/chat/completions` that allows browser requests (LM Studio, Ollama with CORS enabled, a self-hosted gateway...) | Depends on the service |

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

- **Steinberg ADelay**
- **Steinberg AGain Sample Accurate**: sample-accurate gain, plus the SDK's
  Advanced Tutorial class
- **Steinberg SyncDelay**: a delay synced to the host tempo
- **The MDA collection**: 30 effects, the DX10, JX10, Piano and ePiano
  instruments, and a test-tone generator.
- **VST3 instrument: MDA JX10, DX10, Piano, ePiano**: the collection's
  instruments as their own entries, ready to play.

`node tests/vst3-wasm.mjs` opens all 38 classes, processes audio through
each one or plays a note on it, and checks the output. AGain Sample
Accurate starts at 0% gain, SyncDelay's default whole-note delay is longer
than the test, and TestTone starts switched off, so those three are silent
until their parameters are changed.

Plug-in editors (VSTGUI or other native GUI code) are not compiled in. The
widget shows generic controls for every parameter.

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
ships inside every built bundle. The MDA plug-ins, ADelay, AGain Sample
Accurate and SyncDelay are SDK samples under the same license. VST is a
trademark of Steinberg Media Technologies GmbH; this project only uses the
name to describe the format.

The service worker needs `https://` or `http://localhost`. Tests:

- `node tests/archive.mjs`: archive reading and writing
- `node tests/formats.mjs`: WAV, AIFF and MIDI reading and writing
- `node tests/teacher.mjs`: the AI teacher's analysis and API requests
- `node tests/native-id.mjs`: identification (macOS; uses `clang`, `pkgbuild` and `productbuild`)
- `node tests/vst3-wasm.mjs`: the WebAssembly VST3 builds
- `tests/capture.html` in a browser: capture accuracy

## Running it

Static HTML, CSS, and JavaScript modules, no build step and no bundler. The only external dependency
is the Poppins webfont from Google Fonts (plus whichever AI provider you pick for
the teacher, if any).

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
js/            synthesis, sequencer, automation, widgets, plugins, and persistence modules
plugin-sw.js   service worker that serves files from loaded plugin archives
plugins/       built-in effects (source and zip)
tools/         plugin packaging script
native/        VST3 SDK host shim and WebAssembly build script
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
- Disabling the sub-oscillator or noise section silently forces its level slider
  to 0, so re-enabling it comes back muted rather than at the previous level.
- The sequencer uses an audio-clock-driven timer; timing can still be affected by
  heavy main-thread load. Existing loop recordings retain their original timing.
