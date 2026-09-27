-- Online projects: who owns what, and where its bytes sit in R2.
--
-- Nothing a person typed or chose ever becomes part of an R2 key. The key is
-- two random ids, `u_…/p_…`; the account it belongs to and the name the
-- project goes by live only here. Times are Unix milliseconds.
--
-- Apply with:  wrangler d1 migrations apply microtone-online [--local | --remote]

CREATE TABLE users (
  id               TEXT PRIMARY KEY,           -- u_… — random, never derived from the subject
  sceneid_subject  TEXT NOT NULL UNIQUE,       -- the identity provider's stable user id
  display_name     TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL            -- bumped at most daily, on session refresh
);

-- A session is a random bearer token in an HttpOnly cookie. Only its SHA-256
-- is stored, so a copy of this table signs nobody in.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_by_user ON sessions(user_id);

-- One row per slot. A row is inserted 'pending' — which is what claims the
-- slot, atomically against the quota — before its object is written, and
-- turns 'ready' once R2 has the bytes. A pending row older than a few minutes
-- is an upload that died half-way; the next upload by the same person clears
-- it. Only 'ready' rows are ever listed, read or written.
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,                -- p_… — also what the API calls it
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key      TEXT NOT NULL UNIQUE,            -- u_…/p_…
  filename    TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  etag        TEXT NOT NULL DEFAULT '',        -- R2's, unquoted; R2 itself stays the arbiter
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  -- Names are unique per person, as they are in the browser's own storage —
  -- which is also what stops a retried upload from landing twice.
  UNIQUE (user_id, filename)
);
