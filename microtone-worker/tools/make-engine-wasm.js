#!/usr/bin/env node
// Compile the Taud engine's C sources (core/engine/c/) to WebAssembly and wrap
// the result as the single-file module the apps load:
// core/engine/taud-engine.wasm.js.
//
//   node tools/make-engine-wasm.js                    (from microtone-worker/)
//   node tools/make-engine-wasm.js --sdk <wasi-sdk dir>
//   node tools/make-engine-wasm.js --clang clang-22 --sysroot /usr/share/wasi-sysroot
//   node tools/make-engine-wasm.js --check            (is the committed module current?)
//
// What it needs: clang with the wasm32 target, wasm-ld, and a wasi-libc
// sysroot. Either a wasi-sdk release unpacked anywhere (--sdk: it carries all
// three), or the distribution's own — on openSUSE `clang` + `lld` +
// `wasi-libc`, which puts the sysroot at /usr/share/wasi-sysroot. Neither is
// needed to RUN anything: the output is committed, and only a change under
// core/engine/c/ rebuilds it.
//
// The module must import NOTHING — no WASI, no host functions — so it
// instantiates with an empty import object in a page, a Worker, an
// AudioWorklet and Node alike; the build fails if it does. That is why the
// engine's sources use no stdio and no clock.
//
// Two flags are part of the engine's contract, not tuning:
//   -ffp-contract=off   a fused multiply-add rounds once where the reference
//                       rounds twice; with it the golden digests move.
//   -flto               the per-sample path crosses a dozen source files; a
//                       whole-program build is 1.4× faster and renders the
//                       same bits.
// Never add -ffast-math or anything that implies it.
//
// The wasm is base64'd into an ES module rather than shipped as a .wasm file,
// for the reasons core/vendor/zstd-compress.wasm.js is: a .js file is served
// with a JavaScript type by every static host, the desktop shell's asset
// protocol and Node's import alike, and a worklet bundle can carry it.
//
// The module records a digest of the sources it was built from
// (ENGINE_SOURCE_SHA256), so a test can tell a stale module from a current one
// without a compiler — `--check` is that test's question.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const C_DIR = join(root, "core/engine/c");
const OUT = join(root, "core/engine/taud-engine.wasm.js");

/** What the compiler is told. Part of the source digest: changing a flag is
 *  changing the build. */
export const ENGINE_CFLAGS = [
  "--target=wasm32-wasip1", "-mexec-model=reactor",
  "-O2", "-flto", "-std=c99", "-ffp-contract=off", "-DNDEBUG",
];
export const ENGINE_LDFLAGS = [
  // -lc alone: the engine needs no compiler-rt builtins, and a distribution's
  // wasi-libc package does not ship them.
  "-nodefaultlibs", "-lc",
  "-Wl,--gc-sections", "-Wl,--strip-all", "-Wl,-z,stack-size=262144",
];

const SNAP_HEADER = join(C_DIR, "src/snap_layout.h");

/**
 * The snapshot's wire layout as a C header: every numeric SNAP_* export of
 * core/worklet/protocol.js, so the engine fills the very offsets the page
 * reads and the two cannot drift. protocol.js stays the one place the layout
 * is written; this file is generated, committed, and part of the source digest.
 */
export async function snapLayoutHeader() {
  const protocol = await import("../core/worklet/protocol.js");
  const lines = Object.entries(protocol)
    .filter(([name, value]) => name.startsWith("SNAP_") && typeof value === "number" && Number.isInteger(value))
    .map(([name, value]) => `#define ${name} ${value}`);
  return `/* GENERATED from core/worklet/protocol.js by tools/make-engine-wasm.js — do not
 * edit. The snapshot's layout: where the engine writes what the page reads. */
#ifndef TAUD_SNAP_LAYOUT_H
#define TAUD_SNAP_LAYOUT_H

${lines.join("\n")}

#endif
`;
}

