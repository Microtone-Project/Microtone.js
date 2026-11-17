# Microtone desktop, Qt build (item 336): the web app in ../microtone-worker
# inside a QtWebEngine (Chromium) window, served by the shell itself from a
# loopback HTTP server. See README.md.
cmake_minimum_required(VERSION 3.21)

# The app's version is the web app's: microtone-worker/package.json.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../microtone-worker/package.json" MICROTONE_PACKAGE_JSON)
string(JSON MICROTONE_VERSION GET "${MICROTONE_PACKAGE_JSON}" version)

project(microtone-desktop VERSION ${MICROTONE_VERSION} LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Widgets Network HttpServer WebEngineCore WebEngineWidgets)
qt_standard_project_setup()

qt_add_executable(microtone
  src/main.cpp
  src/appserver.cpp src/appserver.h
  src/shell.cpp src/shell.h
  src/links.cpp src/links.h
)

target_link_libraries(microtone PRIVATE
  Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Network Qt6::HttpServer
  Qt6::WebEngineCore Qt6::WebEngineWidgets)

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
