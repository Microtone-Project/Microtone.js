#!/usr/bin/env python3
"""The translation workbench, served from the repository so that Save writes
the files in place. Port 8940.

    python3 microtone-worker/tools/cat-server.py      # from the repo root
    # → http://localhost:8940/microtone-worker/translation/

Everything else is a plain static file server of the directory it is run
from (the repository root), like tools/test-server.py. Two extra endpoints:

    GET  /__cat/ping   {"cat": 1} — the page asks before offering to write
    POST /__cat/save   {"files": [{"path", "text"}]} — writes them, all or none

A save may only write a translation: an app's language table other than
en.js (the reference, which only a developer changes), or the workbench's
own record under translation/data/. Anything else is refused, and so is a
request without the X-Microtone-CAT header (a page on another site cannot
send that header without a preflight, which this server never answers) or
from another origin. It listens on 127.0.0.1 only.
"""
import http.server
import json
import os
import re
import sys
import tempfile

PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8940)
ROOT = os.getcwd()

WRITABLE = [
    re.compile(r"^microtone-worker/src/ui/lang/(?!en\.js$)[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\.js$"),
    re.compile(r"^microtone-touch-worker/src/lang/(?!en\.js$)[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\.js$"),
    re.compile(r"^microtone-worker/translation/data/[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\.json$"),
]
MAX_BODY = 16 * 1024 * 1024


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split("?")[0] == "/__cat/ping":
            return self._json(200, {"cat": 1})
        super().do_GET()

    def do_POST(self):
        if self.path != "/__cat/save":
            return self._json(404, {"error": "no such endpoint"})
        if self.headers.get("X-Microtone-CAT") != "1":
            return self._json(403, {"error": "missing X-Microtone-CAT"})
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        if origin and origin not in (f"http://{host}",):
            return self._json(403, {"error": f"refused origin {origin}"})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "bad length"})
        try:
            files = json.loads(self.rfile.read(length).decode("utf-8"))["files"]
            plan = []
            for f in files:
                path, text = f["path"], f["text"]
                if not isinstance(path, str) or not isinstance(text, str):
                    raise ValueError("path and text must be strings")
                if ".." in path.split("/") or not any(r.match(path) for r in WRITABLE):
                    raise ValueError(f"not a translation file: {path}")
                plan.append((os.path.join(ROOT, *path.split("/")), text, path))
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
            return self._json(400, {"error": str(e)})
        # All or none: every file goes to a temporary beside it first.
        temps = []
        try:
            for abs_path, text, _ in plan:
                os.makedirs(os.path.dirname(abs_path), exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=os.path.dirname(abs_path), prefix=".cat-")
                with os.fdopen(fd, "w", encoding="utf-8", newline="") as out:
                    out.write(text)
                # mkstemp makes it 0600; the file keeps the mode it had.
                mode = os.stat(abs_path).st_mode & 0o777 if os.path.exists(abs_path) else 0o644
                os.chmod(tmp, mode)
                temps.append((tmp, abs_path))
            for tmp, abs_path in temps:
                os.replace(tmp, abs_path)
        except OSError as e:
            for tmp, _ in temps:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            return self._json(500, {"error": str(e)})
        sys.stderr.write("cat-server: wrote " + ", ".join(p for _, _, p in plan) + "\n")
        return self._json(200, {"written": [p for _, _, p in plan]})


if __name__ == "__main__":
    if not os.path.isdir(os.path.join(ROOT, "microtone-worker", "translation")):
        sys.exit("cat-server: run it from the repository root")
    print(f"cat-server: http://localhost:{PORT}/microtone-worker/translation/")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
