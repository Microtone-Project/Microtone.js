// The desktop Settings tab's buffer choices (src/ui/views/settings.js): the
// sizes offered for an output are the ones it will take — WASAPI's modes each
// have limits on each device (desktop-qt/src/wasapi.h), and offering a size
// the mode refuses would only round it behind the person's back.
import { test } from "node:test";
import assert from "node:assert/strict";

import { bufferChoices } from "../../src/ui/views/settings.js";

test("an output without limits offers the usual six sizes", () => {
  assert.deepEqual(bufferChoices(null), [64, 128, 256, 512, 1024, 2048]);
});

test("the shared mixer: its own period first, nothing shorter", () => {
  assert.deepEqual(bufferChoices({ min: 480 }), [480, 512, 1024, 2048]);
  assert.deepEqual(bufferChoices({ min: 441 }), [441, 512, 1024, 2048]);
});

test("low-latency shared: inside the driver's range, on its step, its ends included", () => {
  assert.deepEqual(bufferChoices({ min: 128, max: 480, step: 32 }), [128, 256, 480]);
  assert.deepEqual(bufferChoices({ min: 144, max: 480, step: 48 }), [144, 480]);
});

test("exclusive: from the device's shortest period up", () => {
  assert.deepEqual(bufferChoices({ min: 96 }), [96, 128, 256, 512, 1024, 2048]);
  assert.deepEqual(bufferChoices({ min: 128 }), [128, 256, 512, 1024, 2048]);
});
