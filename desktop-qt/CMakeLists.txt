# Microtone desktop, Qt build (item 336): the web app in ../microtone-worker
# inside a QtWebEngine (Chromium) window, served by the shell itself from a
# loopback HTTP server. See README.md.
cmake_minimum_required(VERSION 3.21)

# The app's version is the web app's: microtone-worker/package.json.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../microtone-worker/package.json" MICROTONE_PACKAGE_JSON)
string(JSON MICROTONE_VERSION GET "${MICROTONE_PACKAGE_JSON}" version)

# macOS: Qt 6.8's own floor. Before project(), or it does not take.
set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0" CACHE STRING "The oldest macOS the build runs on")

project(microtone-desktop VERSION ${MICROTONE_VERSION} LANGUAGES C CXX)
if(WIN32)
  enable_language(RC)  # src/microtone.rc.in
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Widgets Network HttpServer WebSockets WebEngineCore WebEngineWidgets)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  find_package(Qt6 REQUIRED COMPONENTS DBus)  # RealtimeKit (nativeaudio.cpp)
endif()
find_package(Threads REQUIRED)
qt_standard_project_setup()

# Qt 6.8.3's FindWrapOpenGL links Apple's AGL framework, which the macOS 26 SDK
# (Xcode 26) no longer has: "ld: framework 'AGL' not found". Nothing here uses
# AGL, so it comes off the link (later Qt releases dropped it themselves).
if(APPLE AND TARGET WrapOpenGL::WrapOpenGL)
  get_target_property(_mt_gl WrapOpenGL::WrapOpenGL INTERFACE_LINK_LIBRARIES)
  if(_mt_gl)
    list(FILTER _mt_gl EXCLUDE REGEX "AGL")
    set_target_properties(WrapOpenGL::WrapOpenGL PROPERTIES INTERFACE_LINK_LIBRARIES "${_mt_gl}")
  endif()
endif()

# Windows: debug information in the release build too. microtone.pdb ships
# beside the exe, so a crash report (src/crashlog.c) names its frames; /FS
# because Ninja's parallel compiles share a target's .pdb.
if(MSVC)
  add_compile_options($<$<CONFIG:Release>:/Zi> $<$<CONFIG:Release>:/FS>)
  add_link_options($<$<CONFIG:Release>:/DEBUG> $<$<CONFIG:Release>:/OPT:REF> $<$<CONFIG:Release>:/OPT:ICF>)
endif()

