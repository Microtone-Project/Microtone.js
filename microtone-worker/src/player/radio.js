// The radio (item 373): when a song is over, the next one — and "over" for a
// tracker song is a decision, because most of them never end: their last cue
// jumps back and they play forever.
//
// LoopWatch decides it from the cues a playhead passes through. A jump BACK
// across a stretch of the song it has already played (at least `minSpan`
// cues, or back to the song's first cue) is the loop; the cue it lands on is
// played once more, so the listener hears the song turn round, and the
// moment that cue gives way is the SEAM where the next song begins. A song
// that stops by itself (a halt) is a seam at once.
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

export class LoopWatch {
  constructor({ minSpan = LOOP_MIN_SPAN } = {}) {
    this.minSpan = minSpan;
    this.reset();
  }

  /** Forget everything: a new song starts at `firstCue`. */
  reset(firstCue = 0) {
    this.firstCue = firstCue;
    this.visited = new Set();
    this.lastCue = -1;
    this.started = false;
    this.looped = false;
    this.loopFrom = -1;
    this.loopTo = -1;
  }

  /**
   * Feed one observation of the playhead. Returns null while the song goes
   * on, "loop" the moment the loop is recognised, "seam" when the cue after
   * the loop has been played (or a song that has looped once moves on in any
   * way), and "end" when the song stopped by itself after having started.
   */
  observe(cue, playing) {
    if (!playing) return this.started ? "end" : null;
    if (!this.started) {
      this.started = true;
      this.lastCue = cue;
      this.visited.add(cue);
      return null;
    }
    if (cue === this.lastCue) return null;
    const from = this.lastCue;
    this.lastCue = cue;
    if (this.looped) return "seam";
    if (cue < from && this.visited.has(cue) &&
        (from - cue + 1 >= this.minSpan || cue <= this.firstCue)) {
      this.looped = true;
      this.loopFrom = from;
      this.loopTo = cue;
      return "loop";
    }
    this.visited.add(cue);
    return null;
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
