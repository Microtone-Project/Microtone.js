// src/storage/online.js against the real router (server/online/), through a
// cookie-jar fetch — the client and the server checked against each other.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { onlineEnv, browser, taudBytes } from "../fixtures/online-env.js";
import * as online from "../../src/storage/online.js";
import { PROJECT_LIMIT } from "../../server/online/util.js";

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
  assert.equal(listing.limit, PROJECT_LIMIT);
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

test("one project past the limit is refused with 'quota'", async () => {
  const { b } = connect();
  await b.signIn("alice");
  for (let i = 0; i < PROJECT_LIMIT; i++) await online.create(`s${i}.taud`, taudBytes());
  await rejectsWith(online.create("one-more.taud", taudBytes()), "quota");
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

test("read: a watched project reports its bytes arriving, through the real router", async () => {
  const { b } = connect();
  await b.signIn("alice");
  const p = await online.create("big.taud", taudBytes(4000, 7));
  const heard = [];
  const got = await online.read(p.id, { size: p.size, onProgress: (f) => heard.push(f) });
  assert.deepEqual(got.bytes, taudBytes(4000, 7));
  assert.equal(got.etag, p.etag);
  assert.ok(heard.length >= 1);
  assert.equal(heard.at(-1), 1);
});

/** A reply that arrives in `parts`, and (optionally) breaks off after them. */
function trickle(parts, { length = null, breakOff = false } = {}) {
  return async () => {
    const stream = new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        if (breakOff) controller.error(new TypeError("network error"));
        else controller.close();
      },
    });
    const headers = { etag: '"e1"' };
    if (length !== null) headers["content-length"] = String(length);
    return new Response(stream, { headers });
  };
}

test("read: progress climbs with each chunk, and the listing's size stands in for a missing length", async () => {
  const parts = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5, 6]), new Uint8Array([7, 8])];
  let heard = [];
  globalThis.fetch = trickle(parts, { length: 8 });
  const got = await online.read("p_x", { onProgress: (f) => heard.push(f) });
  assert.deepEqual([...got.bytes], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(got.etag, "e1");
  assert.deepEqual(heard, [0.25, 0.75, 1]);

  heard = [];
  globalThis.fetch = trickle(parts);
  await online.read("p_x", { size: 8, onProgress: (f) => heard.push(f) });
  assert.deepEqual(heard, [0.25, 0.75, 1]);

  // no length from anywhere: no bar to fill, the bytes still come
  heard = [];
  globalThis.fetch = trickle(parts);
  assert.equal((await online.read("p_x", { onProgress: (f) => heard.push(f) })).bytes.length, 8);
  assert.deepEqual(heard, []);
});

test("read: a connection lost half-way is 'offline'", async () => {
  const parts = [new Uint8Array([1, 2, 3])];
  globalThis.fetch = trickle(parts, { length: 8, breakOff: true });
  await rejectsWith(online.read("p_x", { onProgress: () => {} }), "offline");
  globalThis.fetch = trickle(parts, { length: 8, breakOff: true });
  await rejectsWith(online.read("p_x"), "offline");
});
