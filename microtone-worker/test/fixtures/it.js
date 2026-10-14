// Impulse Tracker fixtures with OpenMPT OPL samples. OpenMPT stores an OPL
// "sample" in an IT-structured file (an .mptm, or an .it it has loaded one
// into) as an ordinary IMPS header whose `cvt` byte is 0x40 and whose sample
// pointer leads to the twelve bytes of the patch — the same D00…D0B layout as
// an S3M AdLib instrument (soundlib/ITTools.cpp, Load_it.cpp). Sample mode
// only: no instrument headers, a pattern cell names a sample.

import { adlibPatch, SINE_PATCH, SQUARE } from "./s3m.js";

export { adlibPatch, SINE_PATCH, SQUARE };

/**
 * A whole .it in sample mode. `samples` are {data: unsigned 8-bit, loop?} PCM
 * or {opl: 12 bytes} OPL samples, each with `vol` (0…64), `gv` (0…64) and
 * `c5` (C5Speed). `patterns` are arrays of cells {row, ch, note?, smp?, vol?,
 * cmd?, info?}: `note` is IT's 0…119 (60 = C-5), 254 note cut, 255 note off.
 */
export function makeIt({ title = "IT FIXTURE", speed = 6, tempo = 125, channels = 4,
                         samples, patterns, mixvol = 48 }) {
  const ordNum = patterns.length + 1;
  const head = new Uint8Array(0xc0);
  const dv = new DataView(head.buffer);
  head.set([0x49, 0x4d, 0x50, 0x4d], 0);                    // IMPM
  for (let i = 0; i < Math.min(25, title.length); i++) head[4 + i] = title.charCodeAt(i);
  dv.setUint16(0x1e, 0x0410, true);                        // pattern highlight
  dv.setUint16(0x20, ordNum, true);
  dv.setUint16(0x22, 0, true);                             // no instruments
  dv.setUint16(0x24, samples.length, true);
  dv.setUint16(0x26, patterns.length, true);
  dv.setUint16(0x28, 0x0214, true);                        // Cwt/v
  dv.setUint16(0x2a, 0x0214, true);                        // Cmwt
  dv.setUint16(0x2c, 0x0009, true);                        // stereo, linear slides
  head[0x30] = 128; head[0x31] = mixvol; head[0x32] = speed; head[0x33] = tempo;
  head[0x34] = 128;                                        // pan separation
  for (let c = 0; c < 64; c++) { head[0x40 + c] = c < channels ? 32 : 32 | 128; head[0x80 + c] = 64; }

  const ordStart = 0xc0;
  const ptrStart = ordStart + ordNum;
  let at = ptrStart + 4 * (samples.length + patterns.length);
  const blobs = [];
  const place = (bytes) => { const p = at; blobs.push([p, bytes]); at += bytes.length; return p; };

  const smpHeads = samples.map((s) => {
    const h = new Uint8Array(0x50);
    const hv = new DataView(h.buffer);
    h.set([0x49, 0x4d, 0x50, 0x53], 0);                     // IMPS
    h[0x11] = s.gv ?? 64;
    h[0x13] = s.vol ?? 64;
    const name = s.name ?? (s.opl ? "OPL" : "SAMPLE");
    for (let i = 0; i < Math.min(25, name.length); i++) h[0x14 + i] = name.charCodeAt(i);
    if (s.opl) {
      h[0x12] = 0x01;                                       // sample data present
      h[0x2e] = 0x40;                                       // cvt: OPL instrument
      hv.setUint32(0x30, 12, true);
    } else {
      h[0x12] = 0x01 | (s.loop ? 0x10 : 0);
      h[0x2e] = 0x00;                                       // unsigned
      hv.setUint32(0x30, s.data.length, true);
      hv.setUint32(0x34, 0, true);
      hv.setUint32(0x38, s.loop ? s.data.length : 0, true);
    }
    hv.setUint32(0x3c, s.c5 ?? 8363, true);
    return h;
  });
  const smpPtr = smpHeads.map((h) => place(h));
  samples.forEach((s, i) => {
    const p = place(Uint8Array.from(s.opl ?? s.data));
    new DataView(smpHeads[i].buffer).setUint32(0x48, p, true);
  });
  const patPtr = patterns.map((cells) => {
    const body = [];
    for (let r = 0; r < 64; r++) {
      for (const c of cells.filter((x) => x.row === r)) {
        let mask = 0;
        if (c.note !== undefined) mask |= 1;
        if (c.smp !== undefined) mask |= 2;
        if (c.vol !== undefined) mask |= 4;
        if (c.cmd !== undefined) mask |= 8;
        body.push((c.ch + 1) | 0x80, mask);
        if (mask & 1) body.push(c.note);
        if (mask & 2) body.push(c.smp);
        if (mask & 4) body.push(c.vol);
        if (mask & 8) body.push(c.cmd, c.info ?? 0);
      }
      body.push(0);
    }
    const bytes = new Uint8Array(8 + body.length);
    const bv = new DataView(bytes.buffer);
    bv.setUint16(0, body.length, true);
    bv.setUint16(2, 64, true);
    bytes.set(body, 8);
    return place(bytes);
  });
  const out = new Uint8Array(at);
  out.set(head, 0);
  patterns.forEach((_, i) => { out[ordStart + i] = i; });
  out[ordStart + patterns.length] = 255;
  const pv = new DataView(out.buffer);
  [...smpPtr, ...patPtr].forEach((p, i) => pv.setUint32(ptrStart + 4 * i, p, true));
  for (const [p, bytes] of blobs) out.set(bytes, p);
  smpPtr.forEach((p, i) => out.set(smpHeads[i], p));
  return out;
}
