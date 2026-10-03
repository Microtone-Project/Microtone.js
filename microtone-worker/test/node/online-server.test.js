// Online projects server (server/online/) against a real SQLite loaded from
// migrations/ and an in-memory R2 — see test/fixtures/online-env.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { onlineEnv, browser, taudBytes, sketchBytes, barrier } from "../fixtures/online-env.js";
import { handle } from "../../server/online/router.js";
import worker from "../../server/worker.js";
import {
  cleanName, isTaudProject, isSketchFile, kindOf, randomId,
  PROJECT_LIMIT, SIZE_LIMIT, SKETCH_LIMIT, SKETCH_SIZE_LIMIT, PENDING_TTL_MS,
} from "../../server/online/util.js";

const upload = (b, name, bytes = taudBytes()) =>
  b.fetch(`/api/online/projects?name=${encodeURIComponent(name)}`, { method: "POST", body: bytes });
const list = async (b) => (await (await b.fetch("/api/online/projects")).json()).projects;

async function signedIn(env, name = "alice") {
  const b = browser(env);
  const res = await b.signIn(name);
  assert.equal(res.status, 200);
  return b;
}

test("validators: names, the .taud header, ids", () => {
  assert.equal(cleanName("song.taud"), "song.taud");
  assert.equal(cleanName("  song.taud "), "song.taud");
  assert.equal(cleanName("song"), null, "the client adds .taud; the server does not guess");
  assert.equal(cleanName(".taud"), null);
  assert.equal(cleanName("a/b.taud"), null);
  assert.equal(cleanName("a\\b.taud"), null);
  assert.equal(cleanName("a\u0007.taud"), null);
  assert.equal(cleanName("x".repeat(200) + ".taud"), null);
  // decomposed Hangul is stored composed, so it is one name, not two
  assert.equal(cleanName("가.taud"), "가.taud");

  assert.equal(isTaudProject(taudBytes()), true);
  const tsii = taudBytes(); tsii[8] = 0x82; // kk = 10: an instrument bank
  assert.equal(isTaudProject(tsii), false);
  const junk = taudBytes(); junk[0] = 0x50;
  assert.equal(isTaudProject(junk), false);
  assert.equal(isTaudProject(taudBytes(16)), false);

  assert.match(randomId("p_", 16), /^p_[0-9A-Za-z]{16}$/);
  assert.notEqual(randomId("u_", 10), randomId("u_", 10));
});

test("the Worker answers the API and nothing else", async () => {
  // Static files never reach it; what does is either the API or a miss.
  const env = onlineEnv();
  const api = await worker.fetch(new Request("http://localhost:8788/api/online/me"), env);
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), { signedIn: false, signIn: "dev" });
  const miss = await worker.fetch(new Request("http://localhost:8788/no/such/file.js"), env);
  assert.equal(miss.status, 404);
  assert.match(miss.headers.get("content-type"), /text\/plain/);
});

test("a deploy without bindings says so; unknown paths are 404", async () => {
  const res = await handle(new Request("http://localhost:8788/api/online/me"), {});
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "unconfigured" });
  const env = onlineEnv();
  assert.equal((await handle(new Request("http://localhost:8788/api/online/nope"), env)).status, 404);
  assert.equal((await handle(new Request("http://localhost:8788/api/online/me", { method: "DELETE" }), env)).status, 405);
});

test("signed out: /me explains, everything else is 401", async () => {
  const env = onlineEnv();
  const b = browser(env);
  assert.deepEqual(await (await b.fetch("/api/online/me")).json(), { signedIn: false, signIn: "dev" });
  assert.equal((await b.fetch("/api/online/projects")).status, 401);
  assert.equal((await upload(b, "a.taud")).status, 401);
});

test("no sign-in method → signIn null; the SceneID endpoints say unavailable without their variables", async () => {
  const env = onlineEnv({ dev: false });
  const b = browser(env);
  assert.deepEqual(await (await b.fetch("/api/online/me")).json(), { signedIn: false, signIn: null });
  assert.equal((await b.fetch("/api/online/auth/login")).status, 503);
  assert.equal((await b.fetch("/api/online/auth/callback?code=x&state=y")).status, 503);
  assert.equal((await b.signIn()).status, 404, "the test sign-in is off without ONLINE_DEV_LOGIN");
});

