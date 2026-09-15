// Cross-tab clipboard (item 158). Copying a block in one browser tab of
// Microtone must let you paste it in another — they are separate JS worlds with
// separate stores, so the block has to leave the page.
//
// localStorage is the carrier: same-origin, synchronous (a paste is a keystroke
// away from the copy that fed it, and an async read would have to be awaited by
// every call site), and it survives the copying tab being closed. The system
// clipboard is NOT used: a tracker block is binary, the async Clipboard API
// needs a permission prompt to READ, and neither is worth it for something the
// user only ever pastes back into this app.
//
// Each entry carries the writer's stamp, so a reader can tell "the same block I
// already parsed" from "someone else copied something" without re-parsing on
// every menu that asks whether a paste is possible.
//
// Everything here degrades to a plain in-memory slot: storage can be
// unavailable (a private window, storage blocked) and a big enough block can
// exceed the quota. The tab that copied it can always paste it; only the
// sharing is lost.

let seq = 0;
/** Distinguishes this tab's writes from another's when the clock does not. */
const TAB_ID = `${Date.now().toString(36)}.${Math.floor(Math.random() * 1e9).toString(36)}`;

function storage() {
  try {
    const ls = globalThis.localStorage;
    // Touch it: a browser can expose the object and throw on use.
    ls.getItem("microtone.probe");
    return ls;
  } catch {
    return null;
  }
}

/** Uint8Array → base64, in chunks so a big block cannot blow the argument list. */
export function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * One shared slot. `encode(value)` returns a JSON-able object, `decode(obj)`
 * rebuilds the value; both are skipped entirely when storage is unavailable.
 */
export class SharedSlot {
  constructor(key, encode, decode) {
    this.key = key;
    this.encode = encode;
    this.decode = decode;
    this.value = null;   // this tab's copy
    this.stamp = null;   // the stamp `value` was read from / written with
  }

  /** The current block: another tab's if it copied more recently than we did. */
  get() {
    const ls = storage();
    if (ls === null) return this.value;
    let raw;
    try { raw = ls.getItem(this.key); } catch { return this.value; }
    if (raw === null) {
      // Someone cleared it (or storage was wiped). Our own copy stands: losing
      // a clipboard because another tab was closed would be worse than keeping
      // one nobody else can see.
      return this.value;
    }
    try {
      const entry = JSON.parse(raw);
      if (entry.stamp === this.stamp) return this.value; // already ours
      this.value = this.decode(entry.data);
      this.stamp = entry.stamp;
    } catch {
      // Corrupt or written by an incompatible version: ignore it entirely.
    }
    return this.value;
  }

  set(value) {
    this.value = value;
    this.stamp = `${TAB_ID}.${++seq}`;
    const ls = storage();
    if (ls === null) return;
    try {
      if (value === null) ls.removeItem(this.key);
      else ls.setItem(this.key, JSON.stringify({ stamp: this.stamp, data: this.encode(value) }));
    } catch {
      // Over quota (or storage went away mid-session). Drop the shared copy so
      // no other tab pastes something older than what this one just copied.
      try { ls.removeItem(this.key); } catch { /* nothing left to do */ }
    }
  }
}

// ── the two block shapes (doc/clipboard.js) ──────────────────────────────

export function encodeBlock(b) {
  return {
    rows: b.rows, chans: b.chans, wide: b.wide === true,
    cells: bytesToBase64(b.cells),
    cols: b.cols ?? null,
  };
}

export function decodeBlock(d) {
  const b = {
    rows: d.rows | 0, chans: d.chans | 0, wide: d.wide === true,
    cells: base64ToBytes(d.cells),
  };
  if (Array.isArray(d.cols)) b.cols = d.cols;
  return b;
}

export function encodeCueBlock(b) {
  return {
    rows: b.rows, chans: b.chans, cmd: b.cmd === true,
    words: Array.from(b.words),
  };
}

export function decodeCueBlock(d) {
  return {
    rows: d.rows | 0, chans: d.chans | 0, cmd: d.cmd === true,
    words: Uint16Array.from(d.words ?? []),
  };
}
