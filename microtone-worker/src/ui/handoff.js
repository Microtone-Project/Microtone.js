// Cross-page song handoff (item 171).
//
// The IyagiMusic player — an .ims/.rol/.sop web player of its own — has a "remix
// this in Microtone" button. Handing the song over as a DOWNLOAD would mean the
// listener saves a file, finds it, and drops it back in, and for an .ims or a
// .rol TWICE, because a song without its instrument bank makes no sound at all.
// So the sender puts both files in the URL instead and the link does the rest.
// A .sop travels alone — it carries its own instruments — and the bank field is
// simply empty, which the reader already treats as "no bank".
//
// **Why the URL and not postMessage.** The obvious design — open Microtone,
// have it say it is listening, post the bytes across — cannot work here: the
// app is served with `Cross-Origin-Opener-Policy: same-origin` (for the
// SharedArrayBuffer audio path), and that severs the opener relationship the
// moment a cross-origin page opens it. A fragment is never sent to the server,
// survives every header policy, and needs no handshake. It is bounded by the
// browser's URL length rather than by anything we control, so the encoder
// gzips: across 1152 reference songs the encoded payload is a median 9.5 kB and
// a worst case of 52 kB, well inside every browser's limit.

import { gzipSync, gunzipSync } from "../../vendor/fflate.esm.js";

/** The fragment that carries a handed-over song. */
export const HANDOFF_PREFIX = "#import=";
/** Envelope magic, then a flags byte: bit 0 = the rest is gzipped. */
const MAGIC = [0x4d, 0x54, 0x48, 0x31];             // "MTH1"
const FLAG_GZIP = 1;
/** Refuse anything absurd rather than trying to decode it. */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder();

function base64UrlToBytes(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Length-prefixed fields: a name (u8) then its bytes (u32). */
function writeField(parts, name, bytes) {
  const n = enc.encode(name).subarray(0, 255);
  parts.push(Uint8Array.of(n.length), n);
  const len = bytes ? bytes.length : 0;
  parts.push(Uint8Array.of(len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >>> 24) & 0xff));
  if (bytes) parts.push(bytes);
}

function readField(b, o) {
  if (o + 1 > b.length) return null;
  const nameLen = b[o++];
  if (o + nameLen + 4 > b.length) return null;
  const name = dec.decode(b.subarray(o, o + nameLen));
  o += nameLen;
  const len = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000);
  o += 4;
  if (len < 0 || o + len > b.length) return null;
  return { name, bytes: b.subarray(o, o + len), next: o + len };
}

/**
 * Pack a song (and the instrument bank it needs) into a handoff fragment.
 * Exported so the format has one definition and a test can round-trip it; the
 * sender lives in another repo and reimplements the same twelve lines.
 */
export function encodeHandoff({ name, song, bankName = "", bank = null }) {
  const parts = [];
  writeField(parts, name, song);
  writeField(parts, bankName, bank);
  let inner = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { inner.set(p, o); o += p.length; }
  let flags = 0;
  const packed = gzipSync(inner, { level: 9 });
  if (packed.length < inner.length) { inner = packed; flags |= FLAG_GZIP; }
  const out = new Uint8Array(5 + inner.length);
  out.set(MAGIC, 0);
  out[4] = flags;
  out.set(inner, 5);
  return HANDOFF_PREFIX + bytesToBase64Url(out);
}

/**
 * Read a handoff fragment: `{name, bytes, bank}` with `bank` a `{name, bytes}`
 * or null, or null when the hash carries no handoff. Throws on a fragment that
 * claims to be one and is not — a truncated URL is worth saying so about.
 *
 * The NAME matters beyond the status line: `converterFor` picks the converter
 * from its extension, and the sender sets it from what the bytes turned out to
 * be rather than from what the file was called, because this corpus is full of
 * files whose names lie.
 */
export function decodeHandoff(hash) {
  if (!hash || !hash.startsWith(HANDOFF_PREFIX)) return null;
  const raw = base64UrlToBytes(hash.slice(HANDOFF_PREFIX.length));
  if (raw.length < 5 || MAGIC.some((m, i) => raw[i] !== m)) {
    throw new Error("not a Microtone handoff");
  }
  if (raw.length > MAX_PAYLOAD_BYTES) throw new Error("handoff payload too large");
  const body = raw.subarray(5);
  const inner = (raw[4] & FLAG_GZIP) ? gunzipSync(body) : body;
  const songField = readField(inner, 0);
  if (!songField || songField.bytes.length === 0) throw new Error("handoff carries no song");
  const bankField = readField(inner, songField.next);
  return {
    name: songField.name || "song.ims",
    bytes: Uint8Array.from(songField.bytes),
    bank: bankField && bankField.bytes.length
      ? { name: bankField.name || "bank.bnk", bytes: Uint8Array.from(bankField.bytes) }
      : null,
  };
}

/** True when this page load carries a song to import. */
export function handoffArmed(win = window) {
  return win.location.hash.startsWith(HANDOFF_PREFIX);
}
