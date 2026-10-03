// Zstandard COMPRESSION, for saves. Decompression is not here: fzstd does it in
// compress.js — synchronous, small, and on every load path, the player
// library's included. This is upstream zstd's own encoder compiled to
// WebAssembly (core/vendor/zstd-compress.wasm.js, built by
// tools/make-zstd-wasm.js), so a frame from here is byte for byte what
// `zstd -<level>` or Python's zstandard writes for the same input.
//
// An app reaches it through zstdCompressAll, which does the work in a module
// worker: level 19 takes about a second on a large song, and neither save may
// stall the page while it runs. A manual save also reports its progress
// (compressParts), which the status bar shows in place of the unsaved dot. The worker starts on the first save and stops
// once saves stop coming, which is also what gives back its memory — a
// WebAssembly memory never shrinks, and level 19 on a full sample image takes
// it to about 100 MB. Where there is no Worker (Node, the tests) the same encoder
// runs in the calling thread.

/** Autosave: as fast as the gzip it replaces, about a tenth smaller. */
export const ZSTD_LEVEL_AUTOSAVE = 9;
/** Save, Save As, export, upload: slower, about a sixth smaller than gzip. */
export const ZSTD_LEVEL_SAVE = 19;

// ── the encoder, in the thread that loads it ──

let loading = null;

/** The encoder: { compress(bytes, level) → Uint8Array, one complete frame }. */
export function loadZstd() {
  loading ??= instantiate().catch((err) => {
    loading = null; // a failed fetch of the module may succeed next time
    throw err;
  });
  return loading;
}

async function instantiate() {
  const { WASM_BASE64 } = await import("../vendor/zstd-compress.wasm.js");
  const bin = atob(WASM_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  instance.exports._initialize();
  return new ZstdEncoder(instance.exports);
}

/** Bytes per step of a streamed frame: about 30 progress updates for a full
 *  sample image, each a few tens of milliseconds of level-19 work. */
export const ZSTD_STEP = 256 * 1024;

class ZstdEncoder {
  constructor(exports) {
    this.x = exports;
  }

  /**
   * `bytes` as one zstd frame at `level`: content size in the header, no
   * checksum, and the same bytes every time for the same input and level.
   *
   * With `onStep`, the frame is streamed instead, ZSTD_STEP bytes at a time,
   * and `onStep(n)` hears of each step's `n` bytes as it finishes — the only
   * way a save can show how far it has got. A streamed frame is not byte for
   * byte the one-shot frame (its blocks end where its steps do; at level 19,
   * under a tenth of a percent either way), but it is just as fixed by input
   * and level.
   */
  compress(bytes, level, onStep = null) {
    return onStep ? this._streamed(bytes, level, onStep) : this._oneShot(bytes, level);
  }

  _oneShot(bytes, level) {
    const x = this.x;
    // Pointers come back as signed i32; above 2 GiB they would read negative.
    const src = x.mt_alloc(bytes.length) >>> 0;
    const cap = x.mt_bound(bytes.length) >>> 0;
    const dst = src ? x.mt_alloc(cap) >>> 0 : 0;
    try {
      if (!src || !dst) throw new Error("zstd: out of memory");
      // Re-read memory.buffer after every allocation: growing detaches the old one.
      new Uint8Array(x.memory.buffer, src, bytes.length).set(bytes);
      const size = this._check(x.mt_compress(dst, cap, src, bytes.length, level));
      return new Uint8Array(x.memory.buffer, dst, size).slice();
    } finally {
      x.mt_free(src);
      x.mt_free(dst);
    }
  }

  _streamed(bytes, level, onStep) {
    const x = this.x;
    const cap = x.mt_bound(bytes.length) >>> 0;
    const dst = x.mt_alloc(cap) >>> 0;
    const step = dst ? x.mt_alloc(ZSTD_STEP) >>> 0 : 0;
    try {
      if (!dst || !step) throw new Error("zstd: out of memory");
      this._check(x.mt_stream_begin(dst, cap, bytes.length, level));
      for (let off = 0; off < bytes.length;) {
        const n = Math.min(ZSTD_STEP, bytes.length - off);
        new Uint8Array(x.memory.buffer, step, n).set(bytes.subarray(off, off + n));
        off += n;
        this._check(x.mt_stream_feed(step, n, 0));
        onStep(n);
      }
      // Every step goes in as "more to come" and an empty one ends the frame —
      // the pattern a native stream (Python's compressobj) uses, and so the
      // bytes it writes: ending ON the last step lays the final block out
      // differently.
      const size = this._check(x.mt_stream_feed(step, 0, 1));
      return new Uint8Array(x.memory.buffer, dst, size).slice();
    } finally {
      x.mt_free(dst);
      x.mt_free(step);
    }
  }

  _check(result) {
    const r = result >>> 0;
    if (this.x.mt_is_error(r)) throw new Error(`zstd: compression failed (error ${2 ** 32 - r})`);
    return r;
  }
}

// ── off the main thread ──

const WORKER_URL = new URL("./zstd.worker.js", import.meta.url);
const IDLE_MS = 20000; // no save for this long → the worker and its memory go

let worker = null;
let idleTimer = null;
let seq = 0;
const pending = new Map(); // id → { resolve, reject }

/**
 * Each of `parts` compressed at `level`, in the same order. In a worker where
 * the platform has one, falling back to this thread if the worker cannot start
 * or fails; rejects only if the encoder cannot run at all.
 *
 * With `onProgress`, the frames are streamed (ZstdEncoder.compress) and
 * `onProgress(done, total)` follows along in bytes of input, all parts
 * together. Either way the bytes do not depend on which thread made them.
 *
 * The worker gets a COPY of `parts` when this is called, but the fallback reads
 * them later — so a caller hands arrays nothing else will write to (writeTaudWith
 * does).
 */
export async function zstdCompressAll(parts, level, onProgress = null) {
  if (typeof Worker === "function") {
    try {
      return await viaWorker(parts, level, onProgress);
    } catch (err) {
      console.warn(`zstd: the worker failed (${err.message}); compressing on this thread`);
    }
  }
  const zstd = await loadZstd();
  return compressParts(zstd, parts, level, onProgress);
}

/** The loop both threads run. */
export function compressParts(zstd, parts, level, onProgress = null) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  let done = 0;
  const onStep = onProgress && ((n) => { done += n; onProgress(done, total); });
  return parts.map((p) => zstd.compress(p, level, onStep));
}

function viaWorker(parts, level, onProgress) {
  return new Promise((resolve, reject) => {
    if (worker === null) {
      worker = new Worker(WORKER_URL, { type: "module" });
      worker.onmessage = (e) => {
        const { id, out, error, done, total } = e.data;
        const job = pending.get(id);
        if (!job) return;
        if (out === undefined && error === undefined) {
          job.onProgress?.(done, total);
          return;
        }
        pending.delete(id);
        if (error) job.reject(new Error(error));
        else job.resolve(out);
        if (pending.size === 0) idleTimer = setTimeout(stopWorker, IDLE_MS);
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        stopWorker(new Error(e.message || "the worker did not start"));
      };
    }
    clearTimeout(idleTimer);
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, parts, level, progress: !!onProgress });
  });
}

function stopWorker(err = new Error("the worker stopped")) {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
  for (const job of pending.values()) job.reject(err);
  pending.clear();
}
