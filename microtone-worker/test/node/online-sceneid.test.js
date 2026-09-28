// SceneID sign-in (server/online/sceneid.js) against a stand-in for SceneID
// built from its documentation — test/fixtures/online-env.js fakeSceneId.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { onlineEnv, browser, fakeSceneId, taudBytes } from "../fixtures/online-env.js";

// A secret with the characters that would break if it were form-encoded
// before going into the Basic header — the docs say to send it as it is.
const CLIENT = { clientId: "microtone-test", clientSecret: "S3cr3t+/=:odd" };
const CALLBACK = "http://localhost:8788/api/online/auth/callback";

let realFetch;
let sid;
beforeEach((t) => {
  realFetch = globalThis.fetch;
  sid = fakeSceneId(CLIENT);
  globalThis.fetch = sid.fetch;
  t.mock.method(console, "warn", () => {}); // failed sign-ins are logged; expected here
});
afterEach(() => { globalThis.fetch = realFetch; });

/** Click "Sign in with SceneID", sign in at SceneID as `who`, come back. */
async function signInViaSceneId(b, who = "gasman") {
  const login = await b.fetch("/api/online/auth/login");
  assert.equal(login.status, 302);
  return b.fetch(sid.authorize(login.headers.get("location"), who));
}

const tokenCalls = () => sid.calls.filter((c) => c.url.endsWith("/oauth/token/"));
const count = (env, table) => env.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test("/me offers SceneID once both variables are set, ahead of the test sign-in", async () => {
  const both = browser(onlineEnv({ sceneid: CLIENT }));
  assert.equal((await (await both.fetch("/api/online/me")).json()).signIn, "sceneid");
  const idOnly = onlineEnv({ dev: false });
  idOnly.SCENEID_CLIENT_ID = CLIENT.clientId;
  assert.equal((await (await browser(idOnly).fetch("/api/online/me")).json()).signIn, null);
});

test("login sends the window to SceneID with exactly the documented parameters", async () => {
  const b = browser(onlineEnv({ sceneid: CLIENT }));
  const res = await b.fetch("/api/online/auth/login");
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://id.scene.org/oauth/authorize/");
  assert.deepEqual([...to.searchParams.keys()].sort(), ["client_id", "redirect_uri", "response_type", "scope", "state"]);
  assert.equal(to.searchParams.get("client_id"), CLIENT.clientId);
  assert.equal(to.searchParams.get("redirect_uri"), CALLBACK);
  assert.equal(to.searchParams.get("response_type"), "code");
  assert.equal(to.searchParams.get("scope"), "basic");

  const cookie = res.headers.getSetCookie()[0];
  const state = to.searchParams.get("state");
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(cookie.split(";")[0], `__Host-mt_sceneid=${state}`);
  for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=1200"]) assert.ok(cookie.includes(attr), attr);

  const again = new URL((await b.fetch("/api/online/auth/login")).headers.get("location"));
  assert.notEqual(again.searchParams.get("state"), state, "a fresh state every time");
});

test("the redirect URI follows the origin the request came in on", async () => {
  const env = onlineEnv({ sceneid: CLIENT });
  const prod = browser(env, "https://microtone.cc");
  const to = new URL((await prod.fetch("/api/online/auth/login")).headers.get("location"));
  assert.equal(to.searchParams.get("redirect_uri"), "https://microtone.cc/api/online/auth/callback");
});

