#!/bin/sh
# Builds VST3 plug-ins from source into WebAssembly bundles the site can load as plug-and-play VST3s.
#
#   native/build.sh                  build the Steinberg SDK examples listed below
#   native/build.sh NAME DIR ENTRY   build any other VST3 plug-in: bundle NAME from sources in DIR
#
# Needs Emscripten (emcc) and git. The VST3 SDK (MIT License) is fetched at a pinned commit into
# native/.sdk. Output: plugins/vst3/NAME.zip containing NAME.vst3/Contents/wasm32-web/NAME.wasm,
# the bundle layout VST3 uses for every platform, with wasm32-web as the architecture folder.
set -e
cd "$(dirname "$0")"
SDK_COMMIT=3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96
SDK=.sdk
OUT=../plugins/vst3

if [ ! -d "$SDK/.git" ]; then
  git clone --quiet https://github.com/steinbergmedia/vst3sdk.git "$SDK"
  git -C "$SDK" checkout --quiet "$SDK_COMMIT"
  git -C "$SDK" submodule update --init --depth 1 base pluginterfaces public.sdk cmake
fi

# The SDK's CMake normally generates projectversion.h; do the same from its template.
VERSION=$(sed -n '/^project(vstsdk/,/VERSION/s/^ *VERSION \([0-9.]*\).*/\1/p' "$SDK/CMakeLists.txt")
mkdir -p obj/include
sed -e "s/@PROJECT_VERSION_MAJOR@/$(echo "$VERSION" | cut -d. -f1)/" -e "s/@PROJECT_VERSION_MINOR@/$(echo "$VERSION" | cut -d. -f2)/" \
    -e "s/@PROJECT_VERSION_PATCH@/$(echo "$VERSION" | cut -d. -f3)/" -e "s/@PROJECT_VERSION_TWEAK@/0/" -e "s/@[A-Z_]*@//g" \
    "$SDK/cmake/templates/projectversion.h.in" > obj/include/projectversion.h

# SDK sources every plug-in needs, plus the vst3web host shim.
COMMON="
  $SDK/pluginterfaces/base/coreiids.cpp $SDK/pluginterfaces/base/funknown.cpp $SDK/pluginterfaces/base/ustring.cpp
  $SDK/pluginterfaces/base/conststringtable.cpp
  $SDK/base/source/baseiids.cpp $SDK/base/source/fobject.cpp $SDK/base/source/fstring.cpp $SDK/base/source/fdebug.cpp
  $SDK/base/source/updatehandler.cpp $SDK/base/source/fbuffer.cpp $SDK/base/source/fstreamer.cpp $SDK/base/thread/source/flock.cpp
  $SDK/public.sdk/source/common/commoniids.cpp $SDK/public.sdk/source/common/commonstringconvert.cpp $SDK/public.sdk/source/common/memorystream.cpp $SDK/public.sdk/source/common/pluginview.cpp
  $SDK/public.sdk/source/main/pluginfactory.cpp $SDK/public.sdk/source/main/moduleinit.cpp
  $SDK/public.sdk/source/vst/vstaudioeffect.cpp $SDK/public.sdk/source/vst/vstbus.cpp $SDK/public.sdk/source/vst/vstcomponent.cpp
  $SDK/public.sdk/source/vst/vstcomponentbase.cpp $SDK/public.sdk/source/vst/vsteditcontroller.cpp $SDK/public.sdk/source/vst/vstinitiids.cpp
  $SDK/public.sdk/source/vst/vstparameters.cpp $SDK/public.sdk/source/vst/vstnoteexpressiontypes.cpp
  $SDK/public.sdk/source/vst/vstpresetfile.cpp $SDK/public.sdk/source/vst/vstrepresentation.cpp
  $SDK/public.sdk/source/vst/hosting/hostclasses.cpp $SDK/public.sdk/source/vst/hosting/parameterchanges.cpp
  $SDK/public.sdk/source/vst/hosting/eventlist.cpp $SDK/public.sdk/source/vst/hosting/processdata.cpp
  $SDK/public.sdk/source/vst/hosting/pluginterfacesupport.cpp
  $SDK/public.sdk/source/vst/utility/stringconvert.cpp $SDK/public.sdk/source/vst/utility/vst2persistence.cpp
  vst3web/vst3web.cpp"

# Emscripten is not one of the SDK's platforms; its libc is close enough to Linux's for the SDK sources.
FLAGS="-O3 -std=c++17 -D__linux__=1 -DRELEASE=1 -I$SDK -Iobj/include -msimd128 -Wno-deprecated-declarations -Wno-unused-command-line-argument"
LINK="--no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=33554432 -sERROR_ON_UNDEFINED_SYMBOLS=1 -sEXPORTED_FUNCTIONS=_malloc,_free,_vst3web_init,_vst3web_class_count,_vst3web_class_info,_vst3web_open,_vst3web_close,_vst3web_channels,_vst3web_has_events,_vst3web_buffer,_vst3web_process,_vst3web_param_count,_vst3web_param_info,_vst3web_param_text,_vst3web_param_set,_vst3web_note,_vst3web_tempo,_GetPluginFactory"

build() {
  name=$1; shift
  bundle="$OUT/$name.vst3"
  rm -rf "$bundle" "$OUT/$name.zip"
  mkdir -p "$bundle/Contents/wasm32-web" "$bundle/Contents/Resources" obj
  echo "Building $name"
  # shellcheck disable=SC2086
  em++ $FLAGS $LINK $COMMON "$@" -o "$bundle/Contents/wasm32-web/$name.wasm"
  cp "$SDK/LICENSE.txt" "$bundle/Contents/Resources/VST3-SDK-LICENSE.txt"
  (cd "$OUT" && zip -X -q -r "$name.zip" "$name.vst3" && rm -rf "$name.vst3")
  echo "  $OUT/$name.zip ($(du -k "$OUT/$name.zip" | cut -f1) KB)"
}

if [ $# -ge 2 ]; then
  name=$1; dir=$2; shift 2
  build "$name" "$dir"/*.cpp "$@"
  exit
fi

S=$SDK/public.sdk/samples/vst
build ADelay $S/adelay/source/adelaycontroller.cpp $S/adelay/source/adelayprocessor.cpp $S/adelay/source/factory.cpp \
  $S/adelay/source/exampletest.cpp $SDK/public.sdk/source/vst/utility/testing.cpp
build mda-vst3 $S/mda-vst3/source/*.cpp
