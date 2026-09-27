// Online projects — the small pieces every handler shares: limits, random ids,
// responses, the capped body reader and the two validators.
//
// Runs on Cloudflare's Workers runtime (as Pages Functions) and under Node for
// the tests, so it keeps to what both have: Web Crypto, fetch's Request and
// Response, and streams. Nothing here reads the environment.

/** Slots per person. The number is the point: eight is a desk, not an
 *  archive, and the interface says "working projects" for the same reason. */
export const PROJECT_LIMIT = 8;

/** Per-file ceiling. Real projects stay well under half of it; the ceiling is
 *  there so a slot cannot be used to park something that is not a song. */
export const SIZE_LIMIT = 10 * 1024 * 1024;

/** A reserved slot whose upload has not finished after this long is taken to
 *  have died. The body is read BEFORE the slot is reserved, so a live
 *  reservation only ever spans one R2 write — seconds, never minutes. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `prefix` + `length` base-62 characters from the CSPRNG. Bytes of 248 and
 *  above are thrown away rather than folded, so every character is equally
 *  likely (248 = 4 × 62). */
export function randomId(prefix, length) {
  let out = prefix;
  while (out.length < prefix.length + length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < 248 && out.length < prefix.length + length) out += BASE62[b % 62];
    }
  }
  return out;
}

/** A 256-bit bearer token, base64url. */
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── responses ──
//
// Nothing the API answers is cacheable: every body is one person's own data.

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** An error the client can switch on: `{ error: "<code>" }`. The codes are
 *  the API's vocabulary — the client maps them to sentences in the user's
 *  own language, so nothing here is prose. */
export function fail(status, code) {
  return json({ error: code }, status);
}

/**
 * The request body, or null once it passes `limit` bytes. Reads the stream
 * rather than trusting Content-Length alone, so a chunked upload cannot slip
 * past the ceiling — and stops reading the moment it does, so an oversized
 * body is never held in memory whole.
 */
export async function readCapped(request, limit) {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// ── validators ──

const TAUD_MAGIC = [0x1f, 0x54, 0x53, 0x56, 0x4d, 0x61, 0x75, 0x64]; // \x1FTSVMaud

/**
 * Is this a complete Taud PROJECT — the magic, then container kind `00` in
 * the version byte (TAUD_FILE_FORMAT.md §1)? A bank (.tsii) or a song-only
 * file (.tpif) is not a working project, and anything without the magic is
 * not a song at all. The header is all that is checked: the app wrote these
 * bytes, and the app is what will parse them.
 */
export function isTaudProject(bytes) {
  if (bytes.length < 32) return false;
  for (let i = 0; i < TAUD_MAGIC.length; i++) if (bytes[i] !== TAUD_MAGIC[i]) return false;
  return (bytes[8] >> 6) === 0;
}

const NAME_MAX = 120;

/**
 * A project name as the server will store it, or null. NFC, so the same name
 * typed on two systems is one name — Hangul in particular arrives decomposed
 * from some keyboards. It must end in `.taud` (the client adds it, as the
 * local Save As does) and have something in front of that; separators and
 * control characters are refused rather than stripped, since a name that was
 * silently changed is a name the person cannot find again.
 */
export function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").trim();
  if (name.length > NAME_MAX || !name.endsWith(".taud") || name.length === ".taud".length) return null;
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) return null;
  return name;
}

/** Did this D1 (or SQLite) error come from a UNIQUE index? */
export function isUniqueViolation(err) {
  return /UNIQUE constraint failed/.test(String(err?.message ?? err));
}

export function parseCookies(header) {
  const out = new Map();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}
