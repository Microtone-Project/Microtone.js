// Online projects in the desktop app (desktop/ at the repository root).
//
// The app is not a browser on this origin, so it cannot hold the session
// cookie. It holds an ACCESS TOKEN instead — an ordinary session (auth.js),
// sent as `Authorization: Bearer` — and gets it the way RFC 8252 says a
// native app should: in the system's own browser, where the person may be
// signed in to this site already, then back through the app's URI scheme.
//
//   1. The app makes a secret verifier and opens the browser at
//        GET /api/online/auth/desktop?challenge=<S256 of it>&state=<…>
//      (PKCE, RFC 7636). Signed in here already → step 2 at once. Not yet →
//      challenge and state wait in a cookie while the ordinary sign-in runs
//      (SceneID, or the local test sign-in), and auth.js completeSignIn()
//      ends in step 2 instead of the window-closing completion page.
//   2. handOff(): a one-time code, bound to the challenge, good for five
//      minutes, and a page that sends the browser on to
//        cc.microtone.desktop:/signed-in?code=…&state=…
//      which the operating system hands to the app.
//   3. The app swaps code and verifier for the token:
//        POST /api/online/auth/token   {"code": …, "verifier": …}
//      → {"token": …, "user": {"name": …}}   (auth.js desktopToken)
//
// Only the holder of the verifier can spend a code, and only the app that
// started the sign-in holds it: a code read off the address bar, out of the
// browser's history, or by another program that claims the scheme is worth
// nothing. The state is the app's own check that the code answers ITS
// request; the server only carries it.

import { randomToken, sha256Hex, parseCookies } from "./util.js";

/** Where a code goes: the app's URI scheme (desktop/tauri.conf.json,
 *  plugins.deep-link), reverse-domain as RFC 8252 §7.1 asks of a native app. */
export const RETURN_URL = "cc.microtone.desktop:/signed-in";

/** Challenge and state, while an ordinary sign-in runs in between. __Host-
 *  and Lax for the reason the SceneID state cookie is: the way back from
 *  SceneID is a cross-site navigation. Lives as long as that state does. */
const PENDING_COOKIE = "__Host-mt_desktop";
const PENDING_TTL_S = 20 * 60;

/** A code only has to cross from the browser to the app on the same machine. */
export const CODE_TTL_MS = 5 * 60 * 1000;

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/; // BASE64URL of a SHA-256, unpadded
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/; // util.js randomToken()
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/; // RFC 7636 §4.1

/** RFC 7636 S256: BASE64URL(SHA-256(ASCII(verifier))). */
export async function s256(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The desktop sign-in this browser is in the middle of, or null. */
export function pendingDesktop(request) {
  const raw = parseCookies(request.headers.get("cookie")).get(PENDING_COOKIE) ?? "";
  const [challenge = "", state = ""] = raw.split(".");
  return CHALLENGE.test(challenge) && STATE.test(state) ? { challenge, state } : null;
}

export const CLEAR_PENDING = `${PENDING_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/**
 * GET /auth/desktop?challenge=…&state=… — where the app sends the browser.
 * `user` is this browser's own session, if it has one; `signIn` how this
 * deployment signs people in (router.js signInMode).
 */
export async function beginDesktopSignIn({ url, env, user, signIn }) {
  const challenge = url.searchParams.get("challenge") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!CHALLENGE.test(challenge) || !STATE.test(state)) return desktopPage({ kind: "bad-request" }, 400);
  if (user) return handOff(env, user.id, user.name, { challenge, state });
  const pending = `${PENDING_COOKIE}=${challenge}.${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${PENDING_TTL_S}`;
  if (signIn === "sceneid") {
    const res = new Response(null, {
      status: 302,
      headers: { location: "/api/online/auth/login", "cache-control": "no-store" },
    });
    res.headers.append("set-cookie", pending);
    return res;
  }
  if (signIn === "dev") return desktopPage({ kind: "dev" }, 200, [pending]);
  return desktopPage({ kind: "unavailable" }, 503);
}

/**
 * Issue the one-time code for `userId`, and answer with the page that takes
 * it back to the app. `cookies` are Set-Cookie values to send with it (a new
 * session, a spent SceneID state); the pending desktop sign-in is cleared.
 */
export async function handOff(env, userId, name, { challenge, state }, cookies = []) {
  const code = randomToken();
  const now = Date.now();
  const db = env.ONLINE_DB;
  await db.batch([
    db.prepare(`DELETE FROM desktop_codes WHERE expires_at <= ?1`).bind(now),
    db.prepare(`INSERT INTO desktop_codes (code_hash, user_id, challenge, expires_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(await sha256Hex(code), userId, challenge, now + CODE_TTL_MS),
  ]);
  const back = `${RETURN_URL}?${new URLSearchParams({ code, state })}`;
  return desktopPage({ kind: "hand-off", name, back }, 200, [...cookies, CLEAR_PENDING]);
}

/**
 * Spend a code: the account it was issued to, or null. The query that reads
 * the code deletes it, so it is good once even when two requests race — and
 * a wrong verifier spends it as surely as the right one.
 */
export async function redeemCode(env, code, verifier) {
  if (typeof code !== "string" || !CODE.test(code)) return null;
  if (typeof verifier !== "string" || !VERIFIER.test(verifier)) return null;
  const row = await env.ONLINE_DB.prepare(
    `DELETE FROM desktop_codes WHERE code_hash = ?1 RETURNING user_id, challenge, expires_at`,
  ).bind(await sha256Hex(code)).first();
  if (!row || row.expires_at <= Date.now()) return null;
  return row.challenge === await s256(verifier) ? row.user_id : null;
}

/**
 * The pages the browser shows along the way. Both languages at once, as on
 * the completion page (auth.js): nothing here knows which one the app is in.
 */
function desktopPage({ kind, name = "", back = "" }, status, cookies = []) {
  const who = esc(name);
  const body = {
    "hand-off": `
<p lang="en">Signed in as <b>${who}</b>. Microtone on this computer takes it from here — your browser may ask whether to open it.</p>
<p lang="ko"><b>${who}</b>(으)로 로그인했습니다. 이제 이 컴퓨터의 Microtone이 이어받습니다 — 브라우저가 Microtone을 열지 물을 수 있습니다.</p>
<p><a id="back" href="${esc(back)}">Open Microtone · Microtone 열기</a></p>
<p lang="en">You can close this tab afterwards.</p>
<p lang="ko">그런 다음 이 탭을 닫아도 됩니다.</p>
<script>location.href = document.getElementById("back").href;</script>`,
    dev: `
<p lang="en">Test sign-in for the desktop app (this server has no SceneID).</p>
<p lang="ko">데스크톱 앱용 테스트 로그인입니다 (이 서버에는 SceneID가 없습니다).</p>
<form action="/api/online/auth/dev-login"><input name="name" value="tester"> <button>Sign in · 로그인</button></form>`,
    "bad-request": `
<p lang="en">This sign-in link is not complete. Start again from the File tab in Microtone.</p>
<p lang="ko">이 로그인 링크가 온전하지 않습니다. Microtone의 파일 탭에서 다시 시작하세요.</p>`,
    unavailable: `
<p lang="en">Online projects are not available on this server.</p>
<p lang="ko">이 서버에서는 온라인 프로젝트를 쓸 수 없습니다.</p>`,
  }[kind];
  const res = new Response(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light dark">
<title>Microtone</title>${body}
`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The code is in this page's links; keep it out of any Referer.
      "referrer-policy": "no-referrer",
    },
  });
  for (const c of cookies) res.headers.append("set-cookie", c);
  return res;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
