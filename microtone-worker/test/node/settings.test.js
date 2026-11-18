// The desktop Settings tab's buffer choices (src/ui/views/settings.js): the
// sizes offered for an output are the ones it will take — WASAPI's modes each
// have limits on each device (desktop-qt/src/wasapi.h), an open ASIO driver
// has its own (nativeaudio.cpp's status bufferLimits), and offering a size
// the output refuses would only round it behind the person's back.
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

test("ASIO: the driver's own size (0) first, then what the open driver allows", () => {
  // Powers of two from 64 to 2048 (granularity -1 is sent as step 1).
  assert.deepEqual(bufferChoices({ min: 64, max: 2048, step: 1 }, true), [0, 64, 128, 256, 512, 1024, 2048]);
  // Steps of 32 from 96: the usual sizes on the step, the ends included.
  assert.deepEqual(bufferChoices({ min: 96, max: 1024, step: 32 }, true), [0, 96, 128, 256, 512, 1024]);
  // A driver with one size only (granularity 0: min = max = preferred).
  assert.deepEqual(bufferChoices({ min: 480, max: 480, step: 1 }, true), [0, 480]);
  // Another driver than the open one: its sizes are unknown until it opens.
  assert.deepEqual(bufferChoices(null, true), [0, 64, 128, 256, 512, 1024, 2048]);
});
