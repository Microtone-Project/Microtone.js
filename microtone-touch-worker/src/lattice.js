// The isomorphic keyboard's geometry — pure, Node-testable.
//
// The board is a hexagonal lattice addressed by axial coordinates (q, r),
// drawn the way the Lumatone draws it: a pointy-topped grid turned
// TILT ≈ 16.1° anticlockwise, so it is neither pointy- nor flat-topped. A
// layout is two numbers, the degree step to the neighbour along q (`a`,
// climbing to the right at TILT) and along r (`b`, steeply up at TILT + 60°);
// the neighbour up and to the left, at TILT + 120°, is then `b − a`. That is
// the whole definition of "isomorphic": the same hand shape plays the same
// interval everywhere on the board.
//
// TILT is measured, not chosen: the key centres in the Lumatone's own preset
// charts (12-ET Harmonic Table, 19- and 22-ET Bosanquet) sit at 15.9° ± 0.1°,
// and atan(√3 / 6) = 16.10° is the angle at which the lattice lines up with
// the horizontal again — key (q + 7, r − 2) is level with key (q, r).
//
// The steps are not tables per tuning. On an octave-period equal tuning they
// are derived from its own patent fifth — the nearest degree to 3/2 — so a
// layout means the same musical thing on 12, 19, 31 or 53 tones: Bosanquet is
// still whole tones one way and the chromatic semitone the other, whatever a
// whole tone happens to be in degrees. A tuning whose period is not the octave
// (Bohlen–Pierce repeats at the tritave) has no chain of fifths to derive
// from, so there each interval is simply rounded to the nearest degree.
//
// Steps are in DEGREES of the tuning, so an unequal tuning (Shi'er lü) is laid
// out by its degree numbers, exactly as the tracker's keymaps lay it out.

const OCTAVE = 0x1000; // the period of an octave tuning, in 4096-TET units
const cents = (ratio) => 1200 * Math.log2(ratio);

/**
 * Interval sizes, in degrees, of an `n`-degree tuning whose period is
 * `period` 4096-TET units (default: the octave).
 */
export function edoSteps(n, period = OCTAVE) {
  if (period === OCTAVE) {
    const fifth = Math.round(n * Math.log2(1.5));
    const tone = 2 * fifth - n;           // two fifths less an octave
    const limma = 3 * n - 5 * fifth;      // the diatonic semitone, E–F
    const apotome = tone - limma;         // the chromatic semitone, F–F♯
    const major3 = 2 * tone;
    const minor3 = fifth - major3;
    return { n, fifth, tone, limma, apotome, major3, minor3 };
  }
  const step = (period * 1200) / 4096 / n; // cents per degree
  const near = (ratio) => Math.round(cents(ratio) / step);
  return {
    n,
    fifth: near(3 / 2),
    tone: near(9 / 8),
    limma: near(256 / 243),
    apotome: near(2187 / 2048),
    major3: near(5 / 4),
    minor3: near(6 / 5),
  };
}

/** The layouts the board offers, in the order a picker lists them. */
export const LAYOUTS = Object.freeze([
  { id: "wicki", name: "Wicki–Hayden", short: "Wicki" },
  { id: "bosanquet", name: "Bosanquet–Wilson", short: "Bosanquet" },
  { id: "harmonic", name: "Harmonic table", short: "Harmonic" },
  { id: "step", name: "Degree run", short: "Run" },
]);

/**
 * The `a` (shallow, to the right) and `b` (steep, upwards) steps of `layout`
 * on an `n`-degree board. Bosanquet and the harmonic table are the Lumatone's
 * own presets turned into steps.
 *   wicki      whole tones along a, fifths along b (so fourths up-left)
 *   bosanquet  whole tones along a, the chromatic semitone along b (so the
 *              diatonic semitone runs down to the right)
 *   harmonic   major thirds along a, fifths along b, minor thirds up-left —
 *              the C-Thru AXiS table: every triad is one cluster of keys
 *   step       one degree along a, a whole tone along b — the one that
 *              reaches every degree of every tuning
 */
