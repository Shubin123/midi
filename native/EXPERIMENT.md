# Browser-only native VST3 execution

## Status

This is an execution **experiment**, not an executable-to-Wasm converter or
decompiler. It does not recover source code or produce a `wasm32-web` bundle.
Plugins needing no account can now be played live on the experiment page: the free,
GPL-3.0 **Dexed 0.9.8** is verified end to end (see below). Native plugins are not
wired into the main workspace's audio graph.
The existing `native/vst3web` source-build path remains the supported way to
run VST3 DSP in this app. XMachOViewer is not bundled or used as a decompiler;
the experiment's JavaScript loader implements the needed Mach-O parsing.

The goal of the experiment is to attempt the supplied Arcade binary's real
initialization and MIDI/audio processing in a browser, rather than infer compatibility from strings or offer
a sampled substitute. The real Arcade binary now completes its full VST3 lifecycle
and processes real MIDI, but **it renders silence without a signed-in Output
account, so Arcade is not playable**.

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

## Verified playable: Dexed 0.9.8

The official, notarized `dexed-macOS-0.9.8.pkg` (a free GPL-3.0 FM synthesizer needing
no account or content) loads, initializes and plays in Chrome through this emulator.
Newer Dexed releases are built with chained fixups, which this loader does not support.

- With no MIDI the output peak is exactly 0.
- Notes 48, 60, 69, 72 and 84 measure within 2.1 cents of their expected frequencies.
- Note-off releases the sound to silence. Velocity is not verified: the default patch
  shows no velocity response at 0.2, 0.5 or 1.0.
- Rendering costs about 0.3x realtime for one note and 0.6x for a four-note chord in Node.
  In Chrome, 713 live blocks including chords streamed through an AudioWorklet with no
  audio dropouts.

**Play live** on the page starts a dedicated worker that renders 256-frame blocks a few
blocks ahead and sends them straight to an AudioWorklet. Input comes from the on-screen
keys, the computer keyboard or Web MIDI. A stalled plugin is terminated after 8 seconds.

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
   guest-local ownership/depth, not unconditional-success stubs. Floating
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
    instance creation. **`NSNotificationCenter defaultCenter` now succeeds** and
    returns a persistent guest-local object. AppKit notification-name NSString
    constants, observer registration, filesystem/Unicode calls, malloc zones,
    atomic CAS, libc++ concatenation, RTTI casts, C-locale numeric parsing,
    floating-point diagnostics, combined sine/cosine and process-info CPU queries
    now pass, along with pthread attribute initialization and stack-size validation.
    A real guest pthread now executes the plugin's x86 entry point. Mutex and
    condition notification calls pass, and unsupported realtime priority requests
    return `ENOTSUP` without changing the worker's normal scheduling policy.
    The installer-backed run now passes **`NSThread currentThread` and `setName:`**
    in that worker while creating the component. Cocoa thread identity, main-thread
    queries, copied names, lifecycle queries and cooperative cancellation flags
    are now implemented and verified using generated x86 fixtures. Steady/system
    clocks, libc++ timed condition waits, nothrow array allocation, real mapped-image
    `dladdr` lookup and virtual `getcwd` now pass. Darwin64 filesystem statistics, UTC calendar conversion
    and executable-path lookup now pass. Disk Arbitration returns NULL because
    its service is unavailable; no session or hardware identity is fabricated.
    Guest-local `NSRunningApplication currentApplication` and `localizedName`
    now pass, followed by HTTP(S) `NSURL` parsing, mutable request construction,
    copied request bodies, mutable data buffers and delegate pointer-ivar
    assignment. Eight real workers execute; `_nanosleep` parks only the calling
    thread. Default session configuration and operation-queue lookup now pass.
    `NSURLSessionDataTask resume` and the plugin's real delegate callbacks now
    run on a guest delivery thread. With network access off (the default) Arcade's
    three requests (`api.output.com/v1/blocked_loops` and two to `api.rollbar.com`)
    are never sent and complete with `NSURLErrorNotConnectedToInternet`.
    Real PNG decoding through a bounded CoreGraphics subset, Accelerate, libc++
    `ostream` number formatting and libc additions then let the real
    `ArcadeAudioProcessor` construct fully. `createInstance`,
    `IComponent::initialize`, `setupProcessing`, activation and `setProcessing`
    all succeed, reporting one stereo output and one event input, and a real
    note-on/note-off runs through **94 real `process` blocks** (12,000 frames at
    48 kHz) and a clean shutdown. This is verified in Node and Chrome in about
    80 seconds, peaking near 172 MiB of guest heap.
