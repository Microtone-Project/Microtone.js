// The third-party notices of the desktop release (desktop-qt/licences/,
// desktop-qt/tools/collect-notices.js): what each platform's package carries,
// that every vendored library is credited, and that the three CI jobs lay the
// notices into their packages. The Linux library mapping runs against a
// stubbed dpkg, so it needs neither Debian nor Qt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, linuxLibraries, qtComponents, render } from "../../../desktop-qt/tools/collect-notices.js";

const qt = (path) => new URL(`../../../desktop-qt/${path}`, import.meta.url);
const read = (path) => readFileSync(qt(path), "utf8");
const template = read("licences/THIRD-PARTY-NOTICES.txt");
const vendor = read("vendor/VENDOR-VERSIONS.md");
const workflow = readFileSync(new URL("../../../.github/workflows/desktop-qt.yml", import.meta.url), "utf8");

function scratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), "notices-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const vars = {
  VERSION: "1.2.3", QT_VERSION: "6.11.3", QT_SERIES: "6.11",
  RTAUDIO_VERSION: "6.0.1", MONOCYPHER_VERSION: "4.0.2", LINUX_LIBRARIES: "(the libraries)",
};

test("each platform's notices keep their own sections and no marker or placeholder", () => {
  const text = Object.fromEntries(["windows", "macos", "linux"].map((p) => [p, render(template, vars, p)]));
  for (const [platform, t] of Object.entries(text)) {
    assert.ok(!/\{\{|\}\}|@[A-Z_]+@/.test(t), `${platform}: a marker or placeholder is left`);
    for (const must of ["Qt 6.11.3", "RtAudio 6.0.1", "Monocypher 4.0.2", "licences/qtwebengine-third-party.txt", "LGPL-3.0.txt"]) {
      assert.ok(t.includes(must), `${platform} names ${must}`);
    }
  }
  assert.ok(text.windows.includes("Steinberg") && text.windows.includes("Microsoft's C runtime"));
  assert.ok(!text.linux.includes("Steinberg") && !text.macos.includes("Steinberg"), "ASIO is Windows' alone");
  assert.ok(text.linux.includes("(the libraries)") && !text.windows.includes("(the libraries)"));
  assert.ok(text.macos.includes("codesign") && !text.windows.includes("codesign"));
  // The contents list and the headings agree, whatever the platform.
  for (const [platform, t] of Object.entries(text)) {
    const listed = [...t.matchAll(/^ {2}(\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
    const headed = [...t.matchAll(/^(\d+\. .+)\n-{3,}$/gm)].map((m) => m[1]);
    assert.deepEqual(headed, listed, `${platform}: the headings are the contents`);
  }
  // An underline is as long as its heading.
  assert.match(text.linux, /^1\. Qt 6\.11\.3\n-{12}\n/m);
});

test("every library vendored for the desktop app has a section", () => {
  const vendored = [...vendor.matchAll(/^## (\S+) (\S+)/gm)].map((m) => ({ name: m[1], version: m[2] }));
  assert.ok(vendored.length >= 2, "VENDOR-VERSIONS.md names RtAudio and Monocypher");
  for (const { name } of vendored) {
    assert.ok(template.includes(name), `desktop-qt/licences/THIRD-PARTY-NOTICES.txt says nothing of ${name}`);
  }
  // The licence files the package copies are the vendored ones, not copies.
  scratch((dir) => {
    collect(["--platform", "windows", "--out", dir, "--qt-version", "6.11.3"]);
    assert.equal(readFileSync(join(dir, "licences", "RtAudio-LICENSE.txt"), "utf8"), read("vendor/rtaudio/LICENSE"));
    assert.equal(readFileSync(join(dir, "licences", "Monocypher-LICENCE.md"), "utf8"), read("vendor/monocypher/LICENCE.md"));
    const notice = readFileSync(join(dir, "THIRD-PARTY-NOTICES.txt"), "utf8");
    for (const { name, version } of vendored) assert.ok(notice.includes(`${name} ${version}`), `${name} ${version} in the notices`);
    assert.ok(notice.startsWith("﻿"), "Windows' copy has a byte-order mark");
    assert.ok(readdirSync(join(dir, "licences")).includes("qt-components.txt"));
    assert.ok(!existsSync(join(dir, "licences", "ICU-73.2-LICENSE.txt")), "ICU's text is Linux's alone");
  });
});

test("the ASIO SDK's licence is what the notices and the vendor record say it is", () => {
  assert.match(vendor, /GNU GPL\s+version 3/);
  assert.match(render(template, vars, "windows"), /GNU\s+General Public License, version 3/);
  assert.match(readFileSync(new URL("../../../COPYING", import.meta.url), "utf8"), /GNU GENERAL PUBLIC LICENSE\s+Version 3/);
});

test("the Chromium credits are Qt WebEngine's list, whole", () => {
  const text = read("licences/qtwebengine-third-party.txt");
  assert.match(text, /^Chromium, as Qt WebEngine 6\.11 ships it/);
  assert.ok((text.match(/^Licence: /gm) ?? []).length >= 100, "over a hundred components");
  assert.ok(!/&(?:amp|quot|lt|gt|#\d+);/.test(text), "no HTML entity left over");
  for (const entry of ["Chromium License", "ffmpeg", "BoringSSL", "WebRTC", "icu"]) {
    assert.ok(new RegExp(`^${entry}$`, "m").test(text), `the entry ${entry}`);
  }
  assert.match(text, /Copyright 2015 The Chromium Authors/);
  // The workflow's Qt and the credits' series are the same.
  const series = /version: "(\d+\.\d+)\.\d+"/.exec(workflow)[1];
  assert.ok(text.includes(`Qt WebEngine ${series} ships it`), `the credits are for Qt ${series}, which CI builds with`);
  for (const f of ["LGPL-3.0.txt", "LGPL-2.1.txt", "ICU-73.2-LICENSE.txt"]) {
    assert.ok(read(`licences/texts/${f}`).length > 5000, f);
  }
  assert.match(read("licences/texts/LGPL-3.0.txt"), /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(read("licences/texts/LGPL-2.1.txt"), /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1, February 1999/);
});

test("what Qt carries inside itself comes from its SBOMs, tests and tools left out", () => {
  scratch((dir) => {
    const pkg = (name, extra = {}) => ({
      name, versionInfo: "1.0", licenseConcluded: "MIT", copyrightText: "Copyright (c) Someone &lt;a@b&gt;",
      downloadLocation: "https://example.org/x", comment: "", ...extra,
    });
    writeFileSync(join(dir, "qtbase-6.11.3.spdx.json"), JSON.stringify({
      packages: [
        pkg("BundledLibpng", { comment: "Name: LibPNG\nQt usage: …" }),
        pkg("Core_Attribution_siphash", { versionInfo: "unknown", licenseConcluded: "NOASSERTION", downloadLocation: "NOASSERTION" }),
        pkg("Test_Attribution_catch2"),
        pkg("Bootstrap_Attribution_pcre2"),
        pkg("QSQLiteDriverPlugin_Attribution_sqlite"),
        pkg("Core"),
      ],
    }));
    writeFileSync(join(dir, "qtpositioning-6.11.3.spdx.json"), JSON.stringify({ packages: [pkg("BundledLibpng", { comment: "Name: LibPNG" })] }));
    const text = qtComponents(dir, "6.11.3");
    assert.match(text, /^LibPNG 1\.0\n {4}Licence: MIT\n {4}Copyright: Copyright \(c\) Someone <a@b>/m);
    assert.match(text, /^LibPNG 1\.0\n(?:.*\n)*? {4}In: qtbase, qtpositioning$/m, "one entry, both modules");
    assert.match(text, /^siphash\n {4}Licence: see the source/m);
    for (const gone of ["catch2", "pcre2", "sqlite", "Core\n"]) assert.ok(!text.includes(gone), `${gone} left out`);
    assert.equal(qtComponents(dir, "9.9.9"), null, "no SBOM of that version: nothing to list");
  });
});

// A Debian system in miniature: lib/ of a tree, /usr/share/doc and the common
// licences of a fake root, and dpkg's answers as a table.
function fakeSystem(dir, files, owners) {
  const tree = join(dir, "tree"), docRoot = join(dir, "share"), qtLibs = join(dir, "qtlibs");
  for (const d of [join(tree, "lib"), join(docRoot, "common-licenses"), qtLibs]) mkdirSync(d, { recursive: true });
  for (const f of files.tree) writeFileSync(join(tree, "lib", f), "elf");
  symlinkSync("libreal.so.1", join(tree, "lib", "liblink.so.1"));
  for (const f of files.qt ?? []) writeFileSync(join(qtLibs, f), "elf");
  for (const [pkg, copyright] of Object.entries(files.docs ?? {})) {
    mkdirSync(join(docRoot, "doc", pkg), { recursive: true });
    writeFileSync(join(docRoot, "doc", pkg, "copyright"), copyright);
  }
  for (const name of files.common ?? []) writeFileSync(join(docRoot, "common-licenses", name), `${name} text`);
  const run = (cmd, args) => {
    if (cmd === "dpkg") {
      const name = args[1].replace(/^\*\//, "");
      const hit = owners[name];
      if (!hit) throw new Error("dpkg-query: no path found matching pattern");
      return hit.map(([pkgs, path]) => `${pkgs}: ${path}`).join("\n") + "\n";
    }
    const pkg = args[2];
    return `${pkg}\t1.0-1\t${pkg.replace(/\d+$/, "")}-src\t1.0-1\n`;
  };
  return { tree, docRoot, qtLibs, run };
}

test("Linux: each carried library is credited to its package, Qt's own and ICU apart", () => {
  scratch((dir) => {
    const s = fakeSystem(dir, {
      tree: ["libfoo.so.1", "libbar.so.2", "libicuuc.so.73", "libQt6Core.so.6", "libm-2.so"],
      qt: ["libicuuc.so.73", "libQt6Core.so.6"],
      docs: {
        libfoo1: "Files: *\nLicense: LGPL-2.1+\n On Debian systems see /usr/share/common-licenses/LGPL-2.1.\n",
        libbar2: "License: MIT\nLicense: BSD-3-clause\n",
        "libbar2-extra": "License: MIT\n",
        libc6: "License: LGPL-2.1+\n",
      },
      common: ["LGPL-2.1"],
    }, {
      "libfoo.so.1": [["libfoo1:amd64", "/usr/lib/x86_64-linux-gnu/libfoo.so.1"]],
      // Two packages may own one file; a same-named file under /opt is nobody's.
      "libbar.so.2": [["libbar2:amd64, libbar2-extra:amd64", "/lib/x86_64-linux-gnu/libbar.so.2"], ["wine", "/opt/wine/lib/libbar.so.2"]],
      "libm-2.so": [["libc6:amd64", "/lib/x86_64-linux-gnu/libm-2.so"]],
    });
    const section = linuxLibraries({ tree: s.tree, qtLibs: s.qtLibs, outDir: dir, run: s.run, docRoot: s.docRoot, os: { ID: "ubuntu", NAME: "Ubuntu", PRETTY_NAME: "Ubuntu 22.04" } });
    assert.match(section, /^libfoo\.so\.1\n {4}Ubuntu package libfoo1 1\.0-1/m);
    assert.match(section, /Source: https:\/\/launchpad\.net\/ubuntu\/\+source\/libfoo-src — apt-get source libfoo-src=1\.0-1/);
    assert.match(section, /Licences: MIT; BSD-3-clause/);
    assert.match(section, /libicuuc\.so\.73\n {4}ICU 73\.2/);
    assert.ok(!section.includes("libQt6Core") && !section.includes("liblink"), "Qt's libraries and symlinks are not listed");
    assert.match(section, /Besides Qt's own libraries, this package carries the 4 library files/);
    const debian = join(dir, "licences", "debian");
    assert.equal(readFileSync(join(debian, "libfoo1", "copyright"), "utf8").includes("LGPL-2.1+"), true);
    assert.ok(existsSync(join(debian, "libbar2", "copyright")) && existsSync(join(debian, "libbar2-extra", "copyright")), "every owner is credited");
    assert.ok(!existsSync(join(debian, "wine")), "a path outside the system's library folders owns nothing");
    assert.equal(readFileSync(join(debian, "common-licenses", "LGPL-2.1"), "utf8"), "LGPL-2.1 text", "the cited common licence, without the sentence's full stop");
  });
});

test("Linux: a library no package owns stops the build", () => {
  scratch((dir) => {
    const s = fakeSystem(dir, { tree: ["libmystery.so.1"] }, {});
    assert.throws(
      () => linuxLibraries({ tree: s.tree, qtLibs: s.qtLibs, outDir: dir, run: s.run, docRoot: s.docRoot, os: {} }),
      /no Debian package owns libmystery\.so\.1/,
    );
  });
  scratch((dir) => {   // a library of Qt's installation that is not ICU is no one's either
    const s = fakeSystem(dir, { tree: ["libother.so.1"], qt: ["libother.so.1"] }, {});
    assert.throws(() => linuxLibraries({ tree: s.tree, qtLibs: s.qtLibs, outDir: dir, run: s.run, docRoot: s.docRoot, os: {} }), /libother\.so\.1/);
  });
  scratch((dir) => {   // a copyright file that cites a licence the system lacks
    const s = fakeSystem(dir, { tree: ["libfoo.so.1"], docs: { libfoo1: "see /usr/share/common-licenses/Missing-1.0\n" } },
      { "libfoo.so.1": [["libfoo1", "/usr/lib/x86_64-linux-gnu/libfoo.so.1"]] });
    assert.throws(() => linuxLibraries({ tree: s.tree, qtLibs: s.qtLibs, outDir: dir, run: s.run, docRoot: s.docRoot, os: {} }), /Missing-1\.0/);
  });
});

test("the three packages lay the notices in, and the Linux ones after the last removal of a library", () => {
  assert.match(workflow, /collect-notices\.js --platform windows --out \$out --qmake qmake/);
  assert.match(workflow, /collect-notices\.js --platform macos --out "\$app\/Contents\/Resources" --qmake qmake/);
  // macOS: before macdeployqt and the signature, which seal the bundle.
  assert.ok(workflow.indexOf("collect-notices.js --platform macos") < workflow.indexOf('macdeployqt "$app"'));
  const script = read("tools/linux-package.sh");
  const at = script.indexOf('node "$here/tools/collect-notices.js"');
  assert.ok(at > script.indexOf("libwayland-server.so*"), "after the libraries the package leaves to the system are removed");
  assert.ok(at < script.indexOf("appimagetool-x86_64.AppImage --no-appstream"), "before the AppImage is made");
  assert.match(script, /--platform linux --out "\$appdir\/usr\/share\/doc\/microtone"/);
});
