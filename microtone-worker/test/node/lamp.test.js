// Shared blinkenlight ballistics (user request) — the probabilistic-OR
// combiner, the attack/decay-asymmetric slew, and the per-voice bucketing
// every play-indicator lamp in the app (Instruments/Samples tabs' dot, the
// instrument lookup's own lit number) is built on. lamp.js lives in src/ui/,
// not core/engine/, but its maths carries no DOM dependency (matchMedia is
// feature-detected away), so it is exercised directly here rather than only
// through a browser smoke.

import test from "node:test";
import assert from "node:assert/strict";

import {
  LAMP_ATTACK_MS, LAMP_DECAY_MS, combineBrightness, Lamp, liveBrightnessByKey,
} from "../../src/ui/lamp.js";

test("combineBrightness: probabilistic OR, not a sum", () => {
  assert.equal(combineBrightness([]), 0);
  assert.equal(combineBrightness([0.5]), 0.5);
  // 1 - (1-0.5)(1-0.5) = 0.75 — climbs toward full, never past it.
  assert.ok(Math.abs(combineBrightness([0.5, 0.5]) - 0.75) < 1e-9);
  // A second, quieter voice still brightens an already-loud one — but by
  // less than a lone voice at that same level would (the whole point of
  // "probabilistic", not "additive").
  const soloQuiet = combineBrightness([0.2]);
  const addedToLoud = combineBrightness([0.9, 0.2]) - combineBrightness([0.9]);
  assert.ok(addedToLoud > 0 && addedToLoud < soloQuiet,
    `${addedToLoud} should sit in (0, ${soloQuiet})`);
  // One voice at full volume saturates the lamp outright.
  assert.equal(combineBrightness([1, 0.3, 0.7]), 1);
  // Out-of-range inputs clamp rather than going negative or over 1.
  assert.equal(combineBrightness([-0.5]), 0);
  assert.equal(combineBrightness([1.5]), 1);
  // Order does not matter (it's a product).
  assert.equal(combineBrightness([0.3, 0.6, 0.1]), combineBrightness([0.6, 0.1, 0.3]));
});

test("Lamp: attack is faster than decay, both frame-rate independent", () => {
  // One attack time constant covers ~63% of a RISING step.
  const rising = new Lamp();
  rising.value = 0;
  const afterOneTau = rising.update(1, LAMP_ATTACK_MS);
  assert.ok(Math.abs(afterOneTau - 0.6321) < 0.01, String(afterOneTau));

  // The same elapsed time on the DECAY constant covers much less — it is
  // the slower of the two, so a short burst should barely fall at all.
  const falling = new Lamp();
  falling.value = 1;
  const afterShortDecay = falling.update(0, LAMP_ATTACK_MS);
  assert.ok(afterShortDecay > 0.9, String(afterShortDecay));

  // One full decay time constant covers ~63% of a FALLING step.
  const falling2 = new Lamp();
  falling2.value = 1;
  const afterOneDecayTau = falling2.update(0, LAMP_DECAY_MS);
  assert.ok(Math.abs(afterOneDecayTau - (1 - 0.6321)) < 0.01, String(afterOneDecayTau));

  // Ten small steps land the same place one big step of the same total time
  // does (the reused slewTowards already proves this in general; this just
  // confirms Lamp actually calls it rather than some fixed per-frame hop).
  const stepped = new Lamp();
  for (let i = 0; i < 10; i++) stepped.update(1, LAMP_ATTACK_MS / 10);
  const jumped = new Lamp().update(1, LAMP_ATTACK_MS);
  assert.ok(Math.abs(stepped.value - jumped) < 1e-6, `${stepped.value} vs ${jumped}`);
});

test("Lamp: settles exactly and never overshoots or goes eternal", () => {
  const lamp = new Lamp();
  for (let i = 0; i < 200; i++) lamp.update(1, 16);
  assert.equal(lamp.value, 1, "reaches exactly 1, no asymptotic creep forever");
  for (let i = 0; i < 200; i++) lamp.update(0, 16);
  assert.equal(lamp.value, 0);
  // A target that never quite arrives (rapid on/off) still stays in [0,1].
  const flicker = new Lamp();
  for (let i = 0; i < 50; i++) flicker.update(i % 2, 3);
  assert.ok(flicker.value >= 0 && flicker.value <= 1, String(flicker.value));
});

test("liveBrightnessByKey: buckets active voices by key and combines each bucket", () => {
  // Voice 2 is inactive and must be excluded even though it reports a volume.
  const fakeAudio = {
    getVoiceActive: (vi) => vi !== 2,
    getVoiceInstrument: (vi) => [0x01, 0x01, 0x01, 0x02][vi],
    getVoiceEffectiveVolume: (vi) => [0.5, 0.5, 1, 0.4][vi],
  };
  const byInst = liveBrightnessByKey(fakeAudio, 4, (vi) => fakeAudio.getVoiceInstrument(vi));
  assert.equal(byInst.size, 2);
  // Slot 1: voices 0 and 1 (both 0.5) — voice 2 (also slot 1) is inactive and
  // must NOT be folded in, so this is combineBrightness([0.5, 0.5]) = 0.75,
  // not the [0.5, 0.5, 1] a naive scan would produce.
  assert.ok(Math.abs(byInst.get(0x01) - 0.75) < 1e-9, String(byInst.get(0x01)));
  assert.ok(Math.abs(byInst.get(0x02) - 0.4) < 1e-9);

  // A keyOf that excludes some voices (returns null) drops them entirely —
  // voice 3's 0.4 fails the >= 0.5 test here, so slot 2 never appears.
  const onlyLoud = liveBrightnessByKey(fakeAudio, 4,
    (vi) => (fakeAudio.getVoiceActive(vi) && fakeAudio.getVoiceEffectiveVolume(vi) >= 0.5)
      ? fakeAudio.getVoiceInstrument(vi) : null);
  assert.equal(onlyLoud.has(0x02), false);
  assert.ok(Math.abs(onlyLoud.get(0x01) - 0.75) < 1e-9); // voices 0 and 1 both qualify

  // No active voices at all: an empty map, not a crash.
  const silence = liveBrightnessByKey({ getVoiceActive: () => false }, 4, (vi) => vi);
  assert.equal(silence.size, 0);
});
