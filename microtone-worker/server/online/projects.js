// Online projects — the five project endpoints. Every handler gets the
// signed-in account from the router and only ever touches rows whose user_id
// is that account's, so another person's project id answers 404 exactly as a
// made-up one does.
//
// D1 says which projects exist and what they are called; R2 holds the bytes
// under `u_…/p_…`. The two cannot be written in one transaction, so every
// operation is ordered so that a failure half-way leaves, at worst, bytes
// nobody points at — never a listed project with nothing behind it.

import {
  PROJECT_LIMIT, SIZE_LIMIT, PENDING_TTL_MS,
  json, fail, readCapped, isTaudProject, cleanName, isUniqueViolation, randomId,
} from "./util.js";

const COLUMNS = "id, filename, size, etag, updated_at";

/** What the client sees of a project row. `etag` is what it sends back as
 *  If-Match on the next save. */
function publicProject(row) {
  return { id: row.id, name: row.filename, size: row.size, etag: row.etag, modified: row.updated_at };
}

function ownedReady(env, user, id) {
  return env.ONLINE_DB.prepare(
    `SELECT id, r2_key, filename, etag FROM projects WHERE id = ?1 AND user_id = ?2 AND state = 'ready'`,
  ).bind(id, user.id).first();
}

const OCTETS = { contentType: "application/octet-stream" };

/** GET /projects */
export async function listProjects({ env, user }) {
  const { results } = await env.ONLINE_DB.prepare(
    `SELECT ${COLUMNS} FROM projects WHERE user_id = ?1 AND state = 'ready' ORDER BY filename`,
  ).bind(user.id).all();
  return json({ limit: PROJECT_LIMIT, sizeLimit: SIZE_LIMIT, projects: results.map(publicProject) });
}

/**
 * POST /projects?name=<name>, body = the .taud bytes.
 *
 * Quota first, bytes second: the slot is claimed by ONE statement that
 * inserts the row only while fewer than PROJECT_LIMIT exist, so two uploads racing
 * for the last slot cannot both get it, and the name's unique index means a
 * retried upload cannot land twice. The row goes in as 'pending' and turns
 * 'ready' once R2 has the object.
 */
