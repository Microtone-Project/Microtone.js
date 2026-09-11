// Effect-column argument field map (item 120) — which of a command's four
// argument nibbles belong to which FIELD, so the grids can paint each field in
// its own shade of amber. Layouts are transcribed from TAUD_NOTE_EFFECTS.md;
// this pins the ones a reader would get wrong.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fxArgFields, fxColonWarns } from "../../src/ui/notenames.js";
import { EffectOp } from "../../src/engine/tables.js";

const OP = 0, RSVD = -1;

/** fxArgFields as a layout string, for readable assertions. */
const map = (effect, arg, pairedOp = 0) => fxArgFields(effect, arg, pairedOp)
  .map((f) => (f === OP ? "o" : f === RSVD ? "." : String(f))).join("");

// Base-36 opcode letter → effect number, the same mapping the cell stores.
const fx = (letter) => parseInt(letter, 36);

test("one-value commands read the whole argument as a single field", () => {
  for (const letter of ["b", "c", "g", "o"]) assert.equal(map(fx(letter), 0x1234), "1111");
  // Filter cutoff / resonance: 16-bit in SF2 mode, high byte in IT mode —
  // either way ONE value, never a two-field split.
  assert.equal(map(5, 0x1234), "1111");
  assert.equal(map(6, 0xffff), "1111");
});

test("two-byte commands split down the middle", () => {
  for (const letter of ["h", "i", "j", "r", "u", "x", "y"]) {
    assert.equal(map(fx(letter), 0x2277), "1122");
  }
  assert.equal(map(4, 0x2040), "1122"); // 4 $eeaa — elevation, azimuth
  assert.equal(map(7, 0x1003), "1122"); // 7 $xxyy — ditto rows, repeats
});

test("nibble-pair slides mark their reserved low byte", () => {
  for (const letter of ["d", "k", "l", "n", "p", "q", "w"]) {
    assert.equal(map(fx(letter), 0x4000), "12..");
  }
  // Byte-argument commands keep the byte together over the same reserved half.
  for (const letter of ["a", "m", "v"]) assert.equal(map(fx(letter), 0x2000), "11..");
  assert.equal(map(1, 0x0100), "11.."); // 1 $xx00 — global behaviour flags
});

test("bitcrusher and overdrive split by their documented nibble roles", () => {
  assert.equal(map(8, 0x1234), "1233"); // 8 $xyzz — clip, depth, skip
  assert.equal(map(9, 0x10ff), "1.22"); // 9 $x0zz — clip, (reserved), amp
});

test("E / F switch layout on the fine-slide marker nibble", () => {
  assert.equal(map(fx("e"), 0x0155), "1111"); // coarse: one 16-bit value
  assert.equal(map(fx("f"), 0x0155), "1111");
  assert.equal(map(fx("e"), 0xf155), "1222"); // fine: $F marker + 12-bit magnitude
  assert.equal(map(fx("f"), 0xffff), "1222");
  assert.equal(map(fx("e"), 0xefff), "1111"); // $EFFF is still coarse
});

test("T picks one of three layouts from its high byte", () => {
  assert.equal(map(fx("t"), 0x6400), "11.."); // set tempo: byte + reserved
  assert.equal(map(fx("t"), 0xff64), "1122"); // extended set: $FF marker + byte
  assert.equal(map(fx("t"), 0x0013), "..12"); // slide: direction nibble + amount
});

test("S is multiplexed — the sub-command nibble takes the OPCODE's ink", () => {
  // 120.3: "S" and its selector are one two-character command, so they share
  // one colour; only what follows is argument.
  assert.equal(map(fx("s"), 0x3100), "o1.."); // S $3x00 vibrato waveform
  assert.equal(map(fx("s"), 0xc400), "o1.."); // S $Cx00 note cut
  assert.equal(map(fx("s"), 0x8040), "o111"); // S $80xx pan — 9-bit angle, one field
  assert.equal(map(fx("s"), 0xd123), "o123"); // S $Dxny delay, action, action delay
  assert.equal(map(fx("s"), 0xf0a0), "o.11"); // S $F0xx invert loop — 8-bit speed over a reserved nibble
  assert.equal(map(fx("s"), 0xa000), "o111"); // undefined sub-command: one field
});