# ── the engine, native: the same C the web build compiles to WebAssembly
# (core/engine/c), with the same flags that make it the same bits — no
# contracted multiply-adds, never -ffast-math (CLAUDE.md, "The C engine") —
# plus the host's engine side (src/enginehost.c). wasm_parts.c is the tests'.
set(ENGINE_C ${CMAKE_CURRENT_SOURCE_DIR}/../core/engine/c)
file(GLOB ENGINE_SOURCES CONFIGURE_DEPENDS ${ENGINE_C}/src/*.c)
list(FILTER ENGINE_SOURCES EXCLUDE REGEX "wasm_parts\\.c$")
add_library(taudengine STATIC ${ENGINE_SOURCES} src/enginehost.c)
# Not Qt (qt_standard_project_setup turns moc on for every target).
set_target_properties(taudengine PROPERTIES AUTOMOC OFF)
target_include_directories(taudengine PUBLIC ${ENGINE_C}/include PRIVATE ${ENGINE_C}/src)
set_target_properties(taudengine PROPERTIES C_STANDARD 99 C_STANDARD_REQUIRED ON C_EXTENSIONS OFF)
if(MSVC)
  # MSVC has no C99 switch: its C11 mode is the conformant one.
  set_target_properties(taudengine PROPERTIES C_STANDARD 11)
endif()
target_compile_definitions(taudengine PRIVATE NDEBUG)
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(taudengine PRIVATE -O2 -ffp-contract=off -fno-fast-math)
elseif(MSVC)
  target_compile_options(taudengine PRIVATE /O2 /fp:precise)
endif()
include(CheckIPOSupported)
check_ipo_supported(RESULT MICROTONE_IPO OUTPUT MICROTONE_IPO_WHY LANGUAGES C)
if(MICROTONE_IPO)
  set_property(TARGET taudengine PROPERTY INTERPROCEDURAL_OPTIMIZATION TRUE)
endif()
if(NOT WIN32)
  target_link_libraries(taudengine PRIVATE m)
endif()

# ── RtAudio (vendor/rtaudio, see vendor/VENDOR-VERSIONS.md) and its backends
add_library(rtaudio STATIC vendor/rtaudio/RtAudio.cpp)
set_target_properties(rtaudio PROPERTIES AUTOMOC OFF)
target_include_directories(rtaudio PUBLIC vendor/rtaudio)
target_link_libraries(rtaudio PUBLIC Threads::Threads)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  find_package(ALSA REQUIRED)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(PULSE IMPORTED_TARGET libpulse-simple libpulse)
  pkg_check_modules(JACK IMPORTED_TARGET jack)
  target_compile_definitions(rtaudio PUBLIC __LINUX_ALSA__)
  target_link_libraries(rtaudio PUBLIC ALSA::ALSA)
  if(PULSE_FOUND)
    target_compile_definitions(rtaudio PUBLIC __LINUX_PULSE__)
    target_link_libraries(rtaudio PUBLIC PkgConfig::PULSE)
  endif()
  if(JACK_FOUND)
    target_compile_definitions(rtaudio PUBLIC __UNIX_JACK__)
    target_link_libraries(rtaudio PUBLIC PkgConfig::JACK)
  endif()
elseif(WIN32)
  # WASAPI is ours (src/wasapi.c: shared, low-latency shared, exclusive);
  # RtAudio is here for ASIO, with Steinberg's SDK files as its release ships
  # them (vendor/rtaudio/include; GPLv3 — see vendor/VENDOR-VERSIONS.md).
  target_sources(rtaudio PRIVATE
    vendor/rtaudio/include/asio.cpp
    vendor/rtaudio/include/asiodrivers.cpp
    vendor/rtaudio/include/asiolist.cpp
    vendor/rtaudio/include/iasiothiscallresolver.cpp)
  target_include_directories(rtaudio PUBLIC vendor/rtaudio/include)
  target_compile_definitions(rtaudio PUBLIC __WINDOWS_ASIO__)
  # COM (the drivers are COM objects), the registry (where they are listed),
  # the foreground window (the parent of a driver's panel).
  target_link_libraries(rtaudio PUBLIC ole32 advapi32 user32)
elseif(APPLE)
  target_compile_definitions(rtaudio PUBLIC __MACOSX_CORE__)
  target_link_libraries(rtaudio PUBLIC "-framework CoreAudio" "-framework CoreFoundation")
endif()

qt_add_executable(microtone
  src/main.cpp
  src/appserver.cpp src/appserver.h
  src/shell.cpp src/shell.h
  src/links.cpp src/links.h
  src/nativeaudio.cpp src/nativeaudio.h src/enginehost.h
  src/resampler.cpp src/resampler.h
  src/diagnostics.cpp src/diagnostics.h src/crashlog.c src/crashlog.h
  src/filestore.cpp src/filestore.h
  src/oldapp.cpp src/oldapp.h
)

target_link_libraries(microtone PRIVATE
  Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Network Qt6::HttpServer Qt6::WebSockets
  Qt6::WebEngineCore Qt6::WebEngineWidgets
  taudengine rtaudio)

# What the earlier desktop app kept, as the app reads it (src/oldapp.cpp):
# for trying the reader on a real profile, and for diagnostics. Qt Core only.
add_executable(oldapp-dump tools/oldapp-dump.cpp src/oldapp.cpp src/oldapp.h)
target_link_libraries(oldapp-dump PRIVATE Qt6::Core)
set_target_properties(oldapp-dump PROPERTIES AUTOMOC OFF)

# WASAPI: the real backend on Windows; elsewhere, only for trying the host's
# WASAPI glue and the Settings tab's modes, a stand-in (never shipped).
option(MICROTONE_FAKE_WASAPI "Build a stand-in WASAPI backend (testing only)" OFF)
if(WIN32)
  target_sources(microtone PRIVATE src/wasapi.c src/wasapi.h src/asiodriver.cpp src/asiodriver.h)
  target_compile_definitions(microtone PRIVATE MICROTONE_WASAPI=1 MICROTONE_ASIO=1)
  target_link_libraries(microtone PRIVATE ole32)
  # The probes ship beside the app, for when a device will not play: what
  # WASAPI offers on a machine and a test tone through each mode
  # (tools/wasapi-probe.c); the ASIO drivers, their sizes and a tone through
  # one (tools/asio-probe.cpp). Neither is Qt.
  add_executable(wasapi-probe tools/wasapi-probe.c src/wasapi.c)
  target_link_libraries(wasapi-probe PRIVATE ole32)
  set_target_properties(wasapi-probe PROPERTIES AUTOMOC OFF)
  add_executable(asio-probe tools/asio-probe.cpp src/asiodriver.cpp)
  target_link_libraries(asio-probe PRIVATE rtaudio)
  set_target_properties(asio-probe PROPERTIES AUTOMOC OFF)
  # The icon (Explorer, the taskbar, every window: Qt takes IDI_ICON1) and
  # the version Windows shows in the file's properties.
  set(MICROTONE_ICON "${CMAKE_CURRENT_SOURCE_DIR}/icons/microtone.ico")
  configure_file(src/microtone.rc.in ${CMAKE_CURRENT_BINARY_DIR}/microtone.rc @ONLY)
  target_sources(microtone PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/microtone.rc)
elseif(MICROTONE_FAKE_WASAPI)
  target_sources(microtone PRIVATE src/wasapi_fake.c src/wasapi.h)
  target_compile_definitions(microtone PRIVATE MICROTONE_WASAPI=1)
endif()
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_libraries(microtone PRIVATE Qt6::DBus)
endif()

target_compile_definitions(microtone PRIVATE
  MICROTONE_VERSION="${MICROTONE_VERSION}"
  # Where a build run from its build tree finds the web app when no staged
  # copy sits beside the binary: the working tree itself.
  MICROTONE_DEV_ROOT="${CMAKE_CURRENT_SOURCE_DIR}/../microtone-worker")

if(MSVC)
  target_compile_options(microtone PRIVATE /W4)
else()
  target_compile_options(microtone PRIVATE -Wall -Wextra)
endif()

set_target_properties(microtone PROPERTIES WIN32_EXECUTABLE ON MACOSX_BUNDLE ON)

if(APPLE)
  # Microtone.app: its Info.plist (the bundle id, the version, the microphone
  # text the system asks with), the icon, and that text per language. The web
  # app goes into Contents/Resources/www when it is packaged.
  set_target_properties(microtone PROPERTIES OUTPUT_NAME Microtone)
  configure_file(macos/Info.plist.in ${CMAKE_CURRENT_BINARY_DIR}/Info.plist @ONLY)
  set_target_properties(microtone PROPERTIES MACOSX_BUNDLE_INFO_PLIST ${CMAKE_CURRENT_BINARY_DIR}/Info.plist)
  target_sources(microtone PRIVATE icons/microtone.icns macos/en.lproj/InfoPlist.strings
                                   macos/ko.lproj/InfoPlist.strings)
  set_source_files_properties(icons/microtone.icns PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  set_source_files_properties(macos/en.lproj/InfoPlist.strings PROPERTIES MACOSX_PACKAGE_LOCATION Resources/en.lproj)
  set_source_files_properties(macos/ko.lproj/InfoPlist.strings PROPERTIES MACOSX_PACKAGE_LOCATION Resources/ko.lproj)
endif()
