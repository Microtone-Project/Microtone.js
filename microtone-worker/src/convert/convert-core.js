// Conversion core — drives the vendored, UNMODIFIED *2taud.py converters
// inside a Pyodide runtime. Environment-agnostic: the Web Worker
// (convert.worker.js) and the Node tests both call loadConverterRuntime /
// runConverter, differing only in how they obtain the vendor file bytes.
//
// The converters are canonical tsvm sources (vendor/VENDOR-VERSIONS.md);
// running them verbatim is the whole point — no JS port to drift.

/** Converter script per input extension. */
export const CONVERTERS = {
  mod: "mod2taud.py",
  s3m: "s3m2taud.py",
  it: "it2taud.py",
  xm: "xm2taud.py",
  mon: "mon2taud.py",
  ims: "ims2taud.py",
  mid: "midi2taud.py",
  midi: "midi2taud.py",
};

/** Extensions whose converter needs a second input: the instrument bank. */
export const BANK_EXTS = new Set(["ims"]);

export const CONVERTER_SOURCES = [
  "taud_common.py", "mod2taud.py", "s3m2taud.py", "it2taud.py",
  "xm2taud.py", "mon2taud.py", "midi2taud.py",
  // ims2taud imports opl2taud (the OPL→FM-rack instrument compiler) and the
  // Johab decoder its titles are written in; all three are plain stdlib.
  "ims2taud.py", "opl2taud.py", "johab2unicode.py", "johab_symbols.py",
];

/** Microtone.js's own SF2→bank driver (src/convert/sf2bank.py) — installed
 *  alongside the vendored converters; imports midi2taud from the same dir. */
export const SF2BANK_SOURCE = "sf2bank.py";

/** Microtone.js's own BNK→bank driver (src/convert/bnkbank.py) — installed
 *  alongside the vendored converters; imports opl2taud from the same dir. */
export const BNKBANK_SOURCE = "bnkbank.py";

/** {script, isMidi, needsBank} for a file name, or null when it's not a
 *  convertible type. `needsBank` marks the AdLib family, whose songs NAME their
 *  instruments instead of storing them and so need a .BNK alongside. */
export function converterFor(name) {
  const ext = name.toLowerCase().split(".").pop();
  const script = CONVERTERS[ext];
  if (!script) return null;
  return { script, isMidi: script === "midi2taud.py", needsBank: BANK_EXTS.has(ext) };
}

/**
 * Load Pyodide and install the converter sources on its MEMFS.
 * @param loadPyodide  the function from vendor/pyodide/pyodide.js
 * @param indexURL     URL/path of vendor/pyodide/
 * @param sources      {fileName: Uint8Array} for CONVERTER_SOURCES
 * @param onStatus     optional (line) => void progress callback
 */
export async function loadConverterRuntime({ loadPyodide, indexURL, sources, onStatus }) {
  onStatus?.("loading Python runtime…");
  const py = await loadPyodide({ indexURL });
  py.FS.mkdirTree("/converters");
  for (const name of CONVERTER_SOURCES) {
    if (!sources[name]) throw new Error(`missing converter source ${name}`);
  }
  for (const [name, bytes] of Object.entries(sources)) {
    py.FS.writeFile(`/converters/${name}`, bytes);
  }
  py.runPython(`import sys; sys.path.insert(0, "/converters")`);
  onStatus?.(`Python ${py.runPython("import sys; sys.version.split()[0]")} ready`);
  return py;
}

/**
 * Run one converter inside a loaded runtime. Inputs are written to MEMFS,
 * argv is passed through unchanged (paths must reference the input names
 * below), stdout+stderr stream to onLog, and the produced file is returned.
 * All per-run MEMFS files are removed afterwards.
 *
 * @param py       runtime from loadConverterRuntime
 * @param script   e.g. "xm2taud.py"
 * @param argv     converter argv AFTER the script name, e.g. ["/in.xm", "/out.taud"]
 * @param inputs   [{path, bytes}] to place on MEMFS
 * @param output   MEMFS path the converter writes (must appear in argv)
 * @param onLog    optional (line) => void for converter output
 * @returns Uint8Array of the produced file
 */
