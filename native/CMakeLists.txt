# Builds VST3 plug-ins from source into WebAssembly bundles the site loads as plug-and-play VST3s.
#
#   emcmake cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release
#   cmake --build native/build
#
# native/build.sh does both and fetches the VST3 SDK (MIT License) first. The SDK's own CMake modules
# create its base, pluginterfaces, sdk and sdk_hosting libraries; each plug-in is linked with them and
# with vst3web (the host shim) into one .wasm, packaged as plugins/vst3/NAME.zip containing
# NAME.vst3/Contents/wasm32-web/NAME.wasm: the bundle layout VST3 uses for every platform, with
# wasm32-web as the architecture folder.
#
# To build another plug-in, add a vst3web_add_plugin() call below (or pass -DVST3WEB_EXTRA=path/to/file.cmake
# containing them) listing its sources, as its own CMakeLists.txt would for smtg_add_vst3plugin().
cmake_minimum_required(VERSION 3.25.0)

set(SDK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.sdk" CACHE PATH "VST3 SDK checkout")
if(NOT EXISTS "${SDK_ROOT}/pluginterfaces")
    message(FATAL_ERROR "VST3 SDK not found at ${SDK_ROOT}; run native/build.sh to fetch it")
endif()
set(VST3WEB_OUTPUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../plugins/vst3" CACHE PATH "Where plug-in zips are written")

# Same version as the SDK, so the examples' projectversion.h matches a desktop build.
file(STRINGS "${SDK_ROOT}/CMakeLists.txt" _sdk_version REGEX "^ +VERSION [0-9.]+")
string(REGEX MATCH "[0-9.]+" vstsdk_VERSION "${_sdk_version}")
project(vst3web VERSION ${vstsdk_VERSION} LANGUAGES C CXX)
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Configure with emcmake: emcmake cmake -S native -B native/build")
endif()

# After project(), so the SDK detects the Emscripten target rather than the build machine.
list(APPEND CMAKE_MODULE_PATH "${SDK_ROOT}/cmake/modules")
include(SMTG_VST3_SDK)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Emscripten's toolchain sets UNIX, so the SDK configures itself for Linux. Its sources pick platform
# code with __linux__, and Emscripten's libc is close enough to Linux's for them.
add_compile_definitions(__linux__=1)
add_compile_options(-msimd128 -Wno-deprecated-declarations -Wno-unused-command-line-argument -Wno-pragma-pack)
# The SDK's Linux toolset links stdc++fs, which Emscripten's libc++ already contains.
add_library(stdc++fs INTERFACE)
smtg_setup_platform_toolset()

set(public_sdk_SOURCE_DIR ${SDK_ROOT}/public.sdk)
set(pluginterfaces_SOURCE_DIR ${SDK_ROOT}/pluginterfaces)
smtg_create_lib_base_target()
smtg_create_pluginterfaces_target()
smtg_create_public_sdk_common_target()
smtg_create_public_sdk_target()
smtg_create_public_sdk_hosting_target()

set(VST3WEB_EXPORTS
    _malloc _free _GetPluginFactory
    _vst3web_init _vst3web_class_count _vst3web_class_info _vst3web_open _vst3web_close
    _vst3web_channels _vst3web_has_events _vst3web_buffer _vst3web_process
    _vst3web_param_count _vst3web_param_info _vst3web_param_text _vst3web_param_set
    _vst3web_note _vst3web_tempo
)
list(JOIN VST3WEB_EXPORTS "," _exports)

# vst3web_add_plugin(NAME source...) builds plugins/vst3/NAME.zip from a VST3 plug-in's sources.
function(vst3web_add_plugin name)
    add_executable(${name} ${ARGN} "${CMAKE_CURRENT_SOURCE_DIR}/vst3web/vst3web.cpp"
        "${SDK_ROOT}/public.sdk/source/common/memorystream.cpp")
    target_link_libraries(${name} PRIVATE sdk sdk_hosting)
    smtg_target_configure_version_file(${name})
    set_target_properties(${name} PROPERTIES SUFFIX ".wasm")
    target_link_options(${name} PRIVATE
        --no-entry -sSTANDALONE_WASM -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=33554432
        -sERROR_ON_UNDEFINED_SYMBOLS=1 "-sEXPORTED_FUNCTIONS=${_exports}"
    )
    set(stage "${CMAKE_BINARY_DIR}/bundles/${name}")
    set(contents "${stage}/${name}.vst3/Contents")
    add_custom_command(TARGET ${name} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E rm -rf "${stage}"
        COMMAND ${CMAKE_COMMAND} -E make_directory "${contents}/wasm32-web" "${contents}/Resources" "${VST3WEB_OUTPUT_DIR}"
        COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:${name}>" "${contents}/wasm32-web/${name}.wasm"
        COMMAND ${CMAKE_COMMAND} -E copy "${SDK_ROOT}/LICENSE.txt" "${contents}/Resources/VST3-SDK-LICENSE.txt"
        COMMAND ${CMAKE_COMMAND} -E chdir "${stage}"
            ${CMAKE_COMMAND} -E tar cf "${VST3WEB_OUTPUT_DIR}/${name}.zip" --format=zip "${name}.vst3"
        COMMENT "Packaging ${VST3WEB_OUTPUT_DIR}/${name}.zip"
        VERBATIM
    )
endfunction()

# Steinberg's SDK examples that need no VSTGUI editor (the browser draws its own controls).
set(S ${SDK_ROOT}/public.sdk/samples/vst)
vst3web_add_plugin(ADelay
    ${S}/adelay/source/adelaycontroller.cpp ${S}/adelay/source/adelayprocessor.cpp
    ${S}/adelay/source/factory.cpp ${S}/adelay/source/exampletest.cpp
)
vst3web_add_plugin(AGainSampleAccurate
    ${S}/again_sampleaccurate/source/agsa_controller.cpp ${S}/again_sampleaccurate/source/agsa_factory.cpp
    ${S}/again_sampleaccurate/source/agsa_processor.cpp ${S}/again_sampleaccurate/source/tutorial.cpp
)
vst3web_add_plugin(SyncDelay
    ${S}/syncdelay/source/syncdelaycontroller.cpp ${S}/syncdelay/source/syncdelayprocessor.cpp ${S}/syncdelay/source/syncdelayfactory.cpp
)
file(GLOB mda_sources ${S}/mda-vst3/source/*.cpp)
vst3web_add_plugin(mda-vst3 ${mda_sources})

if(VST3WEB_EXTRA)
    include(${VST3WEB_EXTRA})
endif()
