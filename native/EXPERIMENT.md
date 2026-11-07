# Browser-only native VST3 execution

## Status

This is an execution **experiment**, not an executable-to-Wasm converter,
decompiler, or playable native VST3 host. It does not recover source code,
produce a `wasm32-web` bundle, or wire a native plugin into the realtime audio graph.
The existing `native/vst3web` source-build path remains the supported way to
run VST3 DSP in this app. XMachOViewer is not bundled or used as a decompiler;
the experiment's JavaScript loader implements the needed Mach-O parsing.

The goal of the experiment is to attempt the supplied Arcade binary's real
startup in a browser, rather than infer compatibility from strings or offer
a sampled substitute. The attempt has reached actual machine-code execution,
but **Arcade is not playable**.

## Run

```sh
python3 -m http.server 8000
```

Open `tools/native-vst3.html` on that localhost server, or follow **Native
execution experiment** from a macOS x86_64 VST3 card in the app. Select a
`.pkg`, a ZIP containing one macOS VST3 executable, or the executable itself.

- **Try normal startup** executes static initializers and the real bundle entry,
  stopping on faults or unsupported dependencies. A bounded CFBundle/CFURL layer is supplied
  for plugins exporting `bundleEntry`.
- **Factory-only diagnostic** skips all initialization and calls the native
  `GetPluginFactory`, `getFactoryInfo`, `countClasses`, and `getClassInfo`.
  An answer is not evidence of successful startup; even class IDs can be wrong.
- **Try audio processor** runs normal startup, creates the actual VST3 component,
  initializes it with host callbacks, queries IAudioProcessor, enumerates/activates
  buses, and negotiates float32 offline processing. It then closes the processor.
- **Render note 60 preview** attempts that pipeline and processes a bounded
  quarter-second note into a WAV preview. Silence is explicitly labeled. This is
  offline rendering, not realtime MIDI hosting; no stand-in oscillator is used.
- **Stop** terminates the entire worker. Each new attempt uses a fresh worker.
- **Download report** exports the result, including the failing stage and import
  or address, without exporting proprietary code.

The emulator is a locally patched, Emscripten-built Unicorn.js x86 CPU
engine, not a macOS implementation. Its bytes are bundled in `vendor/unicorn`
and verified against a pinned SHA-256 before loading. There is no network
fallback and no npm runtime dependency. The complete corresponding source,
GPL-2.0 license, upstream pins, and rebuild instructions are included there.
`native/build-unicorn.py` rebuilds the supplied source archive in a fresh
directory; this build path was verified before publication. No plugin content
is uploaded or included in the repository.

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
4. The patched emulator passes the previous Wasm memory-out-of-bounds crash.
   Integer scanning now parses the actual formatted class IDs. Initialization
   executes 22 `sprintf`, two `strcpy`, 20 `strcat`, and two `sscanf` calls.
5. Thirty-seven mutexes are initialized; 6,680 lock/unlock pairs execute using tracked
   single-threaded ownership/depth, not unconditional-success stubs. Floating
   imports execute 378 `exp2`, 8,237 `pow`, and 15 `tan` calls through the SSE ABI.
6. Nine `getrlimit`/`setrlimit` attempts run against an actual bounded guest
   descriptor table. The final descriptor limits remain 256/256; requests to
   raise the guest's hard limit fail with errno rather than claiming success.
   Mach timebase/absolute-time and wall-clock queries execute, as does the
   imported `NSObject` class-identity query.
7. Objective-C registration creates three dynamic class pairs with 19 methods
   and four ivars. The bridge canonicalizes 551 selectors and reads seven
   protocol definitions, including the adopted `NSPasteboardItemDataProvider`.
   A tracked `realloc` also executes.
8. Twenty-four libc++ string copy constructors, 16 hash-table prime-sizing calls,
   classic C locale construction/copying and real ctype/collate facet dispatch
   execute. Imported `_DefaultRuneLocale` supplies the Darwin ASCII tables.
9. Twelve embedded fonts load through retained CFData/provider/font objects.
   Bounded SFNT parsing supplies actual font names, units and metrics; UTF-8
   conversion, CFNumber/dictionary creation and autorelease pools execute.
   The absent guest `/System/Library/CoreServices/SystemVersion.plist` returns
   nil through a filesystem lookup, not an unconditional Foundation stub.
