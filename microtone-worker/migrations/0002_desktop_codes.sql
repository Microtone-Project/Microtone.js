-- Desktop sign-in (server/online/desktop.js): a one-time code on its way from
-- the browser to the desktop app, bound to the S256 challenge of a verifier
-- only that app holds. As with sessions, only the code's SHA-256 is stored. A
-- row is deleted when it is redeemed, and is worthless five minutes after it
-- was issued either way; the next code issued sweeps the dead ones.
--
-- Apply with:  wrangler d1 migrations apply microtone-online [--local | --remote]

CREATE TABLE desktop_codes (
  code_hash   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge   TEXT NOT NULL,                   -- BASE64URL(SHA-256(verifier)), RFC 7636 S256
  expires_at  INTEGER NOT NULL
);
