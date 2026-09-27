// Stand-ins for the Cloudflare bindings the online-projects server runs
// against, so its handlers can be tested under Node without wrangler:
//
//   FakeD1  — the D1 client API (prepare/bind/first/all/run/batch) over a real
//             SQLite (node:sqlite), loaded from migrations/ — so the SQL under
//             test is the SQL that ships, constraints and RETURNING included.
//             batch() is one transaction, as on D1.
//   FakeR2  — an in-memory bucket with R2's put/get/delete, including the
//             onlyIf.etagMatches condition put returns null for. ETags are the
//             MD5 of the content, as R2's are for a single-part upload.
//   browser — a cookie jar in front of handle(), standing in for the browser.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { handle } from "../../server/online/router.js";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

class FakeStatement {
  constructor(sqlite, sql, params = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new FakeStatement(this.sqlite, this.sql, params);
  }

  async first(column) {
    const row = this.sqlite.prepare(this.sql).get(...this.params) ?? null;
    return column === undefined ? row : (row?.[column] ?? null);
  }

  async all() { return this.exec(); }
  async run() { return this.exec(); }

  /** Synchronous, so that batch() can run several inside one transaction. */
  exec() {
    const results = this.sqlite.prepare(this.sql).all(...this.params);
    const changes = /^\s*select\b/i.test(this.sql)
      ? 0
      : this.sqlite.prepare("SELECT changes() AS c").get().c;
    return { success: true, results, meta: { changes } };
  }
}

export class FakeD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
    /** Awaited before every batch, if set — lets a test hold requests at the
     *  door of the transaction until all of them have arrived (barrier()). */
    this.beforeBatch = null;
  }

  prepare(sql) { return new FakeStatement(this.sqlite, sql); }

  async batch(statements) {
    if (this.beforeBatch) await this.beforeBatch();
    this.sqlite.exec("BEGIN");
    try {
      const out = statements.map((s) => s.exec());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

export class FakeR2 {
  constructor() {
    this.objects = new Map();
    /** Set to make the next put throw, as a failed R2 write would. */
    this.failNextPut = false;
  }

  async put(key, value, { onlyIf } = {}) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("R2 put failed (injected)");
    }
    const bytes = new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer.slice(
      value.byteOffset, value.byteOffset + value.byteLength));
    const current = this.objects.get(key);
    if (onlyIf?.etagMatches !== undefined && current?.etag !== onlyIf.etagMatches) return null;
    const etag = createHash("md5").update(bytes).digest("hex");
    const obj = { key, etag, httpEtag: `"${etag}"`, size: bytes.length, bytes };
    this.objects.set(key, obj);
    return { key, etag, httpEtag: obj.httpEtag, size: obj.size };
  }

  async get(key) {
    const obj = this.objects.get(key);
    if (!obj) return null;
    return { key, etag: obj.etag, httpEtag: obj.httpEtag, size: obj.size, body: new Blob([obj.bytes]).stream() };
  }

  async delete(keys) {
    for (const k of [].concat(keys)) this.objects.delete(k);
  }
}

/** A hook for FakeD1.beforeBatch that holds every caller until `n` of them
 *  are waiting, then lets them all go at once. */
export function barrier(n) {
  let waiting = 0;
  let open;
  const gate = new Promise((r) => { open = r; });
  return async () => {
    if (++waiting === n) open();
    await gate;
  };
}

/** A fresh environment: an empty database with every migration applied, an
 *  empty bucket, and the local test sign-in switched on unless `dev: false`. */
export function onlineEnv({ dev = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON"); // always on in D1
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  }
  const env = { ONLINE_DB: new FakeD1(sqlite), ONLINE_BUCKET: new FakeR2(), sqlite };
  if (dev) env.ONLINE_DEV_LOGIN = "1";
  return env;
}

/**
 * One browser: its own cookie jar, and a fetch() that goes straight to the
 * router. Relative URLs resolve against `origin`, and requests carry the
 * Sec-Fetch-Site a same-origin fetch from the app would.
 */
export function browser(env, origin = "http://localhost:8788") {
  const jar = new Map();
  async function fetchFn(input, init = {}) {
    const headers = new Headers(init.headers);
    if (jar.size > 0) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");
    const res = await handle(new Request(new URL(input, origin), { ...init, headers }), env);
    for (const cookie of res.headers.getSetCookie()) {
      const [pair, ...attrs] = cookie.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(name);
      else jar.set(name, pair.slice(eq + 1).trim());
    }
    return res;
  }
  return {
    jar,
    fetch: fetchFn,
    /** The local test sign-in, as the sign-in window would perform it. */
    signIn: (name = "alice") => fetchFn(`/api/online/auth/dev-login?name=${encodeURIComponent(name)}`),
  };
}

/** The smallest byte string the server accepts as a project: a .taud header
 *  (container kind 00, version 2), padded; `fill` makes two of them differ. */
export function taudBytes(size = 64, fill = 0) {
  const b = new Uint8Array(size).fill(fill);
  b.set([0x1f, 0x54, 0x53, 0x56, 0x4d, 0x61, 0x75, 0x64, 0x02], 0);
  return b;
}
