// Online projects — accounts and sessions.
//
// Everything here is independent of HOW someone proved who they are. An
// identity provider asks readyForSignIn() before it starts, and hands a stable
// subject and a display name to completeSignIn() when it is done; the same two
// calls serve the local test sign-in below. SceneID plugs in at sceneid.js.
//
// A session is a random token in an HttpOnly cookie — or, for the desktop
// app (desktop.js), the same kind of token sent as `Authorization: Bearer`.
// D1 holds only its SHA-256, so the table is useless to anyone who reads it,
// and signing out (or deleting the row) ends the session at once — no
// signed-cookie secret to rotate, and nothing to keep in sync between deploys.

import { randomId, randomToken, sha256Hex, parseCookies, fail, json, explain, readCapped } from "./util.js";
import { pendingDesktop, handOff, redeemCode, CLEAR_PENDING } from "./desktop.js";

/** `__Host-` binds the cookie to exactly this origin: Secure, Path=/, and no
 *  Domain, so no sibling subdomain can set or read it. Browsers treat
 *  http://localhost as secure, so local development keeps working. */
const COOKIE = "__Host-mt_online";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_MS = 30 * DAY_MS;

/** How often a session in use slides its expiry forward (and marks the
 *  account as seen). Once a day is plenty, and it keeps the common request —
 *  a listing, an open, a save — to one read. */
const REFRESH_MS = DAY_MS;

/** The same name as the client's (core/storage/online.js AUTH_CHANNEL): the
 *  page that finishes a sign-in announces it here, and every open tab of the
 *  app is listening. A BroadcastChannel rather than window.opener, because the
 *  app is served cross-origin-isolated (COOP same-origin), and the round trip
 *  through the identity provider's pages severs the opener. */
const AUTH_CHANNEL = "microtone-online";

/** The session token a request carries, and how: a bearer token (the desktop
 *  app) is taken over a cookie. */
function sessionToken(request) {
  const bearer = /^Bearer ([A-Za-z0-9_-]{1,64})$/.exec(request.headers.get("authorization") ?? "");
  if (bearer) return { token: bearer[1], cookie: false };
  const token = parseCookies(request.headers.get("cookie")).get(COOKIE);
  return token && token.length <= 64 ? { token, cookie: true } : null;
}

/**
 * The signed-in account for this request, or null. `setCookie` is non-null
 * when a cookie session was just extended; the router hands it back on the
 * response so the browser's copy is extended too. A bearer token's expiry
 * lives only here, so extending it is the whole job.
 */
export async function currentUser(request, env) {
  const carried = sessionToken(request);
  if (!carried) return null;
  const { token } = carried;
  const hash = await sha256Hex(token);
  const now = Date.now();
  const db = env.ONLINE_DB;
  const row = await db.prepare(
    `SELECT s.user_id, s.expires_at, u.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
  ).bind(hash, now).first();
  if (!row) return null;
  const user = { id: row.user_id, name: row.display_name, setCookie: null };
  if (row.expires_at - now < SESSION_MS - REFRESH_MS) {
    const expires = now + SESSION_MS;
    await db.batch([
      db.prepare(`UPDATE sessions SET expires_at = ?2 WHERE token_hash = ?1`).bind(hash, expires),
      db.prepare(`UPDATE users SET last_seen_at = ?2 WHERE id = ?1`).bind(row.user_id, now),
    ]);
    if (carried.cookie) user.setCookie = sessionCookie(token, expires, now);
  }
  return user;
}

/**
 * Find the account for an identity-provider subject, creating it on first
 * sight, and return its id. The id is random and never derived from the
 * subject, so nothing in R2 says whose a project is. `subject` is namespaced
 * by the caller ("sceneid:1234", "dev:alice") so two providers cannot collide.
 */
export async function signInAs(env, subject, displayName) {
  const db = env.ONLINE_DB;
  const now = Date.now();
  await db.prepare(
    `INSERT INTO users (id, sceneid_subject, display_name, created_at, last_seen_at)
          VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT (sceneid_subject)
       DO UPDATE SET display_name = excluded.display_name, last_seen_at = excluded.last_seen_at`,
  ).bind(randomId("u_", 10), subject, displayName, now).run();
  const row = await db.prepare(`SELECT id FROM users WHERE sceneid_subject = ?1`).bind(subject).first();
  return row.id;
}

/** Open a session for `userId`; returns its token. The same account's
 *  expired sessions are swept in the same write, so a person who signs in on
 *  many devices over the years leaves no pile behind. */
async function openSession(env, userId) {
  const db = env.ONLINE_DB;
  const token = randomToken();
  const now = Date.now();
  await db.batch([
    db.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND expires_at <= ?2`).bind(userId, now),
    db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(await sha256Hex(token), userId, now, now + SESSION_MS),
  ]);
  return token;
}

/** Open a session for `userId`; returns the Set-Cookie value. */
export async function createSession(env, userId) {
  const token = await openSession(env, userId);
  const now = Date.now();
  return sessionCookie(token, now + SESSION_MS, now);
}

/** Delete the session this request names (cookie or bearer), if it names one. */
async function dropSession(request, env) {
  const carried = sessionToken(request);
  if (carried) {
    await env.ONLINE_DB.prepare(`DELETE FROM sessions WHERE token_hash = ?1`)
      .bind(await sha256Hex(carried.token)).run();
  }
}

/**
 * Can the database take a sign-in? Asked BEFORE anyone is sent off to type a
 * password, so a database whose migrations were never applied fails at once,
 * with the fix in the log, instead of after the whole round trip.
 */