export async function createProject({ request, env, user, url }) {
  const db = env.ONLINE_DB;
  const name = cleanName(url.searchParams.get("name"));
  if (!name) return fail(400, "bad-name");
  const now = Date.now();
  const staleBefore = now - PENDING_TTL_MS;

  // An early answer, so a full desk or a taken name is refused before up to
  // ten megabytes are accepted for nothing. Advisory only — the INSERT below
  // is what actually enforces both.
  const pre = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(filename = ?2), 0) AS clash
       FROM projects WHERE user_id = ?1 AND (state = 'ready' OR updated_at >= ?3)`,
  ).bind(user.id, name, staleBefore).first();
  if (pre.clash) return fail(409, "exists");
  if (pre.n >= PROJECT_LIMIT) return fail(409, "quota");

  const bytes = await readCapped(request, SIZE_LIMIT);
  if (!bytes) return fail(413, "too-large");
  if (!isTaudProject(bytes)) return fail(415, "not-taud");

  const id = randomId("p_", 16);
  const key = `${user.id}/${id}`;
  let stale, inserted;
  try {
    // One transaction: clear this person's dead reservations (an upload that
    // died between reserving and writing), then claim the slot.
    [stale, inserted] = await db.batch([
      db.prepare(
        `DELETE FROM projects WHERE user_id = ?1 AND state = 'pending' AND updated_at < ?2 RETURNING r2_key`,
      ).bind(user.id, staleBefore),
      db.prepare(
        `INSERT INTO projects (id, user_id, r2_key, filename, size, state, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6
          WHERE (SELECT COUNT(*) FROM projects WHERE user_id = ?2) < ?7`,
      ).bind(id, user.id, key, name, bytes.length, now, PROJECT_LIMIT),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return fail(409, "exists");
    throw err;
  }
  const staleKeys = stale.results.map((r) => r.r2_key);
  if (staleKeys.length > 0) {
    // The dead upload may or may not have written its object; either way
    // nothing points at it any more.
    try { await env.ONLINE_BUCKET.delete(staleKeys); } catch (err) { console.error("online: stale sweep", err); }
  }
  if (inserted.meta.changes !== 1) return fail(409, "quota");

  let obj;
  try {
    obj = await env.ONLINE_BUCKET.put(key, bytes, { httpMetadata: OCTETS });
  } catch (err) {
    await db.prepare(`DELETE FROM projects WHERE id = ?1`).bind(id).run();
    throw err;
  }
  await db.prepare(`UPDATE projects SET state = 'ready', etag = ?2 WHERE id = ?1`).bind(id, obj.etag).run();
  return json({ project: publicProject({ id, filename: name, size: bytes.length, etag: obj.etag, updated_at: now }) }, 201);
}

/** GET /projects/:id — the bytes, with the ETag the next save must quote. */
export async function readProject({ env, user, params }) {
  const row = await ownedReady(env, user, params.id);
  if (!row) return fail(404, "not-found");
  const obj = await env.ONLINE_BUCKET.get(row.r2_key);
  if (!obj) return fail(404, "not-found");
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(obj.size),
      "cache-control": "no-store",
      etag: obj.httpEtag,
    },
  });
}

/**
 * PUT /projects/:id, body = the .taud bytes, If-Match = the ETag it was
 * opened (or last saved) with.
 *
 * The condition is enforced by R2 itself, on the write: if the project was
 * saved from somewhere else in the meantime, nothing is written and the
 * answer is 412, so a second browser can never silently undo the first one's
 * work. `If-Match: *` is the deliberate "overwrite anyway".
 */
export async function overwriteProject({ request, env, user, params }) {
  const ifMatch = request.headers.get("if-match")?.trim();
  if (!ifMatch) return fail(428, "precondition-required");
  const row = await ownedReady(env, user, params.id);
  if (!row) return fail(404, "not-found");
  const bytes = await readCapped(request, SIZE_LIMIT);
  if (!bytes) return fail(413, "too-large");
  if (!isTaudProject(bytes)) return fail(415, "not-taud");

  const onlyIf = ifMatch === "*" ? undefined : { etagMatches: ifMatch.replace(/^W\//, "").replace(/"/g, "") };
  const obj = await env.ONLINE_BUCKET.put(row.r2_key, bytes, { httpMetadata: OCTETS, onlyIf });
  if (obj === null) return fail(412, "conflict");
  const now = Date.now();
  await env.ONLINE_DB.prepare(
    `UPDATE projects SET size = ?2, etag = ?3, updated_at = ?4 WHERE id = ?1`,
  ).bind(row.id, bytes.length, obj.etag, now).run();
  return json({ project: publicProject({ id: row.id, filename: row.filename, size: bytes.length, etag: obj.etag, updated_at: now }) });
}

/** PATCH /projects/:id, body = {"name": "<new name>"}. A rename is not an
 *  edit: the modified time stays where the last save put it. */
export async function renameProject({ request, env, user, params }) {
  let body;
  try { body = await request.json(); } catch { return fail(400, "bad-request"); }
  const name = cleanName(body?.name);
  if (!name) return fail(400, "bad-name");
  let row;
  try {
    row = await env.ONLINE_DB.prepare(
      `UPDATE projects SET filename = ?3 WHERE id = ?1 AND user_id = ?2 AND state = 'ready' RETURNING ${COLUMNS}`,
    ).bind(params.id, user.id, name).first();
  } catch (err) {
    if (isUniqueViolation(err)) return fail(409, "exists");
    throw err;
  }
  if (!row) return fail(404, "not-found");
  return json({ project: publicProject(row) });
}

/** DELETE /projects/:id — the row first, so the slot is free and the project
 *  gone from every listing even if the object delete then fails. */
export async function deleteProject({ env, user, params }) {
  const row = await env.ONLINE_DB.prepare(
    `DELETE FROM projects WHERE id = ?1 AND user_id = ?2 AND state = 'ready' RETURNING r2_key`,
  ).bind(params.id, user.id).first();
  if (!row) return fail(404, "not-found");
  try { await env.ONLINE_BUCKET.delete(row.r2_key); } catch (err) { console.error("online: delete", err); }
  return new Response(null, { status: 204 });
}
