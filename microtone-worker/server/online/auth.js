// Online projects — accounts and sessions.
//
// Everything here is independent of HOW someone proved who they are. An
// identity provider hands over a stable subject and a display name; from
// there it is signInAs → createSession → completionPage, and the same three
// calls serve the local test sign-in below. SceneID plugs in at sceneid.js.
//
// A session is a random token in an HttpOnly cookie. D1 holds only its
// SHA-256, so the table is useless to anyone who reads it, and signing out
// (or deleting the row) ends the session at once — no signed-cookie secret to
// rotate, and nothing to keep in sync between deploys.

import { randomId, randomToken, sha256Hex, parseCookies, fail } from "./util.js";

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

/** The same name as the client's (src/storage/online.js AUTH_CHANNEL): the
 *  page that finishes a sign-in announces it here, and every open tab of the
 *  app is listening. A BroadcastChannel rather than window.opener, because the
 *  app is served cross-origin-isolated (COOP same-origin), and the round trip
 *  through the identity provider's pages severs the opener. */
const AUTH_CHANNEL = "microtone-online";

/**
 * The signed-in account for this request, or null. `setCookie` is non-null
 * when the session was just extended; the router hands it back on the
 * response so the browser's copy is extended too.
 */
export async function currentUser(request, env) {
  const token = parseCookies(request.headers.get("cookie")).get(COOKIE);
  if (!token || token.length > 64) return null;
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
    user.setCookie = sessionCookie(token, expires, now);
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

/** Open a session for `userId`; returns the Set-Cookie value. The same
 *  account's expired sessions are swept in the same write, so a person who
 *  signs in on many devices over the years leaves no pile behind. */
export async function createSession(env, userId) {
  const db = env.ONLINE_DB;
  const token = randomToken();
  const now = Date.now();
  const expires = now + SESSION_MS;
  await db.batch([
    db.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND expires_at <= ?2`).bind(userId, now),
    db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(await sha256Hex(token), userId, now, expires),
  ]);
  return sessionCookie(token, expires, now);
}

/** POST /auth/logout — forget this session, here and in the browser. */
export async function signOut(request, env) {
  const token = parseCookies(request.headers.get("cookie")).get(COOKIE);
  if (token && token.length <= 64) {
    await env.ONLINE_DB.prepare(`DELETE FROM sessions WHERE token_hash = ?1`)
      .bind(await sha256Hex(token)).run();
  }
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
 * the app, then closes itself; the text is only for the case where the
 * browser will not let a script close the window. `setCookie` is the new
 * session, if the sign-in worked.
 */
export function completionPage({ ok, setCookie = null }) {
  const msg = ok
    ? { en: "Signed in. You can close this window.", ko: "로그인했습니다. 이 창을 닫아도 됩니다." }
    : { en: "Sign-in did not complete. You can close this window.", ko: "로그인하지 못했습니다. 이 창을 닫아도 됩니다." };
  const type = ok ? "signed-in" : "sign-in-failed";
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Microtone</title>
<p lang="en">${msg.en}</p>
<p lang="ko">${msg.ko}</p>
<script>
try { new BroadcastChannel(${JSON.stringify(AUTH_CHANNEL)}).postMessage({ type: ${JSON.stringify(type)} }); } catch (e) {}
window.close();
</script>
`;
  const res = new Response(html, {
    status: ok ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
  if (setCookie) res.headers.append("set-cookie", setCookie);
  return res;
}

// ── local test sign-in ──
//
// Lets the whole feature be exercised under `wrangler pages dev` before the
// SceneID client exists, through the SAME path a real sign-in takes: a window
// opens, a cookie is set on a top-level navigation, the completion page
// broadcasts. Two locks, both required — the variable only ever lives in
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
  const userId = await signInAs(env, `dev:${name}`, `${name} (local test)`);
  return completionPage({ ok: true, setCookie: await createSession(env, userId) });
}
