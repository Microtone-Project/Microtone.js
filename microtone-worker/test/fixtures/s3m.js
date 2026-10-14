// Scream Tracker 3 fixtures with AdLib instruments: the smallest .s3m files
// that exercise the OPL import end to end. Built rather than committed, for the
// same reason as the .ims and .sop ones — the layout is small enough that
// writing it out documents it — and so that openmpt123, the oracle for how an
// S3M plays, can be handed exactly the bytes the converter is.

/** Two operators as ST3 stores them: the twelve bytes D00…D0B of an AdLib
 *  instrument — modulator then carrier for each of registers 0x20, 0x40, 0x60,
 *  0x80 and 0xE0, then 0xC0 (feedback and connection), then a pad. */
export function adlibPatch(mod, car, { feedback = 0, additive = false } = {}) {
  const r20 = (o) => ((o.am ?? 0) << 7) | ((o.vib ?? 0) << 6) | ((o.eg ?? 1) << 5) |
    ((o.ksr ?? 0) << 4) | ((o.mult ?? 1) & 15);
  const r40 = (o) => ((o.ksl ?? 0) << 6) | ((o.tl ?? 0) & 63);
  const r60 = (o) => ((o.ar ?? 15) << 4) | ((o.dr ?? 0) & 15);
  const r80 = (o) => ((o.sl ?? 0) << 4) | ((o.rr ?? 5) & 15);
  return [r20(mod), r20(car), r40(mod), r40(car), r60(mod), r60(car),
    r80(mod), r80(car), (mod.ws ?? 0) & 7, (car.ws ?? 0) & 7,
    ((feedback & 7) << 1) | (additive ? 1 : 0), 0];
}

/** A plain sine: a silent modulator under a full-level carrier. */
export const SINE_PATCH = adlibPatch({ tl: 63 }, { tl: 0 });

/**
 * A whole .s3m. `channels` are ST3 channel-setting bytes (0…7 left PCM, 8…15
 * right, 16…24 the AdLib melody channels A1…A9). `instruments` are
 * {type: 1, data: Uint8Array of unsigned 8-bit, loop?} samples or {type: 2,
 * patch: 12 bytes} AdLib instruments, each with `volume` and `c2spd`.
 * `patterns` are arrays of cells {row, ch, note?, inst?, vol?, cmd?, info?},
 * note being ST3's (octave << 4 | semitone), 254 the ^^^ note-off.
 */
export function makeS3m({ title = "S3M FIXTURE", speed = 6, tempo = 125, channels,
                          instruments, patterns, orders = null, cwtv = 0x1320,
                          master = 0xb0 }) {
  const ord = orders ?? patterns.map((_, i) => i);
  const ordNum = ord.length + 1 + ((ord.length + 1) & 1);   // ST3 keeps it even
  const head = new Uint8Array(0x60);
  for (let i = 0; i < Math.min(27, title.length); i++) head[i] = title.charCodeAt(i);
  head[0x1c] = 0x1a; head[0x1d] = 16;
  const dv = new DataView(head.buffer);
  dv.setUint16(0x20, ordNum, true);
  dv.setUint16(0x22, instruments.length, true);
  dv.setUint16(0x24, patterns.length, true);
  dv.setUint16(0x28, cwtv, true);
  dv.setUint16(0x2a, 2, true);                              // unsigned samples
  head.set([0x53, 0x43, 0x52, 0x4d], 0x2c);                 // SCRM
  head[0x30] = 64; head[0x31] = speed; head[0x32] = tempo; head[0x33] = master;
  for (let c = 0; c < 32; c++) head[0x40 + c] = c < channels.length ? channels[c] : 0xff;

  const orderBytes = [...ord, ...Array(ordNum - ord.length).fill(0xff)];
  const ptrTable = 0x60 + ordNum;
  const ptrBytes = (instruments.length + patterns.length) * 2;
  let at = (ptrTable + ptrBytes + 15) & ~15;
  const instPtr = [], patPtr = [], blobs = [];
  const place = (bytes) => { const p = at; blobs.push([p, bytes]); at = (at + bytes.length + 15) & ~15; return p; };

  const instHeads = instruments.map((inst) => {
    const h = new Uint8Array(0x50);
    const hv = new DataView(h.buffer);
    h[0] = inst.type;
    const name = inst.name ?? (inst.type === 2 ? "ADLIB" : "SAMPLE");
    for (let i = 0; i < Math.min(27, name.length); i++) h[0x30 + i] = name.charCodeAt(i);
    if (inst.type === 2) {
      h.set(inst.patch, 0x10);
      h.set([0x53, 0x43, 0x52, 0x49], 0x4c);                // SCRI
    } else {
      hv.setUint32(0x10, inst.data.length, true);
      hv.setUint32(0x14, inst.loop ? 0 : 0, true);
      hv.setUint32(0x18, inst.loop ? inst.data.length : 0, true);
      h[0x1f] = inst.loop ? 1 : 0;
      h.set([0x53, 0x43, 0x52, 0x53], 0x4c);                // SCRS
    }
    h[0x1c] = inst.volume ?? 64;
    hv.setUint32(0x20, inst.c2spd ?? 8363, true);
    return h;
  });
  instHeads.forEach((h) => instPtr.push(place(h)));
  instruments.forEach((inst, i) => {
    if (inst.type !== 1) return;
    const p = place(Uint8Array.from(inst.data));
    const seg = p >> 4;
    instHeads[i][0x0d] = (seg >> 16) & 0xff;
    instHeads[i][0x0e] = seg & 0xff;
    instHeads[i][0x0f] = (seg >> 8) & 0xff;
  });
  for (const cells of patterns) {
    const body = [];
    for (let r = 0; r < 64; r++) {
      for (const c of cells.filter((x) => x.row === r)) {
        let b = c.ch & 31;
        if (c.note !== undefined || c.inst !== undefined) b |= 0x20;
        if (c.vol !== undefined) b |= 0x40;
        if (c.cmd !== undefined) b |= 0x80;
        body.push(b);
        if (b & 0x20) body.push(c.note ?? 255, c.inst ?? 0);
        if (b & 0x40) body.push(c.vol);
        if (b & 0x80) body.push(c.cmd, c.info ?? 0);
      }
      body.push(0);
    }
    const bytes = Uint8Array.from([0, 0, ...body]);
    new DataView(bytes.buffer).setUint16(0, bytes.length, true);
    patPtr.push(place(bytes));
  }
  const out = new Uint8Array(at);
  out.set(head, 0);
  out.set(orderBytes, 0x60);
  const pv = new DataView(out.buffer);
  [...instPtr, ...patPtr].forEach((p, i) => pv.setUint16(ptrTable + 2 * i, p >> 4, true));
  for (const [p, bytes] of blobs) out.set(bytes, p);
  instPtr.forEach((p, i) => out.set(instHeads[i], p));
  return out;
}

/** One cycle of a full-scale square, 32 frames, looped: a PCM reference voice. */
export const SQUARE = Array.from({ length: 32 }, (_, i) => (i < 16 ? 255 : 1));
