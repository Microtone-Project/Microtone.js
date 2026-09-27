// SceneID sign-in — NOT WIRED YET. The client registration is still under
// review, so both endpoints answer 503 and sceneIdConfigured() says no, which
// keeps the online section of the File tab hidden on the live site. Nothing
// else in the online-projects server has to change when this file is filled
// in.
//
// What goes here, as an OAuth 2.0 authorization-code flow:
//
//   beginSignIn   GET /api/online/auth/login
//     Make a random `state` (and a PKCE verifier, if SceneID takes one), keep
//     them in a short-lived cookie — HttpOnly, Secure, SameSite=Lax, Path
//     /api/online/auth — and redirect to SceneID's authorize endpoint with
//     env.SCENEID_CLIENT_ID and redirect_uri = <origin>/api/online/auth/callback.
//
//   finishSignIn  GET /api/online/auth/callback?code=…&state=…
//     Check `state` against the cookie (and clear it). Exchange the code at
//     the token endpoint with env.SCENEID_CLIENT_SECRET, fetch the user's id
//     and display name with the access token, then:
//
//       const userId = await signInAs(env, `sceneid:${id}`, displayName);
//       return completionPage({ ok: true, setCookie: await createSession(env, userId) });
//
//     Any failure answers completionPage({ ok: false }). The access token is
//     not kept: the app's own session is all later requests need.
//
// and then sceneIdConfigured() becomes
//   Boolean(env.SCENEID_CLIENT_ID && env.SCENEID_CLIENT_SECRET)
//
// SCENEID_CLIENT_SECRET is a Pages SECRET (dashboard, or `wrangler pages
// secret put`) and .dev.vars locally — never wrangler.toml, never a file.

import { fail } from "./util.js";

export function sceneIdConfigured(env) {
  return false;
}

export async function beginSignIn(request, env) {
  return fail(503, "sign-in-unavailable");
}

export async function finishSignIn(request, env) {
  return fail(503, "sign-in-unavailable");
}
