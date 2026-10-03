#!/usr/bin/env node
// Compile upstream Zstandard's COMPRESSOR to WebAssembly and wrap it as the
// single-file data module core/format/zstd.js loads for saving.
//
//   node tools/make-zstd-wasm.js <wasi-sdk dir> <zstd source dir>
//
// e.g. the x86_64-linux tarball of wasi-sdk 34 and zstd-1.5.7.tar.gz, both
// unpacked — see core/vendor/VENDOR-VERSIONS.md for the URLs and checksums.
// Neither is needed to RUN anything: the output is committed
// (core/vendor/zstd-compress.wasm.js), and only a zstd or wasi-sdk upgrade
// rebuilds it.
//
// What goes in: zstd's lib/common + lib/compress (no decoder, no dictionary
// builder, no legacy formats, no threads) and tools/zstd-wasm.c, the eight
// exports the JavaScript side calls. The module must import NOTHING — no
// WASI, no host functions — so it instantiates with an empty import object in
// a page, a worker and Node alike; the build fails if it does.
//
// The wasm is base64'd into an ES module rather than shipped as a .wasm file:
// a .js file is served with a JavaScript type by every static host, the desktop
// shell's asset protocol and Node's import alike, with no fetch, no URL to
// resolve and no MIME mapping to depend on.

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [sdk, zstd] = process.argv.slice(2);
if (!sdk || !zstd) {
  console.error("usage: node tools/make-zstd-wasm.js <wasi-sdk dir> <zstd source dir>");
  process.exit(2);
}

const lib = join(zstd, "lib");
const header = readFileSync(join(lib, "zstd.h"), "utf8");
const part = (name) => header.match(new RegExp(`#define ZSTD_VERSION_${name}\\s+(\\d+)`))[1];
const zstdVersion = `${part("MAJOR")}.${part("MINOR")}.${part("RELEASE")}`;
const sdkVersion = readFileSync(join(sdk, "VERSION"), "utf8").split("\n")[0].trim();
const clang = join(sdk, "bin", "clang");
const clangVersion = execFileSync(clang, ["--version"], { encoding: "utf8" }).split("\n")[0];

// zstd's own Makefile builds at -O3; the rest switches off what a browser
// cannot use (assembly, the trace hooks, legacy decoders) and drops the error
// strings — the JavaScript side reports the numeric code.
const FLAGS = [
  "--target=wasm32-wasip1", "-mexec-model=reactor", "-O3",
  "-DNDEBUG", "-DDEBUGLEVEL=0", "-DZSTD_DISABLE_ASM", "-DZSTD_TRACE=0",
  "-DZSTD_LEGACY_SUPPORT=0", "-DZSTD_STRIP_ERROR_STRINGS",
  "-ffunction-sections", "-fdata-sections",
];
const LINK = ["-Wl,--gc-sections", "-Wl,--strip-all", "-Wl,-z,stack-size=131072"];
const cFiles = (dir) => readdirSync(join(lib, dir)).filter((f) => f.endsWith(".c")).sort()
  .map((f) => join(lib, dir, f));

const tmp = mkdtempSync(join(tmpdir(), "zstd-wasm-"));
let wasm;
try {
  const out = join(tmp, "zstd.wasm");
  execFileSync(clang, [
    ...FLAGS, `-I${lib}`, `-I${join(lib, "common")}`,
    ...cFiles("common"), ...cFiles("compress"), join(root, "tools/zstd-wasm.c"),
    ...LINK, "-o", out,
  ], { stdio: "inherit" });
  wasm = readFileSync(out);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── checks: imports nothing, exports what zstd.js calls, and round-trips ──
const mod = new WebAssembly.Module(wasm);
const imports = WebAssembly.Module.imports(mod);
if (imports.length) {
  throw new Error(`the module imports ${imports.map((i) => `${i.module}.${i.name}`).join(", ")}`);
}
const exported = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
for (const name of ["memory", "_initialize", "mt_alloc", "mt_free", "mt_bound", "mt_is_error",
  "mt_version", "mt_compress", "mt_stream_begin", "mt_stream_feed"]) {
  if (!exported.has(name)) throw new Error(`the module does not export ${name}`);
}
const x = new WebAssembly.Instance(mod).exports;
x._initialize();
const v = x.mt_version();
if (`${Math.floor(v / 10000)}.${Math.floor(v / 100) % 100}.${v % 100}` !== zstdVersion) {
  throw new Error(`zstd.h says ${zstdVersion}, the library says ${v}`);
}
const { decompress } = await import("../core/vendor/fzstd.esm.js");
const probe = new Uint8Array(3 * 131072).map((_, i) => (i * 7919) % 251 & (i >> 9));
const src = x.mt_alloc(probe.length);
new Uint8Array(x.memory.buffer, src, probe.length).set(probe);
const cap = x.mt_bound(probe.length);
const dst = x.mt_alloc(cap);
const checkFrame = (what, size) => {
  if (x.mt_is_error(size)) throw new Error(`${what} failed: ${size}`);
  const back = decompress(new Uint8Array(x.memory.buffer, dst, size).slice());
  if (back.length !== probe.length || back.some((b, i) => b !== probe[i])) {
    throw new Error(`fzstd does not read back what ${what} wrote`);
  }
};
checkFrame("mt_compress", x.mt_compress(dst, cap, src, probe.length, 19) >>> 0);
// streamed in uneven steps, the last of them empty
if (x.mt_is_error(x.mt_stream_begin(dst, cap, probe.length, 19) >>> 0)) throw new Error("mt_stream_begin failed");
let streamed = 0;
for (const [off, len] of [[0, 100000], [100000, 200000], [300000, probe.length - 300000]]) {
  streamed = x.mt_stream_feed(src + off, len, 0) >>> 0;
  if (x.mt_is_error(streamed)) throw new Error(`mt_stream_feed failed: ${streamed}`);
}
checkFrame("the stream", x.mt_stream_feed(src, 0, 1) >>> 0);

// ── the module ──
const sha256 = createHash("sha256").update(wasm).digest("hex");
const licence = readFileSync(join(zstd, "LICENSE"), "utf8").trimEnd()
  .split("\n").map((l) => (l ? `// ${l}` : "//")).join("\n");
const js = `// GENERATED FILE — do not edit. Rebuild with (from microtone-worker/):
//   node tools/make-zstd-wasm.js <wasi-sdk dir> <zstd source dir>
// See core/vendor/VENDOR-VERSIONS.md.
//
// Zstandard ${zstdVersion}'s COMPRESSOR — lib/common + lib/compress, nothing that
// decodes — with the exports of microtone-worker/tools/zstd-wasm.c, compiled to
// WebAssembly by wasi-sdk ${sdkVersion} (${clangVersion}):
//   ${FLAGS.join(" ")}
//   ${LINK.join(" ")}
// It imports nothing. ${wasm.length} bytes, sha256 ${sha256}.
// Loaded by core/format/zstd.js, which is the only thing that should import this.
//
// Zstandard is dual-licensed BSD-3-Clause / GPL-2.0; it is used here under the
// BSD licence, reproduced verbatim:
//
${licence}

export const ZSTD_VERSION = "${zstdVersion}";
export const WASM_SHA256 = "${sha256}";
export const WASM_BASE64 = "${wasm.toString("base64")}";
`;
writeFileSync(join(root, "core/vendor/zstd-compress.wasm.js"), js);
console.log(`core/vendor/zstd-compress.wasm.js: zstd ${zstdVersion}, wasm ${wasm.length} bytes, ` +
  `module ${js.length} bytes, sha256 ${sha256}`);