13. **Arcade still renders silence (peak exactly 0), and `playable` stays false.**
    Its own log records `ATUserManager::loadUserDataFile mIsLoggedIn=false`, and it
    opens no sample files for the note. The same silence occurs when the signed
    installer's content package is mounted through the lazy `content` option
    (a harness-only path; the page does not mount it yet). This experiment did not
    determine exactly which check keeps the engine silent, because working around
    an account requirement is out of scope. Offline, realtime performance remains
    far from achievable: blocks run at a small fraction of realtime.

The loaded Mach-O is mounted as a read-only snapshot at its virtual bundle
executable path, separate from the 64 MiB resource/write quota and bounded to
256 MiB. `statfs$INODE64`/`statfs64` and their descriptor variants describe this
in-memory filesystem using Darwin's 2168-byte layout; legacy `statfs` is not
silently aliased to a different ABI. They never query physical host storage.
Calendar conversion uses signed 64-bit seconds and Darwin's 56-byte `tm`, with
checked `tm_year` overflow and a guest-local UTC default (`gmtime_r` labels GMT).
Other time zones and timezone-changing APIs are not implemented.
`nanosleep` copies the Darwin64 timespec, validates signed seconds/nanoseconds,
and parks only its caller until a monotonic deadline expires. Other runnable
threads continue; all-blocked waits use the bounded scheduler idle path.
Intervals remain exact bigint nanoseconds, including enormous requests, and the
shared wall-clock watchdog still bounds execution. Successful sleeps leave the
remainder untouched; invalid requests return -1 with guest errno. Guest signal
delivery and interrupted sleeps are not implemented. The standalone
guest treats the loaded image as its executable: `_NSGetExecutablePath` returns
that UTF-8 virtual path, with exact uint32 capacity negotiation and no host path.
`NSRunningApplication` uses a permanent guest-local identity shared across
threads. Its PID agrees with `getpid`/`NSProcessInfo`; its name describes the
browser guest, not an installed host application. PID lookup and executable
architecture are supported; activation, termination and host application metadata
remain explicitly unsupported.
`NSURL` supports construction and inspection of absolute ASCII HTTP(S) URLs,
including percent-encoded UTF-8 paths and IPv6 hosts. Original spelling and
encoded query/fragment fields are preserved; path getters use Foundation's
decoded/trailing-slash semantics. Relative URLs, file URLs, credentials and
automatic escaping of illegal input are explicitly unsupported. Parsing has no
network side effects. A native Foundation fixture supplies independent component
goldens; generated x86 fixtures exercise ownership and browser-worker dispatch.
`NSURLRequest` and `NSMutableURLRequest` retain real guest URLs, preserve integer
cache policies and XMM0 timeout arguments/returns, and implement method/header
mutation, defaults and independent immutable/mutable copies. Headers are limited
to 256 entries/64 KiB; unsupported policies, streams and metadata remain explicit
errors. Body assignment snapshots actual bytes rather than fabricating a payload.
`NSData` and `NSMutableData` share their real buffers and reference counts with
CFData. Copying, ranges, zero-filled growth, append/replacement and mutable-byte
access are supported, with a 16 MiB per-buffer bound and correct provider/pool
lifetimes. No-copy Cocoa constructors, custom deallocators and direct disposal
of managed data/request objects remain unsupported. Named instance-variable
get/set resolves inherited pointer-sized ivars, preserves all 64 value bits and
matches native nil/missing-name behavior; narrow ivars and ARC ownership layouts
are not silently treated as pointers. Authored Objective-C code runs both
natively and in the x86 guest to verify request, data and ivar ABI behavior.
`NSURLSessionConfiguration defaultSessionConfiguration` creates independent
guest-owned configuration objects with native-verified scalar defaults, mutable
timeout/cache/network/cookie settings and independent retained copies. Double
properties use XMM0, integer properties preserve all 64 bits, and pool draining
releases owned configurations. Cache, credential/cookie storage objects, header
dictionaries, protocol classes and background sessions remain explicitly unsupported.
`NSOperationQueue currentQueue` returns nil on guest pthreads not executing an
operation, and the persistent guest main queue on the main thread; `mainQueue`
returns that same identity across threads. Operation submission/execution is not
implemented and is never reported as successfully completed. Authored native and
guest x86 pthread fixtures verify these queue queries.
No request/configuration operation initiates network I/O; transport is not implemented.
`NSURLSession` construction copies configuration and retains its real delegate
and queue; an omitted queue creates a serial queue metadata object, not an
operation executor. Configuration getters return independent copies.
`dataTaskWithRequest:` snapshots an immutable request and creates an identified,
suspended `NSURLSessionDataTask`. Task metadata, copied descriptions and float32
priority match authored native/compiler fixtures, including ignored out-of-range
priorities and zero initial progress counters. Active sessions and their task
registries retain these objects until the guest closes; limits are 32 sessions
and 256 tasks per session. Resume, suspend, cancel, session invalidation, network
transport and delegate callback execution remain explicitly unsupported. No
running/completed task, network response or successful invalidation is fabricated.
Authored C++ fixtures compare these layouts and calendar fields with native
macOS results; no proprietary plugin runs natively for these tests.

