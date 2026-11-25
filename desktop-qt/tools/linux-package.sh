#!/usr/bin/env bash
# The Linux packages of the Qt build (desktop-qt/README.md, "Linux"): an
# AppImage, a .deb and an .rpm of one self-contained tree — the app with Qt,
# QtWebEngine and every library it needs that a desktop may lack beside it
# (linuxdeploy and its Qt plugin) — so each runs on any distribution as new as
# the one that built it (CI: Ubuntu 22.04, glibc 2.35).
#
#   QMAKE=<Qt>/bin/qmake desktop-qt/tools/linux-package.sh <build dir> <out dir>
#
# <out dir> must not hold an earlier run's tree. Writes there:
#   Microtone-<version>-linux-x86_64.AppImage   updates itself (src/updater.h)
#   Microtone-<version>-linux-amd64.deb         /opt/microtone, package "microtone"
#   Microtone-<version>-linux-x86_64.rpm        the same tree
#   AppDir/                                     the tree itself
# The .deb and .rpm are named "microtone", as the Tauri build's are, so that
# installing one over the Tauri build's is an upgrade. Each marks its kind in
# share/microtone/package, which is how the app knows which update to fetch.
#
# Needs node, curl, dpkg-deb and rpmbuild; dpkg-shlibdeps (Debian, Ubuntu) to
# work out the .deb's dependencies. Runs on a Debian-based system: the third-
# party notices (tools/collect-notices.js) credit each carried library from the
# package that owns it there, and stop the build for one that none does. The AppImage tools are fetched into
# <out dir>/tools (MICROTONE_LINUX_TOOLS=<dir> to keep them elsewhere), each
# pinned to a release and its checksum.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: QMAKE=<qmake> $0 <build dir> <out dir>" >&2
  exit 2
fi
: "${QMAKE:?QMAKE must name Qt's qmake (linuxdeploy's Qt plugin reads the Qt it deploys from it)}"
build=$(realpath "$1")
out=$(realpath -m "$2")
here=$(cd "$(dirname "$0")/.." && pwd)  # desktop-qt
repo=$(cd "$here/.." && pwd)
version=$(node -p "require('$repo/microtone-worker/package.json').version")
tools=${MICROTONE_LINUX_TOOLS:-$out/tools}
appdir=$out/AppDir
if [ -e "$appdir" ]; then
  echo "$appdir is an earlier run's: give an empty <out dir>" >&2
  exit 1
fi
mkdir -p "$out" "$tools"
# The tools are AppImages themselves: unpacked and run, so no FUSE is needed.
export APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 PATH="$tools:$PATH"

fetch() {
  local name=$1 url=$2 sum=$3
  [ -f "$tools/$name" ] || curl -fsSL -o "$tools/$name" "$url"
  echo "$sum  $tools/$name" | sha256sum -c --quiet -
  chmod +x "$tools/$name"
}
fetch linuxdeploy-x86_64.AppImage \
  https://github.com/linuxdeploy/linuxdeploy/releases/download/1-alpha-20251107-1/linuxdeploy-x86_64.AppImage \
  c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d
fetch linuxdeploy-plugin-qt-x86_64.AppImage \
  https://github.com/linuxdeploy/linuxdeploy-plugin-qt/releases/download/1-alpha-20250213-1/linuxdeploy-plugin-qt-x86_64.AppImage \
  15106be885c1c48a021198e7e1e9a48ce9d02a86dd0a1848f00bdbf3c1c92724
fetch appimagetool-x86_64.AppImage \
  https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage \
  ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
# The AppImage's own runtime (static: needs no libfuse2 on the machine).
fetch runtime-x86_64 \
  https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64 \
  2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d

# ── the tree: the app, the web app, its entry and icons ──
install -Dm644 "$here/linux/cc.microtone.qt.desktop" "$appdir/usr/share/applications/cc.microtone.qt.desktop"
for size in 32 128 256 512; do
  install -Dm644 "$here/icons/microtone-$size.png" "$appdir/usr/share/icons/hicolor/${size}x${size}/apps/cc.microtone.qt.png"
done
install -Dm644 "$repo/COPYING" "$appdir/usr/share/doc/microtone/LICENSE.txt"
# Where the binary looks for it (src/main.cpp findRoot): ../share/microtone/www.
node "$here/tools/stage-frontend.js" "$appdir/usr/share/microtone/www"

