// The isomorphic keyboard's geometry — pure, Node-testable.
//
// The board is a hexagonal lattice addressed by axial coordinates (q, r): a
// pointy-topped grid, turned by the layout's own TILT. A layout is two
// numbers, the degree step to the neighbour along q (`a`, to the right at
// TILT) and along r (`b`, at TILT + 60°); the neighbour at TILT + 120° is then
// `b − a`. That is the whole definition of "isomorphic": the same hand shape
// plays the same interval everywhere on the board.
//
// The tilt is not a constant: each layout is turned so that the octave of
// the head key stands straight above it, and the octave below straight below
// (see octaveStep) — a column of C's up the board in every tuning. Wicki–
// Hayden needs no turn at all; Bosanquet a few degrees either way; the
// harmonic table up to about 48°. (The Lumatone draws all of its layouts at
// one tilt, atan(√3 / 6) = 16.1°, the angle at which its lattice is level
// again at (q + 7, r − 2); Touch's tilt is the octave's.) A board can instead
// lay its octaves ACROSS — a row of C's to the right, which on the harmonic
// table is its row of major thirds, C E G♯ C′. The degree run is cut into
// strips an octave apart instead, and turned by those (see "The degree run's
// strips" at the end).
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

/** The layouts the board offers, in the order a picker lists them: the
 *  Wicki–Hayden, the Bosanquet–Wilson, the harmonic table and the degree run,
 *  each named in the language's own words (lang/*.js layout.<id>). */
export const LAYOUTS = Object.freeze([{ id: "wicki" }, { id: "bosanquet" }, { id: "harmonic" }, { id: "step" }]);

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
 *              reaches every degree of every tuning — in strips an octave
 *              apart
 *
 * `across` turns the board a quarter: the harmonic table lays its octaves
 * across, and the degree run lays its run across and stacks its strips (see
 * runSteps). The result's `across` says whether it could.
 */
export function layoutSteps(layout, n, period = OCTAVE, across = false) {
  const key = `${layout}|${n}|${period}|${across}`;
  let steps = stepCache.get(key);
  if (!steps) {
    steps = Object.freeze(computeSteps(layout, n, period, across));
    stepCache.set(key, steps);
  }
  return steps;
}
const stepCache = new Map();

function computeSteps(layout, n, period, across) {
  const s = edoSteps(n, period);
  switch (layout) {
    case "wicki": return withTilt({ a: s.tone, b: s.fifth }, n, across);
    case "bosanquet": {
      const steps = { a: s.tone, b: s.apotome > 0 ? s.apotome : s.limma };
      const floor = findFloor(steps, n, period);
      return withTilt(floor ? { ...steps, floor } : steps, n, across);
    }
    case "harmonic": return withTilt({ a: s.major3, b: s.fifth }, n, across);
    default: return runSteps(n, Math.max(2, s.tone), across);
  }
}

/** The steps, plus the octave step and the tilt that stands it upright — or,
 *  `across`, lays it to the right; a board with no such step stands upright
 *  instead, and says so by `across` being false. */
function withTilt(steps, n, across) {
  let octave = across ? octaveStep(steps, n, true) : null;
  across = !!octave;
  octave ??= octaveStep(steps, n);
  return { ...steps, octave, across, tilt: octave ? tiltFor(octave, across) : 0 };
}

/**
 * The key step that is one PERIOD up (an octave, or Bohlen–Pierce's
 * tritave): the shortest {q, r} whose key sounds `n` degrees above the one
 * it starts from — and keeps doing so, two periods at twice the step and one
 * down at its negation, so the head key's octaves form one straight column.
 * On a floored Bosanquet board the step must also span whole floors, which
 * makes EVERY key's octave sit directly above it, not just the head key's.
 *
 * And of those, only a step whose board still RISES (or stays level) to the
 * right: the head key is the bottom-left corner, so a board that falls to the
 * right would put most of itself below it. (The harmonic table's nearest
 * octave, three major thirds along one axis, is such a step — stood upright it
 * runs C3, C2, C1 across the board — so it takes the next one, four keys up
 * at −30°.) Ties go to the smaller turn. Null if no step within reach does it.
 *
 * `across` lays the step to the right instead, and then it is the board's
 * climb UPWARDS that must not be negative — the very steps the upright board
 * turns down: the harmonic table's three major thirds lie level at 0°.
 */
export function octaveStep(steps, n, across = false) {
  const reach = Math.max(12, n);
  let best = null;
  for (let q = -reach; q <= reach; q++) {
    for (let r = -reach; r <= reach; r++) {
      if (keyDegree(q, r, steps) !== n) continue;
      if (keyDegree(-q, -r, steps) !== -n || keyDegree(2 * q, 2 * r, steps) !== 2 * n) continue;
      if (steps.floor && !spansFloors(q, r, steps.floor)) continue;
      const tilt = tiltFor({ q, r }, across);
      if ((across ? riseUpwards(steps, tilt) : riseToRight(steps, tilt)) < -1e-9) continue;
      const length = q * q + r * r + q * r; // squared, in key spacings
      const turn = Math.abs(tilt);
      if (!best || length < best.length || (length === best.length && turn < best.turn)) {
        best = { q, r, length, turn };
      }
    }
  }
  return best && { q: best.q, r: best.r };
}