test("the test sign-in only answers on this machine", async () => {
  const env = onlineEnv();
  const remote = browser(env, "https://microtone.cc");
  assert.equal((await remote.signIn()).status, 404);
  assert.equal(remote.jar.size, 0);
  assert.equal((await (await remote.fetch("/api/online/me")).json()).signIn, null);
});

test("signing in sets an HttpOnly __Host- cookie and announces itself", async () => {
  const env = onlineEnv();
  const b = browser(env);
  const res = await b.signIn("alice");
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /^__Host-mt_online=[A-Za-z0-9_-]{43};/);
  for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) assert.ok(cookie.includes(attr), attr);
  assert.match(await res.text(), /BroadcastChannel\("microtone-online"\)[\s\S]*"signed-in"/);
  const me = await (await b.fetch("/api/online/me")).json();
  assert.deepEqual(me, { signedIn: true, user: { name: "alice (local test)" }, signIn: "dev" });
  // only the token's hash is stored
  const token = b.jar.get("__Host-mt_online");
  const rows = env.sqlite.prepare("SELECT token_hash FROM sessions").all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
});

test("create, list, read back", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  const bytes = taudBytes(1000, 7);
  const res = await upload(b, "my song.taud", bytes);
  assert.equal(res.status, 201);
  const { project } = await res.json();
  assert.match(project.id, /^p_[0-9A-Za-z]{16}$/);
  assert.equal(project.name, "my song.taud");
  assert.equal(project.size, 1000);

  const listing = await (await b.fetch("/api/online/projects")).json();
  assert.equal(listing.limit, PROJECT_LIMIT);
  assert.equal(listing.sizeLimit, SIZE_LIMIT);
  assert.deepEqual(listing.projects, [project]);

  const got = await b.fetch(`/api/online/projects/${project.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("etag"), `"${project.etag}"`);
  assert.equal(got.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);

  // the R2 key is two random ids — nothing the person typed or chose
  const [key] = env.ONLINE_BUCKET.objects.keys();
  const userId = env.sqlite.prepare("SELECT id FROM users").get().id;
  assert.equal(key, `${userId}/${project.id}`);
  assert.match(key, /^u_[0-9A-Za-z]{10}\/p_[0-9A-Za-z]{16}$/);
});

test("uploads are refused for a bad name, a non-project, or past the size limit", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  assert.equal((await upload(b, "no-extension")).status, 400);
  const bank = taudBytes(); bank[8] = 0xc2; // .tpif
  assert.equal((await upload(b, "bank.taud", bank)).status, 415);
  assert.equal((await upload(b, "text.taud", new TextEncoder().encode("hello world, not a song at all"))).status, 415);

  // by Content-Length, and by counting a body that did not declare one
  assert.equal((await upload(b, "big.taud", taudBytes(SIZE_LIMIT + 1))).status, 413);
  const chunked = new ReadableStream({
    start(c) {
      c.enqueue(taudBytes(SIZE_LIMIT));
      c.enqueue(new Uint8Array(1));
      c.close();
    },
  });
  const res = await b.fetch("/api/online/projects?name=big2.taud", { method: "POST", body: chunked, duplex: "half" });
  assert.equal(res.status, 413);
  // exactly at the limit is fine
  assert.equal((await upload(b, "edge.taud", taudBytes(SIZE_LIMIT))).status, 201);
  assert.equal(env.ONLINE_BUCKET.objects.size, 1);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get().n, 1);
});

test("a name is taken once per person; a retried upload cannot land twice", async () => {
  const env = onlineEnv();
  const alice = await signedIn(env, "alice");
  const bob = await signedIn(env, "bob");
  assert.equal((await upload(alice, "a.taud")).status, 201);
  const again = await upload(alice, "a.taud");
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: "exists" });
  assert.equal((await upload(bob, "a.taud")).status, 201, "names are per person");
  // two identical uploads at once, both past the early check before either
  // reaches the INSERT: the unique index lets exactly one through
  env.ONLINE_DB.beforeBatch = barrier(2);
  const both = await Promise.all([upload(bob, "b.taud"), upload(bob, "b.taud")]);
  env.ONLINE_DB.beforeBatch = null;
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
  assert.deepEqual(await both.find((r) => r.status === 409).json(), { error: "exists" });
  assert.equal(env.ONLINE_BUCKET.objects.size, 3);
});

test("the slot limit holds atomically even when uploads race", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  // Hold all 24 at the transaction until every one has passed the early
  // (advisory) check with an empty desk — so the INSERT's own count is the
  // only thing left to refuse the extra eight.
  env.ONLINE_DB.beforeBatch = barrier(24);
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => upload(b, `song${i}.taud`)));
  env.ONLINE_DB.beforeBatch = null;
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, PROJECT_LIMIT);
  assert.equal(statuses.filter((s) => s === 409).length, 24 - PROJECT_LIMIT);
  for (const r of results.filter((r) => r.status === 409)) assert.deepEqual(await r.json(), { error: "quota" });
  assert.equal((await list(b)).length, PROJECT_LIMIT);
  assert.equal(env.ONLINE_BUCKET.objects.size, PROJECT_LIMIT);
  assert.equal((await upload(b, "one-more.taud")).status, 409);
  // deleting one frees one
  const [first] = await list(b);
  assert.equal((await b.fetch(`/api/online/projects/${first.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await upload(b, "one-more.taud")).status, 201);
});

