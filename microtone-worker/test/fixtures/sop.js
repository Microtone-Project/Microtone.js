// SOP fixtures: the smallest .sop files that exercise the OPL3 import end to
// end. Built rather than committed, for the same reason the .ims pair next door
// is — the format is small enough that writing it out documents it, and an
// opaque blob in the corpus would document nothing.
//
// SOP is the song format of a Korean OPL3 tracker of the mid-to-late 1990s,
// found in the same BBS collections as .ims and sharing nothing with it but the
// chip family: twenty tracks, stereo panning, four-operator instruments, and —
// unlike .ims — its instruments stored in the file rather than merely named.
// Section numbers below are SOP_FORMAT.en.md's.

/** A fixed-size, NUL-padded name field. */
const field = (s, n) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < s.length && i < n; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** One operator's five register bytes (§3.2), from the fields they pack. */
function op({ mult = 1, eg = 1, ksr = 0, vib = 0, am = 0, ksl = 0, tl = 0,
              attack = 15, decay = 0, sustain = 0, release = 5, wave = 0 }) {
  return [(am << 7) | (vib << 6) | (eg << 5) | (ksr << 4) | (mult & 15),
          (ksl << 6) | (tl & 63),
          (attack << 4) | decay,
          (sustain << 4) | release,
          wave];
}

/**
 * One eleven-byte operator pair (§3.2): the modulator's four register bytes and
 * its wave select, the channel's shared feedback/connection byte, then the same
 * for the carrier. `additive` is register 0xC0's CNT bit — set means this half's
 * first operator goes straight to the output instead of modulating.
 */
export function sopPair(mod, car, { feedback = 0, additive = false } = {}) {
  const m = op(mod), c = op(car);
  return [...m, (feedback << 1) | (additive ? 1 : 0), ...c];
}

/** One event: u16 delta, u8 code, then its value bytes. §4.2 — the note-on is
 *  the only one with more than one, and it carries its own LENGTH, which is why
 *  a SOP needs no note-off. */
function event(ev) {
  const out = [ev.delta & 0xff, (ev.delta >> 8) & 0xff, ev.code, ev.value & 0xff];
  if (ev.code === 2) out.push(ev.length & 0xff, (ev.length >> 8) & 0xff);
  return out;
}

/** A track, or the control track: u16 numEvents, u32 dataSize, events (§4.1). */
function trackBytes(events) {
  const body = events.flatMap(event);
  return [events.length & 0xff, (events.length >> 8) & 0xff,
          body.length & 0xff, (body.length >> 8) & 0xff,
          (body.length >> 16) & 0xff, (body.length >>> 24) & 0xff, ...body];
}

/**
 * A whole .sop. Everything after the 76-byte header is positional — there is no
 * offset table anywhere — so this writes them in the one order a reader can
 * take them: channel modes, instruments, the tracks, the control track.
 */
export function makeSop({ title = "", percussive = false, tickBeat = 8,
                          beatMeasure = 4, tempo = 120, modes = null,
                          instruments, tracks, control = [] }) {
  const head = new Uint8Array(76);
  head.set(field("sopepos", 7), 0);
  head[8] = 1;                                     // version 0.1, and only 0.1
  head.set(field("FIXTURE.SOP", 13), 10);
  head.set(title instanceof Uint8Array ? title.subarray(0, 31) : field(title, 31), 23);
  head[54] = percussive ? 1 : 0;
  head[56] = tickBeat;
  head[58] = beatMeasure;
  head[59] = tempo;
  head[73] = tracks.length;
  head[74] = instruments.length;
  return Uint8Array.from([
    ...head,
    ...(modes ?? tracks.map(() => 2)),             // §2: 2 is a YM3812 pair
    ...instruments.flatMap((i) => [
      i.type, ...field(i.shortName ?? "", 8), ...field(i.longName ?? "", 19),
      ...(i.data ?? []),
    ]),
    ...tracks.flatMap(trackBytes),
    ...trackBytes(control),
  ]);
}

