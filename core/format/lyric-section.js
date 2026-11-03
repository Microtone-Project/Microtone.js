// `ILyr` — the Project-Data section that gives formant instruments their LYRICS
// (item 280, TAUD_FILE_FORMAT.md §9.17).
//
// A formant instrument with an entry here is a LYRIC INSTRUMENT: its record is
// what every syllable shares (the source, the pool range, how the formants
// follow pitch, the vowel glide, the envelopes — everything an ordinary formant
// instrument has), and the entry lists the syllables a lane sings with it, one
// per note, in order (TAUD_ENGINE_SPEC.md §5.5.3, "Lyric instruments").
//
// Instrument-scoped (the `I` prefix): it travels with the instruments, so a
// .tsii bank carries its lyrics. Like `Ixmp` and `IMix`, it is not decoration:
// §9.8 lists it among the sections a conforming player must honour. A reader
// that ignores it plays the instrument as the formant instrument its record is,
// singing the record's own syllable on every note.
//
// The section is entries back to back:
//
//   U16 instrument (bits 0…9; 10…15 reserved) · U32 L, the entry's length after it
//   U16 S syllables · U8 R recipes · U8 reserved
//   R × 12  recipes — a consonant slot's layout (§7.6): the noise a consonant reads
//   S × 12  syllables
//   …the rest of the L bytes, the EDITOR's: U8 flags · U8 convergence (0…100)
//           · U8 O · O × (U8 consonant id, U8 timing) · U16 P · P × (U16 syllable,
//           U8 timing) · the lyrics as written, UTF-8
//
// A syllable: U8 frontness · U8 openness · U8 roundness · U8 flags (bit 0 the
// syllable has a vowel, bit 1 it is nasalised) · U8 glide/articulations/R (the
// tract block's +53) · U8 × 3 consonant ids (onset 1, onset 2, coda) · U8 × 4
// timing bytes (onset 1, onset 2, coda, glide; the tract block's +10 scale).
//
// The recipes carry pool pointers, so an editor that moves, frees or copies
// pool bytes follows them exactly as it follows a formant record's slots
// (lyricRecipeSpans below). A consonant with no recipe sounds the engine's
// noise generator.
//
// Pure: bytes in, plain objects out, and back. No DOM.

export const ILYR_FOURCC = "ILyr";
export const LYRIC_SYLLABLE_BYTES = 12;
export const LYRIC_RECIPE_BYTES = 12;
/** Syllables an entry can hold (its count is a U16). */
export const LYRIC_MAX_SYLLABLES = 0xffff;
/** Recipes an entry can hold (its count is a U8) — more than there are consonant ids. */
export const LYRIC_MAX_RECIPES = 0xff;

/** Syllable flags. */
export const LYRIC_VOWEL = 0x01;
export const LYRIC_NASAL = 0x02;
/** Editor flags. */
export const LYRIC_ED_XSAMPA = 0x01;
/** The editor's convergence towards the median onset runs 0…100 (percent). */
export const LYRIC_CONVERGE_MAX = 100;