test("a failed R2 write gives the slot back", async (t) => {
  const env = onlineEnv();
  const b = await signedIn(env);
  t.mock.method(console, "error", () => {}); // the router logs the 500; expected here
  env.ONLINE_BUCKET.failNextPut = true;
  const res = await upload(b, "a.taud");
  assert.equal(res.status, 500);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get().n, 0);
  assert.equal((await upload(b, "a.taud")).status, 201, "the name is free again too");
});

test("a reservation that died half-way is swept by the next upload", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  const userId = env.sqlite.prepare("SELECT id FROM users").get().id;
  const old = Date.now() - PENDING_TTL_MS - 1000;
  // fifteen ready projects, plus one upload that reserved the last slot and never finished
  for (let i = 0; i < PROJECT_LIMIT - 1; i++) assert.equal((await upload(b, `s${i}.taud`)).status, 201);
  env.sqlite.prepare(
    `INSERT INTO projects (id, user_id, r2_key, filename, size, state, created_at, updated_at)
     VALUES ('p_deaddeaddeaddead', ?1, ?2, 'dead.taud', 10, 'pending', ?3, ?3)`,
  ).run(userId, `${userId}/p_deaddeaddeaddead`, old);
  await env.ONLINE_BUCKET.put(`${userId}/p_deaddeaddeaddead`, taudBytes());
  assert.equal((await list(b)).length, PROJECT_LIMIT - 1, "a pending row is never listed");
  // the dead reservation neither holds its slot nor its name
  assert.equal((await upload(b, "dead.taud")).status, 201);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM projects WHERE state = 'pending'").get().n, 0);
  assert.equal(env.ONLINE_BUCKET.objects.has(`${userId}/p_deaddeaddeaddead`), false);
  assert.equal((await list(b)).length, PROJECT_LIMIT);
});

test("a FRESH reservation still holds its slot", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  const userId = env.sqlite.prepare("SELECT id FROM users").get().id;
  for (let i = 0; i < PROJECT_LIMIT - 1; i++) await upload(b, `s${i}.taud`);
  env.sqlite.prepare(
    `INSERT INTO projects (id, user_id, r2_key, filename, size, state, created_at, updated_at)
     VALUES ('p_inflightinflight', ?1, 'k', 'inflight.taud', 10, 'pending', ?2, ?2)`,
  ).run(userId, Date.now());
  const res = await upload(b, "late.taud");
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "quota" });
});

