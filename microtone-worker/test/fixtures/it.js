// Impulse Tracker fixtures with OpenMPT OPL samples. OpenMPT stores an OPL
// "sample" in an IT-structured file (an .mptm, or an .it it has loaded one
// into) as an ordinary IMPS header whose `cvt` byte is 0x40 and whose sample
// pointer leads to the twelve bytes of the patch — the same D00…D0B layout as
// an S3M AdLib instrument (soundlib/ITTools.cpp, Load_it.cpp). Sample mode
// unless `instruments` is given (IMPI headers laid out as ITTECH.TXT has them).

import { adlibPatch, SINE_PATCH, SQUARE } from "./s3m.js";

export { adlibPatch, SINE_PATCH, SQUARE };

/**
 * A whole .it in sample mode. `samples` are {data: unsigned 8-bit, loop?} PCM
 * or {opl: 12 bytes} OPL samples, each with `vol` (0…64), `gv` (0…64) and
 * `c5` (C5Speed). `patterns` are arrays of cells {row, ch, note?, smp?, vol?,
 * cmd?, info?}: `note` is IT's 0…119 (60 = C-5), 254 note cut, 255 note off.
 * `orders` defaults to every pattern once, in turn. A sample's `dfp` is its
 * raw IMPS DfP byte (bit 7 = use); `shares: j` points its header at sample j's
 * data (0-based) instead of its own. `linear: false` = Amiga slides.
 *
 * `instruments` switches the file to instrument mode (a cell's `smp` then
 * names an instrument): each is {keyboard: (key) => [note, sample], dfp (raw
 * IMPI byte, bit 7 = DON'T use; default "don't use"), nna, vol: [[value,
 * tick]…] (a volume envelope, else none)}.
 */
export function makeIt({ title = "IT FIXTURE", speed = 6, tempo = 125, channels = 4,
                         samples, patterns, mixvol = 48, orders = null,
                         instruments = null, linear = true }) {
  const insts = instruments ?? [];
  const ord = orders ?? patterns.map((_, i) => i);
  const ordNum = ord.length + 1;
  const head = new Uint8Array(0xc0);
  const dv = new DataView(head.buffer);
  head.set([0x49, 0x4d, 0x50, 0x4d], 0);                    // IMPM
  for (let i = 0; i < Math.min(25, title.length); i++) head[4 + i] = title.charCodeAt(i);
  dv.setUint16(0x1e, 0x0410, true);                        // pattern highlight
  dv.setUint16(0x20, ordNum, true);
  dv.setUint16(0x22, insts.length, true);
  dv.setUint16(0x24, samples.length, true);
  dv.setUint16(0x26, patterns.length, true);
  dv.setUint16(0x28, 0x0214, true);                        // Cwt/v
  dv.setUint16(0x2a, 0x0214, true);                        // Cmwt
  dv.setUint16(0x2c, 0x0001 | (instruments ? 0x0004 : 0) | (linear ? 0x0008 : 0), true);
  head[0x30] = 128; head[0x31] = mixvol; head[0x32] = speed; head[0x33] = tempo;
  head[0x34] = 128;                                        // pan separation
  for (let c = 0; c < 64; c++) { head[0x40 + c] = c < channels ? 32 : 32 | 128; head[0x80 + c] = 64; }

  const ordStart = 0xc0;
  const ptrStart = ordStart + ordNum;
  let at = ptrStart + 4 * (insts.length + samples.length + patterns.length);
  const blobs = [];
  const place = (bytes) => { const p = at; blobs.push([p, bytes]); at += bytes.length; return p; };

  const insPtr = insts.map((ins) => {
    const h = new Uint8Array(0x22a);
    h.set([0x49, 0x4d, 0x50, 0x49], 0);                     // IMPI
    h[0x11] = ins.nna ?? 0;
    h[0x18] = 128;                                          // GbV
    h[0x19] = ins.dfp ?? (32 | 0x80);
    for (let k = 0; k < 120; k++) {
      const [note, smp] = ins.keyboard(k);
      h[0x40 + 2 * k] = note; h[0x41 + 2 * k] = smp;
    }
    if (ins.vol) {
      h[0x130] = 0x01; h[0x131] = ins.vol.length;
      ins.vol.forEach(([v, tick], i) => {
        h[0x136 + 3 * i] = v; h[0x137 + 3 * i] = tick & 0xff; h[0x138 + 3 * i] = tick >> 8;
      });
    }
    return place(h);
  });
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
      h[0x2f] = s.dfp ?? 0;
      hv.setUint32(0x30, s.data.length, true);
      hv.setUint32(0x34, 0, true);
      hv.setUint32(0x38, s.loop ? s.data.length : 0, true);
    }
    hv.setUint32(0x3c, s.c5 ?? 8363, true);
    return h;
  });
  const smpPtr = smpHeads.map((h) => place(h));
  const dataPtr = [];
  samples.forEach((s, i) => {
    const p = s.shares !== undefined ? dataPtr[s.shares] : place(Uint8Array.from(s.opl ?? s.data));
    dataPtr.push(p);
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
  ord.forEach((p, i) => { out[ordStart + i] = p; });
  out[ordStart + ord.length] = 255;
  const pv = new DataView(out.buffer);
  [...insPtr, ...smpPtr, ...patPtr].forEach((p, i) => pv.setUint32(ptrStart + 4 * i, p, true));
  for (const [p, bytes] of blobs) out.set(bytes, p);
  smpPtr.forEach((p, i) => out.set(smpHeads[i], p));
  return out;
}