# ── Qt and the libraries beside it ──
# The Qt plugin brings QtWebEngine's process, resources and locales, the
# platform plugin, TLS and image formats, and a qt.conf that finds them.
# Everything they need comes along (PulseAudio's client library, ICU,
# CUPS's for the print plugin …) except libjack (src/weakjack.c: the
# system's, when it has one), what linuxdeploy's exclude list keeps the
# system's (glibc, libstdc++, X11's core, OpenGL, fontconfig, ALSA),
# OpenSSL, which Qt loads by name, and NSS and Wayland's (below).
# The platforms: Wayland's (native on a Wayland desktop: sharp at
# fractional scales, which XWayland blurs — one libqwayland.so from Qt 6.11,
# libqwayland-egl.so and -generic.so before; with the decoration and shell
# plugins they load, below), X11's (xcb:
# X11 desktops, and Wayland ones without the plugin), and offscreen (no
# display at all: `QT_QPA_PLATFORM=offscreen microtone --version`, CI's
# package checks). Qt takes Wayland where XDG_SESSION_TYPE says so.
qtplugins=$("$QMAKE" -query QT_INSTALL_PLUGINS)
wayland=$(cd "$qtplugins/platforms" && ls libqwayland*.so 2> /dev/null | paste -sd ';')
EXTRA_PLATFORM_PLUGINS="libqoffscreen.so${wayland:+;$wayland}" \
linuxdeploy-x86_64.AppImage --appdir "$appdir" --plugin qt \
  --executable "$build/microtone" \
  --desktop-file "$appdir/usr/share/applications/cc.microtone.qt.desktop" \
  --icon-file "$appdir/usr/share/icons/hicolor/512x512/apps/cc.microtone.qt.png"
# Wayland's platform loads helpers by protocol, which the Qt plugin does not
# bring: the shell (xdg-shell, every desktop's), the EGL client integration
# (without it no GPU drawing, QtWebEngine's included) and the decorations
# (Adwaita's on GNOME, which draws none of its own; bradient elsewhere).
# Qt's own RUNPATH ($ORIGIN/../../lib) finds the tree's Qt from there.
for plugin in wayland-shell-integration/libxdg-shell.so \
              wayland-graphics-integration-client/libqt-plugin-wayland-egl.so \
              wayland-decoration-client/libadwaita.so wayland-decoration-client/libbradient.so; do
  install -Dm755 "$qtplugins/$plugin" "$appdir/usr/plugins/$plugin"
done
# …but NSS is the system's, all of it: it loads its own modules (softokn,
# freebl) from the system's folders, and they must match its libraries — 22.04's
# libnssutil3 beside a newer system's libsoftokn3 stops QtWebEngine at start
# ("version NSSUTIL_3.108 not found"). Every desktop has NSS.
for lib in libnss3.so libnssutil3.so libsmime3.so libssl3.so libsoftokn3.so libfreebl3.so libfreeblpriv3.so \
           libnssckbi.so libnssdbm3.so libnspr4.so libplc4.so libplds4.so; do
  rm -f "$appdir/usr/lib/$lib"
done
# …and so are Wayland's own libraries: the system's Mesa loads its EGL for
# Wayland against them, and every desktop that runs Wayland has them.
rm -f "$appdir"/usr/lib/libwayland-client.so* "$appdir"/usr/lib/libwayland-cursor.so* \
      "$appdir"/usr/lib/libwayland-egl.so* "$appdir"/usr/lib/libwayland-server.so*

# ── the third-party notices ──
# Beside LICENSE.txt: the notices for Qt, Chromium, RtAudio, Monocypher and the
# libraries the tree carries now (every library in lib/ that is not Qt's must
# belong to a package of this system, whose copyright file is copied — the
# script stops on one that does not). It must come after the removals above:
# a library the packages do not carry is not credited either.
node "$here/tools/collect-notices.js" --platform linux --out "$appdir/usr/share/doc/microtone" \
  --qmake "$QMAKE" --tree "$appdir/usr"

# ── the AppImage ──
image=$out/Microtone-$version-linux-x86_64.AppImage
appimagetool-x86_64.AppImage --no-appstream --runtime-file "$tools/runtime-x86_64" "$appdir" "$image"

