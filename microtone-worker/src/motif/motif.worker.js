// The Motif build, off the page. A program runs here on its step budget, so a
// slow or endless one can never freeze the app, and Cancel is simply
// terminate(). The one step a worker cannot do is the soundfont bank — that
// is the converter worker's (Pyodide) — so it asks the page for it and waits.
//
// in : {t:"build", source, steps?, signature?} · {t:"bank", bytes} · {t:"bankError", message}
//    · {t:"pack", bytes} · {t:"packError", message}
// out: {t:"log", line} · {t:"progress", stage, frac} · {t:"bank", selection, bpm, soundfont}
//    · {t:"pack", name}  (the page answers with the pack's bytes)
// A preview runs here too: {t:"capture", source, offset} → {t:"captured",
// result} (captureCall) or {t:"error", …}.
//    · {t:"done", bytes, report}  (an uncompressed .taud: Document.toBytes)
//    · {t:"error", message, pos, trace, motif}

import { buildProject, captureCall } from "./build.js";
import { MotifError } from "./lexer.js";

let pendingBank = null;
let pendingPack = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.t === "bank") {
    pendingBank?.resolve(new Uint8Array(m.bytes));
    pendingBank = null;
    return;
  }
  if (m.t === "bankError") {
    pendingBank?.reject(new MotifError(m.message));
    pendingBank = null;
    return;
  }
  if (m.t === "pack") {
    pendingPack?.resolve(new Uint8Array(m.bytes));
    pendingPack = null;
    return;
  }
  if (m.t === "packError") {
    pendingPack?.reject(new MotifError(m.message));
    pendingPack = null;
    return;
  }
  if (m.t === "capture") {
    try {
      self.postMessage({ t: "captured", result: captureCall(m.source, m.offset, { steps: m.steps }) });
    } catch (err) {
      self.postMessage({ t: "error", message: err?.message ?? String(err), pos: err?.pos ?? null, trace: err?.trace ?? null, motif: err instanceof MotifError });
    }
    return;
  }
  if (m.t !== "build") return;
  try {
    const { doc, report } = await buildProject(m.source, {
      steps: m.steps,
      signature: m.signature,
      log: (line) => self.postMessage({ t: "log", line }),
      progress: (stage, frac) => self.postMessage({ t: "progress", stage, frac }),
      sf2Bank: (selection, { bpm, soundfont }) => new Promise((resolve, reject) => {
        pendingBank = { resolve, reject };
        self.postMessage({ t: "bank", selection, bpm, soundfont });
      }),
      pack: (name) => new Promise((resolve, reject) => {
        pendingPack = { resolve, reject };
        self.postMessage({ t: "pack", name });
      }),
    });
    const bytes = doc.toBytes();
    const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer : bytes.slice().buffer;
    self.postMessage({ t: "done", bytes: buf, report }, [buf]);
  } catch (err) {
    self.postMessage({
      t: "error",
      message: err?.message ?? String(err),
      pos: err?.pos ?? null,
      trace: err?.trace ?? null,
      motif: err instanceof MotifError,
    });
  }
};
