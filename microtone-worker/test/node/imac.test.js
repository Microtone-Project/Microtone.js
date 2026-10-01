// IMAC — The IMS Archive's container (src/convert/imac.js). Microtone imports
// the songs inside it rather than the container, so what matters is that the
// right song comes out, under a name whose extension picks the right
// converter, with the bank that travelled beside it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isImac, readImac, imacSongs } from "../../src/convert/imac.js";
import { converterFor } from "../../src/convert/convert-core.js";

const enc = new TextEncoder();

/** One RIFF chunk, padded to even length; the size never counts the pad. */
function chunk(id, body) {
  const out = new Uint8Array(8 + body.length + (body.length & 1));
  out.set(enc.encode(id), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}
const cat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** An IMAC of `variants`, each `{files: {chunkId: bytes}, meta}`. */
function makeImac(variants) {
  const body = [enc.encode("IMAC"), chunk("modT", new Uint8Array(8)), chunk("creT", new Uint8Array(8))];
  variants.forEach((v, i) => body.push(chunk(`V${String(i).padStart(3, "0")}`, cat([
    ...Object.entries(v.files).map(([id, bytes]) => chunk(id, bytes)),
    chunk("META", enc.encode(JSON.stringify(v.meta))),
  ]))));
  return chunk("RIFF", cat(body));
}

const files = (names) => ({
  bnk_filename: null, ims_filename: null, sop_filename: null, rol_filename: null, ...names,
});
const bytes = (n, fill) => new Uint8Array(n).fill(fill);

const IMAC = makeImac([
  { files: { "IMS ": bytes(5, 1), "ISS ": bytes(4, 2), "BNK ": bytes(3, 3) },
    meta: { files: files({ ims_filename: "SHC.IMS", bnk_filename: "SHC.BNK" }),
            metadata: { songname: "그대에게" } } },
  // The archive filed this song by what its bytes are, and its name lies.
  { files: { "SOP ": bytes(7, 4) },
    meta: { files: files({ sop_filename: "SHC2.IMS" }), metadata: { songname: "그대에게" } } },
  // Nothing Microtone can convert.
  { files: { "ROL ": bytes(6, 5), "BNK ": bytes(3, 6) },
    meta: { files: files({ rol_filename: "SHC.ROL" }), metadata: { songname: "그대에게" } } },
  // One arrangement kept as both: an .ims and the .sop made from it.
  { files: { "IMS ": bytes(2, 7), "SOP ": bytes(2, 8) },
    meta: { files: files({ ims_filename: "S3.IMS", sop_filename: "S3.SOP" }), metadata: { songname: "그대에게" } } },
]);

test("an IMAC is recognised by its bytes, not its name", () => {
  assert.ok(isImac(IMAC));
  assert.ok(!isImac(enc.encode("RIFF\0\0\0\0WAVEfmt ")));
  assert.ok(!isImac(new Uint8Array(4)));
});

test("every variant is read, odd-length chunks and all", () => {
  const v = readImac(IMAC);
  assert.deepEqual(v.map((x) => x.index), [0, 1, 2, 3]);
  // The odd-length ones are padded on disk, and the pad is not part of them.
  assert.deepEqual([...v[1].files["SOP "]], [4, 4, 4, 4, 4, 4, 4]);
  assert.deepEqual([...v[0].files["BNK "]], [3, 3, 3]);
  assert.equal(v[0].meta.metadata.songname, "그대에게");
});

test("the importable songs come out with their own banks and honest extensions", () => {
  const songs = imacSongs(IMAC, "SHC-c6b63369.imac");
  assert.deepEqual(songs.map((s) => [s.variant, s.name]),
    [[0, "SHC.ims"], [1, "SHC2.sop"], [3, "S3.ims"], [3, "S3.sop"]]);
  // The .ims takes the bank of its own variant…
  assert.equal(songs[0].bank.name, "SHC.BNK");
  assert.deepEqual([...songs[0].bank.bytes], [3, 3, 3]);
  // …and a song with none of its own is left to fall back as a lone .ims does.
  assert.equal(songs[2].bank, null);
  assert.equal(songs[1].bank, null, "a .sop carries its own instruments");
  // The extension is what picks the converter, so it is the chunk's kind, not
  // the name the file happened to have.
  for (const s of songs) assert.ok(converterFor(s.name), `${s.name} has a converter`);
  assert.equal(converterFor(songs[1].name).script, "sop2taud.py");
  assert.equal(songs[0].title, "그대에게");
});

test("a song META leaves unnamed is named after the IMAC", () => {
  const imac = makeImac([{ files: { "SOP ": bytes(2, 1) }, meta: null }]);
  assert.deepEqual(imacSongs(imac, "dir/ABC-1234.imac").map((s) => s.name), ["ABC-1234.sop"]);
});

test("an IMAC with nothing importable offers nothing", () => {
  const imac = makeImac([{ files: { "KIS ": bytes(4, 1) }, meta: { files: files({}) } }]);
  assert.deepEqual(imacSongs(imac), []);
});

test("a chunk that runs past its parent is an error, not a guess", () => {
  const bad = Uint8Array.from(IMAC);
  // RIFF head 12, modT 16, creT 16: V000's size field is at 44 + 4.
  new DataView(bad.buffer).setUint32(48, 0xffff, true);
  assert.throws(() => readImac(bad), /runs past/);
});