test("a whole sign-in: code → token (Basic, as documented) → /me/ → a session", async () => {
  const env = onlineEnv({ sceneid: CLIENT });
  const b = browser(env);
  const done = await signInViaSceneId(b);
  assert.equal(done.status, 200);
  const page = await done.text();
  assert.match(page, /postMessage\(\{ type: "signed-in" \}\)/);
  assert.match(page, /^window\.close\(\);$/m, "a sign-in that worked closes its window");

  // the state is spent, the session is set
  assert.equal(b.jar.has("__Host-mt_sceneid"), false);
  assert.ok(b.jar.has("__Host-mt_online"));

  const [tokenCall] = tokenCalls();
  const headers = new Headers(tokenCall.init.headers);
  assert.equal(tokenCall.init.method, "POST");
  assert.equal(headers.get("authorization"), `Basic ${btoa(`${CLIENT.clientId}:${CLIENT.clientSecret}`)}`);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  const form = new URLSearchParams(tokenCall.init.body);
  assert.deepEqual(Object.fromEntries(form), {
    grant_type: "authorization_code", code: form.get("code"), redirect_uri: CALLBACK,
  });
  const meCall = sid.calls.find((c) => c.url === "https://id.scene.org/api/3.0/me/");
  assert.match(new Headers(meCall.init.headers).get("authorization"), /^Bearer tok-/);

  const me = await (await b.fetch("/api/online/me")).json();
  assert.deepEqual(me, { signedIn: true, user: { name: "gasman ^ hooy-program" }, signIn: "sceneid" });
  const row = env.sqlite.prepare("SELECT * FROM users").get();
  assert.equal(row.sceneid_subject, "sceneid:4242");
  assert.equal(row.display_name, "gasman ^ hooy-program");
  // the real name that /me/ sends along is not kept anywhere
  assert.ok(!JSON.stringify(env.sqlite.prepare("SELECT * FROM users").all()).includes("Real"));
  assert.equal((await b.fetch("/api/online/projects")).status, 200);
});

test("signing in again: the same account, its new name, its projects — and one session, not two", async () => {
  const env = onlineEnv({ sceneid: CLIENT });
  const b = browser(env);
  await signInViaSceneId(b);
  await b.fetch("/api/online/projects?name=a.taud", { method: "POST", body: taudBytes() });
  const firstSession = b.jar.get("__Host-mt_online");

  sid.users.gasman.display_name = "gasman ^ new group";
  await signInViaSceneId(b);
  assert.notEqual(b.jar.get("__Host-mt_online"), firstSession);
  assert.equal(count(env, "users"), 1);
  assert.equal(count(env, "sessions"), 1, "the old session was ended, not left to expire");
  assert.equal((await (await b.fetch("/api/online/me")).json()).user.name, "gasman ^ new group");
  const { projects } = await (await b.fetch("/api/online/projects")).json();
  assert.deepEqual(projects.map((p) => p.name), ["a.taud"]);
});

test("a state that does not match is refused before SceneID is asked anything", async () => {
  const env = onlineEnv({ sceneid: CLIENT });
  const b = browser(env);
  const login = await b.fetch("/api/online/auth/login");
  const back = new URL(sid.authorize(login.headers.get("location")));
  back.searchParams.set("state", "not-the-state-this-browser-was-given");
  const res = await b.fetch(back.href);
  assert.equal(res.status, 400);
  assert.equal(tokenCalls().length, 0);
  assert.equal(count(env, "sessions"), 0);
  assert.equal(b.jar.has("__Host-mt_sceneid"), false, "spent either way");
});

test("a callback carried to another browser (no state cookie) is refused", async () => {
  const env = onlineEnv({ sceneid: CLIENT });
  const victim = browser(env);
  // someone else starts a sign-in and hands over the URL SceneID sent THEM back to
  const attacker = browser(env);
  const login = await attacker.fetch("/api/online/auth/login");
  const res = await victim.fetch(sid.authorize(login.headers.get("location")));
  assert.equal(res.status, 400);
  assert.equal(victim.jar.size, 0);
  assert.equal(tokenCalls().length, 0);
});

test("a callback cannot be replayed once its state is spent", async () => {
  const env = onlineEnv({ sceneid: CLIENT });
  const b = browser(env);
  const login = await b.fetch("/api/online/auth/login");
  const back = sid.authorize(login.headers.get("location"));
  assert.equal((await b.fetch(back)).status, 200);
  assert.equal((await b.fetch(back)).status, 400);
  assert.equal(tokenCalls().length, 1);
});

