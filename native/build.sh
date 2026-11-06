#!/bin/sh
# Builds VST3 plug-ins from source into WebAssembly bundles the site can load as plug-and-play VST3s.
#
#   native/build.sh                    build the Steinberg SDK examples listed in native/CMakeLists.txt
#   native/build.sh -DVST3WEB_EXTRA=f  also build the plug-ins added by vst3web_add_plugin() calls in f
#
# Needs Emscripten (emcmake), CMake 3.25+ and git. The VST3 SDK (MIT License) and its VSTGUI (BSD 3-Clause) are
# fetched at a pinned commit into native/.sdk, then emcmake configures native/CMakeLists.txt, which builds the
# SDK's own libraries with its CMake modules. Output: plugins/vst3/NAME.zip containing
# NAME.vst3/Contents/wasm32-web/NAME.wasm and its Contents/Resources (licenses, editor.json, an editor's files).
set -e
cd "$(dirname "$0")"
SDK_COMMIT=3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96
SDK=.sdk

if [ ! -d "$SDK/.git" ]; then
  git clone --quiet https://github.com/steinbergmedia/vst3sdk.git "$SDK"
  git -C "$SDK" checkout --quiet "$SDK_COMMIT"
  git -C "$SDK" submodule update --init --depth 1 base pluginterfaces public.sdk cmake vstgui4
fi
# VSTGUI (BSD 3-Clause) builds the editors of plug-ins that have one; a checkout made before it was needed gets it.
[ -f "$SDK/vstgui4/vstgui/lib/cframe.cpp" ] || git -C "$SDK" submodule update --init --depth 1 vstgui4

# Emscripten needs Python 3.10+; make sure the compiler wrappers CMake calls don't fall back to an older python3.
if [ -z "$EMSDK_PYTHON" ]; then
  for py in python3.15 python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$py" >/dev/null && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
      EMSDK_PYTHON=$(command -v "$py"); export EMSDK_PYTHON; break
    fi
  done
fi

emcmake cmake -S . -B build -DCMAKE_BUILD_TYPE=Release "$@"
cmake --build build --parallel
