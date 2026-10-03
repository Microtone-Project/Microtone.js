// Zstandard compression for saves: the vendored encoder (core/vendor/
// zstd-compress.wasm.js, via core/format/zstd.js), writeTaudWith, and the
// document's toSaveBytes. No Worker exists under Node, so zstdCompressAll runs
// the encoder on this thread — the worker path is test/browser/zstd-smoke.html.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../core/format/taud-parse.js";
import { writeTaud, writeTaudWith } from "../../core/format/taud-write.js";
import { comp, decomp } from "../../core/format/compress.js";
import {
  loadZstd, zstdCompressAll, ZSTD_LEVEL_AUTOSAVE, ZSTD_LEVEL_SAVE, ZSTD_STEP,
} from "../../core/format/zstd.js";
import { SAMPLEINST_SIZE } from "../../core/format/taud-const.js";
import { Document } from "../../src/doc/document.js";
import { withSaveProgress, saveInProgress } from "../../src/ui/saveprogress.js";

const demoDir = fileURLToPath(new URL("../../assets/demo_projects/", import.meta.url));
const temjin = new Uint8Array(await readFile(demoDir + "Temjin_speaki.taud"));
const ambi = new Uint8Array(await readFile(demoDir + "WHEN_AMBI.taud"));

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const isZstd = (b) => ZSTD_MAGIC.every((m, i) => b[i] === m);
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

/** Bytes that compress like a song, not like noise or zeros. */
function songish(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = i % 7 < 5 ? (x >>> 24) & 3 : 0x41 + (i % 13);
  }
  return out;
}

test("the vendored module is the wasm its header names, and imports nothing", async () => {
  const mod = await import("../../core/vendor/zstd-compress.wasm.js");
  const wasm = Buffer.from(mod.WASM_BASE64, "base64");
  assert.equal(createHash("sha256").update(wasm).digest("hex"), mod.WASM_SHA256);
  const compiled = new WebAssembly.Module(wasm);
  assert.deepEqual(WebAssembly.Module.imports(compiled), []);
  const zstd = await loadZstd();
  const v = zstd.x.mt_version();
  assert.equal(`${Math.floor(v / 10000)}.${Math.floor(v / 100) % 100}.${v % 100}`, mod.ZSTD_VERSION);
});

// The sizes a third-party build got wrong (an unterminated frame for any
// multiple of its 128 KiB stream block), the image a .taud always carries
// (66 such blocks), and the edges.
for (const n of [0, 1, 37, 131071, 131072, 131073, 2 * 131072, SAMPLEINST_SIZE]) {
  test(`a ${n}-byte input round-trips at both save levels`, async () => {
    const zstd = await loadZstd();
    const src = songish(n, n + 3);
    for (const level of [ZSTD_LEVEL_AUTOSAVE, ZSTD_LEVEL_SAVE]) {
      const frame = zstd.compress(src, level);
      assert.ok(isZstd(frame), "zstd magic");
      assert.ok(same(decomp(frame, n), src), `level ${level}, with the expected size`);
      assert.ok(same(decomp(frame), src), `level ${level}, from the frame alone`);
    }
  });
}

// The streamed frame a save that shows its progress writes: every step a
// whole ZSTD_STEP but the last, an exact multiple of steps, a single step.
for (const n of [0, 37, ZSTD_STEP - 1, ZSTD_STEP, ZSTD_STEP + 1, 3 * ZSTD_STEP, SAMPLEINST_SIZE]) {
  test(`a ${n}-byte input round-trips streamed, and reports every byte once`, async () => {
    const zstd = await loadZstd();
    const src = songish(n, n + 11);
    const steps = [];
    const frame = zstd.compress(src, ZSTD_LEVEL_SAVE, (k) => steps.push(k));
    assert.ok(isZstd(frame), "zstd magic");
    assert.ok(same(decomp(frame, n), src), "with the expected size");
    assert.ok(same(decomp(frame), src), "from the frame alone");
    assert.equal(steps.reduce((a, k) => a + k, 0), n, "the steps add up to the input");
    assert.equal(steps.length, Math.ceil(n / ZSTD_STEP), "one report per step");
    assert.ok(steps.every((k, i) => k === ZSTD_STEP || i === steps.length - 1), "only the last step is short");
    const fhd = frame[4];
    assert.ok(fhd >> 6 !== 0 || (fhd >> 5) & 1, "content size in the header");
  });
}

