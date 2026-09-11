// The command palette's effect-argument hint (src/ui/palette.js fxArgHint) —
// item 162's "contextual argument hint" requirement: a `:` cell (or a J/O/2/3
// cell paired with one) must describe what the COMBINED argument means,
// rather than falling through to the generic "unknown opcode" text $BA hits
// nowhere in the base FX_INFO table. Pure — palette.js's DOM-building
// refresh() is untested here, only the hint text it calls into.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fxArgHint, fxName, fxArg, FX_INFO } from "../../src/ui/palette.js";
import { EffectOp } from "../../src/engine/tables.js";
import { t } from "../../src/ui/i18n.js";

test("`:` has its own FX_INFO entry, so the opcode picker can offer it", () => {
  assert.deepEqual(FX_INFO[EffectOp.OP_COLON], { l: ":" });
});

test("`:` unpaired (or paired with something that ignores it): the base description, not \"unknown opcode\"", () => {
  const hint = fxArgHint(EffectOp.OP_COLON, 0);
  assert.match(hint, /^: /, "prefixed with the opcode letter, like every other hint");
  assert.doesNotMatch(hint, /unknown opcode/i);
  assert.equal(fxArgHint(EffectOp.OP_COLON, EffectOp.OP_H), fxArgHint(EffectOp.OP_COLON, 0),
    "an unsupported pairing reads the same as no pairing at all");
});

test("`:` paired with J/O/2/3 reads the CONTEXTUAL hint, not the base one", () => {
  const base = fxArgHint(EffectOp.OP_COLON, 0);
  const withJ = fxArgHint(EffectOp.OP_COLON, EffectOp.OP_J);
  const withO = fxArgHint(EffectOp.OP_COLON, EffectOp.OP_O);
  const with2 = fxArgHint(EffectOp.OP_COLON, EffectOp.OP_2);
  const with3 = fxArgHint(EffectOp.OP_COLON, EffectOp.OP_3);
  for (const h of [withJ, withO, with2, with3]) assert.notEqual(h, base);
  assert.match(withJ, /second offset/i);
  assert.match(withO, /low word/i);
  // 2 and 3 share the same paired description — the argument shape is
  // identical, only which side of the region it touches differs (and that
  // is already said by 2/3's OWN hint, not `:`'s).
  assert.equal(with2, with3);
});

test("J/O/2/3 paired with `:`: the EXTENDED hint, not the base one", () => {
  for (const op of [EffectOp.OP_J, EffectOp.OP_O, EffectOp.OP_2, EffectOp.OP_3]) {
    const base = fxArgHint(op, 0);
    const paired = fxArgHint(op, EffectOp.OP_COLON);
    assert.notEqual(paired, base, `op ${op}`);
    assert.match(paired, /paired with/i, `op ${op}`);
  }
});

test("J's extended hint names it the FIRST offset; `:`'s names the second", () => {
  assert.match(fxArgHint(EffectOp.OP_J, EffectOp.OP_COLON), /first offset/i);
  assert.match(fxArgHint(EffectOp.OP_COLON, EffectOp.OP_J), /second offset/i);
});

test("O's extended hint names it the HIGH word; `:`'s names the low word", () => {
  assert.match(fxArgHint(EffectOp.OP_O, EffectOp.OP_COLON), /high word/i);
  assert.match(fxArgHint(EffectOp.OP_COLON, EffectOp.OP_O), /low word/i);
});

test("on an interrupt row, `:` reads as the interrupt's argument, not an extension", () => {
  const INT3 = 0x0013;
  const plain = fxArgHint(EffectOp.OP_COLON, 0);
  const onInt = fxArgHint(EffectOp.OP_COLON, 0, INT3);
  assert.notEqual(onInt, plain, "the row's note changes what the cell means");
  assert.match(onInt, /interrupt/i);
  // Even paired with something that DOES extend: the same colon feeds both,
  // and the interrupt is the reading the composer put the marker there for.
  assert.equal(fxArgHint(EffectOp.OP_COLON, EffectOp.OP_J, INT3), onInt);
  // The neighbouring words are not markers, so they read as before.
  assert.equal(fxArgHint(EffectOp.OP_COLON, 0, 0x000f), plain);
  assert.equal(fxArgHint(EffectOp.OP_COLON, 0, 0x0020), plain);
  // …and a note changes nothing for any OTHER opcode.
  assert.equal(fxArgHint(EffectOp.OP_H, 0, INT3), fxArgHint(EffectOp.OP_H, 0));
  assert.equal(fxArgHint(EffectOp.OP_J, EffectOp.OP_COLON, INT3),
               fxArgHint(EffectOp.OP_J, EffectOp.OP_COLON), "J still reads as extended");
});

test("every fxArgHint output is prefixed \"<letter> <name>: \", like the plain fxArg path", () => {
  for (const op of [EffectOp.OP_J, EffectOp.OP_O, EffectOp.OP_2, EffectOp.OP_3, EffectOp.OP_COLON]) {
    const info = FX_INFO[op];
    const prefix = `${info.l} ${fxName(info)}: `;
    assert.ok(fxArgHint(op, 0).startsWith(prefix), `op ${op} unpaired`);
    assert.ok(fxArgHint(op, EffectOp.OP_COLON === op ? EffectOp.OP_J : EffectOp.OP_COLON)
      .startsWith(prefix), `op ${op} paired`);
  }
});

test("an opcode with no FX_INFO entry still falls back to noEffect/unknownOpcode", () => {
  assert.equal(fxArgHint(0, 0), t("pal.noEffect"));
  assert.equal(fxArgHint(0x99, 0), t("pal.unknownOpcode"), "reserved byte, not a real opcode");
});

test("fxArg(FX_INFO[:]) still answers something on its own — used as the fallback description", () => {
  const info = FX_INFO[EffectOp.OP_COLON];
  assert.ok(fxArg(info).length > 0);
  assert.match(fxArg(info), /Format 3/);
});
