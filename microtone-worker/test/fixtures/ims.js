// Iyagi Music Sound fixtures: the smallest .ims and .BNK that exercise the
// AdLib import end to end. Built rather than committed — the formats are small
// enough that writing them out documents them, and a pair of opaque blobs in
// the corpus would document nothing.

const OPERATOR_FIELDS = ["ksl", "multiple", "feedback", "attack", "sustain", "eg",
                         "decay", "release", "totalLevel", "am", "vib", "ksr",
                         "connection"];

/** A minimal AdLib .BNK holding `patches`: {name, mod, car, modWave, carWave}. */
export function makeBnk(patches) {
  const offName = 28, offData = offName + 12 * patches.length;
  const out = new Uint8Array(offData + 30 * patches.length);
  const dv = new DataView(out.buffer);
  out.set([0, 1], 0);
  out.set([..."ADLIB-"].map((c) => c.charCodeAt(0)), 2);
  dv.setUint16(8, patches.length, true);
  dv.setUint16(10, patches.length, true);
  dv.setUint32(12, offName, true);
  dv.setUint32(16, offData, true);
  patches.forEach((p, i) => {
    const o = offName + i * 12;
    dv.setUint16(o, i, true);
    out[o + 2] = 1;                                // any non-zero flag = in use
    for (let k = 0; k < p.name.length && k < 9; k++) out[o + 3 + k] = p.name.charCodeAt(k);
    const d = offData + i * 30;
    OPERATOR_FIELDS.forEach((f, j) => {
      out[d + 2 + j] = p.mod[f] ?? 0;
      out[d + 15 + j] = p.car[f] ?? 0;
    });
    out[d + 28] = p.modWave ?? 0;
    out[d + 29] = p.carWave ?? 0;
  });
  return out;
}

/** A minimal .ims: header, event stream, then the patch-name table. */
export function makeIms({ title, events, names, tempo = 120, percussive = false }) {
  const body = Uint8Array.from(events);
  const out = new Uint8Array(70 + body.length + 4 + 9 * names.length);
  const dv = new DataView(out.buffer);
  out[0] = 1; out[1] = 0;
  out.set(title.subarray(0, 30), 6);
  out[36] = 240;                                   // ticks a beat
  out[37] = 4;                                     // beats a measure
  dv.setInt32(38, 240, true);                      // totalTick (advisory)
  dv.setInt32(42, body.length, true);
  dv.setInt32(46, events.length, true);
  out[58] = percussive ? 1 : 0;
  out[59] = 1;                                     // pitch-bend range, semitones
  dv.setUint16(60, tempo, true);
  out.set(body, 70);
  const end = 70 + body.length;
  out[end] = 0x77; out[end + 1] = 0x77;
  dv.setUint16(end + 2, names.length, true);
  names.forEach((n, i) => {
    for (let k = 0; k < n.length && k < 9; k++) out[end + 4 + i * 9 + k] = n.charCodeAt(k);
  });
  return out;
}

export const LOUD_OP = { multiple: 1, attack: 15, decay: 0, sustain: 0, eg: 1, release: 5,
                  totalLevel: 0, connection: 1 };

/** A two-patch bank: one with feedback, one plain. */
export const IMS_BANK = makeBnk([
  { name: "LEAD", mod: { ...LOUD_OP, totalLevel: 20, feedback: 4 }, car: LOUD_OP },
  { name: "bass", mod: { ...LOUD_OP, totalLevel: 12 }, car: { ...LOUD_OP, multiple: 1 } },
]);

/** "검은" in 2-byte Johab — the encoding every Iyagi title is written in. */
export const JOHAB_TITLE = Uint8Array.from([0x88, 0xf1, 0xb7, 0x65]);

export const IMS_EVENTS = [
  0x00, 0xc0, 0x00,                    // channel 0 → patch 0
  0x00, 0xc1, 0x01,                    // channel 1 → patch 1
  0x00, 0x90, 60, 100,                 // C4 on channel 0
  0x00, 0x91, 48, 90,                  // C3 on channel 1
  30, 0xe0, 0x00, 0x50,                // channel 0 bends up
  30, 0x80, 60, 0,                     // channel 0 off
  0x00, 0x91, 55, 90,                  // channel 1 re-triggers
  60, 0x81, 55, 0,
  30, 0xfc,                            // end of song
];

export const IMS_SONG = makeIms({ title: JOHAB_TITLE, events: IMS_EVENTS,
                                  names: ["LEAD", "BASS"] });

/**
 * The same music on a 20-tick grid: 240 ÷ 20 is twelve rows to the beat and so
 * FORTY-EIGHT rows to a 4/4 bar, which is the case a flat 64-row cue gets wrong.
 */
export const IMS_SONG_12RPB = makeIms({
  title: JOHAB_TITLE, names: ["LEAD", "BASS"],
  events: [
    0x00, 0xc0, 0x00,                  // channel 0 → patch 0
    0x00, 0xc1, 0x01,                  // channel 1 → patch 1
    // Two and a half bars of it, so the song needs more than one 48-row cue.
    ...Array.from({ length: 12 }, (_, i) => [
      i === 0 ? 0x00 : 100, 0x90, 60 + (i % 5), 100,
      20, 0x80, 60 + (i % 5), 0,
    ]).flat(),
    100, 0x91, 48, 90,
    20, 0x81, 48, 0,
    20, 0xfc,
  ],
});
