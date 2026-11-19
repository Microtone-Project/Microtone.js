// The words of RtAudio's that the desktop's native audio host acts on
// (desktop-qt/src/nativeaudio.cpp, linuxaudiowatch.cpp), pinned to the
// vendored copy: RtAudio's Linux backends tell of a stream whose writes fail
// only as a warning, in words, so an RtAudio update that rewords them must
// fail here rather than leave a broken stream playing nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../../../desktop-qt/${path}`, import.meta.url), "utf8");
const rtaudio = read("vendor/rtaudio/RtAudio.cpp");
const host = read("src/nativeaudio.cpp");
const watch = read("src/linuxaudiowatch.cpp");

test("a failing write is said in the words the host matches (linuxStreamBroken)", () => {
  // The host's prefixes, as nativeaudio.cpp spells them…
  for (const where of ["RtApiAlsa::callbackEvent", "RtApiPulse::callbackEvent", "RtApiJack::callbackEvent"]) {
    assert.ok(host.includes(`"${where}"`), `nativeaudio.cpp matches ${where}`);
  }
  // …and RtAudio's warnings that begin with them.
  assert.ok(rtaudio.includes('"RtApiAlsa::callbackEvent: audio write error, " << snd_strerror'));
  assert.ok(rtaudio.includes('"RtApiAlsa::callbackEvent: error preparing device after underrun, "'));
  assert.ok(rtaudio.includes('"RtApiPulse::callbackEvent: audio write error, "'));
  assert.ok(rtaudio.includes('"RtApiJack::callbackEvent(): the JACK buffer size has changed ... cannot process!"'));
});

test("an ALSA underrun is a dropout, not a loss: its words are the ones excepted", () => {
  assert.ok(rtaudio.includes('"RtApiAlsa::callbackEvent: audio write error, underrun."'));
  assert.ok(host.includes('"audio write error, underrun"'));
});

test("RtAudio lists JACK's devices through a client the watch knows to pass over", () => {
  // A list made because the watch saw that client would make the next.
  assert.ok(rtaudio.includes('jack_client_open( "RtApiJackProbe", options, status )'));
  assert.ok(watch.includes('"RtApiJackProbe"'));
});

test("RtAudio opens PulseAudio's default by its sink's name: the host opens it afresh to follow the default", () => {
  // Were RtAudio to pass no name for the default, the server would move the
  // stream itself, and the reopen would only be a gap.
  assert.ok(rtaudio.includes("dev_output = paDeviceList_[deviceIdx].sinkName.c_str();"));
  assert.ok(rtaudio.includes("info.isDefaultOutput = ( paProbeInfo->defaultSinkName == i->name );"));
  assert.ok(/api == RtAudio::LINUX_PULSE\) \{/.test(host), "openRtAudio makes a fresh PulseAudio instance");
});