# ── .deb and .rpm: the tree in /opt/microtone ──
stage() {  # <root> <kind>
  local root=$1 kind=$2
  mkdir -p "$root/opt/microtone" "$root/usr/bin" "$root/usr/share"
  cp -a "$appdir/usr/." "$root/opt/microtone/"
  # The entry and the icons where the desktop looks; the command on PATH.
  mv "$root/opt/microtone/share/applications" "$root/opt/microtone/share/icons" "$root/usr/share/"
  ln -s ../../opt/microtone/bin/microtone "$root/usr/bin/microtone"
  printf '%s\n' "$kind" > "$root/opt/microtone/share/microtone/package"
}
summary="A tracker workstation for any sound, in any tuning"
describe="Microtone is a tracker workstation for any sound, in any tuning: patterns, samples, FM and sound-chip instruments, a mixing chain on every instrument and a mastering chain on the song, with stereo, surround and ambisonic export."

# Laid out as a Debian package build is (debian/<package>/ with DEBIAN/ in
# it), so dpkg-shlibdeps follows the tree's own $ORIGIN paths and counts its
# libraries as the package's.
debsrc=$out/deb
deb=$debsrc/debian/microtone
stage "$deb" deb
mkdir -p "$deb/DEBIAN"
printf 'Source: microtone\n\nPackage: microtone\nArchitecture: amd64\n' > "$debsrc/debian/control"
# Dependencies: what the tree's programs and libraries need from the system,
# with the versions dpkg-shlibdeps knows; plus OpenSSL, which Qt loads by
# name. Without dpkg-shlibdeps (not a Debian system), a fixed list.
depends="libc6 (>= 2.35), libstdc++6 (>= 11), libasound2, libgl1, libegl1, libgbm1, libdrm2, libexpat1, libfontconfig1, libfreetype6, libx11-6, libx11-xcb1, libxcb1, zlib1g"
if command -v dpkg-shlibdeps > /dev/null; then
  mapfile -t elves < <(find "$deb/opt/microtone" -type f -exec sh -c 'head -c 4 "$1" | grep -q "ELF"' _ {} \; -print)
  if found=$(cd "$debsrc" && dpkg-shlibdeps -O --ignore-missing-info "${elves[@]}" 2> "$out/shlibdeps.txt"); then
    depends=${found#shlibs:Depends=}
  else
    echo "dpkg-shlibdeps failed (see $out/shlibdeps.txt): a fixed list instead" >&2
  fi
fi
depends="$depends, libssl3 | libssl3t64"
cat > "$deb/DEBIAN/control" << EOF
Package: microtone
Version: $version
Architecture: amd64
Maintainer: CuriousTorvald
Installed-Size: $(du -sk --exclude=DEBIAN "$deb" | cut -f1)
Depends: $depends
Suggests: pipewire-jack | jackd2
Section: sound
Priority: optional
Homepage: https://microtone.cc/
Description: $summary
 $describe
EOF
dpkg-deb --root-owner-group --build "$deb" "$out/Microtone-$version-linux-amd64.deb"

rpm=$out/rpm
stage "$rpm" rpm
# rpmbuild works out what the programs need, as dpkg-shlibdeps does; the
# tree's own libraries are neither needed from the system nor offered to it.
bundled=$(find "$rpm/opt/microtone/lib" -maxdepth 1 -name '*.so*' -printf '%f\n' | sed 's/[.+]/\\&/g' | paste -sd '|')
cat > "$out/microtone.spec" << EOF
%global debug_package %{nil}
%global __os_install_post %{nil}
%global _build_id_links none
%global __provides_exclude_from ^/opt/microtone/.*\$
%global __requires_exclude ^(${bundled})
Name: microtone
Version: $version
Release: 1
Summary: $summary
License: GPL-3.0-or-later
URL: https://microtone.cc/
BuildArch: x86_64
Requires: libssl.so.3()(64bit)
Suggests: pipewire-jack-audio-connection-kit

%description
$describe

%install
cp -a "$rpm/." "%{buildroot}/"

%files
%defattr(-,root,root,-)
/opt/microtone
/usr/bin/microtone
/usr/share/applications/cc.microtone.qt.desktop
/usr/share/icons/hicolor/*/apps/cc.microtone.qt.png
EOF
rpmbuild -bb --quiet \
  --define "_topdir $out/rpmbuild" --define "_rpmdir $out" \
  --define "_build_name_fmt Microtone-%{VERSION}-linux-x86_64.rpm" \
  "$out/microtone.spec"

ls -l "$image" "$out/Microtone-$version-linux-amd64.deb" "$out/Microtone-$version-linux-x86_64.rpm"