test("save over a project: If-Match is required, and a stale one is refused", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  const { project } = await (await upload(b, "a.taud", taudBytes(64, 1))).json();
  const put = (bytes, ifMatch) => b.fetch(`/api/online/projects/${project.id}`, {
    method: "PUT", body: bytes, headers: ifMatch === undefined ? {} : { "if-match": ifMatch },
  });

  assert.equal((await put(taudBytes(64, 2))).status, 428);

  const saved = await put(taudBytes(80, 2), `"${project.etag}"`);
  assert.equal(saved.status, 200);
  const { project: v2 } = await saved.json();
  assert.notEqual(v2.etag, project.etag);
  assert.equal(v2.size, 80);
  assert.equal(v2.name, "a.taud");

  // a second browser still holding the first ETag must not undo that save
  const stale = await put(taudBytes(64, 3), `"${project.etag}"`);
  assert.equal(stale.status, 412);
  assert.deepEqual(await stale.json(), { error: "conflict" });
  const now = await b.fetch(`/api/online/projects/${project.id}`);
  assert.deepEqual(new Uint8Array(await now.arrayBuffer()), taudBytes(80, 2));

  // …unless it says so
  assert.equal((await put(taudBytes(64, 3), "*")).status, 200);
  assert.equal((await put(taudBytes(64, 4), "*")).status, 200);
  assert.equal((await list(b))[0].size, 64);
  // the same checks as an upload
  assert.equal((await put(new Uint8Array(40), "*")).status, 415);
  assert.equal((await put(taudBytes(SIZE_LIMIT + 1), "*")).status, 413);
});

test("rename keeps the bytes and the modified time; names stay unique", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  const { project: a } = await (await upload(b, "a.taud")).json();
  await upload(b, "b.taud");
  const rename = (name) => b.fetch(`/api/online/projects/${a.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  const ok = await rename("c.taud");
  assert.equal(ok.status, 200);
  const { project } = await ok.json();
  assert.equal(project.name, "c.taud");
  assert.equal(project.etag, a.etag);
  assert.equal(project.modified, a.modified);
  assert.equal((await rename("b.taud")).status, 409);
  assert.equal((await rename("../x")).status, 400);
  assert.equal((await b.fetch(`/api/online/projects/${a.id}`, { method: "PATCH", body: "{" })).status, 400);
  assert.deepEqual((await list(b)).map((p) => p.name), ["b.taud", "c.taud"]);
});

// ── sketch slots (Microtone Touch's .mtsk) ──

test("validators: a sketch is named .mtsk and starts with its magic", () => {
  assert.equal(cleanName("riff.mtsk"), "riff.mtsk");
  assert.equal(cleanName(".mtsk"), null);
  assert.equal(cleanName("riff.MTSK"), null, "the extension is exact, as .taud's is");
  assert.equal(kindOf("riff.mtsk"), "sketch");
  assert.equal(kindOf("riff.taud"), "project");
  assert.equal(isSketchFile(sketchBytes()), true);
  assert.equal(isSketchFile(sketchBytes(31)), false, "a whole header or nothing");
  assert.equal(isSketchFile(taudBytes()), false);
  assert.equal(isTaudProject(sketchBytes()), false);
});

test("sketches have slots of their own, beside the projects' and never sharing them", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  for (let i = 0; i < PROJECT_LIMIT; i++) assert.equal((await upload(b, `p${i}.taud`)).status, 201);
  // a full desk of projects takes nothing from the sketches…
  for (let i = 0; i < SKETCH_LIMIT; i++) assert.equal((await upload(b, `s${i}.mtsk`, sketchBytes())).status, 201);
  const more = await upload(b, "one-more.mtsk", sketchBytes());
  assert.equal(more.status, 409);
  assert.deepEqual(await more.json(), { error: "quota" });
  // …and a full set of sketches nothing from the projects
  assert.equal((await upload(b, "one-more.taud")).status, 409);
  const sketch = (await list(b)).find((p) => p.name === "s0.mtsk");
  assert.equal((await b.fetch(`/api/online/projects/${sketch.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await upload(b, "one-more.taud")).status, 409, "a sketch's slot does not become a project's");
  assert.equal((await upload(b, "one-more.mtsk", sketchBytes())).status, 201);

  const listing = await (await b.fetch("/api/online/projects")).json();
  assert.equal(listing.limit, PROJECT_LIMIT);
  assert.equal(listing.sketchLimit, SKETCH_LIMIT);
  assert.equal(listing.sketchSizeLimit, SKETCH_SIZE_LIMIT);
  assert.equal(listing.projects.length, PROJECT_LIMIT + SKETCH_LIMIT);
});