const LOUD = { mult: 1, eg: 1, attack: 15, decay: 0, sustain: 0, release: 5 };

/** Twenty tracks is what the format always has (§4.1); most fixtures use two. */
const EMPTY_TRACKS = (n) => Array.from({ length: n }, () => []);
const NTRACKS = 20;

/**
 * Melodic mode: two two-operator instruments, a comment line, notes with
 * lengths, a pitch bend, a volume change and a panning move — and a tempo and a
 * global volume on the control track, which is where §5 puts them.
 *
 * §6: the type-12 record is not an instrument at all. It is one 19-column line
 * of the song's scrolling credits, parked in the instrument table because that
 * is where the editor had room, and it comes FIRST here because 29 corpus files
 * put the credits there — which means the instrument indices below are into the
 * whole table, comments included, exactly as the format has them.
 */
export const SOP_SONG = makeSop({
  title: "SOP FIXTURE",
  instruments: [
    { type: 12, longName: "by nobody at all" },
    { type: 1, shortName: "LEAD", longName: "square lead",
      data: sopPair({ ...LOUD, tl: 20 }, { ...LOUD, tl: 0 }, { feedback: 4 }) },
    { type: 1, shortName: "BASS", longName: "sine bass",
      data: sopPair({ ...LOUD, tl: 12 }, { ...LOUD, tl: 0, mult: 1 }) },
  ],
  tracks: [
    [ // instrument, volume and pitch come BEFORE the note they belong to
      { delta: 0, code: 6, value: 1 },
      { delta: 0, code: 4, value: 100 },
      { delta: 0, code: 2, value: 60, length: 8 },
      { delta: 8, code: 5, value: 120 },           // §4.2: +20 of ±100 → up
      { delta: 0, code: 2, value: 64, length: 16 },
      { delta: 16, code: 4, value: 40 },
      { delta: 0, code: 2, value: 67, length: 32 },
      { delta: 40, code: 2, value: 60, length: 24 },
    ],
    [
      { delta: 0, code: 6, value: 2 },
      { delta: 0, code: 7, value: 2 },             // §4.2: 2 is left
      { delta: 0, code: 2, value: 36, length: 32 },
      { delta: 32, code: 7, value: 0 },            // …and 0 is right
      { delta: 0, code: 2, value: 43, length: 32 },
      { delta: 32, code: 2, value: 36, length: 32 },
    ],
    ...EMPTY_TRACKS(NTRACKS - 2),
  ],
  control: [
    { delta: 0, code: 8, value: 100 },             // global volume, then tempo
    { delta: 0, code: 3, value: 120 },
    { delta: 64, code: 3, value: 150 },            // …and a change part-way in
    { delta: 32, code: 8, value: 64 },
  ],
});

/**
 * Rhythm mode. §4.1: track slots 6…10 ARE the bass drum, snare, tom, cymbal and
 * hi-hat — the corpus shows that diagonal directly — and three of those are not
 * oscillators at all, so their note numbers mean nothing.
 */
export const SOP_SONG_RHYTHM = makeSop({
  title: "SOP DRUMS",
  percussive: true,
  instruments: [
    { type: 1, shortName: "LEAD", data: sopPair({ ...LOUD, tl: 20 }, { ...LOUD }) },
    { type: 6, shortName: "KICK", data: sopPair({ ...LOUD, tl: 4 }, { ...LOUD }) },
    { type: 7, shortName: "SNARE", data: sopPair({ ...LOUD, tl: 6 }, { ...LOUD }) },
    { type: 8, shortName: "TOM", data: sopPair({ ...LOUD, tl: 6 }, { ...LOUD }) },
    { type: 9, shortName: "CYMBAL", data: sopPair({ ...LOUD, tl: 8 }, { ...LOUD }) },
    { type: 10, shortName: "HIHAT", data: sopPair({ ...LOUD, tl: 8 }, { ...LOUD }) },
  ],
  tracks: [
    [{ delta: 0, code: 6, value: 0 }, { delta: 0, code: 2, value: 60, length: 32 }],
    [], [], [], [], [],
    ...[1, 2, 3, 4, 5].map((inst) => [
      { delta: 0, code: 6, value: inst },
      { delta: 0, code: 2, value: 36, length: 4 },
      { delta: 8, code: 2, value: 36, length: 4 },
      { delta: 8, code: 2, value: 36, length: 4 },
      { delta: 8, code: 2, value: 36, length: 4 },
    ]),
    ...EMPTY_TRACKS(NTRACKS - 11),
  ],
  control: [{ delta: 0, code: 3, value: 120 }],
});

