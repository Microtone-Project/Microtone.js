// Conversion worker — owns the Pyodide runtime (13 MB wasm; loaded once on
// the first conversion, kept for the session) so the UI thread never blocks.
//
// in : {t:"convert", id, fileName, bytes, sf2?: {name, bytes}, banks?: [{name, bytes}]}
//    | {t:"sf2", id, mode:"list"|"build", bytes, selection?, bpm?, stereo?}
//    | {t:"bnk", id, mode:"list"|"build", bytes, selection?, bpm?}
// out: {t:"status", id, line} stream, then {t:"done", id, bytes} | {t:"error", id, message}

import {
  CONVERTER_SOURCES, SF2BANK_SOURCE, BNKBANK_SOURCE, converterFor,
  loadConverterRuntime, runConverter, buildArgv,
} from "./convert-core.js";

const VENDOR = new URL("../../vendor/", import.meta.url);

let runtimePromise = null; // single-flight boot
let queue = Promise.resolve(); // one conversion at a time

function ensureRuntime(onStatus) {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const { loadPyodide } = await import(new URL("pyodide/pyodide.js", VENDOR));
      const sources = {};
      const fetchSource = async (name, url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch ${name}: HTTP ${res.status}`);
        sources[name] = new Uint8Array(await res.arrayBuffer());
      };
      await Promise.all([
        ...CONVERTER_SOURCES.map((n) => fetchSource(n, new URL(`converters/${n}`, VENDOR))),
        fetchSource(SF2BANK_SOURCE, new URL(SF2BANK_SOURCE, import.meta.url)),
        fetchSource(BNKBANK_SOURCE, new URL(BNKBANK_SOURCE, import.meta.url)),
      ]);
      return loadConverterRuntime({
        loadPyodide,
        indexURL: new URL("pyodide/", VENDOR).href,
        sources,
        onStatus,
      });
    })();
    runtimePromise.catch(() => { runtimePromise = null; }); // allow retry after a failed boot
  }
  return runtimePromise;
}

/** Build the runConverter spec for one incoming message. */
function jobSpec(m) {
  if (m.t === "convert") {
    const conv = converterFor(m.fileName);
    if (!conv) throw new Error(`no converter for ${m.fileName}`);
    if (conv.isMidi && !m.sf2) throw new Error("MIDI conversion needs a soundfont");
    if (conv.needsBank && !(m.banks?.length)) {
      throw new Error("AdLib conversion needs an instrument bank (.bnk)");
    }
    const inPath = "/in." + m.fileName.toLowerCase().split(".").pop();
    const inputs = [{ path: inPath, bytes: new Uint8Array(m.bytes) }];
    if (conv.isMidi) inputs.push({ path: "/sf.sf2", bytes: new Uint8Array(m.sf2.bytes) });
    const bankPaths = (m.banks ?? []).map((b, i) => `/bank${i}.bnk`);
    bankPaths.forEach((path, i) => {
      inputs.push({ path, bytes: new Uint8Array(m.banks[i].bytes) });
    });
    return {
      label: `converting ${m.fileName}…`,
      script: conv.script,
      argv: buildArgv({
        isMidi: conv.isMidi, needsBank: conv.needsBank, inPath, sf2Path: "/sf.sf2",
        bankPaths, outPath: "/out.taud",
        rpb: m.rpb ?? null, trimPatches: m.trimPatches === true,
        stereoSamples: m.stereoSamples === true,
        keepDuplicatePatterns: m.keepDuplicatePatterns === true,
        realign: m.realign ?? null,
        quantise: m.quantise ?? null, quantiseStrength: m.quantiseStrength ?? 100,
      }),
      inputs,
      output: "/out.taud",
    };
  }
  if (m.t === "sf2") {
    // the sf2bank driver — list presets or build a bank
    const inputs = [{ path: "/sf.sf2", bytes: new Uint8Array(m.bytes) }];
    if (m.mode === "list") {
      return {
        label: "reading soundfont presets…",
        script: SF2BANK_SOURCE,
        argv: ["list", "/sf.sf2", "/out.json"],
        inputs,
        output: "/out.json",
      };
    }
    inputs.push({ path: "/sel.json", bytes: new TextEncoder().encode(JSON.stringify(m.selection)) });
    return {
      label: `building bank (${m.selection.length} presets)…`,
      script: SF2BANK_SOURCE,
      argv: ["build", "/sf.sf2", "/sel.json", "/out.tsii", "--bpm", String(m.bpm ?? 125),
             ...(m.stereo ? ["--stereo"] : [])],
      inputs,
      output: "/out.tsii",
    };
  }
  // m.t === "bnk": the bnkbank driver — list patches or build a bank
  const inputs = [{ path: "/in.bnk", bytes: new Uint8Array(m.bytes) }];
  if (m.mode === "list") {
    return {
      label: "reading AdLib bank patches…",
      script: BNKBANK_SOURCE,
      argv: ["list", "/in.bnk", "/out.json"],
      inputs,
      output: "/out.json",
    };
  }
  inputs.push({ path: "/sel.json", bytes: new TextEncoder().encode(JSON.stringify(m.selection)) });
  return {
    label: `building bank (${m.selection.length} patches)…`,
    script: BNKBANK_SOURCE,
    argv: ["build", "/in.bnk", "/sel.json", "/out.tsii", "--bpm", String(m.bpm ?? 125)],
    inputs,
    output: "/out.tsii",
  };
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.t !== "convert" && m.t !== "sf2" && m.t !== "bnk") return;
  const status = (line) => self.postMessage({ t: "status", id: m.id, line });
  queue = queue.then(async () => {
    try {
      const spec = jobSpec(m); // validate the request before paying for boot
      const py = await ensureRuntime(status);
      status(spec.label);
      const out = runConverter(py, { ...spec, onLog: status });
      const buf = out.slice().buffer;
      self.postMessage({ t: "done", id: m.id, bytes: buf }, [buf]);
    } catch (err) {
      self.postMessage({ t: "error", id: m.id, message: String(err.message ?? err) });
    }
  });
};
