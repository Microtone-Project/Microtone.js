// Online projects in the desktop app (server/online/desktop.js): the browser
// hand-off, the code → access token exchange, and bearer tokens — against the
// same fakes as the other online tests (test/fixtures/online-env.js).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { onlineEnv, browser, fakeSceneId, taudBytes } from "../fixtures/online-env.js";
import { handle } from "../../server/online/router.js";
import { s256 } from "../../server/online/desktop.js";

// RFC 7636 Appendix B — desktop/src/online.rs checks the same pair.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "app-state-0123456789";
const CLIENT = { clientId: "microtone-test", clientSecret: "secret" };

let realFetch;
beforeEach((t) => {
  realFetch = globalThis.fetch;
  t.mock.method(console, "warn", () => {});
});
afterEach(() => { globalThis.fetch = realFetch; });

/** The desktop app: no cookies and no browser headers; a bearer token once it has one. */
function app(env, token = null) {
  return (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return handle(new Request(new URL(path, "http://localhost:8788"), { ...init, headers }), env);
  };
}

const desktopUrl = (challenge = CHALLENGE, state = STATE) =>
  `/api/online/auth/desktop?${new URLSearchParams({ challenge, state })}`;

/** A hand-off page → the code and state its cc.microtone.desktop: link carries. */
async function handedOff(res) {
  assert.equal(res.status, 200);
  const page = await res.text();
  const href = /href="(cc\.microtone\.desktop:\/signed-in\?[^"]+)"/.exec(page)?.[1];
  assert.ok(href, "the page links back to the app");
  const back = new URL(href.replace(/&amp;/g, "&"));
  return { code: back.searchParams.get("code"), state: back.searchParams.get("state"), page };
}

const exchange = (env, code, verifier = VERIFIER) => app(env)("/api/online/auth/token", {
  method: "POST", body: JSON.stringify({ code, verifier }), headers: { "content-type": "application/json" },
});

async function signedInBrowser(env, name = "alice") {
  const b = browser(env);
  assert.equal((await b.signIn(name)).status, 200);
  return b;
}

test("S256 is RFC 7636's", async () => {
  assert.equal(await s256(VERIFIER), CHALLENGE);
});

test("a browser signed in already hands the app a code at once, and the code becomes a bearer token", async () => {
  const env = onlineEnv();
  const b = await signedInBrowser(env);
  const res = await b.fetch(desktopUrl());
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { code, state, page } = await handedOff(res);
  assert.equal(state, STATE, "the app's state comes back untouched");
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.match(page, /lang="en"[\s\S]*alice \(local test\)[\s\S]*lang="ko"/);
  assert.match(page, /location\.href = document\.getElementById\("back"\)\.href/);
  // only the code's hash is kept, with the challenge it is bound to
  const row = env.sqlite.prepare("SELECT * FROM desktop_codes").get();
  assert.notEqual(row.code_hash, code);
  assert.equal(row.challenge, CHALLENGE);

  const got = await exchange(env, code);
  assert.equal(got.status, 200);
  const { token, user } = await got.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(user, { name: "alice (local test)" });
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM desktop_codes").get().n, 0, "spent");

  const desk = app(env, token);
  assert.deepEqual(await (await desk("/api/online/me")).json(),
    { signedIn: true, user: { name: "alice (local test)" }, signIn: "dev" });
  const made = await desk("/api/online/projects?name=a.taud", { method: "POST", body: taudBytes() });
  assert.equal(made.status, 201);
  // the same account the browser is signed in to
  const listed = await (await b.fetch("/api/online/projects")).json();
  assert.deepEqual(listed.projects.map((p) => p.name), ["a.taud"]);
});

test("a bearer session slides forward like a cookie one, but is never sent a cookie", async () => {
  const env = onlineEnv();
  const b = await signedInBrowser(env);
  const { code } = await handedOff(await b.fetch(desktopUrl()));
  const { token } = await (await exchange(env, code)).json();
  const day = 24 * 60 * 60 * 1000;
  const mine = env.sqlite.prepare("SELECT expires_at AS t FROM sessions WHERE token_hash = ?1");
  const hash = createHash("sha256").update(token).digest("hex");
  env.sqlite.prepare("UPDATE sessions SET expires_at = expires_at - ?1").run(2 * day);
  const before = mine.get(hash).t;
  const res = await app(env, token)("/api/online/projects");
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers.getSetCookie(), []);
  assert.ok(mine.get(hash).t > before + day);
});

