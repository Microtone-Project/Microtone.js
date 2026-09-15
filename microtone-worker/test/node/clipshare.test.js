// Item 158 — copy in one browser tab of Microtone, paste in another. The two
// tabs are separate JS worlds, so the block travels through localStorage; these
// pin the carrier (a fake localStorage stands in for the shared origin storage)
// and the degradation when there is none.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SharedSlot, encodeBlock, decodeBlock, encodeCueBlock, decodeCueBlock,
} from "../../src/ui/clipshare.js";
import { makeBlock, blockCell, makeCueBlock, cueBlockIndex } from "../../src/doc/clipboard.js";

/** The shared origin storage both "tabs" see. */
function installStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  return map;
}
function removeStorage() { delete globalThis.localStorage; }

const cellSlot = () => new SharedSlot("microtone.clipboard", encodeBlock, decodeBlock);
const cueSlot = () => new SharedSlot("microtone.cueClipboard", encodeCueBlock, decodeCueBlock);

/** A 3×2 block with a recognisable byte in every cell. */
function sampleBlock(wide = false) {
  const b = makeBlock(3, 2, wide);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 2; c++) blockCell(b, r, c)[0] = 0x10 + r * 4 + c;
  }
  b.cols = [0, 4];
  return b;
}

test("a block copied in one tab is what the other tab pastes", () => {
  installStorage();
  const tabA = cellSlot(), tabB = cellSlot();
  const src = sampleBlock();
  tabA.set(src);

  const got = tabB.get();
  assert.notEqual(got, null, "the second tab sees a clipboard at all");
  assert.equal(got.rows, 3);
  assert.equal(got.chans, 2);
  assert.equal(got.wide, false);
  assert.deepEqual([...got.cells], [...src.cells], "every cell byte survived the trip");
  assert.deepEqual(got.cols, [0, 4], "…and so did the columns the copy carried");
  removeStorage();
});

test("a wide (format 3) block keeps its 16-byte cells", () => {
  installStorage();
  const tabA = cellSlot(), tabB = cellSlot();
  const src = sampleBlock(true);
  tabA.set(src);
  const got = tabB.get();
  assert.equal(got.wide, true);
  assert.equal(got.cells.length, 3 * 2 * 16);
  assert.deepEqual([...got.cells], [...src.cells]);
  removeStorage();
});

test("the newest copy wins, whichever tab made it", () => {
  installStorage();
  const tabA = cellSlot(), tabB = cellSlot();
  tabA.set(sampleBlock());
  assert.equal(tabB.get().cells[0], 0x10, "premise: B adopted A's block");

  const second = makeBlock(1, 1);
  blockCell(second, 0, 0)[0] = 0x77;
  tabB.set(second);
  assert.equal(tabA.get().cells[0], 0x77, "A now pastes what B copied");
  assert.equal(tabA.get().rows, 1);
  removeStorage();
});

test("re-reading an unchanged slot hands back the SAME object", () => {
  // The context menus ask "can I paste?" every time they open; re-parsing the
  // whole block for each of those would be wasted work.
  installStorage();
  const tab = cellSlot();
  tab.set(sampleBlock());
  assert.equal(tab.get(), tab.get());
  removeStorage();
});

test("cue blocks travel too, pattern words intact", () => {
  installStorage();
  const tabA = cueSlot(), tabB = cueSlot();
  const src = makeCueBlock(2, 3);
  src.words[cueBlockIndex(src, 0, 0)] = 0x0012;
  src.words[cueBlockIndex(src, 1, 2)] = 0x0345;
  tabA.set(src);

  const got = tabB.get();
  assert.equal(got.rows, 2);
  assert.equal(got.chans, 3);
  assert.equal(got.cmd, false, "a pattern block says so, so the other tab pastes it as one");
  assert.ok(got.words instanceof Uint16Array, "still a word array, not a plain list");
  assert.deepEqual([...got.words], [...src.words]);
  removeStorage();
});

test("a COMMAND block keeps its flag, so the other tab pastes it into the Cmd words", () => {
  installStorage();
  const tabA = cueSlot(), tabB = cueSlot();
  const src = makeCueBlock(3, 2, true);
  assert.deepEqual([...src.words], [0, 0, 0, 0, 0, 0], "a blank command word is NOP, not CUE_EMPTY");
  src.words[cueBlockIndex(src, 0, 0)] = 0x021d; // LEN 30
  src.words[cueBlockIndex(src, 2, 1)] = 0xf007; // JMP 7
  tabA.set(src);

  const got = tabB.get();
  assert.equal(got.rows, 3);
  assert.equal(got.chans, 2, "the two Cmd slots, not two voices");
  assert.equal(got.cmd, true, "…and the flag that says which space those columns are in");
  assert.deepEqual([...got.words], [...src.words]);
  removeStorage();
});

test("with no storage at all the clipboard is still this tab's own", () => {
  removeStorage();
  const tab = cellSlot();
  const src = sampleBlock();
  tab.set(src);
  assert.equal(tab.get(), src, "a private window can still copy and paste in place");
});

test("a storage that throws is treated as no storage", () => {
  globalThis.localStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  const tab = cellSlot();
  const src = sampleBlock();
  tab.set(src);
  assert.equal(tab.get(), src);
  removeStorage();
});

test("a copy too big for the quota drops the SHARED entry, not the local one", () => {
  const map = installStorage();
  const tabA = cellSlot(), tabB = cellSlot();
  tabA.set(sampleBlock());
  assert.notEqual(tabB.get(), null, "premise: something is shared");

  globalThis.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  const big = makeBlock(64, 64);
  blockCell(big, 0, 0)[0] = 0x5a;
  tabA.set(big);
  assert.equal(tabA.get().cells[0], 0x5a, "the tab that copied it can still paste it");
  assert.equal(map.has("microtone.clipboard"), false,
    "…and no other tab is left holding an older block that looks current");
  removeStorage();
});

test("garbage in the slot is ignored rather than thrown at the paste", () => {
  installStorage();
  globalThis.localStorage.setItem("microtone.clipboard", "{not json");
  const tab = cellSlot();
  assert.equal(tab.get(), null);
  removeStorage();
});