10. Three single-precision `__exp10f` calls and one pthread key creation run.
    **All 768 static initializers complete**, verified in Node and Chrome.
11. The real `bundleEntry` retains a guest bundle, copies its URL, obtains the
    UTF-8 path `/plugin/Arcade.vst3` and returns true. Normal startup reaches the
    factory with `initialized: true` and class IDs
    `56535441524344617263616465000000` (component) and
    `56534541524344617263616465000000` (controller).
12. The processor probe invokes the real factory's `createInstance`. It executes
    pthread identity, run-loop source creation/registration and guest Objective-C
    instance creation, then stops at **`NSNotificationCenter defaultCenter`**.
    This Cocoa class is not implemented. No Arcade processor has been returned
    and **zero Arcade audio blocks have run**; `playable` remains false. A passing
    generated audio fixture is not a passing Arcade playback test.

The old published engine faulted at last CPU entry `0x100412c3`. Source
profiling and ASAN isolated a TCI adapter temporary-lifetime leak: helper-call
argument extensions were allocated but never freed, corrupting long
instrumented translation blocks. The bundled source frees these temporaries
after emitting the helper call; the optimizer remains enabled. An independent
512-group load/store regression now completes. No plugin machine code was
changed to fix this host-engine defect.

Fixing this emulator defect is not proof that Arcade will run:
the binary imports 31 native libraries/frameworks, including Objective-C,
Cocoa, WebKit, CoreAudio, Security, and Accelerate. Their behavior, plugin
resources/content, licensing, complete VST3 object creation and Arcade event/audio
processing remain unverified/unimplemented. Real-time performance is not established.
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
- A bounded single-threaded libc/C++ and CoreFoundation subset
  is supplied. Allocation is a bounded bump allocator; frees
  retire records but do not reclaim space. `realloc` preserves contents when
  growing, tracks shrinking, and preserves the original on allocation failure.
  Destructors are registered but the
  diagnostic worker is discarded rather than implementing macOS unload.
- `sprintf`/`snprintf` support bounded integer, byte-string, character and
  pointer conversions with register and stack arguments. Unsupported floating,
  wide-character, positional and `%n` conversions fail explicitly. `snprintf`
  returns the untruncated byte count and honors zero capacity.
- The string copy bridge supports the observed x86_64 libc++ default 24-byte
  layout, not the alternate layout or other standard libraries. Short strings
  retain their inline representation; long strings get independent storage,
  including embedded NUL bytes and a terminating NUL. Contents are bounded to
  1 MiB and malformed sizes/capacities fail explicitly. Both C1/C2 constructor
  entrypoints and bounded assignment, append, insert, erase, resize, reserve,
  comparison and search operations are supported. Other string operations fail.
  `__next_prime` returns the lowest prime at least as large as its input, with
  the libc++ zero special case; requests above 2^24 fail explicitly instead of
  truncating 64-bit input or running an unbounded primality search.
- Locales support only the classic C locale, shared ownership, ctype<char> and
  collate<char> facets. Their callable guest vtables implement case conversion,
  widening/narrowing, comparison, transformation and hashing. Darwin rune tables
  provide ASCII classifications/case mappings; non-ASCII classification is zero.
  Other facets, named locales and locale loading are not implemented.
- CoreFoundation supports bounded data, UTF-8/ASCII strings, numbers and immutable
  dictionaries with standard type callbacks or pointer identity. Font providers
  retain their source data; SFNT table parsing supplies names and scaled hhea
  metrics, not glyph rasterization or a complete CoreText implementation. Custom
  allocators/callbacks, arbitrary CF objects and general Foundation remain unsupported.
- Darwin FILE globals and bounded descriptor-backed stdio implement integer/string
  printf and va_list calls, transfers, status flags and callbacks. Floating printf
  remains unsupported. Calls accept at most 64 integer/pointer arguments, including
  correctly aligned native stack arguments.