/** Write snap_layout.h if protocol.js has moved; true when it was current. */
async function syncSnapLayout(write) {
  const want = await snapLayoutHeader();
  const have = existsSync(SNAP_HEADER) ? readFileSync(SNAP_HEADER, "utf8") : null;
  if (have === want) return true;
  if (write) writeFileSync(SNAP_HEADER, want);
  return false;
}

/** The C sources, sorted, as [repo-relative name, bytes]. */
export function engineSources() {
  const list = [];
  for (const dir of ["src", "include"]) {
    for (const f of readdirSync(join(C_DIR, dir)).sort()) {
      if (/\.[ch]$/.test(f)) list.push([`${dir}/${f}`, readFileSync(join(C_DIR, dir, f))]);
    }
  }
  return list;
}

/** One digest over every source file and every flag. */
export function engineSourceDigest() {
  const h = createHash("sha256");
  for (const [name, bytes] of engineSources()) {
    h.update(`${name}\0${bytes.length}\0`);
    h.update(bytes);
  }
  h.update([...ENGINE_CFLAGS, ...ENGINE_LDFLAGS].join("\0"));
  return h.digest("hex");
}

/** The functions the module exports: the player library's whole public header,
 *  the allocator the JavaScript side marshals through, and whatever a source
 *  file marks with TAUD_WASM_EXPORT (an export_name attribute, which the
 *  linker honours by itself). */
