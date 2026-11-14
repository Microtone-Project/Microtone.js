// Randomness seams for the Taud engine. No engine file may call Math.random
// directly — everything routes through here so tests (the golden gate) can seed it.
//
// The engine's own streams live in the module (its mulberry32, and the dither's
// xorshift32 at the adapter's seed — mixer.c te_xorshift32). What is here is
// random(): Math.random uses — vol/pan swing at trigger and the random LFO
// waveform — musically intended nondeterminism in production, injectable for
// tests, and the seed the module's stream starts from (engineSeed).

// Injectable uniform [0,1) source.
let _random = Math.random;

export function random() {
  return _random();
}

/** Replace the uniform source (pass null to restore Math.random). */
export function setRandomSource(fn) {
  _random = fn ?? Math.random;
}

/** Simple seedable mulberry32 for tests. Its `state()` is where the stream
 *  stands — what a WebAssembly engine continues it from (engineSeed). */
export function makeSeededRandom(seed = 1) {
  let a = seed >>> 0;
  function mulberry32() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  mulberry32.state = () => a;
  return mulberry32;
}

/**
 * The 32-bit state a WebAssembly engine starts its own generator from. The
 * module imports nothing, so it cannot call the source installed here; it runs
 * the same mulberry32 inside instead. With a makeSeededRandom source installed
 * the engine continues THAT stream from where it stands, so a seeded render is
 * the same render in either engine; otherwise the seed is one draw from the
 * source in force (Math.random in production).
 */
export function engineSeed() {
  if (typeof _random.state === "function") return _random.state() >>> 0;
  return Math.floor(_random() * 4294967296) >>> 0;
}
