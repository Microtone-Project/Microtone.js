// SceneID sign-in (https://id.scene.org/docs/) — OAuth 2.0 with the
// authorization-code grant, the only one SceneID offers. The app opens a small
// window on /api/online/auth/login, and everything after that happens in it:
//
//   beginSignIn   GET /api/online/auth/login
//     Make a random `state`, keep it in a short-lived cookie, and send the
//     window on to SceneID's authorize page.
//
//   (SceneID)     The person signs in there and, the first time, allows
//                 Microtone to see their SceneID.
//
//   finishSignIn  GET /api/online/auth/callback?code=…&state=…
//     The state must match the cookie: that is what stops a sign-in someone
//     else started from being completed in this browser. The code is swapped
//     for an access token — HTTP Basic with the client id and secret, exactly
//     as the docs spell it — the token reads /me/, and SceneID's user id
//     becomes the account (the docs: the id is the identity; display names
//     change). completionPage() then tells every open tab of the app.
//
// The access token is used once and dropped: the app's own session is all
// later requests need. Only scope "basic" is asked for, and of what it returns
// only the id and the display name are kept — never the real name.
//
// SceneID only sends people back to REGISTERED redirect URIs, so each origin
// that signs in needs <origin>/api/online/auth/callback listed under
// "Maintained websites" in the SceneID profile: https://microtone.cc,
// https://touch.microtone.cc (Microtone Touch, its own Worker on this same
// code), and http://localhost:8788 for `wrangler dev --port 8788`.
//
// SCENEID_CLIENT_ID and SCENEID_CLIENT_SECRET come from the environment:
// Worker secrets in production, .dev.vars locally — never a file here.

import { fail, randomToken, parseCookies } from "./util.js";
import { readyForSignIn, completeSignIn, completionPage } from "./auth.js";

const AUTHORIZE_URL = "https://id.scene.org/oauth/authorize/";
const TOKEN_URL = "https://id.scene.org/oauth/token/";
const ME_URL = "https://id.scene.org/api/3.0/me/";

/** Holds `state` between the two halves. __Host- (so Path=/), and Lax because
 *  SceneID sends the window back with a cross-site navigation, which Lax lets
 *  through for a top-level GET and Strict would not. */
const STATE_COOKIE = "__Host-mt_sceneid";

/** Long enough to register a SceneID account on the way, if need be. */
const STATE_TTL_S = 20 * 60;

/** Per request to SceneID. The window shows a spinner-less blank until the
 *  callback answers, so a stall should end in a message, not in nothing. */
const TIMEOUT_MS = 10_000;

export function sceneIdConfigured(env) {
  return Boolean(env.SCENEID_CLIENT_ID && env.SCENEID_CLIENT_SECRET);
}

/** Where SceneID sends the window back to — on whatever origin this request
 *  came in on, so production, a preview and localhost each use their own. */
function callbackUrl(request) {
  return new URL("/api/online/auth/callback", request.url).href;
}

function stateCookie(value, maxAge) {
  return `${STATE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** GET /auth/login */
export async function beginSignIn(request, env) {
  if (!sceneIdConfigured(env)) return fail(503, "sign-in-unavailable");
  if (!(await readyForSignIn(env))) return completionPage({ ok: false });
  const state = randomToken();
  const target = new URL(AUTHORIZE_URL);
  target.search = new URLSearchParams({
    client_id: env.SCENEID_CLIENT_ID,
    redirect_uri: callbackUrl(request),
    response_type: "code",
    scope: "basic",
    state,
  }).toString();
  const res = new Response(null, {
    status: 302,
    headers: { location: target.href, "cache-control": "no-store" },
  });
  res.headers.append("set-cookie", stateCookie(state, STATE_TTL_S));
  return res;
}

/** GET /auth/callback — always answers with the completion page, and always
 *  spends the state, whichever way it went. */
export async function finishSignIn(request, env) {
  if (!sceneIdConfigured(env)) return fail(503, "sign-in-unavailable");
  const url = new URL(request.url);
  const spent = stateCookie("", 0);
  const failed = (why) => {
    console.warn(`online: SceneID sign-in did not complete: ${why}`);
    return completionPage({ ok: false, setCookies: [spent] });
  };

  const expected = parseCookies(request.headers.get("cookie")).get(STATE_COOKIE);
  const state = url.searchParams.get("state");
  if (!expected || state !== expected) return failed("state does not match");
  // Declined at SceneID, or an error it reports back instead of a code.
  const error = url.searchParams.get("error");
  if (error) return failed(`authorize answered ${error}`);
  const code = url.searchParams.get("code");
  if (!code) return failed("no code");

  let who;
  try {
    who = await identify(env, code, callbackUrl(request));
  } catch (err) {
    return failed(err.message);
  }
  return completeSignIn(request, env, `sceneid:${who.id}`, who.name, [spent]);
}

/** Code → access token → { id, name } of the SceneID user. Throws with a
 *  short reason (never a token) when any step does not give what it should. */
async function identify(env, code, redirectUri) {
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      // The docs: client id as the user name, secret as the password, as they
      // are — not form-encoded first.
      authorization: `Basic ${btoa(`${env.SCENEID_CLIENT_ID}:${env.SCENEID_CLIENT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const token = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || typeof token?.access_token !== "string") {
    throw new Error(`token endpoint answered ${tokenRes.status} ${token?.error ?? ""}`.trim());
  }

  const meRes = await fetch(ME_URL, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const me = await meRes.json().catch(() => null);
  const user = me?.success === true ? me.user : null;
  const id = user?.id === undefined || user?.id === null ? "" : String(user.id);
  if (!meRes.ok || !id) throw new Error(`/me/ answered ${meRes.status}`);
  const name = String(user.display_name ?? "").trim().slice(0, 100) || `SceneID ${id}`;
  return { id, name };
}