test("the sketch limit holds atomically when uploads race", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  await upload(b, "song.taud"); // a project in the way counts for nothing
  const n = SKETCH_LIMIT + 6;
  env.ONLINE_DB.beforeBatch = barrier(n);
  const results = await Promise.all(Array.from({ length: n }, (_, i) => upload(b, `s${i}.mtsk`, sketchBytes())));
  env.ONLINE_DB.beforeBatch = null;
  assert.equal(results.filter((r) => r.status === 201).length, SKETCH_LIMIT);
  assert.equal(results.filter((r) => r.status === 409).length, n - SKETCH_LIMIT);
  assert.equal((await list(b)).length, SKETCH_LIMIT + 1);
});

test("a slot holds only its own kind, up to its own ceiling", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  const wrong = await upload(b, "taud-in-disguise.mtsk", taudBytes());
  assert.equal(wrong.status, 415);
  assert.deepEqual(await wrong.json(), { error: "not-sketch" });
  const wrong2 = await upload(b, "sketch-in-disguise.taud", sketchBytes());
  assert.equal(wrong2.status, 415);
  assert.deepEqual(await wrong2.json(), { error: "not-taud" });
  assert.equal((await upload(b, "big.mtsk", sketchBytes(SKETCH_SIZE_LIMIT + 1))).status, 413);
  assert.equal((await upload(b, "edge.mtsk", sketchBytes(SKETCH_SIZE_LIMIT))).status, 201);

  // saving over one checks the same, by the slot's kind
  const { project: s } = await (await upload(b, "s.mtsk", sketchBytes(64, 1))).json();
  const { project: p } = await (await upload(b, "p.taud")).json();
  const put = (id, bytes) => b.fetch(`/api/online/projects/${id}`, { method: "PUT", body: bytes, headers: { "if-match": "*" } });
  const r1 = await put(s.id, taudBytes());
  assert.equal(r1.status, 415);
  assert.deepEqual(await r1.json(), { error: "not-sketch" });
  assert.equal((await put(s.id, sketchBytes(SKETCH_SIZE_LIMIT + 1))).status, 413);
  assert.equal((await put(s.id, sketchBytes(80, 2))).status, 200);
  assert.equal((await put(p.id, sketchBytes())).status, 415);
  assert.equal((await put(p.id, taudBytes(SKETCH_SIZE_LIMIT + 1))).status, 200, "a project's ceiling is its own");
});