export function runConverter(py, { script, argv, inputs, output, onLog }) {
  for (const f of inputs) py.FS.writeFile(f.path, f.bytes);
  const log = (line) => { if (line.trim() !== "") onLog?.(line); };
  py.setStdout({ batched: log });
  py.setStderr({ batched: log });
  try {
    // argv as a JSON literal — a JSON string is a valid Python string literal,
    // so no globals/PyProxy lifetime to manage.
    const argvJson = JSON.stringify(JSON.stringify([script, ...argv]));
    py.runPython(`
import sys, runpy, json
sys.argv = json.loads(${argvJson})
try:
    runpy.run_path("/converters/" + sys.argv[0], run_name="__main__")
except SystemExit as e:
    if e.code not in (0, None):
        raise RuntimeError(f"converter exited with code {e.code}") from None
`);
    return py.FS.readFile(output);
  } finally {
    py.setStdout();
    py.setStderr();
    for (const f of inputs) {
      try { py.FS.unlink(f.path); } catch { /* not created */ }
    }
    try { py.FS.unlink(output); } catch { /* converter failed before writing */ }
  }
}

/** argv for a conversion: tracker files take (in, out); MIDI adds the
 *  soundfont. Converter defaults are used as-is — notably far-loop
 *  synth-loop rescue, which upstream midi2taud now applies by default
 *  (opt-out is --no-force-synth-loop). -v streams the converter's vprint
 *  diagnostics through the status channel (the import progress popup).
 *  `rpb` (MIDI only) pins midi2taud's rows-per-beat grid axis (one of
 *  2/4/8/16/32/64 — argparse choices); null/"auto" leaves it auto-picked.
 *  `stereoSamples` (MIDI only, item 90.1) opts IN to keeping SF2 stereo sample
 *  pairs as stereo — double the pool bytes per stereo instrument.
 *  `trimPatches` (MIDI only, item 75) opts IN to dropping the Ixmp patches the
 *  song never triggers — off by default, so an imported bank keeps each preset's
 *  full zone map and Housekeeping ("Cleanup instrument patches") decides later.
 *  Worth turning on when the untrimmed pool overflows the converter's 8 MB
 *  budget: that path resamples EVERY sample down, costing quality song-wide.
 *  `keepDuplicatePatterns` (MIDI only) opts IN to --no-dedup-patterns: every
 *  cue×voice cell gets its own pattern instead of sharing one copy of each
 *  distinct bar, so editing a repeat can't change the other occurrences.
 *  `realign` (MIDI only, item 183) opts IN to --realign-tempo, for a MIDI whose
 *  declared tempo does not describe its own events: null/"off" trusts the file,
 *  "auto" infers the real tempo from the note onsets, and a NUMBER is that tempo
 *  in BPM. Every tick and every tempo is scaled by one factor, so the
 *  performance keeps its real-time timing and the music's beat becomes one
 *  quarter note. Auto is inert on a file that is already aligned.
 *  `quantise` (MIDI only, item 168) opts IN to --quantise: null/"off" leaves
 *  the performance's own timing alone, which is the default; "auto" snaps notes
 *  to the subdivision the onsets already use, "row" to the Taud row grid, and a
 *  number to that beat subdivision. BOTH ENDS of a note are snapped, so a
 *  quantised note lasts a whole number of grid steps. `quantiseStrength`
 *  (0..100) is how far each end moves towards the grid — the setting that
 *  tightens sloppy playing without flattening deliberate off-grid timing.
 *  `bankPaths` (AdLib .ims only) are the .BNK files patch names resolve
 *  against, most specific first. */
export function buildArgv({ isMidi, needsBank = false, inPath, sf2Path,
                            bankPaths = [], outPath, rpb = null,
                            trimPatches = false, stereoSamples = false,
                            keepDuplicatePatterns = false, realign = null,
                            quantise = null, quantiseStrength = 100 }) {
  if (needsBank) {
    // The song's own bank first, then the general one: patch names resolve
    // most-specific-first, and case-insensitively.
    const argv = [inPath, outPath, "-v"];
    for (const b of bankPaths) argv.push("-b", b);
    return argv;
  }
  if (!isMidi) return [inPath, outPath, "-v"];
  const argv = [inPath, sf2Path, outPath, "-v"];
  if (rpb != null && rpb !== "auto") argv.push("--rpb", String(rpb));
  if (trimPatches) argv.push("--trim-unused-patches");
  if (stereoSamples) argv.push("--stereo-samples");
  if (keepDuplicatePatterns) argv.push("--no-dedup-patterns");
  // Realignment before quantisation on the command line as in the pipeline:
  // the grid has to be right before anything is snapped to it.
  if (realign != null && realign !== "off") argv.push("--realign-tempo", String(realign));
  if (quantise != null && quantise !== "off") {
    argv.push("--quantise", String(quantise));
    if (quantiseStrength !== 100) argv.push("--quantise-strength", String(quantiseStrength));
  }
  return argv;
}