/** How many degrees a board turned by `tilt` climbs per key spacing to the
 *  right — the horizontal part of its pitch gradient. A floored board climbs
 *  its floors' lift on top of `b`, spread over their rows (or, in strips, on
 *  top of `a`, spread over their width). */
export function riseToRight({ a, b, floor }, tilt) {
  const shallow = a + (floor?.cols ? floor.lift / floor.cols : 0);
  const steep = b + (floor?.rows ? floor.lift / floor.rows : 0);
  // Solve g·e1 = shallow, g·e2 = steep for the gradient g; the basis' determinant is sin 60°.
  return (shallow * Math.sin(tilt + DEG60) - steep * Math.sin(tilt)) / Math.sin(DEG60);
}

/** …and per key spacing UP the board: what climbs up a board is what climbs
 *  to the right of the same board turned a quarter clockwise. */
export function riseUpwards(steps, tilt) {
  return riseToRight(steps, tilt - Math.PI / 2);
}

/** The tilt (radians, −π…π) that points key step {q, r} straight up — or,
 *  `across`, straight to the right. */
export function tiltFor({ q, r }, across = false) {
  const angle = Math.atan2((r * SQRT3) / 2, q + r / 2); // on an unturned board
  const t = (across ? 0 : Math.PI / 2) - angle;
  return Math.atan2(Math.sin(t), Math.cos(t));
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
 *  layout's two steps, plus a period for every FLOOR the key is up — floors
 *  `rows` rows tall (Bosanquet, see findFloor; the degree run across) or
 *  strips `cols` keys wide along q (the degree run, see runSteps). */
export function keyDegree(q, r, { a, b, floor }) {
  const d = q * a + r * b;
  if (!floor) return d;
  return d + Math.floor(floor.cols ? q / floor.cols : r / floor.rows) * floor.lift;
}

/** True when step (q, r) climbs whole floors, so it moves every key by the
 *  same interval, wherever in its floor the key is. */
function spansFloors(q, r, floor) {
  return (floor.cols ? q % floor.cols : r % floor.rows) === 0;
}

const SQRT3 = Math.sqrt(3);
const DEG60 = Math.PI / 3;

/** Unit steps along q and r on a board turned by `tilt` radians, in screen
 *  space (y down), per unit of key size — and the determinant that inverts
 *  them. Cached per tilt: a board has one. */
function basis(tilt) {
  let m = basisCache.get(tilt);
  if (!m) {
    const QX = SQRT3 * Math.cos(tilt), QY = -SQRT3 * Math.sin(tilt);
    const RX = SQRT3 * Math.cos(tilt + DEG60), RY = -SQRT3 * Math.sin(tilt + DEG60);
    m = { QX, QY, RX, RY, DET: QX * RY - QY * RX };
    basisCache.set(tilt, m);
  }
  return m;
}
const basisCache = new Map();

/** Centre of key (q, r), for keys of circumradius `size`, origin at (0, 0)
 *  and y growing DOWNWARD (screen space), on a board turned by `tilt`. */
export function hexCentre(q, r, size, tilt = 0) {
  const { QX, QY, RX, RY } = basis(tilt);
  return { x: size * (q * QX + r * RX), y: size * (q * QY + r * RY) };
}

/** The key under point (x, y) — the inverse of hexCentre, cube-rounded. */
export function pixelToHex(x, y, size, tilt = 0) {
  const { QX, QY, RX, RY, DET } = basis(tilt);
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
export function visibleKeys(width, height, size, origin, tilt = 0) {
  const { QX, QY, RX, RY, DET } = basis(tilt);
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
      const c = hexCentre(q, r, size, tilt);
      const x = origin.x + c.x, y = origin.y + c.y;
      if (x < -size || x > width + size || y < -size || y > height + size) continue;
      out.push({ q, r, x, y });
    }
  }
  return out;
}

// ── Fat fingers ──────────────────────────────────────────────────────────────
//
// Where two keys touch, and where three do, the board can have a touch point
// of its own: a finger landing near the corner three keys share plays all
// three, near the edge two keys share both of them, and anywhere else the key
// under it. On the harmonic table those are its triads (the major and minor
// triangles of the Tonnetz) and its thirds and fifths, each one finger wide.
//
// A zone is a circle — FAT_CORNER of a key's size around a corner, FAT_EDGE
// around an edge's midpoint (corners first where the two meet: their radii
// add up to just past the half-edge between them, so no stretch of a key's
// rim is left for one key alone) — and what is left of a key, about three
// fifths of it, plays that key. A finger holding a zone keeps it until it
// is FAT_SLACK further out, so a finger resting on a rim does not chatter.

export const FAT_CORNER = 0.3;
export const FAT_EDGE = 0.22;
export const FAT_SLACK = 0.05;

/** The six neighbours of a key, anticlockwise from `a`; two in a row are
 *  neighbours of each other too, so each pair meets the key at a corner. */
const AROUND = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