export function layoutSteps(layout, n, period = OCTAVE) {
  const key = `${layout}|${n}|${period}`;
  let steps = stepCache.get(key);
  if (!steps) {
    steps = Object.freeze(computeSteps(layout, n, period));
    stepCache.set(key, steps);
  }
  return steps;
}
const stepCache = new Map();

function computeSteps(layout, n, period) {
  const s = edoSteps(n, period);
  switch (layout) {
    case "wicki": return { a: s.tone, b: s.fifth };
    case "bosanquet": {
      const steps = { a: s.tone, b: s.apotome > 0 ? s.apotome : s.limma };
      const floor = findFloor(steps, n, period);
      return floor ? { ...steps, floor } : steps;
    }
    case "harmonic": return { a: s.major3, b: s.fifth };
    default: return { a: 1, b: Math.max(2, s.tone) };
  }
}

function gcd(x, y) {
  x = Math.abs(x); y = Math.abs(y);
  while (y) [x, y] = [y, x % y];
  return x;
}

/** True when the board reaches every degree of the tuning, in every octave:
 *  the two steps share no factor. 24-TET's patent fifth is 12-TET's, so
 *  Wicki–Hayden there only ever plays the even degrees; 7-TET's harmonic table
 *  (thirds of 2, fifths of 4) has every note — but each in only every other
 *  octave, which counting notes modulo the octave would not notice. */
export function reachesAll({ a, b }) {
  return gcd(a, b) === 1;
}

/** True when a layout is playable at all: it reaches every degree, and no
 *  two neighbouring keys sound the same note (a step of 0, or a = b, which
 *  makes the upper-left neighbour a unison — what tiny tunings run into). */
export function layoutWorks(steps) {
  const { a, b } = steps;
  return a !== 0 && b !== 0 && a !== b && reachesAll(steps);
}

/** `preferred` when it works on this tuning, else "step". */
export function fitLayout(preferred, n, period = OCTAVE) {
  return layoutWorks(layoutSteps(preferred, n, period)) ? preferred : "step";
}

/** Degree (relative to the board's origin) of the key at (q, r): the
 *  layout's two steps, plus a period for every FLOOR the key's row is up
 *  (Bosanquet only; see findFloor). */
export function keyDegree(q, r, { a, b, floor }) {
  const d = q * a + r * b;
  return floor ? d + Math.floor(r / floor.rows) * floor.lift : d;
}

const SQRT3 = Math.sqrt(3);
/** The board's tilt from pointy-topped, in radians (see the header). */
export const TILT = 0;//Math.atan(SQRT3 / 6); // the tilt used by Lumatone
const DEG60 = Math.PI / 3;
// Unit steps along q and r, in screen space (y down), per unit of key size.
const QX = SQRT3 * Math.cos(TILT), QY = -SQRT3 * Math.sin(TILT);
const RX = SQRT3 * Math.cos(TILT + DEG60), RY = -SQRT3 * Math.sin(TILT + DEG60);
const DET = QX * RY - QY * RX;

/** Centre of key (q, r), for keys of circumradius `size`, origin at (0, 0)
 *  and y growing DOWNWARD (screen space). */
export function hexCentre(q, r, size) {
  return { x: size * (q * QX + r * RX), y: size * (q * QY + r * RY) };
}

/** The key under point (x, y) — the inverse of hexCentre, cube-rounded. */
export function pixelToHex(x, y, size) {
  const qf = (x * RY - y * RX) / (size * DET);
  const rf = (y * QX - x * QY) / (size * DET);
  // Cube rounding: round all three axes, then fix the one that moved most.
  const sf = -qf - rf;
  let q = Math.round(qf), r = Math.round(rf), s = Math.round(sf);
  const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q: q || 0, r: r || 0 }; // never −0
}

/**
 * Every key that shows, even in part, on a `width` × `height` board whose
 * key (0, 0) is centred at `origin` (screen space). → [{q, r, x, y}], the
 * centres included.
 */
