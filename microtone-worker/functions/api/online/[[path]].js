// Cloudflare Pages Function: every request under /api/online — the online
// projects API. The routing and all the logic live in server/online/, where
// Node can import them for the tests; this file only adapts Pages' calling
// convention. Pages builds a Function only for the paths under functions/,
// so the rest of the site stays plain static files.

import { handle } from "../../../server/online/router.js";

export const onRequest = (context) => handle(context.request, context.env);