test("a code is good once, for five minutes, and only with its own verifier", async () => {
  const env = onlineEnv();
  const b = await signedInBrowser(env);
  const fresh = async () => (await handedOff(await b.fetch(desktopUrl()))).code;

  // a wrong verifier spends the code as surely as the right one
  const first = await fresh();
  const wrong = await exchange(env, first, "x".repeat(43));
  assert.equal(wrong.status, 400);
  assert.deepEqual(await wrong.json(), { error: "invalid-grant" });
  assert.equal((await exchange(env, first)).status, 400);

  const second = await fresh();
  assert.equal((await exchange(env, second)).status, 200);
  assert.equal((await exchange(env, second)).status, 400, "not twice");

  const third = await fresh();
  env.sqlite.prepare("UPDATE desktop_codes SET expires_at = ?1").run(Date.now() - 1);
  assert.equal((await exchange(env, third)).status, 400, "not late");

  for (const body of ["not json", "{}", JSON.stringify({ code: "a", verifier: VERIFIER })]) {
    const res = await app(env)("/api/online/auth/token", { method: "POST", body });
    assert.equal(res.status, 400, body);
  }
  // a browser page on another site cannot do the swap for the app
  const cross = await app(env)("/api/online/auth/token", {
    method: "POST", body: JSON.stringify({ code: await fresh(), verifier: VERIFIER }),
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(cross.status, 403);
  // and the dead codes are swept as new ones are issued
  env.sqlite.prepare("UPDATE desktop_codes SET expires_at = ?1").run(Date.now() - 1);
  await fresh();
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM desktop_codes").get().n, 1);
});

test("signed out, the test sign-in ends in the hand-off rather than closing its window", async () => {
  const env = onlineEnv();
  const b = browser(env);
  const ask = await b.fetch(desktopUrl());
  assert.equal(ask.status, 200);
  assert.match(await ask.text(), /<form action="\/api\/online\/auth\/dev-login">/);
  assert.ok(b.jar.has("__Host-mt_desktop"));

  const { code, state, page } = await handedOff(await b.signIn("bob"));
  assert.equal(state, STATE);
  assert.doesNotMatch(page, /window\.close/);
  assert.ok(b.jar.has("__Host-mt_online"), "the browser is signed in too");
  assert.equal(b.jar.has("__Host-mt_desktop"), false, "and the desktop sign-in is over");
  assert.deepEqual((await (await exchange(env, code)).json()).user, { name: "bob (local test)" });

  // a later sign-in on the site closes its window as it always did
  assert.match(await (await b.signIn("bob")).text(), /window\.close\(\);/);
});

test("signed out with SceneID: off to SceneID, and back to the app", async () => {
  const sid = fakeSceneId(CLIENT);
  globalThis.fetch = sid.fetch;
  const env = onlineEnv({ sceneid: CLIENT });
  const b = browser(env);
  const ask = await b.fetch(desktopUrl());
  assert.equal(ask.status, 302);
  assert.equal(ask.headers.get("location"), "/api/online/auth/login");
  const login = await b.fetch(ask.headers.get("location"));
  assert.equal(login.status, 302);
  const { code, state } = await handedOff(await b.fetch(sid.authorize(login.headers.get("location"))));
  assert.equal(state, STATE);
  assert.equal(b.jar.has("__Host-mt_sceneid"), false, "the SceneID state is spent");
  assert.deepEqual((await (await exchange(env, code)).json()).user, { name: "gasman ^ hooy-program" });
});

test("a SceneID sign-in that fails ends the desktop one too", async () => {
  const sid = fakeSceneId(CLIENT);
  globalThis.fetch = sid.fetch;
  const env = onlineEnv({ sceneid: CLIENT });
  const b = browser(env);
  await b.fetch(desktopUrl());
  const login = await b.fetch("/api/online/auth/login");
  sid.meFails = true;
  const done = await b.fetch(sid.authorize(login.headers.get("location")));
  assert.equal(done.status, 400);
  assert.doesNotMatch(await done.text(), /cc\.microtone\.desktop/);
  assert.equal(b.jar.has("__Host-mt_sceneid"), false);
});

test("a broken link, and a server nobody can sign in to", async () => {
  const env = onlineEnv();
  const b = await signedInBrowser(env);
  for (const url of [desktopUrl("short"), desktopUrl(CHALLENGE, "x"), "/api/online/auth/desktop"]) {
    const res = await b.fetch(url);
    assert.equal(res.status, 400, url);
    assert.match(await res.text(), /not complete/);
  }
  assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS n FROM desktop_codes").get().n, 0);
  const closed = browser(onlineEnv({ dev: false }));
  assert.equal((await closed.fetch(desktopUrl())).status, 503);
});

test("signing out with the token ends that session and no other", async () => {
  const env = onlineEnv();
  const b = await signedInBrowser(env);
  const { code } = await handedOff(await b.fetch(desktopUrl()));
  const { token } = await (await exchange(env, code)).json();
  assert.equal((await app(env, token)("/api/online/auth/logout", { method: "POST" })).status, 204);
  assert.equal((await app(env, token)("/api/online/projects")).status, 401);
  assert.equal((await b.fetch("/api/online/projects")).status, 200, "the browser stays signed in");
  // nor is anything else in the Authorization header a session
  const odd = await app(env)("/api/online/projects", { headers: { authorization: "Bearer a/b" } });
  assert.equal(odd.status, 401);
});