export async function readyForSignIn(env) {
  try {
    await env.ONLINE_DB.prepare(`SELECT 1 FROM users LIMIT 1`).first();
    await env.ONLINE_DB.prepare(`SELECT 1 FROM sessions LIMIT 1`).first();
    return true;
  } catch (err) {
    console.error("online: cannot sign anyone in:", explain(err));
    return false;
  }
}

/**
 * Record a sign-in: find or create the account, open its session (ending the
 * one this browser had), and answer with the completion page — or, when the
 * sign-in was begun by the desktop app (desktop.js), with the page that hands
 * it on to the app. Any failure here answers with the failure page too — the
 * person is looking at a small window, and a JSON error is not something to
 * leave in it.
 */
export async function completeSignIn(request, env, subject, displayName, extraCookies = []) {
  const desktop = pendingDesktop(request);
  try {
    const userId = await signInAs(env, subject, displayName);
    const session = await replaceSession(request, env, userId);
    if (desktop) return await handOff(env, userId, displayName, desktop, [...extraCookies, session]);
    return completionPage({ ok: true, setCookies: [...extraCookies, session] });
  } catch (err) {
    console.error("online: sign-in could not be recorded:", explain(err));
    // A desktop sign-in that failed is over, too: a later sign-in on the site
    // must not wander off to the app.
    return completionPage({ ok: false, setCookies: desktop ? [...extraCookies, CLEAR_PENDING] : extraCookies });
  }
}

/**
 * POST /auth/token {"code": …, "verifier": …} — the desktop app's half of
 * desktop.js: spend the code, open a session, and hand over its token, which
 * the app then sends as `Authorization: Bearer`.
 */
export async function desktopToken({ request, env }) {
  const raw = await readCapped(request, 4096);
  let body = null;
  try { body = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array(0))); } catch { /* answered below */ }
  const userId = await redeemCode(env, body?.code, body?.verifier);
  if (!userId) return fail(400, "invalid-grant");
  const token = await openSession(env, userId);
  const row = await env.ONLINE_DB.prepare(`SELECT display_name FROM users WHERE id = ?1`).bind(userId).first();
  return json({ token, user: { name: row?.display_name ?? "" } });
}

/** A sign-in completing in a browser that was already signed in — as the same
 *  account or another — ends the old session rather than leaving it behind
 *  to expire, then opens the new one. Returns its Set-Cookie value. */
export async function replaceSession(request, env, userId) {
  await dropSession(request, env);
  return createSession(env, userId);
}

/** POST /auth/logout — forget this session, here and in the browser. */
export async function signOut(request, env) {
  await dropSession(request, env);
  const res = new Response(null, { status: 204 });
  res.headers.append("set-cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return res;
}

function sessionCookie(token, expiresAt, now) {
  const maxAge = Math.floor((expiresAt - now) / 1000);
  // Lax, not Strict: the identity provider sends the browser back to us with
  // a cross-site navigation, and the sign-in has to survive it.
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/**
 * The page a sign-in window lands on at the end. It tells every open tab of
 * the app. A sign-in that worked then closes its window — the text is only
 * for a browser that will not let a script do that. One that did not work
 * stays open, because the window is the only place that can say so: the
 * person may have declined on purpose, or may need to try again. Both
 * languages at once, since nothing here knows which one the app is in — nor
 * which app: the tracker and Microtone Touch share this server, so the page
 * names neither's menus.
 * `setCookies` are Set-Cookie values: the new session, the spent state.
 */
export function completionPage({ ok, setCookies = [] }) {
  const msg = ok
    ? { en: "Signed in. You can close this window.", ko: "로그인했습니다. 이 창을 닫아도 됩니다." }
    : { en: "Sign-in did not complete. You can close this window and try again.",
        ko: "로그인하지 못했습니다. 이 창을 닫고 다시 시도하세요." };
  const type = ok ? "signed-in" : "sign-in-failed";
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light dark">
<title>Microtone</title>
<p lang="en">${msg.en}</p>
<p lang="ko">${msg.ko}</p>
<p><button type="button" onclick="window.close()">Close · 닫기</button></p>
<script>
try { new BroadcastChannel(${JSON.stringify(AUTH_CHANNEL)}).postMessage({ type: ${JSON.stringify(type)} }); } catch (e) {}
${ok ? "window.close();" : ""}
</script>
`;
  const res = new Response(html, {
    status: ok ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
  for (const c of setCookies) res.headers.append("set-cookie", c);
  return res;
}

// ── local test sign-in ──
//
// Lets the whole feature be exercised under `wrangler dev` without a
// SceneID account or a registered localhost callback, through the SAME path a
// real sign-in takes: a window opens, a cookie is set on a top-level
// navigation, the completion page broadcasts. Two locks, both required — the variable only ever lives in
// .dev.vars (gitignored), and even if it were set in production the request
// has to arrive addressed to this machine, which Cloudflare's edge never
// routes.

export function devSignInAllowed(request, env) {
  if (env.ONLINE_DEV_LOGIN !== "1") return false;
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** GET /auth/dev-login?name=alice — one test account per name. */
export async function devSignIn(request, env) {
  if (!devSignInAllowed(request, env)) return fail(404, "not-found");
  const raw = new URL(request.url).searchParams.get("name") ?? "";
  const name = raw.trim().slice(0, 40) || "tester";
  if (!(await readyForSignIn(env))) return completionPage({ ok: false });
  return completeSignIn(request, env, `dev:${name}`, `${name} (local test)`);
}
