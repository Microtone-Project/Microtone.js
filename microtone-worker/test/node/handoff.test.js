// Cross-page song handoff (item 171) — the URL fragment behind the IyagiMusic
// player's "remix this in Microtone" button.
//
// The fragment carries both halves of an AdLib song, because one without the
// other makes no sound. It is a fragment rather than a postMessage handshake
// because the app is served with COOP `same-origin`, which severs a
// cross-origin opener before it can say anything; see handoff.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  encodeHandoff, decodeHandoff, handoffArmed, HANDOFF_PREFIX,
} from "../../src/ui/handoff.js";
import { IMS_SONG, IMS_BANK } from "../fixtures/ims.js";
import { SOP_SONG } from "../fixtures/sop.js";

test("a song and its bank survive the round trip", () => {
  const hash = encodeHandoff({
    name: "검은 고양이.ims", song: IMS_SONG, bankName: "SONG.BNK", bank: IMS_BANK,
  });
  assert.ok(hash.startsWith(HANDOFF_PREFIX));
  assert.ok(/^[#a-zA-Z0-9\-_=]+$/.test(hash), "fragment must need no escaping");
  const got = decodeHandoff(hash);
  assert.equal(got.name, "검은 고양이.ims");
  assert.deepEqual([...got.bytes], [...IMS_SONG]);
  assert.equal(got.bank.name, "SONG.BNK");
  assert.deepEqual([...got.bank.bytes], [...IMS_BANK]);
});

test("a song with no bank of its own carries none", () => {
  const got = decodeHandoff(encodeHandoff({ name: "bare.ims", song: IMS_SONG }));
  assert.equal(got.bank, null);
  assert.deepEqual([...got.bytes], [...IMS_SONG]);
});

test("a .sop needs no bank and the extension is what routes it", () => {
  // A .sop stores its own instruments, so an empty bank field is the normal
  // case for it rather than a song arriving half-dressed. The name is the only
  // thing that says which converter to use, and the sender sets its extension
  // from what the BYTES turned out to be — so a .sop saved as SOMETHING.IMS
  // still arrives as a .sop.
  const got = decodeHandoff(encodeHandoff({ name: "SV6-CHAN.sop", song: SOP_SONG }));
  assert.equal(got.bank, null);
  assert.equal(got.name, "SV6-CHAN.sop");
  assert.deepEqual([...got.bytes], [...SOP_SONG]);
});

test("the fragment is small enough to be a URL", () => {
  // The whole point of gzipping: the reference corpus's worst case is 52 kB
  // encoded, and a browser's URL limit is orders of magnitude above that.
  const hash = encodeHandoff({ name: "x.ims", song: IMS_SONG, bank: IMS_BANK });
  assert.ok(hash.length < IMS_SONG.length + IMS_BANK.length,
    `gzip should pay for base64's 4/3 (${hash.length} vs ${IMS_SONG.length + IMS_BANK.length})`);
});

test("only an #import= hash is a handoff", () => {
  const win = (hash) => ({ location: { hash } });
  assert.ok(handoffArmed(win(HANDOFF_PREFIX + "AAA")));
  assert.ok(!handoffArmed(win("")));
  assert.ok(!handoffArmed(win("#instruments")));
  assert.equal(decodeHandoff("#instruments"), null);
  assert.equal(decodeHandoff(""), null);
});

test("a fragment that is not a handoff is refused, not guessed at", () => {
  // A truncated URL is worth an error rather than a half-read song.
  assert.throws(() => decodeHandoff(HANDOFF_PREFIX + "bm90aGluZw"), /not a Microtone handoff/);
  const good = encodeHandoff({ name: "x.ims", song: IMS_SONG });
  assert.throws(() => decodeHandoff(good.slice(0, good.length - 200)));
});
