// The soundfont library — soundfonts someone has added in the File view's
// Soundfonts tab, converted for the tracker and kept in this browser (OPFS
// soundfonts/, beside the projects). Instruments → New… offers them beside the
// bundled GeneralUser GS.
//
// Adding an .sf2 converts it IN THE BACKGROUND: sf2taudify.py under Pyodide, in
// a worker of its own (convert.js taudifySoundfont), one soundfont at a time.
// Nothing waits on it; the tab shows how far it has got, and a banner says when
// it is done or why it failed. What is kept is sf2taudify's .taud.sf2.gz as it
// came out — a file someone can download, and add again in another browser:
// a soundfont that sf2taudify already made (its INFO comment says so) is
// stored as it is, which is also how one too large to convert in a browser
// gets in, made by sf2taudify.py on a computer.
//
// Every File view copy (one per pane) and the Instruments view read the same
// state through this module; `onLibraryChange` tells them when to redraw, and
// `onJobProgress` when only a progress bar moved.

import * as opfs from "../storage/opfs.js";
import { downloadBlob } from "../storage/import-export.js";
import { taudifySoundfont } from "../convert/convert.js";
import { gunzipSync, gzipSync } from "../../core/vendor/fflate.esm.js";
import { showBanner } from "./components/banner.js";
import { t } from "./i18n.js";

const EXT = ".taud.sf2.gz";

const listeners = new Set();
const progressListeners = new Set();
let jobs = [];          // [{ id, file, title, state: "queued"|"converting", progress, abort }]
let nextJob = 1;
let queue = Promise.resolve();
let showLibrary = null; // set by the app: open the File view on this tab

function changed() { for (const fn of listeners) fn(); }

/** Call `fn` whenever the library or its queue changes. Returns an unsubscribe. */
export function onLibraryChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Call `fn(job)` when only a running job's progress moved. */
export function onJobProgress(fn) { progressListeners.add(fn); return () => progressListeners.delete(fn); }

/** The app's way to the Soundfonts tab, for a banner's Show button. */
export function setShowLibrary(fn) { showLibrary = fn; }

/** The name a soundfont is shown under: its file name without the extensions. */
export function soundfontTitle(name) {
  return name.replace(/(\.taud)?\.sf2(\.gz)?$/i, "");
}

/** The stored soundfonts, by name: [{ file, title, size, mtime, note, source }]. */
export async function librarySoundfonts() {
  if (!(await opfs.available())) return [];
  const [files, index] = await Promise.all([opfs.listSoundfonts(), opfs.readSoundfontIndex()]);
  return files.filter((f) => f.name.endsWith(EXT)).map((f) => ({
    file: f.name, title: soundfontTitle(f.name), size: f.size, mtime: f.mtime,
    note: String(index[f.name]?.note ?? ""), source: index[f.name]?.source ?? null,
  }));
}

/** The conversions waiting or running, oldest first. */
export function libraryJobs() { return jobs.slice(); }

/** Leave a note on a stored soundfont (an empty one removes it). */
export async function setSoundfontNote(file, note) {
  const index = await opfs.readSoundfontIndex();
  const entry = { ...(index[file] ?? {}) };
  const text = note.trim();
  if (text) entry.note = text; else delete entry.note;
  if (Object.keys(entry).length) index[file] = entry; else delete index[file];
  await opfs.writeSoundfontIndex(index);
  changed();
}

export async function removeSoundfont(file) {
  await opfs.removeSoundfont(file);
  const index = await opfs.readSoundfontIndex();
  if (file in index) { delete index[file]; await opfs.writeSoundfontIndex(index); }
  changed();
}

/** Save the stored .taud.sf2.gz as it is. */
export async function downloadSoundfont(file) {
  downloadBlob(await opfs.soundfontFile(file), file);
}

/** A stored soundfont, unzipped, as the bank build takes it: { name, bytes }. */
export async function loadSoundfont(file) {
  const blob = await opfs.soundfontFile(file);
  return { name: file.replace(/\.gz$/, ""), bytes: await gunzipBlob(blob) };
}

/** Cancel a waiting or running conversion. */
export function cancelJob(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  job.abort.abort();
  jobs = jobs.filter((j) => j !== job);
  changed();
}

/**
 * Add picked files to the library: a soundfont sf2taudify already made is
 * stored as it is, anything else converted in the background. `confirmReplace`
 * (title) → Promise<boolean> is asked when the name is taken. Resolves once
 * every file is stored or queued, not when the conversions end, with how many
 * were (a declined replace or an unreadable file is not counted).
 */