/** An editor's part with nothing set. */
export function blankLyricEditor() {
  return { xsampa: false, converge: 0, overrides: [], sylOverrides: [], text: "" };
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const s8 = (x) => (x << 24) >> 24;

/** A syllable with nothing set: [a] at the chart's default, no consonant, the
 *  timing bytes as written (128). */
export function blankSyllable() {
  return {
    front: 200, open: 255, round: 0, vowel: true, nasal: false, gr: 0,
    cons: [0, 0, 0], timing: [128, 128, 128, 128],
  };
}

/** A recipe with nothing set: consonant `cons` on the noise generator. */
export function generatorRecipe(cons) {
  return { cons, ptr: 0, len: 0, offset: 0, rate: 0, tilt: 0, gain: 0 };
}

function readRecipe(b, o) {
  return {
    cons: b[o], ptr: u24(b, o + 1), len: u16(b, o + 4), offset: u16(b, o + 6),
    rate: u16(b, o + 8), tilt: s8(b[o + 10]), gain: b[o + 11],
  };
}

function readSyllable(b, o) {
  const f = b[o + 3];
  return {
    front: b[o], open: b[o + 1], round: b[o + 2],
    vowel: (f & LYRIC_VOWEL) !== 0, nasal: (f & LYRIC_NASAL) !== 0,
    gr: b[o + 4],
    cons: [b[o + 5], b[o + 6], b[o + 7]],
    timing: [b[o + 8], b[o + 9], b[o + 10], b[o + 11]],
  };
}

const utf8 = new TextDecoder("utf-8", { fatal: false });
const utf8enc = new TextEncoder();

/**
 * Read one entry body (the L bytes after the length): {syllables, recipes,
 * editor} or null when it is INVALID — no syllable, or shorter than its
 * counts say.
 */
function readEntryBody(b) {
  if (b.length < 4) return null;
  const S = u16(b, 0), R = b[2];
  const fixedEnd = 4 + R * LYRIC_RECIPE_BYTES + S * LYRIC_SYLLABLE_BYTES;
  if (S === 0 || fixedEnd > b.length) return null;
  const recipes = [];
  for (let k = 0; k < R; k++) recipes.push(readRecipe(b, 4 + k * LYRIC_RECIPE_BYTES));
  const syllables = [];
  const so = 4 + R * LYRIC_RECIPE_BYTES;
  for (let k = 0; k < S; k++) syllables.push(readSyllable(b, so + k * LYRIC_SYLLABLE_BYTES));
  // The editor's tail: tolerant — a short or missing tail is an entry no
  // editor wrote, which plays the same.
  const editor = blankLyricEditor();
  let o = fixedEnd;
  if (o + 3 <= b.length) {
    const fl = b[o], n = b[o + 2];
    editor.xsampa = (fl & LYRIC_ED_XSAMPA) !== 0;
    editor.converge = Math.min(LYRIC_CONVERGE_MAX, b[o + 1]);
    o += 3;
    for (let k = 0; k < n && o + 2 <= b.length; k++, o += 2) {
      editor.overrides.push({ cons: b[o], timing: b[o + 1] });
    }
    if (o + 2 <= b.length) {
      const p = u16(b, o);
      o += 2;
      for (let k = 0; k < p && o + 3 <= b.length; k++, o += 3) {
        editor.sylOverrides.push({ index: u16(b, o), timing: b[o + 2] });
      }
    }
    editor.text = utf8.decode(b.subarray(Math.min(o, b.length)));
  }
  return { syllables, recipes, editor };
}

/**
 * The section → {entries: Map instId → entry, problems: [{instId, detail}]}.
 * An entry is {instId, syllables, recipes, editor}. An INVALID entry (no
 * syllable, or shorter than its counts) is dropped and reported; so is a
 * second entry for an instrument (the first is kept), and a truncated tail.
 */
export function parseLyricSection(payload) {
  const entries = new Map();
  const problems = [];
  let o = 0;
  while (o + 6 <= payload.length) {
    const instId = u16(payload, o) & 0x3ff;
    const len = u32(payload, o + 2);
    const start = o + 6;
    if (start + len > payload.length) {
      problems.push({ instId, detail: "truncated" });
      break;
    }
    const body = readEntryBody(payload.subarray(start, start + len));
    if (body === null) problems.push({ instId, detail: "invalid" });
    else if (entries.has(instId)) problems.push({ instId, detail: "duplicate" });
    else entries.set(instId, { instId, ...body });
    o = start + len;
  }
  if (o < payload.length && o + 6 > payload.length) problems.push({ instId: -1, detail: "trailing bytes" });
  return { entries, problems };
}

/** One entry → its bytes, header included. */
export function buildLyricEntry(e) {
  const S = e.syllables.length;
  const R = e.recipes.length;
  if (S < 1 || S > LYRIC_MAX_SYLLABLES) throw new RangeError(`ILyr: ${S} syllables`);
  if (R > LYRIC_MAX_RECIPES) throw new RangeError(`ILyr: ${R} recipes`);
  const ed = e.editor ?? blankLyricEditor();
  const text = utf8enc.encode(ed.text ?? "");
  const ovr = ed.overrides ?? [];
  const syl = ed.sylOverrides ?? [];
  if (ovr.length > 0xff || syl.length > 0xffff) throw new RangeError("ILyr: too many overrides");
  const bodyLen = 4 + R * LYRIC_RECIPE_BYTES + S * LYRIC_SYLLABLE_BYTES
    + 3 + ovr.length * 2 + 2 + syl.length * 3 + text.length;
  const out = new Uint8Array(6 + bodyLen);
  const id = e.instId & 0x3ff;
  out[0] = id & 0xff; out[1] = id >>> 8;
  out[2] = bodyLen & 0xff; out[3] = (bodyLen >>> 8) & 0xff;
  out[4] = (bodyLen >>> 16) & 0xff; out[5] = (bodyLen >>> 24) & 0xff;
  let o = 6;
  out[o] = S & 0xff; out[o + 1] = S >>> 8; out[o + 2] = R; out[o + 3] = 0;
  o += 4;
  for (const r of e.recipes) {
    out[o] = r.cons & 0xff;
    out[o + 1] = r.ptr & 0xff; out[o + 2] = (r.ptr >>> 8) & 0xff; out[o + 3] = (r.ptr >>> 16) & 0xff;
    out[o + 4] = r.len & 0xff; out[o + 5] = (r.len >>> 8) & 0xff;
    out[o + 6] = r.offset & 0xff; out[o + 7] = (r.offset >>> 8) & 0xff;
    out[o + 8] = r.rate & 0xff; out[o + 9] = (r.rate >>> 8) & 0xff;
    out[o + 10] = r.tilt & 0xff;
    out[o + 11] = r.gain & 0xff;
    o += LYRIC_RECIPE_BYTES;
  }
  for (const s of e.syllables) {
    out[o] = s.front & 0xff; out[o + 1] = s.open & 0xff; out[o + 2] = s.round & 0xff;
    out[o + 3] = (s.vowel ? LYRIC_VOWEL : 0) | (s.nasal ? LYRIC_NASAL : 0);
    out[o + 4] = s.gr & 0xff;
    for (let k = 0; k < 3; k++) out[o + 5 + k] = s.cons[k] & 0xff;
    for (let k = 0; k < 4; k++) out[o + 8 + k] = s.timing[k] & 0xff;
    o += LYRIC_SYLLABLE_BYTES;
  }
  out[o] = ed.xsampa ? LYRIC_ED_XSAMPA : 0;
  out[o + 1] = Math.max(0, Math.min(LYRIC_CONVERGE_MAX, ed.converge | 0));
  out[o + 2] = ovr.length;
  o += 3;
  for (const v of ovr) { out[o] = v.cons & 0xff; out[o + 1] = v.timing & 0xff; o += 2; }
  out[o] = syl.length & 0xff; out[o + 1] = syl.length >>> 8;
  o += 2;
  for (const v of syl) {
    out[o] = v.index & 0xff; out[o + 1] = (v.index >>> 8) & 0xff; out[o + 2] = v.timing & 0xff;
    o += 3;
  }
  out.set(text, o);
  return out;
}

/** Entries → the section payload, ascending by instrument. */
export function buildLyricSection(entries) {
  const list = [...entries].sort((a, b) => (a.instId & 0x3ff) - (b.instId & 0x3ff));
  const parts = list.map(buildLyricEntry);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The recipe consonant `cons` reads in `entry`, or null (the generator). The
 *  first recipe naming it wins. */
export function lyricRecipeOf(entry, cons) {
  for (const r of entry.recipes) if (r.cons === cons) return r;
  return null;
}

/** Every pool span an entry's recipes claim: [{ptr, len, rate, recipe}] — spans
 *  of length 0 (the generator) claim nothing and are left out. */
export function lyricRecipeSpans(entry) {
  const out = [];
  for (const r of entry.recipes) if (r.len > 0) out.push({ ptr: r.ptr, len: r.len, rate: r.rate, recipe: r });
  return out;
}

/** A deep copy of an entry (for ops that rewrite one). */
export function cloneLyricEntry(e) {
  return {
    instId: e.instId,
    syllables: e.syllables.map((s) => ({ ...s, cons: s.cons.slice(), timing: s.timing.slice() })),
    recipes: e.recipes.map((r) => ({ ...r })),
    editor: {
      xsampa: !!e.editor?.xsampa, converge: e.editor?.converge | 0,
      overrides: (e.editor?.overrides ?? []).map((v) => ({ ...v })),
      sylOverrides: (e.editor?.sylOverrides ?? []).map((v) => ({ ...v })),
      text: e.editor?.text ?? "",
    },
  };
}
