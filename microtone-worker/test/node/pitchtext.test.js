// The spellings a pitch field takes (spinner.js parsePitchText): a plain
// number in the field's own unit, hex as 4096-TET units, cents, and ratios —
// every non-plain spelling landing on a whole 4096-TET unit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePitchText } from "../../src/ui/components/spinner.js";

test("a plain number is taken in the field's own unit, as it stands", () => {
  assert.equal(parsePitchText("256"), 256);
  assert.equal(parsePitchText("-12.5"), -12.5);
  assert.equal(parsePitchText(" +7 "), 7);
  assert.equal(parsePitchText("700", "cents"), 700);
  assert.equal(parsePitchText("12.25", "cents"), 12.25);
});

test("$ and 0x are hexadecimal 4096-TET units", () => {
  assert.equal(parsePitchText("$100"), 256);
  assert.equal(parsePitchText("0x1000"), 4096);
  assert.equal(parsePitchText("-$10"), -16);
  assert.equal(parsePitchText("$1000", "cents"), 1200);
  assert.equal(parsePitchText("0x555", "cents"), (0x555 * 1200) / 4096);
});

test("a trailing c (or ¢) is cents, rounded to a 4096-TET unit", () => {
  assert.equal(parsePitchText("700c"), 2389);       // 2389.33
  assert.equal(parsePitchText("1200C"), 4096);
  assert.equal(parsePitchText("-100c"), -341);      // -341.33
  assert.equal(parsePitchText("701.9 ¢"), 2396);
  assert.equal(parsePitchText("−15.0 ¢", "cents"), (-51 * 1200) / 4096);
  assert.equal(parsePitchText("100c", "cents"), (341 * 1200) / 4096);
});

test("n/d is a frequency ratio, rounded to the nearest 4096-TET unit", () => {
  assert.equal(parsePitchText("3/2"), Math.round(4096 * Math.log2(1.5)));
  assert.equal(parsePitchText("3/2"), 2396);
  assert.equal(parsePitchText("3:2"), 2396);
  assert.equal(parsePitchText("2/1"), 4096);
  assert.equal(parsePitchText("1/2"), -4096);
  assert.equal(parsePitchText("-5/4"), -1319);      // a sign turns it downward
  assert.equal(parsePitchText("81/80"), 73);        // the syntonic comma
  assert.equal(parsePitchText("3/1", "cents"), (6492 * 1200) / 4096);
  assert.equal(Object.is(parsePitchText("1/1"), 0), true); // never −0
});

test("anything else is not a pitch", () => {
  for (const t of ["", "  ", "abc", "3/", "/2", "0/1", "1/0", "$", "0x", "c", "3/2c", "1.2.3"]) {
    assert.ok(Number.isNaN(parsePitchText(t)), t);
  }
});
