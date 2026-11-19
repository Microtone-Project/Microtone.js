// The microtone Worker (wrangler.toml at the repository root) — and the
// microtone-touch Worker too (microtone-touch-worker/wrangler.toml), which
// runs this same code with the same D1 and R2 bindings, so the two sites are
// one account and one set of projects. Everything either site is made of is a
// static file, served by Cloudflare before this code runs; a request reaches
// it only when no file matches. What lives here is the online-projects API
// and the desktop app's update address (desktop-update.js) — every other miss
// is an ordinary 404.

import { handle } from "./online/router.js";
import { desktopUpdate, UPDATE_PATH } from "./desktop-update.js";

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/online")) return handle(request, env);
    if (path === UPDATE_PATH) return desktopUpdate(request);
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
