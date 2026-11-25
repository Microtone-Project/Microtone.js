#!/usr/bin/env node
// Lays the third-party notices into a package of the Qt build:
//
//   node desktop-qt/tools/collect-notices.js --out <dir> [--platform windows|macos|linux]
//        [--qmake <qmake>]  (or --qt-version <v> --qt-prefix <dir> [--qt-libs <dir>])
//        [--tree <usr dir> --qt-libs <dir>]   (Linux: the packaged tree)
//
// writes into <dir>
//   THIRD-PARTY-NOTICES.txt   desktop-qt/licences/THIRD-PARTY-NOTICES.txt for
//                             the platform, with the versions filled in: the
//                             app's, Qt's (from qmake), RtAudio's and
//                             Monocypher's (from vendor/VENDOR-VERSIONS.md),
//                             and — Linux — the libraries the tree carries
//   licences/                 the licence texts it points to: Qt's LGPL and
//                             Chromium's, the Chromium credits compiled from
//                             Qt's documentation (qtwebengine-credits.js), RtAudio's
//                             and Monocypher's own files from vendor/, the list of
//                             what Qt carries inside itself (from the SBOM of
//                             the Qt that is installed), and — Linux — each
//                             carried library's Debian copyright file
//
// The Linux part reads the tree, never a list kept by hand: every library in
// <tree>/lib that is neither Qt's nor ICU (which Qt's own installation brings)
// must belong to an installed Debian/Ubuntu package, whose copyright file is
// copied. A library that belongs to none stops the build — a package must
// never carry a file nobody is credited for.
//
// Node only, no dependencies (the repository's rule).
import { execFileSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const qtDir = join(here, "..");          // desktop-qt
const repo = join(qtDir, "..");

/** The Qt modules this app deploys, whose SBOMs say what Qt carries inside. */
export const SBOM_MODULES = [
  "qtbase", "qtdeclarative", "qtsvg", "qtwayland", "qtwebengine", "qtwebchannel",
  "qtwebsockets", "qthttpserver", "qtpositioning", "qtserialport",
];
/** Packages of an SBOM that are not part of what runs: tests, tools, the build. */
const NOT_SHIPPED = /^(Test|Bootstrap_|Platform_|QSQLite)|Compositor|Ivi/;

// ── the template ──

/**
 * `{{#linux macos}} … {{/linux macos}}` keeps its lines only on those
 * platforms; `@NAME@` is replaced from `vars`. A placeholder left over is an
 * error, so a template and its caller cannot drift apart.
 */
export function render(template, vars, platform) {
  const lines = [];
  let keep = true;
  for (const line of template.split("\n")) {
    const open = /^\{\{#([a-z ]+)\}\}$/.exec(line);
    const close = /^\{\{\/([a-z ]+)\}\}$/.exec(line);
    if (open) keep = open[1].split(" ").includes(platform);
    else if (close) keep = true;
    else if (keep) lines.push(line);
  }
  let text = lines.join("\n").replace(/\n{4,}/g, "\n\n\n");
  text = text.replace(/@([A-Z_]+)@/g, (m, name) => {
    if (!(name in vars)) throw new Error(`the notices template wants @${name}@, which nothing gave`);
    return vars[name];
  });
  // A heading's underline is as long as the heading, whatever filled it in.
  return text.replace(/^(.*\S.*)\n([-=])\2{2,}$/gm, (m, head, rule) => `${head}\n${rule.repeat([...head].length)}`);
}

// ── what Qt carries inside itself ──

/**
 * The third-party components named by the SBOMs (SPDX JSON) of the Qt modules
 * in <sbomDir>, as text. Qt writes one package per component it carries, with
 * the licence and the copyright lines; the name Qt gave it is in the comment.
 */
export function qtComponents(sbomDir, qtVersion) {
  const found = new Map();
  for (const mod of SBOM_MODULES) {
    const file = join(sbomDir, `${mod}-${qtVersion}.spdx.json`);
    if (!existsSync(file)) continue;
    for (const p of JSON.parse(readFileSync(file, "utf8")).packages ?? []) {
      if (!/^Bundled|_Attribution_/.test(p.name) || NOT_SHIPPED.test(p.name)) continue;
      const named = /^\s*Name: (.+)$/m.exec(p.comment ?? "");
      const name = (named ? named[1] : p.name.replace(/^.*_Attribution_/, "").replace(/^Bundled_?/, "")).trim();
      const version = p.versionInfo && p.versionInfo !== "unknown" ? p.versionInfo : "";
      const key = `${name}\n${version}`;
      if (!found.has(key)) {
        found.set(key, {
          name, version, licence: p.licenseConcluded && p.licenseConcluded !== "NOASSERTION" ? p.licenseConcluded : "see the source",
          copyright: (p.copyrightText ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim(),
          source: p.downloadLocation && p.downloadLocation !== "NOASSERTION" ? p.downloadLocation : "",
          modules: new Set(),
        });
      }
      found.get(key).modules.add(mod);
    }
  }
  if (found.size === 0) return null;
  const out = [
    `Components that Qt ${qtVersion} carries inside its libraries`,
    "",
    "From the SBOMs Qt publishes with each module. A component is listed for every",
    "module that names it, whether or not the app uses the feature it serves.",
    "The licence text of each is in Qt's source, in src/3rdparty/<name> of the",
    "module's archive: https://download.qt.io/archive/qt/",
  ];
  for (const c of [...found.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    out.push("", `${c.name}${c.version ? " " + c.version : ""}`, `    Licence: ${c.licence}`);
    const lines = c.copyright.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length) out.push(`    Copyright: ${lines[0]}`, ...lines.slice(1).map((l) => `               ${l}`));
    if (c.source) out.push(`    Source: ${c.source}`);
    out.push(`    In: ${[...c.modules].join(", ")}`);
  }
  return out.join("\n") + "\n";
}

// ── the libraries a Linux tree carries ──

/** Where a Debian/Ubuntu library sits (a lib directory, at most one folder down). */
const LIB_PATH = /^\/(usr\/)?lib(\/x86_64-linux-gnu)?(\/[^/]+)?\/[^/]+$/;

function osRelease(root = "/etc/os-release") {
  try {
    return Object.fromEntries(readFileSync(root, "utf8").split("\n").map((l) => /^(\w+)=("?)(.*)\2$/.exec(l)).filter(Boolean).map((m) => [m[1], m[3]]));
  } catch {
    return {};
  }
}

/**
 * Credits every library in <tree>/lib that is not Qt's: copies the copyright
 * file of its Debian package into <outDir>/licences/debian/ (and the common
 * licences those files cite), and returns the section of the notices.
 * `run(cmd, args)` returns a command's output (dpkg's), injectable for tests;
 * `docRoot` is where /usr/share/doc and /usr/share/common-licenses are.
 */
export function linuxLibraries({ tree, qtLibs, outDir, run = (c, a) => execFileSync(c, a, { encoding: "utf8" }), docRoot = "/usr/share", os = osRelease() }) {
  const libDir = join(tree, "lib");
  const names = readdirSync(libDir)
    .filter((n) => /\.so(\.|$)/.test(n) && !lstatSync(join(libDir, n)).isSymbolicLink() && !n.startsWith("libQt6"))
    .sort();
  const byPackage = new Map();
  const icu = [];
  const unowned = [];
  for (const name of names) {
    if (qtLibs && existsSync(join(qtLibs, name))) {  // from Qt's own installation
      if (/^libicu/.test(name)) icu.push(name);
      else unowned.push(`${name} (in Qt's installation, but not a library this tool knows the licence of)`);
      continue;
    }
    let owners = [];
    try {
      owners = run("dpkg", ["-S", `*/${name}`]).split("\n").flatMap((line) => {
        const m = /^(.+): (\/.+)$/.exec(line);
        return m && LIB_PATH.test(m[2]) && basename(m[2]) === name ? m[1].split(", ").map((p) => p.replace(/:[a-z0-9]+$/, "")) : [];
      });
    } catch { /* dpkg: no path matching the pattern */ }
    owners = [...new Set(owners)];
    if (owners.length === 0) { unowned.push(name); continue; }
    for (const pkg of owners) {
      if (!byPackage.has(pkg)) byPackage.set(pkg, { libs: [] });
      byPackage.get(pkg).libs.push(name);
    }
  }
  if (unowned.length) {
    throw new Error(
      `no Debian package owns ${unowned.join(", ")}: the package would carry a library nobody is credited for. ` +
      "This tool must run on the Debian or Ubuntu system that built the tree.",
    );
  }

  const debian = join(outDir, "licences", "debian");
  const common = new Set();
  const entries = [];
  const home = os.ID === "ubuntu" ? (s) => `https://launchpad.net/ubuntu/+source/${s}`
    : os.ID === "debian" ? (s, v) => `https://sources.debian.org/src/${s}/${v.replace(/^\d+:/, "")}/`
    : null;
  for (const [pkg, { libs }] of [...byPackage].sort(([a], [b]) => a.localeCompare(b))) {
    const [pkgName, version, src, srcVersion] = run("dpkg-query", ["-W", "-f=${Package}\t${Version}\t${source:Package}\t${source:Version}", pkg]).trim().split("\t");
    const copyright = join(docRoot, "doc", pkg, "copyright");
    if (!existsSync(copyright)) throw new Error(`${pkg} has no ${copyright}`);
    const text = readFileSync(copyright, "utf8");
    mkdirSync(join(debian, pkg), { recursive: true });
    writeFileSync(join(debian, pkg, "copyright"), text);
    for (const m of text.matchAll(/\/usr\/share\/common-licenses\/([A-Za-z0-9.+-]*[A-Za-z0-9+-])/g)) common.add(m[1]);
    const licences = [...new Set([...text.matchAll(/^License: *(\S.*)$/gm)].map((m) => m[1].trim()))];
    entries.push([
      libs.join(", "),
      `    ${os.NAME ?? "Debian"} package ${pkgName} ${version}` + (src && src !== pkgName ? ` (source package ${src})` : ""),
      licences.length ? `    Licences: ${licences.slice(0, 6).join("; ")}${licences.length > 6 ? "; …" : ""}` : "",
      `    Copyright and licence terms: licences/debian/${pkg}/copyright`,
      `    Source: ${(home ? home(src, srcVersion) + " — " : "")}apt-get source ${src}=${srcVersion}`,
    ].filter(Boolean).join("\n"));
  }
  for (const name of [...common].sort()) {
    const file = join(docRoot, "common-licenses", name);
    if (!existsSync(file)) throw new Error(`a copyright file cites ${file}, which is not here`);
    mkdirSync(join(debian, "common-licenses"), { recursive: true });
    copyFileSync(realpathSync(file), join(debian, "common-licenses", name));
  }
  if (icu.length) {
    entries.push([
      [...new Set(icu.map((n) => n.replace(/\.so\.(\d+).*/, ".so.$1")))].join(", "),
      "    ICU 73.2, brought by Qt's own installation, which Qt's libraries are linked against",
      "    Licence: the Unicode licence (and the licences it lists for ICU's other parts):",
      "    licences/ICU-73.2-LICENSE.txt",
      "    Source: https://github.com/unicode-org/icu/releases/tag/release-73-2",
    ].join("\n"));
  }

  return [
    `Besides Qt's own libraries, this package carries the ${names.length} library files below,`,
    `each copied unmodified from the ${os.PRETTY_NAME ?? "Debian-based"} system that built it (the`,
    "debugging symbols may be stripped), so that the app runs on a desktop that",
    "lacks them. They are",
    "separate files in lib/: you may replace any of them with your own build of the",
    "same library and version. The ones that name the GNU LGPL or GPL are offered",
    "with their source: the source package named below, which is the one they were",
    "built from. The system's own libraries (the C library, X11, OpenGL, ALSA,",
    "fontconfig, NSS, Wayland, JACK) are not carried; the desktop supplies them.",
    "",
    "A copyright file may name one of the common licences of the Debian system",
    "(/usr/share/common-licenses/<name>): its text is in licences/debian/common-licenses/.",
    "",
    entries.join("\n\n"),
  ].join("\n");
}

// ── the whole ──

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

function vendorVersion(name) {
  const text = readFileSync(join(qtDir, "vendor", "VENDOR-VERSIONS.md"), "utf8");
  const m = new RegExp(`^## ${name} (\\S+)`, "m").exec(text);
  if (!m) throw new Error(`vendor/VENDOR-VERSIONS.md has no "## ${name} <version>"`);
  return m[1];
}

export function collect(argv) {
  const platform = arg(argv, "--platform", { win32: "windows", darwin: "macos", linux: "linux" }[process.platform]);
  if (!["windows", "macos", "linux"].includes(platform)) throw new Error(`platform ${platform}?`);
  const out = arg(argv, "--out");
  if (!out) throw new Error("--out <dir>");

  const qmake = arg(argv, "--qmake");
  if (!qmake && !arg(argv, "--qt-version")) throw new Error("--qmake <qmake>, or --qt-version <v> (with --qt-prefix <dir> for Qt's component list)");
  const query = (key) => execFileSync(qmake, ["-query", key], { encoding: "utf8" }).trim();
  const qtVersion = arg(argv, "--qt-version") ?? query("QT_VERSION");
  const qtPrefix = arg(argv, "--qt-prefix") ?? (qmake ? query("QT_INSTALL_PREFIX") : null);
  const qtLibs = arg(argv, "--qt-libs") ?? (qmake ? query("QT_INSTALL_LIBS") : null);
  const tree = arg(argv, "--tree");

  const vars = {
    VERSION: JSON.parse(readFileSync(join(repo, "microtone-worker", "package.json"), "utf8")).version,
    QT_VERSION: qtVersion,
    QT_SERIES: qtVersion.split(".").slice(0, 2).join("."),
    RTAUDIO_VERSION: vendorVersion("RtAudio"),
    MONOCYPHER_VERSION: vendorVersion("Monocypher"),
    LINUX_LIBRARIES: "",
  };
  const licences = join(out, "licences");
  mkdirSync(licences, { recursive: true });
  for (const [from, to] of [
    ["licences/texts/LGPL-3.0.txt", "LGPL-3.0.txt"],
    ["licences/texts/LGPL-2.1.txt", "LGPL-2.1.txt"],
    ["licences/qtwebengine-third-party.txt", "qtwebengine-third-party.txt"],
    ["vendor/rtaudio/LICENSE", "RtAudio-LICENSE.txt"],
    ["vendor/monocypher/LICENCE.md", "Monocypher-LICENCE.md"],
    // ICU 73 is a library of Qt's Linux installation (Linux's section names it).
    ...(platform === "linux" ? [["licences/texts/ICU-73.2-LICENSE.txt", "ICU-73.2-LICENSE.txt"]] : []),
  ]) copyFileSync(join(qtDir, from), join(licences, to));
  const major = qtVersion.split(".").slice(0, 2).join(".");
  const credits = readFileSync(join(licences, "qtwebengine-third-party.txt"), "utf8");
  if (!credits.includes(`Qt WebEngine ${major} ships it`)) {
    console.warn(`warning: licences/qtwebengine-third-party.txt is Qt WebEngine's list for another series than ${major}: node desktop-qt/tools/qtwebengine-credits.js --qt ${major}`);
  }

  const sbom = qtPrefix ? join(qtPrefix, "sbom") : null;
  const components = sbom && existsSync(sbom) ? qtComponents(sbom, qtVersion) : null;
  writeFileSync(join(licences, "qt-components.txt"), components
    ?? `The list of what Qt ${qtVersion} carries inside its libraries was not available when this package was made (Qt's SBOMs were not found).\nIt is in Qt's own documentation: https://doc.qt.io/qt-${major}/licenses-used-in-qt.html\n`);
  if (!components) console.warn("warning: no Qt SBOM found; qt-components.txt points to Qt's documentation instead");

  if (platform === "linux") {
    if (!tree) throw new Error("--tree <usr dir> is needed on Linux");
    vars.LINUX_LIBRARIES = linuxLibraries({ tree, qtLibs, outDir: out });
  }

  const template = readFileSync(join(qtDir, "licences", "THIRD-PARTY-NOTICES.txt"), "utf8");
  // Notepad on a Windows 10 of 2018 reads a file without a byte-order mark as ANSI.
  writeFileSync(join(out, "THIRD-PARTY-NOTICES.txt"), (platform === "windows" ? String.fromCharCode(0xfeff) : "") + render(template, vars, platform));
  return { out, platform, vars };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { out, platform, vars } = collect(process.argv.slice(2));
    console.log(`third-party notices for ${platform} (app ${vars.VERSION}, Qt ${vars.QT_VERSION}) → ${out}`);
  } catch (e) {
    console.error(`collect-notices: ${e.message}`);
    process.exit(1);
  }
}
