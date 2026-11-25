// The Tauri build's move to the next desktop app (server/desktop-update.js):
// Tauri copies from 5.0.6 on ask the site with from=tauri, and on the stable
// channel hear "nothing new" (204, the Tauri updater's word for it) until
// TAURI_MOVES is thrown; then the new app's manifest, as every other copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHANNELS, TAURI_MOVES, UPDATE_PATH, desktopUpdate } from "../../server/desktop-update.js";

const ask = (query, options) => desktopUpdate(new Request(`https://microtone.cc${UPDATE_PATH}?${query}`), options);

test("a Tauri copy on stable hears nothing new until the switch", () => {
  const res = ask("channel=stable&from=tauri&version=5.0.6&platform=windows-x86_64-nsis", { tauriMoves: false });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("thrown, the switch sends a Tauri copy to the new app's manifest", () => {
  const res = ask("channel=stable&from=tauri&version=5.0.6", { tauriMoves: true });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), CHANNELS.stable);
});

test("the preview channel moves a Tauri copy at once (how the move is tried)", () => {
  const res = ask("channel=preview&from=tauri", { tauriMoves: false });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), CHANNELS.preview);
});

test("the new app's own copies are not held back", () => {
  for (const query of ["channel=stable", "", "channel=stable&version=5.1.0&platform=linux-x86_64-appimage"]) {
    const res = ask(query, { tauriMoves: false });
    assert.equal(res.status, 302, query);
    assert.equal(res.headers.get("location"), CHANNELS.stable, query);
  }
});

test("the switch is a boolean", () => {
  assert.equal(typeof TAURI_MOVES, "boolean");
});

test("the Tauri build asks this address, on stable, as from=tauri", () => {
  const conf = JSON.parse(readFileSync(new URL("../../../desktop/tauri.conf.json", import.meta.url), "utf8"));
  const [endpoint, ...more] = conf.plugins.updater.endpoints;
  assert.equal(more.length, 0);
  const url = new URL(endpoint);
  assert.equal(`${url.origin}${url.pathname}`, `https://microtone.cc${UPDATE_PATH}`);
  assert.equal(url.searchParams.get("channel"), "stable");
  assert.equal(url.searchParams.get("from"), "tauri");
});
