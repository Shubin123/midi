# Adding a controller preset

A controller preset is one JSON file, `presets/<maker>/<model>.json`, checked
against [schema.json](schema.json) whenever it loads. No code anywhere else
knows about a particular controller: the Arturia MiniLab 3
([presets/arturia/minilab3.json](presets/arturia/minilab3.json)) is read by the
same loader as a preset made in the browser with MIDI learn. Start from it, or
from one of the generic presets in `presets/generic/`.

## 1. Gather the sources first

Every message in a preset must come from somewhere you can cite, never from
memory. In order of trust:

1. The maker's manual, MIDI implementation chart, and editor software manual
   (MIDI Control Center, Novation Components, …).
2. The maker's own DAW integration scripts, or a DAW's official ones for the
   device (Bitwig's open-source extensions, Ableton's remote scripts, FL
   Studio's device scripts). These are where SysEx for pad colours, screens and
   DAW modes usually is.
3. Captures from a real unit (see 5). Only these make a preset `hardware`.
4. Community sources, only to corroborate, said so in the source's `notes`.

List them in `sources` (an `id`, a `title`, a `url`), and give each message,
control or feedback entry a `source` saying which one and where ("manual §4.4",
"Bitwig PadBank.java"). When sources disagree, say so in the `source` and say
which you chose. Firmware matters: put what you know in `firmware`.

## 2. Write the preset

- `id` is `maker/model`, the file's path; `status` is `community` until the
  maintainers accept it as `official`; `verified` is `documented` (from the
  sources only) or `hardware` (every message checked against captures), never
  more than you checked.
- `detect`: the Universal SysEx identity reply's manufacturer, family and member
  bytes, and regular expressions for the port names on macOS, Windows and Linux,
  each with a `role`: `main`, `daw` (a DAW/MCU port, kept from playing notes) or
  `ignore`.
- `controls`: one per physical control (or a Shift layer that sends its own
  messages), with a `type`, a `label` as printed on the device, and a `role`
  lessons can name: `knob 1`…, `fader 1`…, `pad 1`…, `main encoder`, `shift`,
  `play`, `stop`, `record`, `loop`, `tap`.
- `programs`: what each control sends in each of the device's programs or modes
  (`cc`, `note` (with `pressure` for poly aftertouch), `notes` as a range for
  keys, `bend`, `pressure`, or `learn` when only the user can know), its
  `channel` (or `"any"`), and for a CC its `encoding`: `absolute`,
  `binary-offset`, `twos-complement`, `signed-bit`, `button` (127 down, 0 up) or
  `toggle`. `enter` and `exit` are sent when the program is used and let go (a
  DAW-mode handshake). A program the user makes in the maker's editor is a
  `template`.
- `listen` and `queries`: SysEx the device sends about its program or pad bank,
  as templates with a `{value}`, and what to send to ask it.
- `feedback`: `pads` (an RGB template with `{index}`, `{r}`, `{g}`, `{b}`, and
  each pad's index), `leds` (a control's own message echoed back), `screen` (a
  text template with `{text:line1:10}` and the width of each line), `encoders`
  (a template telling an encoder its value), the `programs` they work in, and
  `requires: "sysex"` if they need it.
- `shiftLayer`: what the device does by itself (its own arpeggiator, chord mode,
  transpose…), so the teacher can explain it.
- `variations`: what the app does with the controls. One is the `default`;
  others `extend` it and change only what they say. `pages` list what knobs
  move (element ids, "Widget › Control", `osc:2:level`, `loop:1:volume`,
  `tempo`, or `from` a plug-in, a widget or the automation lane). `mappings`
  give each control an action: `notes`, `bend`, `mod`, `sustain`, `page`
  (`slot`), `param` (`param`), `loop` and `clear` (`slot`), `step` and `drum`
  (`index`), `metronome`, `tap`, `record`, `play`, `stop`, `loop-toggle`,
  `browse`, `confirm`, `tempo`, `set-page`, `page-next`, `variation`, `arp`,
  `hold`, `shift`, … with an optional `hold` (half a second) or `shift` action.

What JSON can't say may go in a JS module of `hooks` beside an official preset;
it gets a frozen API (`send` to its device, `state`, `program`) and is never
run for a preset imported from a file.

## 3. Add it

Add its path to [presets/index.json](presets/index.json). Reload the app: a
preset that doesn't pass the schema is left out and the Controllers widget's
Presets says why (`node tests/controllers.mjs` says it too).

## 4. Test it without the device

Put the messages your sources give in `tests/captures/<model>.json`, in the
format of [minilab3.json](../../tests/captures/minilab3.json): for each program,
each control's bytes and the event they should be (`value`, `turn`, `press`,
`release`, `note`, `pressure`, `bend`), plus the SysEx it announces. Write them
from the sources, not from your preset, so the test checks one against the
other, and mark the file `"recorded": false`. Then add checks to
`tests/controllers.mjs` like the MiniLab 3's: every capture decodes to its
control, the port names and identity match, the feedback bytes are the
documented ones. `node tests/controller-panel.mjs` shows how to drive the app
with a mock device (tests/support/mock-midi.js) if your preset needs more.

## 5. Check it on hardware

With the device: in Chrome's console on the app,
`import('./js/controllers/midi.js').then(({ midi }) => midi.subscribe((t, d) => t === 'message' && console.log(d.port.name, [...d.data].map(b => b.toString(16).padStart(2, '0')).join(' '))))`
logs every message as it arrives. Move each control in each program, compare,
and record what came in as the captures (`"recorded": true`, the firmware
version). Check the feedback by eye: every pad colour, the screen, the DAW
handshake and its exit. Only then is the preset `"verified": "hardware"`.

## 6. Send it

Open a pull request with the preset, its captures and tests, saying what you
checked and on which firmware. Presets made in the browser can be exported
(Controllers › Presets › Export, or Import / Export › Export controller presets)
and shared the same way; imported, they are JSON only.
