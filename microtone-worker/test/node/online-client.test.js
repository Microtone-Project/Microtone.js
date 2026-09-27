// src/storage/online.js against the real router (server/online/), through a
// cookie-jar fetch — the client and the server checked against each other.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { onlineEnv, browser, taudBytes } from "../fixtures/online-env.js";
import * as online from "../../src/storage/online.js";

let realFetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

/** Point the client at a fresh server, as one browser. */
function connect(env = onlineEnv()) {
  const b = browser(env);
  globalThis.fetch = b.fetch;
  return { env, b };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof online.OnlineError, String(err));
    assert.equal(err.code, code);
    return true;
  });
}

test("status: no API at all is simply 'not available'", async () => {
  // a static host's 404
  globalThis.fetch = async () => new Response("<h1>Not found</h1>", { status: 404 });
  assert.equal((await online.status()).available, false);
  // an SPA fallback answering index.html with 200
  globalThis.fetch = async () => new Response("<!doctype html><title>Microtone</title>");
  assert.equal((await online.status()).available, false);
  // no network
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  assert.equal((await online.status()).available, false);
  // bindings missing
  const b = browser({});
  globalThis.fetch = b.fetch;
  assert.equal((await online.status()).available, false);
});

test("status: an API with no way to sign in yet is hidden too", async () => {
  connect(onlineEnv({ dev: false }));
  assert.deepEqual(await online.status(), { available: false, signedIn: false, signIn: null, user: null });
});

test("status: signed out with a sign-in method, then signed in", async () => {
  const { b } = connect();
  assert.deepEqual(await online.status(), { available: true, signedIn: false, signIn: "dev", user: null });
  await rejectsWith(online.list(), "signed-out");
  await b.signIn("alice");
  assert.deepEqual(await online.status(),
    { available: true, signedIn: true, signIn: "dev", user: { name: "alice (local test)" } });
});

test("the sign-in page broadcasts under the name the client listens for", async () => {
  const { b } = connect();
  const html = await (await b.signIn("alice")).text();
  assert.ok(html.includes(`new BroadcastChannel(${JSON.stringify(online.AUTH_CHANNEL)})`));
});

test("a whole session: create, list, open, save, conflict, rename, remove", async () => {
  const { b } = connect();
  await b.signIn("alice");

  const p = await online.create("tune.taud", taudBytes(100, 1));
  assert.equal(p.name, "tune.taud");
  await rejectsWith(online.create("tune.taud", taudBytes()), "exists");
  await rejectsWith(online.create("tune.taud.bak", taudBytes()), "bad-name");
  await rejectsWith(online.create("x.taud", new Uint8Array(64)), "not-taud");

  const listing = await online.list();
  assert.equal(listing.limit, 16);
  assert.deepEqual(listing.projects.map((q) => q.id), [p.id]);

  // open it here, and in "another browser" (the same etag, read twice)
  const here = await online.read(p.id);
  const there = await online.read(p.id);
  assert.deepEqual(here.bytes, taudBytes(100, 1));
  assert.equal(here.etag, p.etag);

  const saved = await online.save(p.id, taudBytes(120, 2), here.etag);
  assert.notEqual(saved.etag, here.etag);
  // the other copy is now stale, and is told so rather than winning
  await rejectsWith(online.save(p.id, taudBytes(90, 3), there.etag), "conflict");
  assert.deepEqual((await online.read(p.id)).bytes, taudBytes(120, 2));
  // …until its owner says to overwrite
  const forced = await online.save(p.id, taudBytes(90, 3), null);
  assert.equal(forced.size, 90);

  const renamed = await online.rename(p.id, "tune 2.taud");
  assert.equal(renamed.name, "tune 2.taud");
  await online.remove(p.id);
  assert.deepEqual((await online.list()).projects, []);
  await rejectsWith(online.read(p.id), "not-found");
});

test("the seventeenth project is refused with 'quota'", async () => {
  const { b } = connect();
  await b.signIn("alice");
  for (let i = 0; i < 16; i++) await online.create(`s${i}.taud`, taudBytes());
  await rejectsWith(online.create("s16.taud", taudBytes()), "quota");
});

test("sign out: the session is gone and every tab is told", async () => {
  const { b } = connect();
  await b.signIn("alice");
  const heard = [];
  const off = online.onAuthChange((type) => heard.push(type));
  try {
    await online.signOut();
    assert.equal((await online.status()).signedIn, false);
    await rejectsWith(online.list(), "signed-out");
    // BroadcastChannel delivers on a later turn
    for (let i = 0; i < 50 && heard.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(heard, ["signed-out"]);
  } finally {
    off();
  }
});

test("a dropped connection is 'offline', not a crash", async () => {
  globalThis.fetch = async () => { throw new TypeError("NetworkError when attempting to fetch resource."); };
  await rejectsWith(online.list(), "offline");
  await rejectsWith(online.save("p_0000000000000000", taudBytes(), "x"), "offline");
});
