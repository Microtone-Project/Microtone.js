#!/usr/bin/env node
// Build a Taud project from a Taud Motif Language source:
//
//   node tools/motif.js <song.tml> [out.taud] [-v] [--no-source] [--check]
//
// (from microtone-worker/; the default output is the source's own name with
// .taud). --check runs the program and compiles the song without building the
// bank, which is quick, and says what it would make. --no-source leaves the
// TML out of the project (it is kept in a PMtf section by default, so the
// Motif view can open it again).
//
// The soundfont bank is made by the app's own SF2 driver (src/convert/
// sf2bank.py) run with the local python3, exactly as the app runs it under
// Pyodide. A song that names no soundfont plays the one the app bundles,
// assets/GeneralUser-GS.taud.sf2.gz; one that names a file finds it next to
// the .tml.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { ZSTD_LEVEL_SAVE } from "../core/format/zstd.js";
import { buildProject, evaluate, BUNDLED_SOUNDFONT } from "../src/motif/build.js";
import { compileScore } from "../src/motif/compile.js";
import { MotifError } from "../src/motif/lexer.js";

const APP = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const verbose = args.includes("-v");
const check = args.includes("--check");
const files = args.filter((a) => !a.startsWith("-"));
if (!files.length) {
  console.error("usage: node tools/motif.js <song.tml> [out.taud] [-v] [--no-source] [--check]");
  process.exit(2);
}
const inPath = resolve(files[0]);
const outPath = resolve(files[1] ?? join(dirname(inPath), basename(inPath).replace(/\.tml$/i, "") + ".taud"));
const source = readFileSync(inPath, "utf8");
const log = (line) => console.log(line);

function report(err) {
  if (!(err instanceof MotifError)) throw err;
  console.error(`${inPath}:${err.located}`);
  for (const f of err.trace ?? []) console.error(`    in ${f.name} (line ${f.line}:${f.col})`);
  process.exit(1);
}

/** The soundfont a song asks for, as bytes. */
function soundfontBytes(name) {
  if (name === null || name === BUNDLED_SOUNDFONT) {
    return gunzipSync(readFileSync(join(APP, "assets/GeneralUser-GS.taud.sf2.gz")));
  }
  const path = resolve(dirname(inPath), name);
  if (!existsSync(path)) throw new MotifError(`the soundfont "${name}" is not next to the source (${path})`);
  return readFileSync(path);
}

async function sf2Bank(selection, { bpm, soundfont }) {
  const tmp = mkdtempSync(join(tmpdir(), "motif-"));
  try {
    const sf2 = join(tmp, "font.sf2");
    writeFileSync(sf2, soundfontBytes(soundfont));
    writeFileSync(join(tmp, "presets.json"), JSON.stringify(selection));
    // --bpm: the SF2 release times become per-tick fadeouts at the song's tempo.
    execFileSync("python3", [join(APP, "src/convert/sf2bank.py"), "build", sf2,
      join(tmp, "presets.json"), join(tmp, "bank.tsii"), "--bpm", String(bpm)], {
      env: { ...process.env, PYTHONPATH: join(APP, "vendor/converters"), PYTHONDONTWRITEBYTECODE: "1" },
      stdio: verbose ? "inherit" : "ignore",
    });
    return new Uint8Array(readFileSync(join(tmp, "bank.tsii")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  if (check) {
    const score = evaluate(source, { log });
    const { patterns, cues } = compileScore(score);
    let events = 0;
    for (const l of score.lanes) events += l.ev.size;
    log(`${inPath}: ${score.song.bars} bars in ${score.tuning.name}, ${score.instruments.length} instruments, ` +
      `${score.lanes.length} lanes, ${events} rows with events → ${patterns.length} patterns, ${cues.length} cues`);
  } else {
    const t0 = performance.now();
    let last = "";
    const { doc } = await buildProject(source, {
      sf2Bank, log,
      progress: verbose ? (stage) => { if (stage !== last) { last = stage; log(`[${stage}]`); } } : undefined,
      embedSource: !args.includes("--no-source"),
    });
    const bytes = await doc.toSaveBytes(ZSTD_LEVEL_SAVE);
    writeFileSync(outPath, bytes);
    log(`${outPath}: ${bytes.length} bytes in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
} catch (err) {
  report(err);
}
