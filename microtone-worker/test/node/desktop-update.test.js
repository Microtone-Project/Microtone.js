// The desktop app's update address (server/desktop-update.js): a redirect to
// the channel's manifest on GitHub, from an address on this site that every
// installed copy has compiled in.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../../server/worker.js";
import { CHANNELS } from "../../server/desktop-update.js";

const ask = (path, init) => worker.fetch(new Request(new URL(path, "https://microtone.cc"), init), {});

test("each channel goes to its manifest, stable by default", async () => {
  for (const [query, to] of [["", CHANNELS.stable], ["?channel=stable", CHANNELS.stable],
    ["?channel=preview&version=5.0.5&platform=windows-x86_64", CHANNELS.preview]]) {
    const res = await ask(`/api/desktop/update${query}`);
    assert.equal(res.status, 302, query);
    assert.equal(res.headers.get("location"), to);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.match(CHANNELS.stable, /^https:\/\/github\.com\/Microtone-Project\/Microtone\.js\/releases\/latest\/download\/desktop\.json$/);
  assert.match(CHANNELS.preview, /\/releases\/download\/desktop-preview\/desktop\.json$/);
});

test("an unknown channel, another method, a neighbouring path", async () => {
  assert.equal((await ask("/api/desktop/update?channel=nightly")).status, 400);
  assert.equal((await ask("/api/desktop/update?channel=toString")).status, 400);
  assert.equal((await ask("/api/desktop/update", { method: "POST" })).status, 405);
  assert.equal((await ask("/api/desktop/update/x")).status, 404);
  assert.equal((await ask("/api/desktop")).status, 404);
});

test("the Qt build trusts exactly the Tauri build's updater key", async () => {
  const { readFile } = await import("node:fs/promises");
  const header = await readFile(new URL("../../../desktop-qt/src/updatekey.h", import.meta.url), "utf8");
  const tauri = JSON.parse(await readFile(new URL("../../../desktop/tauri.conf.json", import.meta.url), "utf8"));
  const compiled = /kUpdateKey\[\] =\s*"([A-Za-z0-9+/=]+)";/.exec(header)?.[1];
  assert.ok(compiled, "updatekey.h holds the key");
  assert.equal(compiled, tauri.plugins.updater.pubkey);
});