The old published engine faulted at last CPU entry `0x100412c3`. Source
profiling and ASAN isolated a TCI adapter temporary-lifetime leak: helper-call
argument extensions were allocated but never freed, corrupting long
instrumented translation blocks. The bundled source frees these temporaries
after emitting the helper call; the optimizer remains enabled. An independent
512-group load/store regression now completes. No plugin machine code was
changed to fix this host-engine defect. A second engine fix implements interpreter load
operations that were `TODO()` aborts, which SSE2 `pextrw` reaches; see `vendor/unicorn/README.md`.

Arcade also requires a signed-in Output account and its downloaded sound content.
The guest mounts no account or entitlement files, there is no sign-in UI
(the plugin's editor is not hosted), and no response, entitlement or hardware
identity is fabricated. Reaching Arcade's audio code therefore cannot by itself
produce licensed playback.

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
- 256 MiB image/binary limit, 16 MiB package TOC limit, 32 MiB factory/startup
  guest heap and 256 MiB processor/render guest heap, and
  bounded dyld fixup operations. Installer content is streamed, not installed.
- Segment permissions and zero-filled BSS are modeled. Imports have explicit
  implementations or fail; unknown framework functions are never replaced by
  silent successful no-ops. Imported data also traps when unsupported.
- A bounded libc/C++ and CoreFoundation subset
  is supplied. Allocation uses bounded, aligned, first-fit free blocks with
  coalescing and tail reclamation; reports distinguish requested/live capacity
  from historical high-water use. Darwin version-6 malloc-zone tables have real
  guest callbacks and allocation ownership, with zeroed calloc, aligned allocation,
  size lookup, naming, reallocation and zone destruction. `realloc` preserves contents when
  growing, tracks shrinking, and preserves the original on allocation failure.
  Destructors are registered but the
  diagnostic worker is discarded rather than implementing macOS unload.
- `sprintf`/`snprintf` support bounded integer, byte-string, character,
  pointer and fixed-point `%f`/`%F` conversions with GP/SSE register and stack
  arguments. Fixed-point precision is limited to 4,096 digits and uses exact
  ties-to-even rounding. Unsupported scientific/general/hex floating formats,
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
- Darwin FILE globals and bounded descriptor-backed stdio implement integer/string/
  fixed-point printf and va_list calls, transfers, status flags and callbacks.
  Calls accept at most 64 variadic arguments, with separate GP/SSE register
  cursors and a shared overflow stack. Other floating formats remain unsupported.
- `sscanf` supports bounded ASCII integer conversions, field widths, assignment
  suppression, length modifiers and literal/whitespace matching. It writes the
  declared integer size through register/stack pointer arguments and reports
  assignment counts or EOF. Unsupported conversions and out-of-range integers
  fail explicitly; this is not a complete locale-aware scanning library.
- Mutex attributes and normal/error-checking/recursive mutexes have guest-local
  state. Static Darwin signatures are recognized, recursive depth is checked,
  locked destruction/trylock return busy, and invalid objects return errors.
  Normal self-deadlock fails explicitly instead of claiming a lock was acquired.
  Contended locks park the guest thread and wake on unlock; ownership is tracked
  independently for each thread. libc++ `mutex` operations use the same locks.
  Priority-ceiling protocols remain unsupported.
- Bounded time-sliced pthreads execute actual x86 entry points with complete
  Unicorn CPU snapshots, independent guarded stacks, TLS values, errno and
  autorelease pools. At most 32 secondary threads, 8 MiB per stack and 32 MiB of
  combined stack/guard reservations are allowed. Threads advance only during
  bounded guest calls, sharing the caller's instruction/time budget; they are not
  host OS threads and do not execute between host calls. Join preserves all
  64 return bits; detach/exit reclaim stacks and CPU snapshots. Up to 512 keys
  have per-thread values, with up to four destructor passes on exit. Key deletion
  never calls the destructor. Static C++ initialization guards park contenders.
- `pthread_self` supplies a stable guest-local opaque identity per thread;
  `pthread_equal` validates registered identities. Scheduling queries expose the
  normal virtual policy. Realtime or non-default-priority changes return
  `ENOTSUP`, rather than granting unimplemented priority behavior. Main-thread
  exit, cancellation and blocking inside synchronous host-to-guest callbacks
  remain unsupported.
- Darwin condition variables and libc++ condition-variable wrappers implement
  atomic mutex release/parking, FIFO signal, broadcast and mutex reacquisition
  before returning. Busy destruction fails. Timed waits and custom condition
  attributes remain unsupported; recursive wait depth above one is rejected.
  No wait is replaced by a successful no-op.
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
  Secondary-thread `CFRunLoopGetCurrent` fails explicitly rather than incorrectly
  returning the main thread's run loop.
- `NSURLSessionDataTask` `resume`/`cancel` and `finishTasksAndInvalidate` run
  through one guest thread per guest, delivering `didSendBodyData`,
  `didReceiveResponse` (with a callable completion block), `didReceiveData`,
  `didCompleteWithError` and `didBecomeInvalidWithError` to the plugin's real
  x86 delegate methods with per-callback autorelease pools. Network access is
  opt-in: without the page's checkbox every request fails as offline and nothing
  leaves the guest. With it, a synchronous worker XMLHttpRequest performs the
  request, so browser CORS rules apply and a refusal reaches the plugin as
  `NSURLErrorCannotConnectToHost`. Reports list method and URL without the query.
  Redirect callbacks, `suspend`, `invalidateAndCancel`, main-queue delegates and
  completion handlers called after their callback returns are not implemented.
- The native audio bridge uses actual component/processor vtables and bounded
  IHostApplication/IEventList callbacks. It supports float32 buses, note on/off,
  at most 16 buses per direction and 128 audio channels per direction, and blocks
  of 1–4096 frames at 8–192 kHz. Offline renders contain at most 48,000 frames.
  Processing reuses guest allocations, rejects non-finite audio and control-voltage
  buses, and propagates signed 32-bit VST3 failures without losing precision in
  JavaScript. Host message creation, parameter changes, controllers/editors, timing
  context are not implemented. Probe reports keep `playable: false` even when an
  offline render succeeds; live playing is reported separately on the page.
- Scalar double and selected single-precision math imports use full 16-byte XMM register reads/writes, with
  arguments in XMM0/XMM1 and results in XMM0. They provide numerical values, not
  a complete macOS libm floating-exception/errno environment or last-bit libm
  equivalence guarantee. Single-precision results round to float32; vector math
  entrypoints remain unsupported.
- Single-threaded OSAtomic CAS/add/increment/decrement/bitwise operations preserve
  exact 32/64-bit values, including barrier variants. They do not implement real
  concurrent guest threads. RTTI casts traverse bounded Itanium single/multiple/
  virtual inheritance metadata, including public paths and ambiguous subobjects;
  unrecognized type-info layouts fail rather than returning a fabricated cast.
- C-locale handles model C/POSIX and the guest's C default environment, category
  masks, duplication and freeing. `strtod`/`strtod_l` preserve end pointers, signed
  zero, NaN payloads and Darwin range errors, including exact hexadecimal rounding
  and subnormals. Numeric tokens are bounded to 4,096 bytes; non-nearest rounding
  modes stop explicitly. No host locale or process environment is exposed.
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
  Mounted-file content starts empty. Guest-only home and temporary directories
  permit bounded in-memory file creation/removal and stat/access queries; plugin
  resources remain read-only. No path writes to the real host filesystem.
  Empty stdin and bounded 64 KiB stdout/stderr
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
  a small NSObject fallback and managed Foundation subset are supplied, with
  explicit retain/release and bounded nested autorelease pools. Missing-file
  NSDictionary lookup returns nil; parsing existing property lists fails explicitly.
  General Foundation and static class realization remain unsupported. Custom `+initialize`
  and C++ construction callbacks fail explicitly, as do unknown messages.
  Default notification-center, application, file-manager and process-info objects
  are guest-local. Process-info PID, CPU and memory queries reflect the virtual
  guest, not the host OS; unimplemented version queries fail explicitly.
- Component lifecycle calls share an allowance of 20 billion instructions/110 seconds;
  each audio block has 100 million instructions/30 seconds; other calls retain 2 million
  instructions/2 seconds. Lifecycle and audio calls run without per-instruction counting
  when only one guest thread is runnable, which is about four times faster; their instruction
  budget then applies between imports only, and the page-side watchdog stops a wedged worker.
  Both are backed by
  a separate page-side worker watchdog (30 seconds by default). The watchdog
  can terminate a wedged Wasm emulator; it does not rely on guest cooperation.
- This is not a security audit. Keep browser security features enabled and
  only load files you are authorized to analyze. Plugin machine code is never
  run directly by macOS.

## Verification

```sh
node tests/native-vst3.mjs
node tests/native-vst3-scanf.mjs
node tests/native-vst3-mutex.mjs
node tests/native-vst3-files.mjs
node tests/native-vst3-objc.mjs
node tests/native-vst3-libcpp.mjs
node tests/native-vst3-zones.mjs
node tests/native-vst3-atomic.mjs
node tests/native-vst3-rtti.mjs
node tests/native-vst3-clocale.mjs
node tests/native-vst3-float.mjs
node tests/native-vst3-session-transport.mjs
node tests/native-vst3-images.mjs
node tests/native-vst3-iostream.mjs
node tests/native-vst3-accelerate.mjs
node tests/native-vst3-libc.mjs
node tests/native-vst3-browser.mjs
ARCADE_PKG='/absolute/path/to/Arcade_OSX_Install_2.2.0.R18263.pkg' node tests/native-vst3-browser.mjs
DEXED_PKG='/absolute/path/to/dexed-macOS-0.9.8.pkg' node tests/native-vst3-browser.mjs
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
verify timebase fields, monotonic samples, negative wall timestamps and padding,
plus libc++ nanosecond steady-clock and microsecond system-clock return values.
Authored Clang C++ fixtures verify those units and the actual calling convention.
Timed libc++ condition waits release their mutex, wake on signal or real wall-clock
deadline, and reacquire the mutex before returning; timeout is not fabricated
success or a scheduler deadlock. When no thread is runnable, the synchronous
scheduler uses bounded one-millisecond atomic waits where available and deadline
polling otherwise, without charging idle time as guest instructions. The shared
wall-clock budget still stops frozen-clock waits. Direct pthread timed-wait imports
and condition attributes remain unsupported. Browser fixtures exercise expiration
and ownership restoration. Nothrow allocation tests verify real heap ownership,
null on exhaustion and propagation of unrelated faults. `dladdr` tests verify
mapped-image bounds, nearest defined symbols, header lookup, cached strings and
actual virtual executable names; unmapped addresses never identify host libraries.
`getcwd` returns the guest directory used by relative paths, supports caller-owned
and Darwin-allocated buffers, ignores size for a null buffer, and reports real
buffer/heap errors without exposing the host working directory.
Objective-C tests cover registration, inheritance, ivar tail padding, protocols,
method replacement and explicit lifecycle failures. The supported
`NSNotificationCenter defaultCenter` returns one persistent center per guest,
with real class/metaclass lookup, instance identity, bounded retain/release and
autorelease pool handling. Independently allocated centers have separate
lifetimes. Selector-based observer registration/removal and synchronous posting
execute actual x86 callbacks, preserving caller stack variables, GP registers
and all 16 XMM registers. Filters, weak observer cleanup, notification ownership,
nested delivery and shared execution budgets are tested. Block/queue-based
observers remain unsupported and throw explicitly. Unit and
x86 dispatch tests cover singleton reuse, ownership and guest isolation.
Generated native callbacks
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
deletion/reuse, invalid keys and 512-key exhaustion. Compiled C/C++ threading
fixtures compare results against native execution of those authored fixtures,
covering contended locks, condition handoffs, per-thread TLS/errno/pools, x87,
MXCSR and XMM context preservation, joins, exit and repeated destructor passes.
The browser fixture executes a real pthread entry and joins its 64-bit result.
Cocoa thread fixtures verify distinct main/worker objects, copied-name ownership,
retained objects after thread exit, lifecycle queries and cooperative cancellation
flags. Thread sleep and native Cocoa thread startup remain explicitly unsupported.
The URL session transport test compiles one authored Objective-C delegate twice:
natively against real Cocoa and a local HTTP server, and as x86 in the guest with an
injected transport. The delegate event logs must match exactly for response/data
delivery, a cancel disposition, POST progress and a refused connection. It also
checks the offline default, query-free request logs and object release.
Image, Accelerate, libc and iostream suites compile the same authored source natively
and as x86, then compare real macOS CoreGraphics, Accelerate, libc and libc++ results with
the guest's: pixels, FFT scaling, exact number formatting and `std::weak_ptr` behavior.
The optional Arcade test separately verifies factory-only
execution, **768/768 static initializers**, and the explicit CFBundle startup
success, Cocoa notification registration, zone/atomic operations, RTTI/numeric
parsing, process-info queries, pthread attribute setup, actual thread creation and
mutex/condition notifications, Cocoa thread identity/name assignment, chrono clocks,
timed waits, nothrow allocation, `dladdr`, `getcwd`, Darwin64 filesystem statistics,
the Disk Arbitration unavailable-service path, UTC `localtime_r` and executable
path lookup, guest application identity/name, URL/request construction, copied
data buffers and delegate ivar assignment, followed by a real `_nanosleep`,
default session configuration and current operation-queue lookup. Eight workers
start; session construction and suspended data-task creation succeed. It now
expects a complete lifecycle, 94 processed blocks and silence, with real delegate
delivery and no request sent.
These checks do not verify
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

RTTI compiler verification builds the repository's own small C++ fixture on
macOS and compares ten real-host cast results with execution of Clang-generated
x86 Mach-O in the guest. It does not execute the proprietary plugin natively;
its generated binaries are removed after each test. Pure generated fixtures also
verify malloc-zone vtables, atomic CAS and RTTI dispatch in Chrome workers.
