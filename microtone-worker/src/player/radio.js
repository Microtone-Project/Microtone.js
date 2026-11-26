// The radio (item 373): when a song is over, the next one — and "over" for a
// tracker song is a decision, because most of them never end: their last cue
// jumps back and they play forever.
//
// RadioWatch decides it from what a playhead passes through. A jump BACK
// across a stretch of the song it has already played (at least `minSpan`
// cues, or back to the song's first cue) is the loop. A song that has looped
// plays on — round again if it must — until it has played `minSeconds`
// (170 s), and then to the next 4-bar line: that line is the SEAM where the
// next song begins, beat-matched. Bars are counted as they are played, from
// the song's first row (a bar is `rowsPerBar` rows, sMet's secondary beat;
// a new cue starts a new one), so the outgoing song always leaves at the
// start of its (4n)th bar, n > 0, and the incoming one starts at its first —
// both on the same 4-bar grid. The loop's own jump is never the seam: the
// listener hears the song come round.
//
// A song that FADES OUT is over where it fades: if it has faded when it loops
// or stops, the watch says "fade", and the next song starts from its
// beginning at its own tempo, not matched to a silence. The fade is read off
// the song's written level (taudplay level.js — global volume × the loudest
// lane's note and lane volume, i.e. V/W, the volume column and D, M and N),
// as it was just BEFORE the loop or the stop: under FADE_RATIO of the
// loudest the song has been. Envelopes are not in that level, so a note
// decaying into a rest is not a fade. A song that stops by itself without
// fading is an "end", and the next one is matched to it.
//
// The same watch drives the Microtone Player's radio and the Music Hub's
// catalogue walk (how long a song plays before the radio moves on), so the
// length the Hub lists is the length the player plays.
//
// The radio mix is beat-matched and NOT crossfaded: the next song starts at
// the outgoing song's tempo — folded by octaves, so a song twice as fast is
// already matched at half time — and glides to its own over a few bars, by
// the engine's tempo scale (taudplay `setTempoScale`). Pure: no DOM, no audio.

export const LOOP_MIN_SPAN = 4;
/** A looping song plays at least this long before the radio moves on. */
export const RADIO_MIN_SECONDS = 170;
/** The grid the radio mixes on, in bars. */
export const MIX_BARS = 4;
/** Faded: the written level just before the end is under this share of the
 *  loudest it has been (1/8, −18 dB). */
export const FADE_RATIO = 1 / 8;

export class RadioWatch {
  constructor({ minSpan = LOOP_MIN_SPAN, minSeconds = RADIO_MIN_SECONDS, mixBars = MIX_BARS, rowsPerBar = 16 } = {}) {
    this.minSpan = minSpan;
    this.minSeconds = minSeconds;
    this.mixBars = mixBars;
    this.rowsPerBar = rowsPerBar;
    this.reset();
  }

  /** Forget everything: a new song starts at `firstCue`. */
  reset(firstCue = 0, rowsPerBar = this.rowsPerBar) {
    this.firstCue = firstCue;
    this.rowsPerBar = Math.max(1, rowsPerBar | 0 || 16);
    this.visited = new Set();
    this.lastCue = -1;
    this.lastRow = 0;
    this.started = false;
    this.looped = false;
    this.loopFrom = -1;
    this.loopTo = -1;
    this.seconds = 0;   // song time played since the start
    this.bar = 0;       // bars begun since the start, the first one is 0
    this.armed = false; // the next bar line is the seam
    this.level = -1;    // the written level last seen while a lane sounded
    this.peak = 0;      // the loudest it has been
  }

  /** The song has faded out, by what it was last heard at. */
  get faded() {
    return this.peak > 0 && this.level >= 0 && this.level < this.peak * FADE_RATIO;
  }