/**
 * The fat-finger zone under point (x, y) (relative to key (0, 0)'s centre):
 * `{ keys: [{q, r}, …], x, y }` with one, two or three keys, and the zone's
 * own point — the key's centre, the edge's midpoint or the corner. `was`,
 * the zone the finger was in, is returned as it is while the finger has not
 * left it.
 */
export function fatZone(x, y, size, tilt = 0, was = null) {
  if (was?.keys.length > 1) {
    const radius = was.keys.length === 3 ? FAT_CORNER : FAT_EDGE;
    if (Math.hypot(x - was.x, y - was.y) <= (radius + FAT_SLACK) * size) return was;
  } else if (was) {
    // Off a lone key only once into a zone further than the slack — or onto
    // another key, which is never further than its rim.
    const z = zoneAt(x, y, size, tilt, FAT_SLACK);
    if (z.keys.length === 1 && z.keys[0].q === was.keys[0].q && z.keys[0].r === was.keys[0].r) return was;
  }
  return zoneAt(x, y, size, tilt, 0);
}

function zoneAt(x, y, size, tilt, shrink) {
  const { q, r } = pixelToHex(x, y, size, tilt);
  const near = (radius, points) => {
    let best = null;
    for (const p of points) {
      const c = hexCentre(p.q, p.r, size, tilt);
      const d = Math.hypot(x - c.x, y - c.y);
      if (d <= (radius - shrink) * size && (!best || d < best.d)) best = { d, keys: p.keys, x: c.x, y: c.y };
    }
    return best && { keys: best.keys, x: best.x, y: best.y };
  };
  const corners = AROUND.map(([aq, ar], i) => {
    const [bq, br] = AROUND[(i + 1) % 6];
    return {
      q: q + (aq + bq) / 3, r: r + (ar + br) / 3,
      keys: [{ q, r }, { q: q + aq, r: r + ar }, { q: q + bq, r: r + br }],
    };
  });
  const edges = AROUND.map(([aq, ar]) => ({
    q: q + aq / 2, r: r + ar / 2, keys: [{ q, r }, { q: q + aq, r: r + ar }],
  }));
  const c = hexCentre(q, r, size, tilt);
  return near(FAT_CORNER, corners) ?? near(FAT_EDGE, edges) ?? { keys: [{ q, r }], x: c.x, y: c.y };
}

/** The touch points to draw around key (q, r) — two of its corners and three
 *  of its edges, so that drawing them for every key draws each point once:
 *  `[{keys, q, r}]`, the point at fractional (q, r). */
export function fatPoints(q, r) {
  const [[aq, ar], [bq, br], [cq, cr]] = AROUND;
  const key = (dq, dr) => ({ q: q + dq, r: r + dr });
  return [
    { keys: [key(0, 0), key(aq, ar), key(bq, br)], q: q + (aq + bq) / 3, r: r + (ar + br) / 3 },
    { keys: [key(0, 0), key(bq, br), key(cq, cr)], q: q + (bq + cq) / 3, r: r + (br + cr) / 3 },
    ...[[aq, ar], [bq, br], [cq, cr]].map(([dq, dr]) => ({ keys: [key(0, 0), key(dq, dr)], q: q + dq / 2, r: r + dr / 2 })),
  ];
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
      const c = hexCentre(q, r, 1); // "up" on the UNTURNED board: the tilt comes after
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

// ── The degree run's strips ──────────────────────────────────────────────────
//
// One degree along a and a whole tone (w degrees) along b has a direction that
// does not climb at all: w keys along a and one row back down, (w, −1), is the
// same note again. Stood up by its octave the way the other layouts are, the
// board repeats itself across — in 12-TET exactly, every other column the
// same notes at the same height — so its width is wasted.
//
// So the board is cut along that repeat into STRIPS w keys wide, each a period
// above the one to its left: (w, −1) is an octave, for every key. A strip
// holds every degree once per period, and then the board is turned to lay
// that step level, which is the turn that makes a strip's pitch depend on
// height alone — the run climbs straight up, and every strip to the right is
// an octave higher. In 12-TET the turn is 30°, which stands the whole tones in
// a column, C D E F♯ G♯ A♯ C′, with C♯ D♯ F … zigzagging beside them, and the
// next C two columns to the right; from 17 tones up a strip leans right, by up
// to 24°.
//
// Across, the same board is taken in a MIRROR (a quarter turn would set the
// run falling, or the strips stacking downwards): whole tones along a, one
// degree along b, cut into floors w rows tall and stood up by their own
// octave step (−1, w). The run climbs across, each floor is an octave above
// the one below, and the turn is 30° less the upright one's — none at all in
// 12-TET, where it is the Bosanquet board.

/** The degree run on an `n`-degree board whose whole tone is `w` degrees. */
function runSteps(n, w, across) {
  if (across) {
    const octave = { q: -1, r: w };
    return { a: w, b: 1, floor: { rows: w, lift: n }, octave, across: true, tilt: tiltFor(octave) };
  }
  const octave = { q: w, r: -1 };
  return { a: 1, b: w, floor: { cols: w, lift: n }, octave, across: false, tilt: tiltFor(octave, true) };
}