/**
 * A four-operator instrument, asked for both ways the format allows (§8): track
 * 0 says so in the channel-mode table, track 1 only by selecting a type-0
 * instrument. The two halves' CNT bits are 0 and 1, which is the connection
 * `1 → 2 → 3, and 4`.
 */
export const SOP_SONG_4OP = makeSop({
  title: "SOP WIDE",
  modes: [1, 2, ...Array.from({ length: NTRACKS - 2 }, () => 0)],
  instruments: [
    { type: 0, shortName: "WIDE", longName: "four operators",
      data: [...sopPair({ ...LOUD, tl: 24 }, { ...LOUD, tl: 18 }, { feedback: 3 }),
             ...sopPair({ ...LOUD, tl: 12, mult: 2 }, { ...LOUD, tl: 0, wave: 5 },
                        { additive: true })] },
  ],
  tracks: [
    [{ delta: 0, code: 6, value: 0 },
     { delta: 0, code: 2, value: 60, length: 32 },
     { delta: 32, code: 2, value: 67, length: 32 }],
    [{ delta: 0, code: 6, value: 0 },
     { delta: 0, code: 2, value: 48, length: 64 }],
    ...EMPTY_TRACKS(NTRACKS - 2),
  ],
  control: [{ delta: 0, code: 3, value: 120 }],
});

/**
 * Sixteen ticks a beat is SIXTY-FOUR rows to a 4/4 bar — exactly one pattern —
 * where the eight-ticks-a-beat songs above are thirty-two and fit two.
 */
export const SOP_SONG_16RPB = makeSop({
  title: "SOP FINE",
  tickBeat: 16,
  instruments: [
    { type: 1, shortName: "LEAD", data: sopPair({ ...LOUD, tl: 20 }, { ...LOUD }) },
  ],
  tracks: [
    [{ delta: 0, code: 6, value: 0 },
     ...Array.from({ length: 12 }, (_, i) => (
       { delta: i === 0 ? 0 : 16, code: 2, value: 60 + (i % 5), length: 12 })),
    ],
    ...EMPTY_TRACKS(NTRACKS - 1),
  ],
  control: [{ delta: 0, code: 3, value: 120 }],
});

/**
 * The chip's vibrato bit set on both operators. §3.2's `vib`: a shared LFO the
 * operator opts into, at ~6.078 Hz and — with the depth bit clear, which the
 * AdLib driver never sets — ±7 cents. Small, fast and bright; get either number
 * wrong and it becomes a slow deep wobble instead.
 */
export const SOP_SONG_VIB = makeSop({
  title: "SOP VIB",
  instruments: [
    { type: 1, shortName: "VIB", longName: "shimmering lead",
      data: sopPair({ ...LOUD, tl: 20, vib: 1 }, { ...LOUD, tl: 0, vib: 1 }) },
    { type: 1, shortName: "PLAIN", longName: "no vibrato",
      data: sopPair({ ...LOUD, tl: 20 }, { ...LOUD, tl: 0 }) },
  ],
  tracks: [
    [{ delta: 0, code: 6, value: 0 },
     { delta: 0, code: 2, value: 60, length: 64 }],
    [{ delta: 0, code: 6, value: 1 },
     { delta: 0, code: 2, value: 48, length: 64 }],
    ...EMPTY_TRACKS(NTRACKS - 2),
  ],
  control: [{ delta: 0, code: 3, value: 120 }],
});