test("Z is multiplexed the same way", () => {
  assert.equal(map(fx("z"), 0x0080), "o111"); // Z $0xxx — selector + 12-bit speed
  // 163.1: the funk form carries TWO values — the walk selector and the speed
  // it drives — so it must not read as one 12-bit number the way the slide does.
  assert.equal(map(fx("z"), 0xf080), "o122"); // Z $Ffxx — selector, walk, speed
  assert.equal(map(fx("z"), 0xffff), "o122");
});

test("effect 0 is an explicit blank: no field, every nibble dim", () => {
  // 163.1: `0 $xxxx` exists to say "nothing happens here" over a pattern-ditto
  // ghost. The engine reads no part of the argument, so no part of it is a
  // value — the whole cell is reserved ink, which is what tells the two apart.
  assert.equal(map(0, 0x0000), "....");
  assert.equal(map(0, 0xbeef), "....");
});

test("every effect number yields four fields, and the last is never the opcode's", () => {
  // 120.2: the opcode's colour and the LAST argument's colour must differ, so
  // no layout may end on 'o' (or on a reserved nibble, which would leave the
  // cell ending in dim ink). Effect 0 is exempt on both counts and tested
  // above: it is the one command with no argument at all.
  for (let effect = 1; effect <= 35; effect++) {
    for (const arg of [0x0000, 0x1234, 0xf155, 0xff64, 0x8040, 0xffff]) {
      const fields = fxArgFields(effect, arg);
      assert.equal(fields.length, 4, `effect ${effect} arg ${arg}`);
      assert.ok(fields.some((f) => f > 0), `effect ${effect} arg ${arg} has no argument field`);
      const last = fields.filter((f) => f > 0).pop();
      assert.ok(last >= 1 && last <= 3, `effect ${effect} arg ${arg} last field ${last}`);
    }
  }
});

// ── item 162.1 + 181: the red "this `:` needs a second look" flag ──────────
// A per-SLOT mask now: bit 0 flags the first effect cell, bit 1 the second, so
// an interrupt row can redden the `:` that lost and leave the winner alone.
// The correct-and-supported arrangements (and anything that isn't a `:` at
// all) paint through the ordinary per-field colours above like any other row.

const NOTE_INT3 = 0x0013;

test("`:` correctly on the second slot, paired with something that reads it: no warning", () => {
  for (const op of [EffectOp.OP_J, EffectOp.OP_O, EffectOp.OP_2, EffectOp.OP_3]) {
    assert.equal(fxColonWarns(op, EffectOp.OP_COLON), 0, `op ${op}`);
  }
});

test("`:` on the FIRST slot warns, even paired with a command that reads it", () => {
  for (const op of [EffectOp.OP_J, EffectOp.OP_O, EffectOp.OP_2, EffectOp.OP_3]) {
    assert.equal(fxColonWarns(EffectOp.OP_COLON, op), 3, `op ${op}`);
  }
});

test("`:` paired with a command that ignores it warns, regardless of slot", () => {
  assert.equal(fxColonWarns(EffectOp.OP_H, EffectOp.OP_COLON), 3, "H does not read `:`");
  assert.equal(fxColonWarns(EffectOp.OP_COLON, EffectOp.OP_H), 3, "still `:` on the first slot too");
});

test("no `:` in either slot: never warns, whatever the row otherwise says", () => {
  assert.equal(fxColonWarns(EffectOp.OP_J, 0), 0, "unpaired J");
  assert.equal(fxColonWarns(0, 0), 0, "empty row");
  assert.equal(fxColonWarns(EffectOp.OP_J, 0, NOTE_INT3), 0, "…nor on an interrupt row");
});

test("`:` alone in a slot still hits rule 1 or rule 2 — the row is still wrong to read", () => {
  // First slot: rule 1 fires on POSITION alone, empty second slot or not.
  assert.equal(fxColonWarns(EffectOp.OP_COLON, 0), 3, "`:` first, nothing to extend");
  // Second slot with nothing in front of it: rule 2 fires too — $00 (OP_NONE)
  // is not in EXT_CAPABLE_OPS, so it reads exactly like any other command
  // that doesn't consume the argument.
  assert.equal(fxColonWarns(0, EffectOp.OP_COLON), 3, "`:` second, nothing in front of it");
});

test("`:` in BOTH slots flags BOTH — neither of them extends anything", () => {
  assert.equal(fxColonWarns(EffectOp.OP_COLON, EffectOp.OP_COLON), 3);
});

// ── item 181: on an interrupt row the `:` is the interrupt's ARGUMENT ───────

