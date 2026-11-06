# Browser-only native VST3 execution

## Status

This is an execution **experiment**, not an executable-to-Wasm converter,
decompiler, or playable native VST3 host. It does not recover source code,
produce a `wasm32-web` bundle, or wire a native plugin into the audio graph.
The existing `native/vst3web` source-build path remains the supported way to
run VST3 DSP in this app. XMachOViewer is not bundled or used as a decompiler;
the experiment's JavaScript loader implements the needed Mach-O parsing.

The goal of the experiment is to attempt the supplied Arcade binary's real
startup in a browser, rather than infer compatibility from strings or offer
a sampled substitute. The attempt has reached actual machine-code execution,
but **Arcade is not playable**.

## Run

```sh
npm ci --ignore-scripts
python3 -m http.server 8000
```

Open `tools/native-vst3.html` on that localhost server, or follow **Native
execution experiment** from a macOS x86_64 VST3 card in the app. Select a
`.pkg`, a ZIP containing one macOS VST3 executable, or the executable itself.

- **Try normal startup** executes static initializers, stopping on faults or
  unsupported dependencies. A CFBundle compatibility layer is still required
  for plugins exporting `bundleEntry`.
- **Factory-only diagnostic** skips all initialization and calls the native
  `GetPluginFactory`, `getFactoryInfo`, `countClasses`, and `getClassInfo`.
  An answer is not evidence of successful startup; even class IDs can be wrong.
- **Stop** terminates the entire worker. Each new attempt uses a fresh worker.
- **Download report** exports the result, including the failing stage and import
  or address, without exporting proprietary code.

The emulator is `@alexaltea/unicorn-js` 2.1.4, an Emscripten-built x86 CPU
emulator, not a macOS implementation. Its unmodified single-architecture
distribution is pinned in `package-lock.json` and verified against SHA-256
`643adbbb0c77eadb71182f116c9da0860814221a25194dac3ed561589929ef6d`.
The worker prefers the installed package and otherwise fetches that exact
version from jsDelivr. No plugin content is uploaded. The engine's source
and GPL-2.0 license are available through the dependency's package metadata
and https://github.com/AlexAltea/unicorn.js; the npm release records source
commit `560284c59c11c8d6c94d537f4354339f069ddcdf`.

## Observed target: Arcade

Tested on November 6, 2026 against the user-supplied macOS installer named
`Arcade_OSX_Install_2.2.0.R18263.pkg`. Its embedded executable is
`Arcade.vst3/Contents/MacOS/Arcade`: 79,561,104 bytes, Intel x86_64 Mach-O.
The installer reports 2.2.0, while the embedded Info.plist reports 2.0.0.
These observations do not establish authenticity, authorization, or integrity
of the original distribution.

In **Chrome**, with the package selected directly from disk:

1. The worker extracts the VST3 payload, skipping installer scripts and other
   components, and maps the original executable into emulated memory.
2. Factory-only mode executes the actual factory and virtual methods. They
   return vendor `Output`, URL `www.output.com`, and two `Arcade` classes:
   `Audio Module Class` and `Component Controller Class`. Both class IDs are
   zero because initialization has not run. Calls include C++ allocation,
   zeroing, guarded statics, and `memcpy`.
3. Normal startup enters the first of **768** static initializers. The provided
   default-allocator constant and UUID bridge allow actual `CFUUIDCreate`,
   `CFUUIDGetUUIDBytes`, `CFRelease`, and `__cxa_atexit` calls.
4. The published emulator then raises a Wasm memory-out-of-bounds exception.
   The last CPU entry is `0x100412c3` (unslid `0x412c3`). The report identifies
   this as `emulator-fault`, not a guest memory fault or successful conversion.
   Zero initializers have completed; the worker is discarded.

A separate source build at upstream commit
`1220477c7fb0f8fe4b500f4bd211de52f6dfe638`, with Unicorn submodule
`8028ec436f2d9376525352dd38ed9ed6b9f6be10`, reproduced the same failure.
A profiling build identified the fault in `tcg_optimize_x86_64`, called by
translation-block generation. Increasing the Emscripten stack to 4 MiB and
adding stack checks did not resolve it. Disabling that optimizer did not
produce a returning startup attempt and is not shipped as a workaround.
Those diagnostic builds are not runtime dependencies.

Fixing the emulator is only the next step, not proof that Arcade will run:
the binary imports 31 native libraries/frameworks, including Objective-C,
Cocoa, WebKit, CoreAudio, Security, and Accelerate. Their behavior, plugin
resources/content, bundle startup, licensing, VST3 object creation, event and
audio processing, and real-time performance remain unverified/unimplemented.
No licensing checks are patched or suppressed.

## Boundaries

- Thin Intel Mach-O and ordinary universal binaries with an x86_64 slice;
  PE, ELF, ARM64-only binaries, chained fixups, and encrypted images are not
  supported by this loader. It uses classic dyld pointer rebases and binds.
- 256 MiB image/binary limit, 16 MiB package TOC limit, 32 MiB guest heap, and
  bounded dyld fixup operations. Installer content is streamed, not installed.
- Segment permissions and zero-filled BSS are modeled. Imports have explicit
  implementations or fail; unknown framework functions are never replaced by
  silent successful no-ops. Imported data also traps when unsupported.
- Only a small single-threaded libc/C++ bridge and default-allocator/UUID
  operations are supplied. Allocation is a bounded bump allocator; frees
  retire records but do not reclaim space. Destructors are registered but the
  diagnostic worker is discarded rather than implementing macOS unload.
- CPU instruction allowances and per-call elapsed-time checks are backed by
  a separate page-side worker watchdog (30 seconds by default). The watchdog
  can terminate a wedged Wasm emulator; it does not rely on guest cooperation.
- This is not a security audit. Keep browser security features enabled and
  only load files you are authorized to analyze. No native code is run by macOS.

## Verification

```sh
node tests/native-vst3.mjs
node tests/native-vst3-browser.mjs
ARCADE_PKG='/absolute/path/to/Arcade_OSX_Install_2.2.0.R18263.pkg' node tests/native-vst3-browser.mjs
npm test
```

The ordinary suites use small, explicitly generated machine-code/Mach-O,
ZIP, xar, and cpio fixtures, not copies of commercial plugin code. They
cover native virtual calls, dyld backward/wrapped offsets, BSS zeroing,
SSE float processing, supported and unsupported imports, faults, limits,
package truncation, worker cancellation, watchdog expiry, and recovery with
a fresh worker. The optional Arcade test separately verifies factory-only
execution and the **known startup failure**, not audio playback.