test("a rename cannot change what kind of slot it is", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  const { project: s } = await (await upload(b, "riff.mtsk", sketchBytes())).json();
  const { project: p } = await (await upload(b, "song.taud")).json();
  const rename = (id, name) => b.fetch(`/api/online/projects/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
  });
  const r1 = await rename(s.id, "riff.taud");
  assert.equal(r1.status, 400);
  assert.deepEqual(await r1.json(), { error: "bad-name" });
  assert.equal((await rename(p.id, "song.mtsk")).status, 400);
  assert.equal((await rename(s.id, "groove.mtsk")).status, 200);
  assert.equal((await rename("p_nonexistent00000", "x.mtsk")).status, 404, "a missing one is still not-found");
  assert.deepEqual((await list(b)).map((x) => x.name), ["groove.mtsk", "song.taud"]);
});

test("delete removes the row and the object", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  const { project } = await (await upload(b, "a.taud")).json();
  assert.equal((await b.fetch(`/api/online/projects/${project.id}`, { method: "DELETE" })).status, 204);
  assert.equal(env.ONLINE_BUCKET.objects.size, 0);
  assert.equal((await b.fetch(`/api/online/projects/${project.id}`)).status, 404);
  assert.equal((await b.fetch(`/api/online/projects/${project.id}`, { method: "DELETE" })).status, 404);
});

test("one person cannot see or touch another's projects", async () => {
  const env = onlineEnv();
  const alice = await signedIn(env, "alice");
  const mallory = await signedIn(env, "mallory");
  const { project } = await (await upload(alice, "secret.taud")).json();
  const url = `/api/online/projects/${project.id}`;
  assert.deepEqual(await list(mallory), []);
  assert.equal((await mallory.fetch(url)).status, 404);
  assert.equal((await mallory.fetch(url, { method: "PUT", body: taudBytes(), headers: { "if-match": "*" } })).status, 404);
  assert.equal((await mallory.fetch(url, { method: "PATCH", body: '{"name":"mine.taud"}' })).status, 404);
  assert.equal((await mallory.fetch(url, { method: "DELETE" })).status, 404);
  assert.equal((await alice.fetch(url)).status, 200);
  assert.deepEqual((await list(alice)).map((p) => p.name), ["secret.taud"]);
});

test("cross-site writes are refused; same-origin and non-browser ones are not", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  const res = await b.fetch("/api/online/projects?name=x.taud", {
    method: "POST", body: taudBytes(), headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(res.status, 403);
  const byOrigin = new Request("http://localhost:8788/api/online/auth/logout", {
    method: "POST", headers: { origin: "https://evil.example" },
  });
  assert.equal((await handle(byOrigin, env)).status, 403);
  // reads are fine from anywhere (the cookie still has to be there)
  assert.equal((await b.fetch("/api/online/projects", { headers: { "sec-fetch-site": "cross-site" } })).status, 200);
});

test("sign out ends the session on the server, not just in the browser", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  const token = b.jar.get("__Host-mt_online");
  const res = await b.fetch("/api/online/auth/logout", { method: "POST" });
  assert.equal(res.status, 204);
  assert.equal(b.jar.size, 0);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  // a copy of the old cookie is worthless now
  const replay = new Request("http://localhost:8788/api/online/projects", {
    headers: { cookie: `__Host-mt_online=${token}` },
  });
  assert.equal((await handle(replay, env)).status, 401);
});

test("sessions expire, and slide forward (at most daily) while in use", async () => {
  const env = onlineEnv();
  const b = await signedIn(env);
  const day = 24 * 60 * 60 * 1000;
  const sessions = () => env.sqlite.prepare("SELECT expires_at FROM sessions").all();

  // fresh: nothing to extend, no cookie re-issued
  const quiet = await b.fetch("/api/online/projects");
  assert.deepEqual(quiet.headers.getSetCookie(), []);

  // two days on: extended, and the browser's copy with it
  env.sqlite.prepare("UPDATE sessions SET expires_at = expires_at - ?1").run(2 * day);
  env.sqlite.prepare("UPDATE users SET last_seen_at = 0").run();
  const before = sessions()[0].expires_at;
  const slid = await b.fetch("/api/online/projects");
  assert.equal(slid.status, 200);
  assert.match(slid.headers.getSetCookie()[0] ?? "", /Max-Age=2592000/);
  assert.ok(sessions()[0].expires_at > before + day);
  assert.ok(env.sqlite.prepare("SELECT last_seen_at FROM users").get().last_seen_at > 0);

  // past its expiry: gone
  env.sqlite.prepare("UPDATE sessions SET expires_at = ?1").run(Date.now() - 1);
  assert.equal((await b.fetch("/api/online/projects")).status, 401);
  // …and swept the next time that account signs in
  await b.signIn("alice");
  assert.equal(sessions().length, 1);
});

test("signing in again keeps the same account and its projects", async () => {
  const env = onlineEnv();
  const one = await signedIn(env, "alice");
  await upload(one, "a.taud");
  const two = await signedIn(env, "alice");
  assert.deepEqual((await list(two)).map((p) => p.name), ["a.taud"]);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 2, "one per browser");
});
