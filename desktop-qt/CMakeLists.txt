# Microtone desktop, Qt build (item 336): the web app in ../microtone-worker
# inside a QtWebEngine (Chromium) window, served by the shell itself from a
# loopback HTTP server. See README.md.
cmake_minimum_required(VERSION 3.21)

# The app's version is the web app's: microtone-worker/package.json.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../microtone-worker/package.json" MICROTONE_PACKAGE_JSON)
string(JSON MICROTONE_VERSION GET "${MICROTONE_PACKAGE_JSON}" version)

project(microtone-desktop VERSION ${MICROTONE_VERSION} LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Widgets Network HttpServer WebSockets WebEngineCore WebEngineWidgets)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  find_package(Qt6 REQUIRED COMPONENTS DBus)  # RealtimeKit (nativeaudio.cpp)
endif()
find_package(Threads REQUIRED)
qt_standard_project_setup()

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
  # RtAudio stays for ASIO, which comes with Steinberg's SDK files. With no
  # API of its own compiled it falls back to its dummy, which the host skips.
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
)

target_link_libraries(microtone PRIVATE
  Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Network Qt6::HttpServer Qt6::WebSockets
  Qt6::WebEngineCore Qt6::WebEngineWidgets
  taudengine rtaudio)

# WASAPI: the real backend on Windows; elsewhere, only for trying the host's
# WASAPI glue and the Settings tab's modes, a stand-in (never shipped).
option(MICROTONE_FAKE_WASAPI "Build a stand-in WASAPI backend (testing only)" OFF)
if(WIN32)
  target_sources(microtone PRIVATE src/wasapi.c src/wasapi.h)
  target_compile_definitions(microtone PRIVATE MICROTONE_WASAPI=1)
  target_link_libraries(microtone PRIVATE ole32)
  # What WASAPI offers on a machine, and a test tone through each mode: ships
  # beside the app, for when a device will not play (tools/wasapi-probe.c).
  add_executable(wasapi-probe tools/wasapi-probe.c src/wasapi.c)
  target_link_libraries(wasapi-probe PRIVATE ole32)
  set_target_properties(wasapi-probe PROPERTIES AUTOMOC OFF)  # plain C: no Qt
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