- `sscanf` supports bounded ASCII integer conversions, field widths, assignment
  suppression, length modifiers and literal/whitespace matching. It writes the
  declared integer size through register/stack pointer arguments and reports
  assignment counts or EOF. Unsupported conversions and out-of-range integers
  fail explicitly; this is not a complete locale-aware scanning library.
- Mutex attributes and normal/error-checking/recursive mutexes have guest-local
  state. Static Darwin signatures are recognized, recursive depth is checked,
  locked destruction/trylock return busy, and invalid objects return errors.
  Normal self-deadlock fails explicitly instead of claiming a lock was acquired.
  This only models one guest thread; it provides neither thread creation nor a
  cross-thread scheduler. Priority-ceiling protocols remain unsupported.
- Up to 512 pthread keys track full-width values for the single guest thread.
  Creation records validated destructor addresses; deletion does not invoke them.
  Thread exit/destructor execution and real thread creation remain unsupported.
- `pthread_self` supplies one stable guest-local opaque thread identity;
  `pthread_equal` validates that identity. This does not expose a host thread.
- Bundles implement retained identity and owned absolute file URLs, bounded UTF-8
  filesystem representations and POSIX path copies. The bundle path comes from
  the selected bundle name, not a host filesystem lookup. Bundle metadata/resource
  APIs, dynamic loading and unload via `bundleExit` are not implemented. Failed
  startup is cached so initializers are never rerun against a partially initialized
  image. C++ boolean return values use AL, not undefined upper RAX bits.
- A cooperative, single-threaded CFRunLoop subset tracks version-zero sources,
  modes, ordering, coalesced signals, invalidation and retained registration.
  Native perform callbacks execute between processing blocks, with bounded drain
  counts. Custom ownership/schedule callbacks and blocking run-loop APIs remain
  unsupported; this is not a Cocoa event loop or a thread scheduler.
- The native audio bridge uses actual component/processor vtables and bounded
  IHostApplication/IEventList callbacks. It supports float32 buses, note on/off,
  at most 16 buses per direction and 128 audio channels per direction, and blocks
  of 1–4096 frames at 8–192 kHz. Offline renders contain at most 48,000 frames.
  Processing reuses guest allocations, rejects non-finite audio and control-voltage
  buses, and propagates signed 32-bit VST3 failures without losing precision in
  JavaScript. Host message creation, parameter changes, controllers/editors, timing
  context and realtime AudioWorklet integration are not implemented. Reports keep
  `playable: false` even when an offline fixture render succeeds.
- Scalar double and selected single-precision math imports use full 16-byte XMM register reads/writes, with
  arguments in XMM0/XMM1 and results in XMM0. They provide numerical values, not
  a complete macOS libm floating-exception/errno environment or last-bit libm
  equivalence guarantee. Single-precision results round to float32; vector math
  entrypoints remain unsupported.
- The guest has a 256-slot descriptor table with real soft/hard limit
  enforcement, independent descriptor flags, shared open-file offsets on dup,
  64-bit seeking, close/read/write and a small fcntl subset. `RLIMIT_NOFILE`
  reads and changes this table's limits, never the host machine's limits.
  Errors return -1 and store Darwin errno values in stable guest-local storage;
  invalid guest buffers return EFAULT. Other resource categories and unsupported
  fcntl commands stop explicitly.
- `NativeVst3Guest` accepts an optional `files` map of read-only byte resources
  (64 MiB total, at most 4,096 files) for the virtual filesystem. Relative paths start at `/plugin`;
  no path accesses the real host filesystem. The current file-picker worker
  does **not** yet mount package resources or external sample/license files.
  Its filesystem starts empty. Empty stdin and bounded 64 KiB stdout/stderr
  buffers are modeled; output and descriptor limits are included in reports.
- Mach absolute-time ticks derive from the browser monotonic clock, with an
  internally consistent 1/1 nanosecond timebase and nondecreasing results.
  This conversion does not improve the browser clock's actual resolution.
  `gettimeofday` uses wall time and the Darwin 64-bit timeval field layout;
  legacy timezone output remains unsupported.