test("a streamed frame is the same bytes every time, and within half a percent of one-shot", async () => {
  const zstd = await loadZstd();
  const image = parseTaud(temjin).sampleInstImage;
  const step = () => {};
  const a = zstd.compress(image, ZSTD_LEVEL_SAVE, step);
  zstd.compress(songish(5000), ZSTD_LEVEL_AUTOSAVE); // a one-shot in between changes nothing
  assert.ok(same(a, zstd.compress(image, ZSTD_LEVEL_SAVE, step)));
  const oneShot = zstd.compress(image, ZSTD_LEVEL_SAVE);
  // Measured at level 19: −0.03 % (WHEN) to +0.09 % (this one).
  assert.ok(Math.abs(a.length - oneShot.length) <= oneShot.length / 200,
    `streamed ${a.length}, one-shot ${oneShot.length}`);
});

test("zstdCompressAll's progress runs over all the parts together, up to the total", async () => {
  const parts = [songish(3 * ZSTD_STEP + 5), songish(100), new Uint8Array(0), songish(ZSTD_STEP)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const seen = [];
  const out = await zstdCompressAll(parts, ZSTD_LEVEL_SAVE, (done, all) => seen.push([done, all]));
  assert.equal(out.length, parts.length);
  out.forEach((frame, i) => assert.ok(same(decomp(frame, parts[i].length), parts[i]), `part ${i}`));
  assert.ok(seen.every(([, all]) => all === total), "the same total throughout");
  assert.ok(seen.every(([d], i) => i === 0 || d >= seen[i - 1][0]), "never backwards");
  assert.equal(seen.at(-1)[0], total, "ends at the total");
  // …and without a callback, nothing streams: the one-shot frames
  const zstd = await loadZstd();
  const plain = await zstdCompressAll(parts, ZSTD_LEVEL_SAVE);
  plain.forEach((frame, i) => assert.ok(same(frame, zstd.compress(parts[i], ZSTD_LEVEL_SAVE)), `part ${i}`));
});

test("the same input and level give the same bytes", async () => {
  const zstd = await loadZstd();
  const src = songish(300000);
  assert.ok(same(zstd.compress(src, ZSTD_LEVEL_SAVE), zstd.compress(src, ZSTD_LEVEL_SAVE)));
  // …and the encoder holds no state between calls that changes a frame
  zstd.compress(songish(5000, 9), ZSTD_LEVEL_AUTOSAVE);
  assert.ok(same(zstd.compress(src, ZSTD_LEVEL_SAVE), zstd.compress(src, ZSTD_LEVEL_SAVE)));
});

test("the frame header records the content size (a frame with no checksum)", async () => {
  const zstd = await loadZstd();
  for (const n of [37, 300000]) {
    const fhd = zstd.compress(songish(n), ZSTD_LEVEL_SAVE)[4];
    const fcsFlag = fhd >> 6, singleSegment = (fhd >> 5) & 1;
    assert.ok(fcsFlag !== 0 || singleSegment, `n=${n}: content size present`);
    assert.equal((fhd >> 2) & 1, 0, `n=${n}: no checksum`);
  }
});

test("level 19 is smaller than level 9, which is smaller than gzip", async () => {
  const doc = parseTaud(temjin);
  const zstd = await loadZstd();
  const gz = comp(doc.sampleInstImage).length;
  const z9 = zstd.compress(doc.sampleInstImage, ZSTD_LEVEL_AUTOSAVE).length;
  const z19 = zstd.compress(doc.sampleInstImage, ZSTD_LEVEL_SAVE).length;
  assert.ok(z19 < z9 && z9 < gz, `gzip ${gz}, zstd-9 ${z9}, zstd-19 ${z19}`);
});

// writeTaudWith is writeTaud with a different compressor: given gzip it must
// write the very same file, for every container kind.
for (const kind of ["taud", "tsii", "tpif"]) {
  test(`writeTaudWith(gzip) writes exactly what writeTaud writes — .${kind}`, async () => {
    for (const bytes of [temjin, ambi]) {
      const parsed = { ...parseTaud(bytes), kind };
      const viaAsync = await writeTaudWith(parsed, async (raw) => raw.map((b) => comp(b)));
      assert.ok(same(viaAsync, writeTaud(parsed)));
    }
  });
}

test("a zstd save parses back to the same document as a gzip one", async () => {
  for (const bytes of [temjin, ambi]) {
    const parsed = parseTaud(bytes);
    const packed = await writeTaudWith(parsed, (raw) => zstdCompressAll(raw, ZSTD_LEVEL_SAVE));
    const gz = writeTaud(parsed);
    assert.ok(packed.length < gz.length, `zstd ${packed.length} < gzip ${gz.length}`);
    // Re-written with gzip, both must be the same file byte for byte.
    assert.ok(same(writeTaud(parseTaud(packed)), gz));
  }
});

test("writeTaudWith refuses a compressor that loses a section", async () => {
  await assert.rejects(
    writeTaudWith(parseTaud(temjin), async (raw) => raw.slice(1).map((b) => comp(b))),
    /sections went to compress/);
});

test("Document.toSaveBytes writes zstd sections, and the same document", async () => {
  const doc = new Document(parseTaud(temjin));
  const saved = await doc.toSaveBytes(ZSTD_LEVEL_SAVE);
  const reparsed = parseTaud(saved);
  assert.ok(same(new Document(reparsed).toBytes(), doc.toBytes()));
  // the image sits right after the 32-byte header
  assert.ok(isZstd(saved.subarray(32)), "image section is a zstd frame");
});

test("toSaveBytes is the document when the save began, not when it finished", async () => {
  const doc = new Document(parseTaud(temjin));
  const before = doc.toBytes();
  const pending = doc.toSaveBytes(ZSTD_LEVEL_AUTOSAVE);
  // An edit lands while the sections compress: a sample byte, a cue word.
  doc.sampleInstImage[1000] ^= 0xff;
  doc.songs[0].cues[0][0] ^= 1;
  doc.dirty = true;
  const saved = await pending;
  assert.ok(same(new Document(parseTaud(saved)).toBytes(), before));
});

test("toSaveBytes reports its progress to the end, and still saves the same document", async () => {
  const doc = new Document(parseTaud(temjin));
  const seen = [];
  const saved = await doc.toSaveBytes(ZSTD_LEVEL_SAVE, (done, total) => seen.push(done / total));
  assert.ok(seen.length > 30, `${seen.length} reports for a full sample image`);
  assert.equal(seen.at(-1), 1);
  assert.ok(same(new Document(parseTaud(saved)).toBytes(), doc.toBytes()));
});

test("withSaveProgress: up while the save runs, and returns what it returns", async () => {
  const emitted = [];
  const store = { emit: (what) => emitted.push(what) };
  let during = null;
  const result = await withSaveProgress(store, async (progress) => {
    during = saveInProgress();
    progress(1, 2);
    progress(2, 2);
    return "bytes";
  });
  assert.equal(result, "bytes");
  assert.equal(during, true);
  assert.equal(saveInProgress(), false);
  assert.deepEqual(emitted, ["status", "status"], "the status bar hears of the start and the end");
  // …and a save that throws still takes the bar down
  await assert.rejects(withSaveProgress(store, async () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(saveInProgress(), false);
});

test("every `dirty = true` counts in editSerial; clearing it does not", () => {
  const doc = new Document(parseTaud(temjin));
  assert.equal(doc.dirty, false);
  const s0 = doc.editSerial;
  doc.dirty = true;
  doc.dirty = true;
  assert.equal(doc.editSerial, s0 + 2);
  doc.dirty = false;
  assert.equal(doc.editSerial, s0 + 2);
  assert.equal(doc.dirty, false);
});
