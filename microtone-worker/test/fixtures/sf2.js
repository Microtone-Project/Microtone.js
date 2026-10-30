// A small SoundFont with every kind of stereo pair the bank build knows, for
// sf2taudify and the preset list:
//   preset 0  "split"    a LINKED L/R pair at 44.1 kHz, 100000 frames, both
//                        zones starting 70000 in (sf2taudify splits the slice
//                        onto a sample of its own, and must keep it linked)
//   preset 1  "oneshot"  a LINKED pair at 32 kHz, 80000 frames, unlooped (over
//                        the cap: a synthesized loop and a baked decay)
//   preset 2  "panned"   two MONO samples hard-panned apart, whose tails end
//                        at different frames
//   preset 3  "mono"     one plain mono sample, for contrast, with a 15 ms
//                        volume attack (attackVolEnv −7271 timecents): shorter
//                        than a tick at 125 BPM (20 ms), longer at 300 (8.3 ms)
// Deterministic: the noise is an LCG, not Math.random.

const FULL_RANGE = 0x7f00;

function tone(n, freq, rate, envEnd, seed) {
  const out = new Int16Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const env = Math.max(0, 1 - i / envEnd) ** 2;
    const x = 20000 * env * (Math.sin((2 * Math.PI * freq * i) / rate) +
      0.3 * Math.sin((2 * Math.PI * freq * 2.01 * i) / rate)) + ((s >>> 16) / 65536 - 0.5) * 60;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(x)));
  }
  return out;
}

/** The SoundFont's bytes. */
export function makeStereoSf2() {
  const samples = [ // name, data, rate, link, type (1 mono, 2 right, 4 left)
    ["A(L)", tone(100000, 440, 44100, 110000, 1), 44100, 1, 4],
    ["A(R)", tone(100000, 443, 44100, 90000, 2), 44100, 0, 2],
    ["B(L)", tone(80000, 220, 32000, 100000, 3), 32000, 3, 4],
    ["B(R)", tone(80000, 331, 32000, 90000, 4), 32000, 2, 2],
    ["C(L)", tone(20000, 500, 32000, 18000, 5), 32000, 0, 1],
    ["C(R)", tone(20000, 505, 32000, 12000, 6), 32000, 0, 1],
    ["D", tone(12000, 600, 32000, 12000, 7), 32000, 0, 1],
  ];
  const smplParts = [];
  const shdr = [];
  let pos = 0;
  for (const [name, data, rate, link, type] of samples) {
    const n = data.length;
    shdr.push(sampleHeader(name, pos, pos + n, pos + 8, pos + n - 8, rate, link, type));
    smplParts.push(new Uint8Array(data.buffer), new Uint8Array(92)); // 46 zero frames between
    pos += n + 46;
  }
  shdr.push(sampleHeader("EOS", 0, 0, 0, 0, 0, 0, 0));

  // instruments: [name, [zone: [[gen, amount], ...] ending in sampleID (53)]]
  const z = (si, ...gens) => [[43, FULL_RANGE], ...gens, [53, si]];
  const startAt = (off) => [[4, Math.floor(off / 32768)], [0, off % 32768]];
  const insts = [
    ["split", [z(0, ...startAt(70000)), z(1, ...startAt(70000))]],
    ["oneshot", [z(2), z(3)]],
    ["panned", [z(4, [17, -500]), z(5, [17, 500])]],
    ["mono", [z(6, [34, -7271])]],
  ];
  const inst = [], ibag = [], igen = [];
  let gi = 0, bi = 0;
  for (const [name, zones] of insts) {
    inst.push(concat(str(name, 20), u16(bi)));
    for (const zone of zones) {
      ibag.push(concat(u16(gi), u16(0)));
      bi++;
      for (const [op, amt] of zone) { igen.push(concat(u16(op), u16(amt & 0xffff))); gi++; }
    }
  }
  inst.push(concat(str("EOI", 20), u16(bi)));
  ibag.push(concat(u16(gi), u16(0)));
  igen.push(new Uint8Array(4));

  const phdr = [], pbag = [], pgen = [];
  insts.forEach(([name], p) => {
    phdr.push(concat(str(name, 20), u16(p), u16(0), u16(p), u32(0), u32(0), u32(0)));
    pbag.push(concat(u16(2 * p), u16(0)));
    pgen.push(concat(u16(43), u16(FULL_RANGE), u16(41), u16(p)));
  });
  phdr.push(concat(str("EOP", 20), u16(0), u16(0), u16(insts.length), u32(0), u32(0), u32(0)));
  pbag.push(concat(u16(2 * insts.length), u16(0)));
  pgen.push(new Uint8Array(4));

  const info = list("INFO", [["ifil", concat(u16(2), u16(1))], ["isng", str("EMU8000", 8)], ["INAM", str("stereo test", 12)]]);
  const sdta = list("sdta", [["smpl", concat(...smplParts)]]);
  const pdta = list("pdta", [
    ["phdr", concat(...phdr)], ["pbag", concat(...pbag)], ["pmod", new Uint8Array(10)], ["pgen", concat(...pgen)],
    ["inst", concat(...inst)], ["ibag", concat(...ibag)], ["imod", new Uint8Array(10)], ["igen", concat(...igen)],
    ["shdr", concat(...shdr)],
  ]);
  const body = concat(ascii("sfbk"), info, sdta, pdta);
  return concat(ascii("RIFF"), u32(body.length), body);
}

function sampleHeader(name, start, end, ls, le, rate, link, type) {
  return concat(str(name, 20), u32(start), u32(end), u32(ls), u32(le), u32(rate),
    Uint8Array.of(60, 0), u16(link), u16(type));
}

function list(type, chunks) {
  const body = concat(ascii(type), ...chunks.map(([id, b]) => concat(ascii(id), u32(b.length), b,
    new Uint8Array(b.length & 1))));
  return concat(ascii("LIST"), u32(body.length), body);
}

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const str = (s, n) => { const b = new Uint8Array(n); b.set(ascii(s).subarray(0, n)); return b; };
const u16 = (v) => Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
const u32 = (v) => Uint8Array.of(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
