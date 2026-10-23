// Language debug mode (`?lang=debug`, src/ui/i18n.js): every string shows as
// its key in full and the start of its English; it is never saved, and the
// picker offers it only while it is on.

import { test } from "node:test";
import assert from "node:assert/strict";

import { t, changeLang, currentLang, pickerLangs, debugLabel, DEBUG_LANG, DEBUG_ENGLISH_CHARS, LANGS } from "../../src/ui/i18n.js";
import en from "../../src/ui/lang/en.js";

test("a debug label: the key whole, the English cut with an ellipsis", () => {
  assert.equal(debugLabel("topbar.playSong", "Song"), "[topbar.playSong] Song");
  const long = debugLabel("topbar.playSongTitle", "Play from start (Shift+Space)");
  assert.ok(long.startsWith("[topbar.playSongTitle] Play from"));
  assert.ok(long.endsWith("…"));
  assert.equal([...long.slice("[topbar.playSongTitle] ".length)].length, DEBUG_ENGLISH_CHARS);
  assert.equal(debugLabel("x.y", "line one\nline two"), "[x.y] line one line…", "line breaks fold to spaces");
  assert.equal(debugLabel("css.font", ""), "[css.font]");
  assert.equal(debugLabel("no.such", undefined), "[no.such] (no English)");
});

test("the mode is offered only while on, and switching to it without the address does nothing", async () => {
  assert.deepEqual(pickerLangs(), LANGS);
  assert.equal(await changeLang(DEBUG_LANG), false);
  assert.equal(currentLang(), "en");
  assert.equal(t("topbar.playSong"), en["topbar.playSong"]);
});

test("?lang=debug: t() labels every string, placeholders filled, and the picker can leave and return", async () => {
  globalThis.location = { search: "?lang=debug" };
  try {
    const { initI18n } = await import("../../src/ui/i18n.js");
    await initI18n();
    assert.equal(currentLang(), DEBUG_LANG);
    assert.ok(DEBUG_LANG in pickerLangs());
    assert.equal(t("topbar.playSong"), "[topbar.playSong] Song");
    assert.equal(t("imix.unisDetune", { c: 5 }), "[imix.unisDetune] Detune (±5 ¢)", "the English with its placeholders filled");
    assert.equal(t("ctx.muteTitle", { ch: 7 }), "[ctx.muteTitle] Silence lane…");
    assert.equal(t("no.such.key"), "[no.such.key] (no English)");
    assert.equal(await changeLang("en"), true);
    assert.equal(t("topbar.playSong"), "Song");
    assert.equal(await changeLang(DEBUG_LANG), true, "back in without a reload");
    assert.equal(t("topbar.playSong"), "[topbar.playSong] Song");
  } finally {
    delete globalThis.location;
  }
});
