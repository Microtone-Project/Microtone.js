// Running a Motif build from the page. The work happens in the Motif worker
// (src/motif/motif.worker.js); this side answers its one question — the
// soundfont bank, which only the converter worker (Pyodide) can make — and
// hands back the built project's bytes.

import { buildSf2Bank } from "../convert/convert.js";
import { MotifError } from "../motif/lexer.js";

/** What a cancelled build rejects with. */
export class MotifCancelled extends Error {
  constructor() { super("cancelled"); this.name = "MotifCancelled"; }
}

/**
 * Start a build. Returns {promise, cancel}: the promise resolves with
 * {bytes, report} (an uncompressed .taud, ready for parseTaud) and rejects
 * with a MotifError (line and column in `pos`), a MotifCancelled, or an Error.
 *
 * @param opts.resolveSoundfont  async (name) → {name, bytes}, or null when the
 *        person declines. `name` is the song's `soundfont`, null for the
 *        bundled GeneralUser GS.
 * @param opts.onProgress  (stage, fraction)
 * @param opts.onLog       (line) — print() output and the stages' own lines
 */
export function startMotifBuild(source, { resolveSoundfont, onProgress = null, onLog = null, steps } = {}) {
  const worker = new Worker(new URL("../motif/motif.worker.js", import.meta.url), { type: "module" });
  let settled = false;
  let fail;
  const promise = new Promise((resolve, reject) => {
    fail = reject;
    const finish = () => { settled = true; worker.terminate(); };
    worker.onmessage = async (e) => {
      const m = e.data;
      if (settled) return;
      switch (m.t) {
        case "log": onLog?.(m.line); break;
        case "progress": onProgress?.(m.stage, m.frac); break;
        case "bank": {
          try {
            const sf2 = await resolveSoundfont(m.soundfont);
            if (settled) return;
            if (!sf2) {
              finish();
              reject(new MotifCancelled());
              return;
            }
            const tsii = await buildSf2Bank(sf2.bytes, m.selection, { bpm: m.bpm, onStatus: (line) => onLog?.(line) });
            if (settled) return;
            const buf = tsii.slice().buffer;
            worker.postMessage({ t: "bank", bytes: buf }, [buf]);
          } catch (err) {
            if (!settled) worker.postMessage({ t: "bankError", message: err?.message ?? String(err) });
          }
          break;
        }
        case "done":
          finish();
          resolve({ bytes: new Uint8Array(m.bytes), report: m.report });
          break;
        case "error":
          finish();
          reject(m.motif ? new MotifError(m.message, m.pos, m.trace) : new Error(m.message));
          break;
        default: break;
      }
    };
    worker.onerror = (e) => {
      if (settled) return;
      finish();
      reject(new Error(e.message || "the Motif worker failed to start"));
    };
  });
  worker.postMessage({ t: "build", source, steps });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      worker.terminate();
      fail(new MotifCancelled());
    },
  };
}