- The bounded Objective-C bridge models dynamic classes/metaclasses, selectors,
  methods, aligned ivars, instances and protocol inheritance/conformance. Guest
  method dispatch preserves the native call stack, including nested calls and
  stack arguments. Nil sends clear integer and vector return registers. Only
  a small NSObject fallback and managed NSString subset are supplied, with
  explicit retain/release and bounded nested autorelease pools. Missing-file
  NSDictionary lookup returns nil; parsing existing property lists fails explicitly.
  General Foundation and static class realization remain unsupported. Custom `+initialize`
  and C++ object lifecycle callbacks fail explicitly, as do unknown messages.
- CPU instruction allowances and per-call elapsed-time checks are backed by
  a separate page-side worker watchdog (30 seconds by default). The watchdog
  can terminate a wedged Wasm emulator; it does not rely on guest cooperation.
- This is not a security audit. Keep browser security features enabled and
  only load files you are authorized to analyze. No native code is run by macOS.

## Verification

```sh
node tests/native-vst3.mjs
node tests/native-vst3-scanf.mjs
node tests/native-vst3-mutex.mjs
node tests/native-vst3-files.mjs
node tests/native-vst3-objc.mjs
node tests/native-vst3-libcpp.mjs
node tests/native-vst3-browser.mjs
ARCADE_PKG='/absolute/path/to/Arcade_OSX_Install_2.2.0.R18263.pkg' node tests/native-vst3-browser.mjs
npm test
```

The ordinary suites use small, explicitly generated machine-code/Mach-O,
ZIP, xar, and cpio fixtures, not copies of commercial plugin code. They
cover native virtual calls, dyld backward/wrapped offsets, BSS zeroing,
SSE float processing, supported and unsupported imports, faults, limits,
package truncation, worker cancellation, watchdog expiry, and recovery with
a fresh worker. Scanning tests verify 64-bit and narrow stores, canary bytes,
stack arguments, mismatch/EOF returns, and explicit unsupported formats. Mutex
tests verify lifecycle errors, static initialization and recursive depth. Browser
fixtures execute scanning, static-mutex and descriptor-limit imports from native
initializers. File tests fill all 256 descriptor slots and check actual limit
enforcement, lowering limits with live descriptors, shared offsets, readonly
resources, 64-bit seeks, errno and short/full diagnostic writes. Clock tests
verify timebase fields, monotonic samples, negative wall timestamps and padding.
Objective-C tests cover registration, inheritance, ivar tail padding, protocols,
method replacement and explicit lifecycle failures. Generated native callbacks
verify nested dispatch, stack arguments and nil vector returns. A browser
fixture registers a class and executes its guest method to obtain a factory ID.
String tests verify inline/boundary/long copies, independent ownership, embedded
NULs, invalid representations, both native constructor entrypoints and a browser
initializer. Prime-sizing tests compare an exhaustive small range with a sieve,
check the supported upper boundary and reject oversized 64-bit requests.
Locale tests exercise native facet calls and imported rune-table reads; float32
tests verify SSE input/output widths. CoreFoundation tests cover data ownership,
font metadata and malformed tables, names/metrics, UTF-16 ranges, UTF-8 output
capacity, full-width numbers, dictionary callbacks and autorelease lifetimes.
Stdio tests verify actual descriptor output, va_list/stack arguments, EOF/errors
and bounded diagnostics. TLS tests cover independent values, destructor registration,
deletion/reuse, invalid keys and 512-key exhaustion.
The optional Arcade test separately verifies factory-only
execution, **768/768 static initializers**, and the explicit CFBundle startup
success, followed by the actual Cocoa failure during processor creation, not
Arcade audio playback. Its startup/processor probes explicitly use the supported
120-second watchdog to tolerate concurrent test-suite CPU load; the interactive
startup probe's default remains 30 seconds. Processor/render UI probes use 120 seconds.
Bundle fixtures execute actual x86 entry code, test UTF-8 path capacity and native
boolean return width, and prevent repeated failed initialization. Run-loop tests
execute ordered native callbacks and check registration ownership. Audio fixtures
execute actual factory/component/processor vtables, process stereo samples with
MIDI-controlled gain, verify signed failure returns and fixed guest allocation,
and transfer the resulting PCM through a worker into the WAV preview UI. None
contains proprietary plugin code or claims to reproduce Arcade's sound.
