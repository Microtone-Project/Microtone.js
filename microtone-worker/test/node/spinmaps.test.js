// The instrument panels' spinner mappings (src/ui/spinmaps.js) and the Hertz
// spinner (components/hzspinner.js): what each shows for a stored value, what
// it stores for what is typed, and where one press of ∓ lands.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MIX_DB_MAP, ATTEN_DB_MAP, sfResoDbMap, centsMap, pitchHexMap, hexMap,
} from "../../src/ui/spinmaps.js";
import {
  hzSpinnerMap, hzOfCents, centsOfHz, formatHz, parseHzText,
} from "../../src/ui/components/hzspinner.js";
import { pitchTablePresets, ANCHOR_NOTE } from "../../core/tuning/pitchtables.js";

const tet12 = pitchTablePresets[120]; // 12-TET, the default notation

test("Hz: SoundFont's absolute cents, read and typed in hertz", () => {
  assert.equal(Math.round(hzOfCents(6900)), 440);
  assert.equal(centsOfHz(440), 6900);
  assert.equal(formatHz(440), "440 Hz");
  assert.equal(formatHz(1250), "1.25 kHz");
  assert.equal(formatHz(12000), "12 kHz");
  for (const [text, hz] of [["440", 440], ["440 Hz", 440], ["440hz", 440], ["1.2k", 1200], ["1.2 kHz", 1200], ["12KHZ", 12000]]) {
    assert.equal(parseHzText(text), hz, text);
  }
  assert.equal(Math.round(parseHzText("6900c")), 440, "absolute cents, for a SoundFont's own numbers");
  assert.ok(Number.isNaN(parseHzText("loud")));
  const m = hzSpinnerMap();
  assert.equal(m.toDisplay(6900), "440 Hz");
  assert.equal(m.fromDisplay("1 kHz"), centsOfHz(1000));
  assert.equal(m.fromDisplay("5"), 1500, "clamped to the SoundFont range");
  assert.equal(m.step(6900, 1), 7000, "a semitone a press");
  assert.equal(m.step(13500, 1), 13500);
});

test("Hz with an Off value: the top step turns it off, and back", () => {
  const m = hzSpinnerMap({ off: 0xffff, offLabel: "Off" });
  assert.equal(m.toDisplay(0xffff), "Off");
  assert.equal(m.step(13500, 1), 0xffff);
  assert.equal(m.step(0xffff, -1), 13500);
  assert.equal(m.step(0xffff, 1), 0xffff);
  assert.equal(m.fromDisplay("off"), 0xffff);
  assert.equal(m.fromDisplay("440"), 6900);
});

test("dB: a mix octet, an attenuation octet (0 = unset), SoundFont centibels", () => {
  assert.equal(MIX_DB_MAP.toDisplay(159), "+0.0 dB");
  assert.equal(MIX_DB_MAP.fromDisplay("0"), 159);
  assert.equal(MIX_DB_MAP.fromDisplay("−∞"), 0);
  assert.equal(ATTEN_DB_MAP.fromDisplay("0 dB"), 159, "unity typed is unity stored");
  assert.equal(ATTEN_DB_MAP.fromDisplay(""), 0, "nothing typed is unset");
  assert.equal(ATTEN_DB_MAP.toDisplay(159), "+0.0 dB");
  assert.notEqual(ATTEN_DB_MAP.toDisplay(0), "−∞ dB", "0 is unset, not silence");
  const r = sfResoDbMap();
  assert.equal(r.toDisplay(60), "6.0 dB");
  assert.equal(r.fromDisplay("6.5 dB"), 65);
  assert.equal(r.fromDisplay("200"), 960);
  assert.equal(r.step(65, 1), 80, "a dB a press, landing on whole dB");
  assert.equal(r.step(0xffff, 1), 0, "from flat, + starts at 0 dB");
  assert.equal(sfResoDbMap({ flat: false }).toDisplay(0xffff), "96.0 dB");
});

test("cents: a detune over 4096-TET units, a degree of the song's notation a press", () => {
  const m = centsMap(tet12, -0x8000, 0x7fff);
  assert.equal(m.toDisplay(4096), "1200.0 ¢");
  assert.equal(m.fromDisplay("700"), Math.round((700 * 4096) / 1200));
  assert.equal(m.fromDisplay("3/2"), Math.round(4096 * Math.log2(1.5)));
  assert.equal(m.fromDisplay("$100"), 256, "hex is 4096-TET units");
  const up = m.step(0, 1);
  assert.ok(up > 0 && Math.abs(up - 4096 / 12) < 1, `one 12-TET step up (${up})`);
  assert.equal(centsMap(tet12, -10, 10).fromDisplay("1200"), 10, "kept within the field's range");
});

test("hex: a note word (typed as hex or a note name) and a plain address", () => {
  const p = pitchHexMap(tet12);
  assert.equal(p.toDisplay(0x5000), "$5000");
  assert.equal(p.fromDisplay("$5000"), 0x5000);
  assert.equal(p.fromDisplay("5000"), 0x5000, "a note field's digits are hex");
  assert.equal(p.fromDisplay("C-4"), ANCHOR_NOTE);
  assert.equal(p.fromDisplay("0"), 0, "a range end may sit below every note");
  assert.equal(p.fromDisplay("FFFF"), 0xffff);
  assert.ok(p.step(0x5000, 1) > 0x5000);
  const a = hexMap(6, 0, 8388607);
  assert.equal(a.toDisplay(0x1f00), "$001F00");
  assert.equal(a.fromDisplay("$1F00"), 0x1f00);
  assert.equal(a.fromDisplay("1f00"), 0x1f00);
  assert.equal(a.fromDisplay("#100"), 100, "decimal with a #");
  assert.equal(a.fromDisplay("$FFFFFF"), 8388607, "clamped to the pool");
  assert.equal(a.step(0, -1), 0);
});
