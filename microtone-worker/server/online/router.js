// Online projects — the HTTP surface. functions/api/online/[[path]].js hands
// every request under /api/online here; the tests call handle() directly.
//
//   GET    /api/online/me                   who is signed in, and how to sign in
//   GET    /api/online/projects             this person's projects
//   POST   /api/online/projects?name=…      a new one (body: .taud bytes)
//   GET    /api/online/projects/:id         its bytes
//   PUT    /api/online/projects/:id         save over it (If-Match: its ETag)
//   PATCH  /api/online/projects/:id         rename it ({"name": …})
//   DELETE /api/online/projects/:id
//   GET    /api/online/auth/login           → SceneID  (sceneid.js)
//   GET    /api/online/auth/callback        ← SceneID
//   POST   /api/online/auth/logout
//   GET    /api/online/auth/dev-login       local test sign-in (auth.js)
//
// Bindings (wrangler.toml): ONLINE_DB is the D1 database, ONLINE_BUCKET the R2
// bucket. There are no R2 or D1 credentials anywhere — a binding IS the
// permission — so the only secret this server will ever read is SceneID's.

import { fail, json } from "./util.js";
import { currentUser, signOut, devSignIn, devSignInAllowed } from "./auth.js";
import { sceneIdConfigured, beginSignIn, finishSignIn } from "./sceneid.js";
import {
  listProjects, createProject, readProject, overwriteProject, renameProject, deleteProject,
} from "./projects.js";

const PREFIX = "/api/online";

/** `session` says whether a route looks at the signed-in account at all:
 *  "required" answers 401 to anyone without one, "optional" passes null. The
 *  sign-in routes have none, so they never re-issue the cookie of a session
 *  they are in the middle of replacing or ending. */
const ROUTES = [
  { path: /^\/me$/, session: "optional", GET: me },
  { path: /^\/projects$/, session: "required", GET: listProjects, POST: createProject },
  {
    path: /^\/projects\/(?<id>p_[0-9A-Za-z]{16})$/, session: "required",
    GET: readProject, PUT: overwriteProject, PATCH: renameProject, DELETE: deleteProject,
  },
  { path: /^\/auth\/login$/, GET: (c) => beginSignIn(c.request, c.env) },
  { path: /^\/auth\/callback$/, GET: (c) => finishSignIn(c.request, c.env) },
  { path: /^\/auth\/logout$/, POST: (c) => signOut(c.request, c.env) },
  { path: /^\/auth\/dev-login$/, GET: (c) => devSignIn(c.request, c.env) },
];

/** How this deployment lets people sign in: "sceneid", "dev", or null for
 *  "not at all yet" — in which case the app shows no online section. */
function signInMode(request, env) {
  if (sceneIdConfigured(env)) return "sceneid";
  if (devSignInAllowed(request, env)) return "dev";
  return null;
}

/** GET /me. Answers 200 either way, so a signed-out visit is not an error in
 *  anyone's console. */
function me({ request, env, user }) {
  const signIn = signInMode(request, env);
  if (!user) return json({ signedIn: false, signIn });
  return json({ signedIn: true, user: { name: user.name }, signIn });
}

/**
 * A state-changing request must come from the app's own pages. The session
 * cookie is SameSite=Lax, which already keeps it off cross-site POSTs; this
 * is the second lock, for browsers old enough to ignore that. A request with
 * neither header is not from a browser, so it carries no victim's cookie.
 */
function sameOrigin(request, url) {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  return origin === null || origin === url.origin;
}

export async function handle(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return fail(404, "not-found");
  const sub = url.pathname.slice(PREFIX.length).replace(/\/+$/, "");
  let route = null;
  let match = null;
  for (const r of ROUTES) {
    match = r.path.exec(sub);
    if (match) { route = r; break; }
  }
  if (!route) return fail(404, "not-found");
  const handler = route[request.method];
  if (!handler) return fail(405, "method");
  // A deploy without its bindings answers 503, which the client takes as "no
  // online projects on this site" — the same as the 404 a static host gives.
  if (!env.ONLINE_DB || !env.ONLINE_BUCKET) return fail(503, "unconfigured");
  if (request.method !== "GET" && !sameOrigin(request, url)) return fail(403, "cross-origin");

  try {
    const user = route.session ? await currentUser(request, env) : null;
    if (route.session === "required" && !user) return fail(401, "signed-out");
    const res = await handler({ request, env, url, user, params: match.groups ?? {} });
    // A session that was just extended re-issues its cookie on whatever the
    // answer was.
    if (user?.setCookie) res.headers.append("set-cookie", user.setCookie);
    return res;
  } catch (err) {
    console.error("online:", err);
    return fail(500, "server-error");
  }
}
