# Patched browser CPU engine

`unicorn.cjs` is the x86-only Emscripten build of Unicorn.js. The browser
loads these local bytes after checking their SHA-256; there is no CDN fallback.
No commercial plugin code is included.

- Unicorn.js source: https://github.com/AlexAltea/unicorn.js
- Unicorn.js commit: `1220477c7fb0f8fe4b500f4bd211de52f6dfe638`
- Unicorn submodule: `8028ec436f2d9376525352dd38ed9ed6b9f6be10`
- Engine SHA-256: `75c6b66b745079190372efc245e462374a5db8cc45f9e4edccd242122fc6a632`
- Corresponding source archive SHA-256: `ff976b48a43115f20e440fe75402fb3049043f93044428d05e9432652de94505`
- Build toolchain used: Emscripten `6.0.13-git`, Python `3.14.10`, CMake.

`source.tar.gz` contains the complete corresponding source snapshot, including
Unicorn, the TCI adapter, upstream compatibility patches, build scripts, and
licenses. It already has those patches applied. Do not run `patchUnicorn()`
again: the additional lifetime fix changes the upstream patch context.
The top-level `LICENSE` is the upstream GPL-2.0 license; additional component
notices and licenses remain in the source archive.

## Local change

In `unicorn/qemu/tcg/tcg.c`, `tcg_gen_callN` now records every temporary created
by the narrow-argument-to-64-bit TCI adapter and frees it after emitting the
call. Previously these temporaries accumulated across a translation block,
corrupting the compiler context during long memory-instrumented blocks. The
optimizer is still enabled. The build uses Release optimization, a 4 MiB
Emscripten stack, and no ASAN/profiling instrumentation.

The independent regression in `tests/native-vst3-engine.mjs` executes a long
sequence of memory loads/stores with import-range instrumentation. It contains
no target plugin bytes. The published npm 2.1.4 engine faults on this sequence;
the bundled build completes it.

## Rebuild

Activate Emscripten and install CMake and Python 3.12 or later supported by your
Emscripten installation. From the repository root:

```sh
python3 native/build-unicorn.py /absolute/path/to/new-build-directory
```

The directory must not exist. The script checks the source archive hash,
extracts it, generates constants, and builds the x86 engine. It does not change
the checked-in engine. The resulting file is `dist/unicorn_x86.js` inside that
directory. Compiler/toolchain or absolute build-path changes may change its hash. To intentionally
update the bundled engine, copy it to `unicorn.cjs`, update the pinned hash in
`js/native-vst3-engine.js` and this document, then run the full test suite.

`native/unicorn-temp-lifetime.patch` is the reviewable delta against the
upstream source after its own TCI compatibility patches. It is already applied
in the source archive; it must not be applied again during rebuilds.
