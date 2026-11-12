#!/usr/bin/env node
// Bring libtaudplay (the portable C player library, its own repository) in
// step with the engine: its src/ and include/ ARE core/engine/c/, copied.
//
//   node tools/make-taudplay-c.js [<taudplay-c checkout>]     (from microtone-worker/)
//
// The default checkout is ../../taudplay-c. What it writes there:
//   src/*.c, src/*.h, include/*.h   verbatim (a file the engine no longer has is removed);
//   include/taudplay.h              TAUDPLAY_VERSION stamped with this app's version;
//   README.md                       its "In step with …" line.
// What it only CHECKS: that the Makefile and CMakeLists.txt there build every
// source file the library needs — a file added to the engine is reported, not
// silently left out of the build. The build files, the tests, the command-line
// tool and the rest of the README are that repository's own.
//
// It commits nothing: look at `git diff` there, run `make check`, and commit.

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { engineSources, engineSourceDigest } from "./make-engine-wasm.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The engine's sources that only the WebAssembly build is made of: the host
 *  API a browser calls (`tw_*`), the worklet's snapshot, the tests' hooks.
 *  They are copied (anyone may build the module from the library's tree) but
 *  the native library does not compile them. */
export const WASM_ONLY = ["wasm_api.c", "wasm_parts.c", "snapshot.c"];

/** The `name.c` files a build file lists under src/. */
function listedSources(text) {
  return new Set([...text.matchAll(/\bsrc\/([A-Za-z0-9_]+\.c)\b/g)].map((m) => m[1]));
}

export function syncTaudplayC(outDir, { log = console.log } = {}) {
  for (const need of ["include/taudplay.h", "Makefile", "CMakeLists.txt", "README.md"]) {
    if (!existsSync(join(outDir, need))) throw new Error(`${outDir} is not a taudplay-c checkout (no ${need})`);
  }
  const version = JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")).version;
  const digest = engineSourceDigest().slice(0, 12);
  const sources = engineSources(); // [ "src/x.c" | "include/x.h", bytes ]

  let written = 0;
  const names = new Set();
  for (const [name, bytes] of sources) {
    names.add(name);
    let out = bytes;
    if (name === "include/taudplay.h") {
      const text = bytes.toString("utf8");
      const stamped = text.replace(/^#define TAUDPLAY_VERSION "[^"]*"$/m, `#define TAUDPLAY_VERSION "${version}"`);
      if (!stamped.includes(`#define TAUDPLAY_VERSION "${version}"`)) throw new Error("taudplay.h has no TAUDPLAY_VERSION line to stamp");
      out = Buffer.from(stamped, "utf8");
    }
    const dest = join(outDir, name);
    if (!existsSync(dest) || !readFileSync(dest).equals(out)) {
      writeFileSync(dest, out);
      written++;
      log(`  wrote ${name}`);
    }
  }
  for (const dir of ["src", "include"]) {
    for (const f of readdirSync(join(outDir, dir))) {
      if (/\.[ch]$/.test(f) && !names.has(`${dir}/${f}`)) {
        unlinkSync(join(outDir, dir, f));
        written++;
        log(`  removed ${dir}/${f} (the engine no longer has it)`);
      }
    }
  }

  const readmePath = join(outDir, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const line = `In step with taudplay ${version} (Microtone.js ${version}, engine ${digest}).`;
  const stampedReadme = readme.replace(/In step with taudplay [^\n]*?\(Microtone\.js [^)]*\)\./, line);
  if (!stampedReadme.includes(line)) throw new Error('README.md has no "In step with taudplay … (Microtone.js …)." line to stamp');
  if (stampedReadme !== readme) { writeFileSync(readmePath, stampedReadme); written++; log("  wrote README.md (the version line)"); }

  // The build files must compile what the library is made of.
  const wanted = sources.map(([n]) => n).filter((n) => n.startsWith("src/") && n.endsWith(".c"))
    .map((n) => n.slice(4)).filter((n) => !WASM_ONLY.includes(n));
  const problems = [];
  for (const file of ["Makefile", "CMakeLists.txt"]) {
    const listed = listedSources(readFileSync(join(outDir, file), "utf8"));
    for (const n of wanted) if (!listed.has(n)) problems.push(`${file} does not build src/${n}`);
    for (const n of listed) if (!wanted.includes(n) && !WASM_ONLY.includes(n)) problems.push(`${file} names src/${n}, which the engine does not have`);
  }
  return { version, digest, written, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] ?? join(HERE, "../../../taudplay-c"));
  const r = syncTaudplayC(outDir);
  console.log(`${outDir}: ${r.written === 0 ? "already in step" : `${r.written} file(s) changed`} — taudplay ${r.version}, engine ${r.digest}`);
  if (r.problems.length) {
    console.error(`\nThe library's build files need a hand:\n  ${r.problems.join("\n  ")}`);
    process.exit(1);
  }
}
