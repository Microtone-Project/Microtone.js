// Where a save goes. Served by tools/cat-server.py (the repository, locally),
// the workbench writes the files straight into the checkout; anywhere else
// (microtone.cc) it hands over one .zip (or .tar.gz) of them, laid out by
// their paths in the repository, to unpack at its root.

import { zipSync, gzipSync, strToU8 } from "../../core/vendor/fflate.esm.js";

const PING = "/__cat/ping";
const SAVE = "/__cat/save";

/** True when the page is served by tools/cat-server.py, which can write. */
export async function canWrite() {
  try {
    const r = await fetch(PING, { cache: "no-store" });
    if (!r.ok) return false;
    return (await r.json()).cat === 1;
  } catch {
    return false;
  }
}

/** Write the files into the checkout; resolves the paths written. */
export async function writeFiles(files) {
  const r = await fetch(SAVE, {
    method: "POST",
    // The custom header makes a cross-site page's request a preflighted one,
    // which the server never answers: only this origin can save.
    headers: { "content-type": "application/json", "x-microtone-cat": "1" },
    body: JSON.stringify({ files: files.map(({ path, text }) => ({ path, text })) }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `the server said ${r.status}`);
  return body.written ?? [];
}

/** The files as a .zip, each at its repository path. */
export function zipBlob(files) {
  const entries = {};
  for (const f of files) entries[f.path] = strToU8(f.text);
  return new Blob([zipSync(entries, { level: 6 })], { type: "application/zip" });
}

/** The files as a .tar.gz (POSIX ustar), each at its repository path. */
export function tarGzBlob(files, mtime = Math.floor(Date.now() / 1000)) {
  const blocks = [];
  let size = 1024; // the two zero blocks that end the archive
  for (const f of files) {
    const data = strToU8(f.text);
    blocks.push(ustarHeader(f.path, data.length, mtime), data);
    size += 512 + Math.ceil(data.length / 512) * 512;
  }
  const tar = new Uint8Array(size);
  let at = 0;
  for (const b of blocks) {
    tar.set(b, at);
    at += Math.ceil(b.length / 512) * 512;
  }
  return new Blob([gzipSync(tar, { level: 6, mtime: mtime * 1000 })], { type: "application/gzip" });
}

function ustarHeader(path, size, mtime) {
  const h = new Uint8Array(512);
  const put = (at, len, bytes) => {
    if (bytes.length > len) throw new Error(`${path}: too long for a tar header`);
    h.set(bytes, at);
  };
  const octal = (at, len, n) => put(at, len, strToU8(n.toString(8).padStart(len - 1, "0") + "\0"));
  // A name over 100 bytes splits at a slash: the head goes in `prefix`.
  let name = strToU8(path), prefix = new Uint8Array(0);
  if (name.length > 100) {
    const cut = path.lastIndexOf("/", path.length - 2);
    if (cut <= 0) throw new Error(`${path}: too long for a tar header`);
    prefix = strToU8(path.slice(0, cut));
    name = strToU8(path.slice(cut + 1));
  }
  put(0, 100, name);
  octal(100, 8, 0o644); // mode
  octal(108, 8, 0); // uid
  octal(116, 8, 0); // gid
  octal(124, 12, size);
  octal(136, 12, mtime);
  h.fill(0x20, 148, 156); // the checksum counts its own field as spaces
  h[156] = 0x30; // "0": a regular file
  put(257, 8, strToU8("ustar\u000000"));
  put(345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(148, 8, strToU8(sum.toString(8).padStart(6, "0") + "\0 "));
  return h;
}

export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