test("an interrupt row's lone `:` is doing its job in either slot — no warning", () => {
  assert.equal(fxColonWarns(EffectOp.OP_COLON, 0, NOTE_INT3), 0, "first slot");
  assert.equal(fxColonWarns(0, EffectOp.OP_COLON, NOTE_INT3), 0, "second slot");
  // …including beside a command that has nothing to do with it. The `:` is the
  // interrupt's, not that command's, so rule 2 has nothing to say here.
  assert.equal(fxColonWarns(EffectOp.OP_H, EffectOp.OP_COLON, NOTE_INT3), 0);
  assert.equal(fxColonWarns(EffectOp.OP_COLON, EffectOp.OP_H, NOTE_INT3), 0);
  // …and beside one that DOES read it: the same colon feeds both.
  assert.equal(fxColonWarns(EffectOp.OP_COLON, EffectOp.OP_J, NOTE_INT3), 0);
});

test("two `:` on an interrupt row: the first wins, only the second reddens", () => {
  assert.equal(fxColonWarns(EffectOp.OP_COLON, EffectOp.OP_COLON, NOTE_INT3), 2);
});

test("every interrupt marker reads the same, and its neighbours do not", () => {
  for (let n = 0; n < 16; n++) {
    assert.equal(fxColonWarns(EffectOp.OP_COLON, EffectOp.OP_COLON, 0x0010 + n), 2, `Int${n}`);
  }
  // $000F is the last reserved sentinel and $0020 the lowest playable note —
  // neither is an interrupt, so both fall back to the ordinary rules.
  assert.equal(fxColonWarns(EffectOp.OP_COLON, EffectOp.OP_COLON, 0x000f), 3);
  assert.equal(fxColonWarns(EffectOp.OP_COLON, EffectOp.OP_COLON, 0x0020), 3);
});

// ── contextual field colouring for a correctly-paired `:` (fxArgFields'
// 3rd `pairedOp` arg) — only reached when fxColonWarns is false, so these
// pairings are exactly the ones that read normally instead of flat red. ──

test("J correctly paired with `:`: J's own cell is ONE full-resolution field", () => {
  // Unpaired J keeps its base two-byte split.
  assert.equal(map(EffectOp.OP_J, 0x2277), "1122");
  // Paired with `:`, J's argument is no longer two bytes — it's the whole
  // 16-bit off1, one field.
  assert.equal(map(EffectOp.OP_J, 0x2277, EffectOp.OP_COLON), "1111");
});

test("`:` paired with J/O takes field 2, whole cell — \"the other half\"", () => {
  assert.equal(map(EffectOp.OP_COLON, 0x0567, EffectOp.OP_J), "2222");
  assert.equal(map(EffectOp.OP_COLON, 0x0002, EffectOp.OP_O), "2222");
});

test("O correctly paired with `:`: unchanged (O was already one field)", () => {
  assert.equal(map(EffectOp.OP_O, 0x0001, 0), "1111");
  assert.equal(map(EffectOp.OP_O, 0x0001, EffectOp.OP_COLON), "1111");
});

test("2/3 correctly paired with `:`: base layout unchanged, `:` inherits each nibble's field", () => {
  assert.equal(map(EffectOp.OP_2, 0x0f20, EffectOp.OP_COLON), "1123", "region/op/speed, same as unpaired");
  assert.equal(map(EffectOp.OP_3, 0x0f20, EffectOp.OP_COLON), "1123");
  // `:`'s $fuuk: f joins region's field (1), uu joins the op's field (2,2),
  // k joins the speed's field (3).
  assert.equal(map(EffectOp.OP_COLON, 0x0018, EffectOp.OP_2), "1223");
  assert.equal(map(EffectOp.OP_COLON, 0x0018, EffectOp.OP_3), "1223");
});

test("a flagged (fxColonWarns) pairing never reaches contextual colouring — the view paints flat red instead", () => {
  // pairedOp alone doesn't gate correctness — callers only pass it when
  // fxColonWarns is false (glyphs.js paintFxCell takes the red branch
  // first). Sanity: an UNSUPPORTED target still falls through fxLayout's
  // pairedOp branch to its own default layout, since only J/O/2/3 match it.
  assert.equal(map(EffectOp.OP_COLON, 0x1234, EffectOp.OP_H), "1111", "H doesn't match either branch");
  assert.equal(map(EffectOp.OP_H, 0x1234, EffectOp.OP_COLON), "1122", "H's own layout, untouched");
});
