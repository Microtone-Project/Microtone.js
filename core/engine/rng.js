// Randomness seams for the Taud engine. No engine file may call Math.random
// directly — everything routes through here so tests (the golden gate) can seed it.
//
// Two independent streams, mirroring AudioAdapter.kt:
//  - xorshift32: the noise-shaped dither PRNG in pcm32fToPcm8 (deterministic,
//    seeded constant per adapter instance — AudioAdapter.kt:1199-1214)
//  - random(): Math.random uses — vol/pan swing at trigger (2593-2597) and the
//    random LFO waveform 3 (1432). Musically intended nondeterminism in
//    production; injectable for tests.

export function makeXorshift32(seed = 0x9e3779b9) {
  let x = seed >>> 0;
  return function xorshift32() {
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x = x >>> 0;
    return x;
  };
}

// Injectable uniform [0,1) source.
let _random = Math.random;

export function random() {
  return _random();
}

/** Replace the uniform source (pass null to restore Math.random). */
export function setRandomSource(fn) {
  _random = fn ?? Math.random;
}

/** Simple seedable mulberry32 for tests. */
export function makeSeededRandom(seed = 1) {
  let a = seed >>> 0;
  return function mulberry32() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
