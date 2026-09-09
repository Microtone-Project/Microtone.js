// Main-thread conversion API. convertToTaud() lazily spawns the module
// worker (which lazily boots Pyodide) and resolves with .taud container
// bytes ready for the normal loadBytes path.

import { converterFor } from "./convert-core.js";

export { converterFor };

/** Extensions the import pipeline accepts, for file-picker accept lists. */
export const CONVERT_ACCEPT = ".mod,.s3m,.it,.xm,.mon,.ims,.mid,.midi";

let worker = null;
let nextId = 1;
const pending = new Map(); // id → {resolve, reject, onStatus}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./convert.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.t === "status") p.onStatus?.(m.line);
    else if (m.t === "done") { pending.delete(m.id); p.resolve(new Uint8Array(m.bytes)); }
    else if (m.t === "error") { pending.delete(m.id); p.reject(new Error(m.message)); }
  };
  worker.onerror = (e) => {
    // a worker-level failure (e.g. module load) kills every pending job
    for (const p of pending.values()) p.reject(new Error(e.message || "conversion worker failed"));
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

/**
 * Convert a tracker/MIDI file to .taud bytes.
 * @param fileName  original name (extension selects the converter)
 * @param bytes     Uint8Array of the file
 * @param opts.sf2  {name, bytes} soundfont (required for .mid/.midi)
 * @param opts.banks  [{name, bytes}] AdLib .BNK banks, most specific first
 *                    (required for .ims — the song only names its patches)
 * @param opts.rpb  MIDI rows-per-beat (2/4/8/16/32/64, or null/"auto")
 * @param opts.trimPatches  MIDI: drop the Ixmp patches the song never triggers
 *                          (item 75; off = keep each preset's full zone map)
 * @param opts.keepDuplicatePatterns  MIDI: give every cue×voice cell its own
 *                          pattern instead of pooling identical ones
 * @param opts.realign  MIDI (item 183): null/"off" trusts the file's tempo;
 *                      "auto" infers the tempo the events are really written
 *                      in, a number IS that tempo in BPM. Rescales the whole
 *                      timeline onto that grid without moving anything in time.
 * @param opts.quantise  MIDI (item 168): null/"off" keeps the performance's own
 *                          timing; "auto" / "row" / a beat subdivision snaps
 *                          note onsets onto that grid
 * @param opts.quantiseStrength  MIDI: 0..100, how far each onset moves
 * @param opts.onStatus  (line) => void progress stream
 */
export function convertToTaud(fileName, bytes,
                              { sf2 = null, banks = null, rpb = null, trimPatches = false,
                                stereoSamples = false, keepDuplicatePatterns = false,
                                realign = null, quantise = null, quantiseStrength = 100,
                                onStatus = null } = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onStatus });
    const buf = bytes.slice().buffer;
    const msg = { t: "convert", id, fileName, bytes: buf, rpb, trimPatches,
                  stereoSamples, keepDuplicatePatterns, realign,
                  quantise, quantiseStrength };
    const transfer = [buf];
    if (sf2) {
      const sfBuf = sf2.bytes.slice().buffer;
      msg.sf2 = { name: sf2.name, bytes: sfBuf };
      transfer.push(sfBuf);
    }
    if (banks?.length) {
      msg.banks = banks.map((b) => {
        const buf = b.bytes.slice().buffer;
        transfer.push(buf);
        return { name: b.name, bytes: buf };
      });
    }
    ensureWorker().postMessage(msg, transfer);
  });
}

function bankRequest(msg, onStatus) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onStatus });
    ensureWorker().postMessage({ ...msg, id }, [msg.bytes]);
  });
}

/** List an .sf2's presets: [{bank, program, name}] (bank 128 = drum kits). */
export async function listSf2Presets(sf2Bytes, { onStatus = null } = {}) {
  const out = await bankRequest({ t: "sf2", mode: "list", bytes: sf2Bytes.slice().buffer }, onStatus);
  return JSON.parse(new TextDecoder().decode(out));
}

/**
 * Build a .tsii instrument bank from selected presets ([[bank, program], …])
 * via the canonical midi2taud machinery. `bpm` should be the destination
 * song's BPM (fadeout steps are tempo-relative).
 */
export function buildSf2Bank(sf2Bytes, selection, { bpm = 125, stereo = false, onStatus = null } = {}) {
  return bankRequest(
    { t: "sf2", mode: "build", bytes: sf2Bytes.slice().buffer, selection, bpm, stereo },
    onStatus,
  );
}

/** List an AdLib .BNK's patches: [{index, name}], bank order. `index` is what
 *  buildBnkBank's selection addresses by (BNK names are not unique). */
export async function listBnkPresets(bnkBytes, { onStatus = null } = {}) {
  const out = await bankRequest({ t: "bnk", mode: "list", bytes: bnkBytes.slice().buffer }, onStatus);
  return JSON.parse(new TextDecoder().decode(out));
}

/**
 * Build a .tsii instrument bank from selected patch indices (from
 * listBnkPresets) via the canonical opl2taud machinery — each patch becomes
 * an ordinary two-operator FM rack. `bpm` should be the destination song's
 * BPM (auto-vibrato speed is tempo-relative).
 */
export function buildBnkBank(bnkBytes, selection, { bpm = 125, onStatus = null } = {}) {
  return bankRequest(
    { t: "bnk", mode: "build", bytes: bnkBytes.slice().buffer, selection, bpm },
    onStatus,
  );
}
