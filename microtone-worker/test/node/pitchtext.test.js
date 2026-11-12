// The spellings a pitch field takes (spinner.js parsePitchText): a plain
// number in the field's own unit, hex as steps of the field's grid, cents, and
// ratios — every non-plain spelling landing on a whole step of that grid
// (4096-TET unless the field says otherwise; the notation maker's is 65536).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePitchText } from "../../src/ui/components/spinner.js";
import { fineCentsMap } from "../../src/ui/spinmaps.js";

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

test("a 65536-TET field reads hex as 65536-TET steps and rounds to them", () => {
  // `$095C0` is a perfect fifth there, not 4096-TET $95C0 (11231.25 cents).
  assert.equal(parsePitchText("$095C0", "cents", 65536), (0x95c0 * 1200) / 65536);
  assert.equal(parsePitchText("$10000", "units", 65536), 65536);
  assert.equal(parsePitchText("700c", "units", 65536), 38229);      // 38229.33
  assert.equal(parsePitchText("100c", "cents", 65536), (5461 * 1200) / 65536);
  assert.equal(parsePitchText("3/2", "units", 65536), Math.round(65536 * Math.log2(1.5)));
  assert.equal(parsePitchText("701.955", "cents", 65536), 701.955); // plain: as it stands
});

test("the notation maker's cents fields hold sixteenths and step one 65536-TET step", () => {
  const m = fineCentsMap(0, 0xffff);
  assert.equal(m.fromDisplay("$095C0"), 0x95c0 / 16);
  assert.equal(m.fromDisplay("3/2"), Math.round(65536 * Math.log2(1.5)) / 16);
  assert.equal(m.fromDisplay("701.955c"), m.fromDisplay("3/2"));
  assert.equal(m.fromDisplay("5/4"), Math.round(65536 * Math.log2(1.25)) / 16);
  assert.equal(m.fromDisplay("386.31"), Math.round((386.31 * 65536) / 1200) / 16);
  assert.equal(m.fromDisplay("-3/2"), 0);                // clamped to the field
  assert.ok(Number.isNaN(m.fromDisplay("junk")));        // keeps what it held
  assert.equal(m.step(2396, 1), 2396.0625);
  assert.equal(m.step(2396.0625, -1), 2396);
  assert.equal(m.step(0, -1), 0);
  assert.equal(m.toDisplay(2396), "701.95");
  // Every 65536-TET step survives its own two-decimal text.
  for (let s = 0; s < 0x10000 * 16; s += 37) {
    assert.equal(m.fromDisplay(m.toDisplay(s / 16)), s / 16, `step ${s}`);
  }
});
