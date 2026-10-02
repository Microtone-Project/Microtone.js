import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("vendored fflate gzip round-trip", async () => {
  const ff = await import("../../core/vendor/fflate.esm.js");
  const data = new TextEncoder().encode("microtone".repeat(1000));
  const back = ff.gunzipSync(ff.gzipSync(data));
  assert.deepEqual(back, data);
});

test("vendored fzstd exposes decompress", async () => {
  const fz = await import("../../core/vendor/fzstd.esm.js");
  assert.equal(typeof fz.decompress, "function");
});

test("engine constants import and are sane", async () => {
  const c = await import("../../core/engine/constants.js");
  assert.equal(c.SAMPLING_RATE, 48000); // 32000→48000, the browser's own rate (item 108)
  assert.equal(c.TRACKER_CHUNK, 128); // 512→128 for the AudioWorklet callback budget (bit-exact; see constants.js)
  assert.equal(c.MAX_VOICES, 64);
  assert.equal(c.SAMPLE_BIN_TOTAL, 8 * 1024 * 1024);
  assert.equal(c.PATTERN_EMPTY, 0x7fff);
});

test("corpus files present with Taud magic", async () => {
  const magic = Uint8Array.from([0x1f, 0x54, 0x53, 0x56, 0x4d, 0x61, 0x75, 0x64]); // \x1FTSVMaud
  const dir = fileURLToPath(new URL("../corpus/", import.meta.url));
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".taud"));
  assert.ok(files.length >= 5, `expected >= 5 corpus files, got ${files.length}`);
  for (const f of files) {
    const head = (await readFile(dir + f)).subarray(0, 8);
    assert.deepEqual(Uint8Array.from(head), magic, `${f} lacks Taud magic`);
  }
});