export function visibleKeys(width, height, size, origin) {
  // The board, grown by a key all round, mapped into (q, r): its corners
  // bound every key that can show.
  const corners = [[-size, -size], [width + size, -size], [-size, height + size], [width + size, height + size]]
    .map(([x, y]) => ({
      q: ((x - origin.x) * RY - (y - origin.y) * RX) / (size * DET),
      r: ((y - origin.y) * QX - (x - origin.x) * QY) / (size * DET),
    }));
  const qLo = Math.floor(Math.min(...corners.map((c) => c.q)));
  const qHi = Math.ceil(Math.max(...corners.map((c) => c.q)));
  const rLo = Math.floor(Math.min(...corners.map((c) => c.r)));
  const rHi = Math.ceil(Math.max(...corners.map((c) => c.r)));
  const out = [];
  for (let q = qLo; q <= qHi; q++) {
    for (let r = rLo; r <= rHi; r++) {
      const c = hexCentre(q, r, size);
      const x = origin.x + c.x, y = origin.y + c.y;
      if (x < -size || x > width + size || y < -size || y > height + size) continue;
      out.push({ q, r, x, y });
    }
  }
  return out;
}

// ── Bosanquet's floors ───────────────────────────────────────────────────────
//
// Bosanquet climbs by a chromatic semitone up its steep axis and comes back
// down a diatonic one up-left, so going UP the board it barely climbs at
// all: in 12-TET the key two rows straight above the root IS the root, at
// the same pitch, and the board repeats itself floor after floor. Each of
// those floors is meant to be an octave above the last.
//
// The floor is found the way you would find it by eye: walk up from the root
// through the keys within FLOOR_CONE of straight up, row by row, and stop at
// the first key that is the root again or the root's right-hand neighbour
// (22-TET reaches D, not C). That key's row is the next floor. The board is
// then lifted by however much puts that floor exactly one period above the
// one below: a period in 12, 19 or 22-TET, nothing at all in 5-, 7-, 8-, 9-
// or 16-TET, whose floors already sit an octave apart by the arithmetic of
// their steps.
//
// A floor also has to hold EVERY degree, or lifting it leaves holes: the rows
// of one floor, a whole tone apart along their length, must between them
// cover all the steps inside a whole tone. From 31 tones up the walk passes a
// key one degree off the root after only two rows — but a two-row floor of
// 31-TET holds two degrees in every five, and lifting it by 31 (≡ 1 mod 5)
// puts every floor's gaps in the same place, so C4 would be on no key of the
// board at all. Such near-misses are walked past; the walk goes on to the
// exact repeat, which is always a whole tone's worth of rows up and always
// complete.

const FLOOR_CONE = 20 * (Math.PI / 180); // either side of straight up

/** → { rows, lift } — floors are `rows` rows tall and each is `lift`
 *  degrees above the one below — or null when no lift is needed. */
export function findFloor({ a, b }, n, period = OCTAVE) {
  const pc = (d) => ((d % n) + n) % n;
  /** Do rows 0 … rows−1 hold every degree between two whole tones? */
  const complete = (rows) => {
    const span = Math.abs(a);
    const seen = new Set();
    for (let r = 0; r < rows; r++) seen.add((((r * b) % span) + span) % span);
    return seen.size === span;
  };
  for (let r = 1; r <= 4 * n; r++) {
    for (let q = -r - 2; q <= 2; q++) {
      const c = hexCentre(q, r, 1);
      if (Math.abs(Math.atan2(-c.y, c.x) - Math.PI / 2) > FLOOR_CONE) continue;
      const d = q * a + r * b;
      const isRoot = pc(d) === 0, isRight = pc(d - a) === 0;
      if (!(isRoot || isRight) || !complete(r)) continue;
      const periods = Math.round((d - (isRoot ? 0 : a)) / n);
      const lift = (1 - periods) * n;
      return lift === 0 ? null : { rows: r, lift };
    }
  }
  return null;
}