export async function addSoundfontFiles(files, { confirmReplace }) {
  const stored = new Set((await librarySoundfonts()).map((s) => s.file));
  let taken = 0;
  for (const f of files) {
    const title = soundfontTitle(f.name);
    const file = title + EXT;
    if ((stored.has(file) || jobs.some((j) => j.file === file)) && !(await confirmReplace(title))) continue;
    jobs.filter((j) => j.file === file).forEach((j) => cancelJob(j.id));
    let bytes;
    try {
      bytes = /\.gz$/i.test(f.name) ? await gunzipBlob(f) : new Uint8Array(await f.arrayBuffer());
      if (!isSf2(bytes)) throw new Error(t("sf.notSf2"));
    } catch (err) {
      failed(title, err);
      continue;
    }
    if (taudified(bytes)) {
      await store(file, await gzip(bytes), f.name);
      stored.add(file);
    } else {
      enqueue(file, title, f.name, bytes);
    }
    taken++;
  }
  return taken;
}

function enqueue(file, title, source, bytes) {
  const job = { id: nextJob++, file, title, state: "queued", progress: 0, abort: new AbortController() };
  jobs.push(job);
  changed();
  queue = queue.then(async () => {
    if (job.abort.signal.aborted) return;
    job.state = "converting";
    changed();
    const t0 = performance.now();
    try {
      const gz = await taudifySoundfont(bytes, {
        signal: job.abort.signal,
        onProgress: (value) => {
          job.progress = value;
          for (const fn of progressListeners) fn(job);
        },
      });
      bytes = null;
      await store(file, gz, source);
      jobs = jobs.filter((j) => j !== job);
      changed();
      console.info(`soundfont ${title}: converted in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      showBanner({
        text: t("sf.ready", { name: title }),
        actions: [
          ...(showLibrary ? [{ label: t("sf.show"), onClick: () => showLibrary(), primary: true }] : []),
          { label: t("sf.dismiss") },
        ],
      });
    } catch (err) {
      bytes = null;
      jobs = jobs.filter((j) => j !== job);
      changed();
      if (err?.name !== "AbortError") failed(title, err);
    }
  });
}

async function store(file, gz, source) {
  await opfs.writeSoundfont(file, gz);
  const index = await opfs.readSoundfontIndex();
  index[file] = { ...(index[file] ?? {}), source };
  await opfs.writeSoundfontIndex(index);
  changed();
}

/** A banner saying why `title` did not make it in. Running out of memory —
 *  a soundfont of a gigabyte or so does, in a browser's wasm — says what to
 *  do instead. */
function failed(title, err) {
  const msg = String(err?.message ?? err);
  console.error(`soundfont ${title}:`, err);
  const tooBig = /MemoryError|out of memory|Out of memory|RangeError|Array buffer allocation|memory access out of bounds/i.test(msg);
  showBanner({
    text: tooBig ? t("sf.tooBig", { name: title }) : t("sf.failed", { name: title, err: msg }),
    actions: [{ label: t("sf.dismiss") }],
  });
}

// Leaving while a soundfont converts loses it: ask first.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (jobs.length === 0) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

// ── bytes ──

function isSf2(b) {
  return b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x73 && b[9] === 0x66 && b[10] === 0x62 && b[11] === 0x6b;                        // sfbk
}

/** True when the soundfont's INFO comment carries sf2taudify's note. */
export function taudified(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 12;
  while (pos + 12 <= b.length) {
    const size = dv.getUint32(pos + 4, true);
    if (fourcc(b, pos) === "LIST" && fourcc(b, pos + 8) === "INFO") {
      const end = Math.min(b.length, pos + 8 + size);
      for (let p = pos + 12; p + 8 <= end;) {
        const n = dv.getUint32(p + 4, true);
        if (fourcc(b, p) === "ICMT") {
          return new TextDecoder("latin1").decode(b.subarray(p + 8, Math.min(end, p + 8 + n))).includes("sf2taudify:");
        }
        p += 8 + n + (n & 1);
      }
      return false;
    }
    pos += 8 + size + (size & 1);
  }
  return false;
}

const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** Unzip a Blob off the main thread where the browser can (DecompressionStream). */
async function gunzipBlob(blob) {
  if (typeof DecompressionStream === "function") {
    const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return gunzipSync(new Uint8Array(await blob.arrayBuffer()));
}

async function gzip(bytes) {
  if (typeof CompressionStream === "function") {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return gzipSync(bytes);
}
