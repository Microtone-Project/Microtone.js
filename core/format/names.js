// The \uHHHH name-escape convention. TSVM's string reader is ASCII-only, so
// every non-ASCII character in a stored name (PNam, sMet song fields, INam,
// SNam) is carried as a literal \uHHHH escape in the file. The FILE keeps the
// escapes; the frontend resolves them for display and re-escapes on save.

/** ASCII-escape every non-ASCII UTF-16 code unit as \uHHHH (uppercase hex).
 *  Idempotent: already-escaped input passes through unchanged. */
export function escapeNonAscii(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 0x80 ? s[i] : "\\u" + c.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** Resolve \uHHHH escapes back to characters for DISPLAY (case-insensitive
 *  hex). Inverse of escapeNonAscii for its output range. */
export function unescapeName(s) {
  if (!s || !s.includes("\\u")) return s;
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ── The four project strings, §9.2 (item 115) ────────────────────────────────
// PNam / PCom / PCpr are NAMES and ride the escape convention above: they sit
// beside sMet's song name, composer and copyright, and the readers those go
// through are ASCII-only. PMsg does not — it is free prose that no TSVM reader
// consumes, and the format calls the field UTF-8, so escaping it would only
// make a paragraph unreadable in every other tool (and six times longer).

/** True for the project-string section whose payload is stored as plain UTF-8. */
const isProseSection = (fourcc) => fourcc === "PMsg";

/** Section payload for a project string: NUL-terminated, escaped where §9.2's
 *  ASCII-only readers need it. Line breaks are normalised to LF. */
export function encodeProjectString(fourcc, text) {
  const body = isProseSection(fourcc)
    ? String(text).replace(/\r\n?/g, "\n")
    : escapeNonAscii(String(text));
  const bytes = new TextEncoder().encode(body);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out; // the trailing NUL is the last byte, already zero
}

/** Display text for a decoded project string (Document.projectString). */
export function decodeProjectString(fourcc, raw) {
  return isProseSection(fourcc) ? (raw ?? "") : unescapeName(raw ?? "");
}
