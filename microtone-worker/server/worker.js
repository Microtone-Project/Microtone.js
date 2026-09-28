// The microtone Worker (wrangler.toml at the repository root). Everything the
// site is made of is a static file, served by Cloudflare before this code
// runs; a request reaches it only when no file matches. The one thing that
// lives here is the online-projects API — every other miss is an ordinary 404.

import { handle } from "./online/router.js";

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/api/online")) return handle(request, env);
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