test("declining at SceneID: a page that says so, and stays open", async () => {
  const env = onlineEnv({ sceneid: CLIENT });
  const b = browser(env);
  const login = await b.fetch("/api/online/auth/login");
  const state = new URL(login.headers.get("location")).searchParams.get("state");
  const res = await b.fetch(`${CALLBACK}?error=access_denied&state=${state}`);
  assert.equal(res.status, 400);
  const page = await res.text();
  assert.match(page, /Sign-in did not complete/);
  assert.match(page, /"sign-in-failed"/);
  assert.doesNotMatch(page, /^window\.close\(\);$/m, "the window stays open to say so");
  assert.equal(tokenCalls().length, 0);
  assert.equal(b.jar.has("__Host-mt_sceneid"), false);
});

test("anything going wrong at SceneID ends in the failure page, never a session", async (t) => {
  const cases = {
    "wrong client secret": (env) => { env.SCENEID_CLIENT_SECRET = "not-it"; },
    "SceneID unreachable": () => { sid.down = true; },
    "/me/ refuses the token": () => { sid.meFails = true; },
  };
  for (const [what, breakIt] of Object.entries(cases)) {
    await t.test(what, async () => {
      const env = onlineEnv({ sceneid: CLIENT });
      const b = browser(env);
      const login = await b.fetch("/api/online/auth/login");
      breakIt(env);
      const res = await b.fetch(sid.authorize(login.headers.get("location")));
      sid.down = false;
      sid.meFails = false;
      assert.equal(res.status, 400);
      assert.equal(b.jar.has("__Host-mt_online"), false);
      assert.equal(count(env, "sessions"), 0);
      assert.equal(count(env, "users"), 0);
    });
  }
  await t.test("a user without an id", async () => {
    const env = onlineEnv({ sceneid: CLIENT });
    const res = await signInViaSceneId(browser(env), "nobody");
    assert.equal(res.status, 400);
    assert.equal(count(env, "users"), 0);
  });
});

test("the test sign-in also replaces a session rather than adding one", async () => {
  const env = onlineEnv();
  const b = browser(env);
  await b.signIn("alice");
  await b.signIn("bob");
  assert.equal(count(env, "sessions"), 1);
  assert.equal((await (await b.fetch("/api/online/me")).json()).user.name, "bob (local test)");
});

test("an unmigrated database fails the sign-in at once — before SceneID — and the log names the fix", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const env = onlineEnv({ sceneid: CLIENT, migrated: false });
  const b = browser(env);
  const res = await b.fetch("/api/online/auth/login");
  assert.equal(res.status, 400, "the failure page, not a redirect to SceneID");
  assert.match(await res.text(), /Sign-in did not complete/);
  assert.equal(sid.calls.length, 0);
  assert.equal(b.jar.size, 0);
  const said = logged.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
  assert.match(said, /no such table: users/);
  assert.match(said, /wrangler d1 migrations apply microtone-online --local/);
  // the test sign-in says the same, in the same way
  const dev = await browser(onlineEnv({ migrated: false })).signIn("alice");
  assert.equal(dev.status, 400);
  assert.match(await dev.text(), /Sign-in did not complete/);
});

test("a database failure at the very end still answers with the failure page, not raw JSON", async (t) => {
  t.mock.method(console, "error", () => {});
  const env = onlineEnv({ sceneid: CLIENT });
  const b = browser(env);
  const login = await b.fetch("/api/online/auth/login");
  env.sqlite.exec("DROP TABLE sessions"); // gone between the two halves
  const res = await b.fetch(sid.authorize(login.headers.get("location")));
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /"sign-in-failed"/);
  assert.equal(b.jar.has("__Host-mt_online"), false);
  assert.equal(b.jar.has("__Host-mt_sceneid"), false, "the state is spent either way");
});