  /**
   * Feed one observation of the playhead: where it is (`cue`, `row`),
   * whether it plays, the song time `dt` (seconds) since the previous
   * observation, and the written `level` now (−1 while no lane sounds).
   * Returns null while the song goes on, "loop" the moment the loop is
   * recognised, "seam" at the bar line where the beat-matched next song
   * begins, "fade" when a song that has faded out loops or stops (the next
   * one starts as written), and "end" when it stopped by itself unfaded.
   *
   * `armed` turns true while the bar BEFORE the seam plays: a host that
   * halts its engine at the next bar line then (taudplay `stopAtBarLine`)
   * cuts exactly on it, and the halt is read as the seam.
   */
  observe({ cue, row = 0, playing, dt = 0, level = -1 }) {
    if (!playing) {
      if (!this.started) return null;
      return this.faded ? "fade" : this.armed ? "seam" : "end";
    }
    if (!this.started) {
      this.started = true;
      this.lastCue = cue;
      this.lastRow = row;
      this.visited.add(cue);
      this._hear(level);
      return null;
    }
    this.seconds += dt;
    let ev = null;
    const rpb = this.rowsPerBar;
    const crossed = cue !== this.lastCue || Math.floor(row / rpb) !== Math.floor(this.lastRow / rpb);
    if (cue !== this.lastCue && !this.looped) {
      const from = this.lastCue;
      if (cue < from && this.visited.has(cue) &&
          (from - cue + 1 >= this.minSpan || cue <= this.firstCue)) {
        this.looped = true;
        this.loopFrom = from;
        this.loopTo = cue;
        // Judged on the level BEFORE this observation: the jump has already
        // struck the song's first notes again.
        ev = this.faded ? "fade" : "loop";
      } else {
        this.visited.add(cue);
      }
    }
    this.lastCue = cue;
    this.lastRow = row;
    if (crossed) {
      this.bar++;
      if (this.armed) return "seam";
    }
    this._hear(level);
    if (!this.armed && this.looped && ev !== "fade" && this.seconds >= this.minSeconds &&
        (this.bar + 1) % this.mixBars === 0) {
      this.armed = true;
    }
    return ev;
  }

  _hear(level) {
    if (!(level >= 0)) return; // nothing sounds: keep what was last heard
    this.level = level;
    if (level > this.peak) this.peak = level;
  }
}

/**
 * The tempo scale the INCOMING song starts at so that its rows land on the
 * outgoing song's: the ratio of the two tempos (BPM ÷ speed, the outgoing
 * one as it sounds — its own scale included), folded by octaves into
 * [1/√2, √2), then held to the engine's 0.25…4.
 */
export function matchScale(outTempo, inTempo) {
  if (!(outTempo > 0) || !(inTempo > 0)) return 1;
  let r = outTempo / inTempo;
  while (r >= Math.SQRT2) r /= 2;
  while (r < Math.SQRT1_2) r *= 2;
  return Math.min(4, Math.max(0.25, r));
}

/** Bars the incoming song glides over, back to its own tempo. */
export const GLIDE_BARS = 4;

/**
 * Seconds of the incoming song's own time that `GLIDE_BARS` bars last:
 * rows per bar (sMet's secondary beat, 16 by default) × the row's length,
 * `speed` ticks of 2.5 ÷ BPM seconds. Held to 4…20 s so neither a frantic
 * song nor a dirge makes the glide a lurch or a crawl.
 */
export function glideSeconds(bpm, speed, rowsPerBar = 16) {
  if (!(bpm > 0) || !(speed > 0)) return 8;
  const s = GLIDE_BARS * (rowsPerBar || 16) * speed * 2.5 / bpm;
  return Math.min(20, Math.max(4, s));
}

/**
 * Pick the next song from `pool` (anything with an `id`), at random, never
 * the one playing unless it is all there is, and not one of the `recent` ids
 * while any other is left. `rand` is a function returning [0, 1).
 */
export function pickNext(pool, currentId, recent = [], rand = Math.random) {
  if (!pool.length) return null;
  let choices = pool.filter((s) => s.id !== currentId && !recent.includes(s.id));
  if (!choices.length) choices = pool.filter((s) => s.id !== currentId);
  if (!choices.length) choices = pool;
  return choices[Math.floor(rand() * choices.length) % choices.length];
}