export function publicExports() {
  const header = readFileSync(join(C_DIR, "include/taudplay.h"), "utf8");
  const names = new Set(["malloc", "free"]);
  for (const m of header.matchAll(/\b(taud_[a-z0-9_]+)\s*\(/g)) names.add(m[1]);
  return [...names];
}

function committedDigest() {
  if (!existsSync(OUT)) return null;
  return readFileSync(OUT, "utf8").match(/ENGINE_SOURCE_SHA256 = "([0-9a-f]{64})"/)?.[1] ?? null;
}

/** `bin --version`'s major version number, or null when it does not run. */
function majorOf(bin) {
  try {
    const v = execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Number(v.match(/(?:clang version|LLD) (\d+)/)?.[1] ?? NaN) || null;
  } catch { return null; }
}

/**
 * A clang with the wasm32 target AND the wasm-ld of the same major version:
 * with -flto the objects are LLVM bitcode, which an older linker cannot read
 * ("Invalid summary version"), and a rolling distribution easily has a newer
 * clang than lld. Returns { clang, ld } — ld null when plain `wasm-ld` is the
 * matching one already.
 */
function findToolchain(arg) {
  const tries = arg ? [arg] : ["clang", "clang-24", "clang-23", "clang-22", "clang-21", "clang-20", "clang-19", "clang-18"];
  const seen = [];
  for (const c of tries) {
    const major = majorOf(c);
    if (major === null) continue;
    let targets = "";
    try {
      targets = execFileSync(c, ["--print-targets"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch { /* no targets, no use */ }
    if (!/\bwasm32\b/.test(targets)) continue;
    if (majorOf(`wasm-ld-${major}`) === major) return { clang: c, ld: `wasm-ld-${major}` };
    if (majorOf("wasm-ld") === major) return { clang: c, ld: null };
    seen.push(`${c} (LLVM ${major}, no wasm-ld ${major})`);
  }
  throw new Error(arg ? `${arg} is not a clang with the wasm32 target and a wasm-ld of its own version`
    : `no clang with the wasm32 target and a matching wasm-ld on PATH${seen.length ? `: found ${seen.join(", ")}` : ""} (try --clang or --sdk)`);
}

/** Where `bin` is on PATH (clang's --ld-path wants a path). */
function whichBin(bin) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return bin;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i < 0 ? null : argv[i + 1];
  };
  const check = argv.includes("--check");
  const layoutCurrent = await syncSnapLayout(!check);
  const digest = engineSourceDigest();

  if (check) {
    const have = committedDigest();
    if (!layoutCurrent) {
      console.error("core/engine/c/src/snap_layout.h is STALE (protocol.js moved) — rebuild with node tools/make-engine-wasm.js");
      process.exit(1);
    }
    if (have === digest) {
      console.log("core/engine/taud-engine.wasm.js is current");
      return;
    }
    console.error(have === null ? "core/engine/taud-engine.wasm.js is missing or has no source digest"
      : "core/engine/taud-engine.wasm.js is STALE — rebuild with node tools/make-engine-wasm.js");
    process.exit(1);
  }

  const sdk = opt("--sdk");
  const tc = sdk ? { clang: join(sdk, "bin", "clang"), ld: null } : findToolchain(opt("--clang"));
  const clang = tc.clang;
  const sysroot = sdk ? null : (opt("--sysroot") ?? process.env.WASI_SYSROOT ?? "/usr/share/wasi-sysroot");
  if (sysroot !== null && !existsSync(join(sysroot, "lib/wasm32-wasip1/libc.a"))) {
    throw new Error(`no wasi-libc under ${sysroot} (install wasi-libc, or pass --sysroot / --sdk)`);
  }
  const clangVersion = execFileSync(clang, ["--version"], { encoding: "utf8" }).split("\n")[0];
  const toolchain = sdk
    ? `wasi-sdk ${readFileSync(join(sdk, "VERSION"), "utf8").split("\n")[0].trim()} (${clangVersion})`
    : `${clangVersion}, wasi-libc sysroot ${sysroot}`;

  const sources = engineSources().filter(([n]) => n.endsWith(".c")).map(([n]) => join(C_DIR, n));
  const tmp = mkdtempSync(join(tmpdir(), "taud-engine-wasm-"));
  let wasm;
  try {
    const out = join(tmp, "taud-engine.wasm");
    execFileSync(clang, [
      ...ENGINE_CFLAGS, ...(sysroot ? [`--sysroot=${sysroot}`] : []),
      ...(tc.ld ? [`--ld-path=${whichBin(tc.ld)}`] : []),
      `-I${join(C_DIR, "include")}`, ...sources,
      ...ENGINE_LDFLAGS, ...publicExports().map((n) => `-Wl,--export=${n}`),
      "-o", out,
    ], { stdio: "inherit" });
    wasm = readFileSync(out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // ── checks: imports nothing, exports what the JavaScript side calls ──
  const mod = new WebAssembly.Module(wasm);
  const imports = WebAssembly.Module.imports(mod);
  if (imports.length) {
    throw new Error(`the module imports ${imports.map((i) => `${i.module}.${i.name}`).join(", ")}`);
  }
  const exported = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
  for (const name of ["memory", "_initialize", ...publicExports()]) {
    if (!exported.has(name)) throw new Error(`the module does not export ${name}`);
  }
  const x = new WebAssembly.Instance(mod).exports;
  x._initialize();
  const probe = x.malloc(64);
  if (!probe) throw new Error("malloc returned NULL in a fresh instance");
  x.free(probe);

  const sha256 = createHash("sha256").update(wasm).digest("hex");
  const b64 = wasm.toString("base64");
  const js = `// GENERATED FILE — do not edit. Rebuild with (from microtone-worker/):
//   node tools/make-engine-wasm.js
// after any change under core/engine/c/.
//
// The Taud engine (core/engine/c/), compiled to WebAssembly by
// ${toolchain}:
//   ${ENGINE_CFLAGS.join(" ")}
//   ${ENGINE_LDFLAGS.join(" ")}
// It imports nothing. ${wasm.length} bytes, sha256 ${sha256}.
// Loaded by core/engine/wasm-module.js, which is the only thing that should
// import this.

export const ENGINE_WASM_SHA256 = "${sha256}";
// A digest of the C sources and build flags this was compiled from; the
// engine-wasm test fails when it no longer matches the tree.
export const ENGINE_SOURCE_SHA256 = "${digest}";
export const ENGINE_WASM_BASE64 = "${b64}";
`;
  writeFileSync(OUT, js);
  console.log(`core/engine/taud-engine.wasm.js: wasm ${wasm.length} bytes, module ${js.length} bytes, ` +
    `sha256 ${sha256}\n  built with ${toolchain}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
