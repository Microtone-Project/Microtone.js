// Sketches kept on this phone.
//
// IndexedDB, which every browser a phone runs has — Safari included, where
// the tracker's OPFS can only be written from a worker. A record keeps the
// sketch model itself rather than its .mtsk, so nothing is lost on the way:
// a .mtsk forgets an empty lane's preset and every mute, and is only made
// when a sketch goes online or leaves as a file.
//
// Names are unique here, as they are online: a write that would give a
// second sketch an existing name fails with "exists" (checked and written in
// one transaction), and the caller asks whether to replace it — which is a
// write to THAT sketch's id.

const DB_NAME = "microtone-touch";
const STORE = "sketches";
export const NAME_MAX = 64;

export class LibraryError extends Error {
  constructor(code, existing = null) {
    super(`library: ${code}`);
    this.code = code;
    this.existing = existing; // "exists": the sketch that has the name
  }
}

/** A name as it is kept, or "" for one that cannot be: NFC, so the same name
 *  typed on two keyboards is one name, and trimmed. */
export const cleanName = (raw) => String(raw ?? "").normalize("NFC").trim().slice(0, NAME_MAX).trim();

let opening = null;
function db() {
  if (typeof indexedDB === "undefined") return Promise.reject(new LibraryError("unavailable"));
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new LibraryError("unavailable"));
    req.onblocked = () => reject(new LibraryError("unavailable"));
  });
  opening.catch(() => { opening = null; }); // a private window may allow it later
  return opening;
}

/** Run `fn(store, done)` in one transaction; resolves with what `done` was
 *  given once the transaction has COMMITTED, and rejects if it aborts. */
async function transact(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    let result;
    let failure = null;
    t.oncomplete = () => (failure ? reject(failure) : resolve(result));
    t.onabort = t.onerror = () => reject(failure ?? new LibraryError("unavailable"));
    fn(t.objectStore(STORE), (value) => { result = value; }, (err) => { failure = err; t.abort(); });
  });
}

const meta = (rec) => ({
  id: rec.id, name: rec.name, modified: rec.modified, sections: rec.sketch?.sections?.length ?? 1,
});

const newId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/** → [{ id, name, modified, sections }], the newest first. */
export async function list() {
  const all = await transact("readonly", (store, done) => {
    const req = store.getAll();
    req.onsuccess = () => done(req.result);
  });
  return all.map(meta).sort((a, b) => b.modified - a.modified);
}

/** → { id, name, modified, sketch } — the sketch as untrusted JSON, for
 *  normaliseSketch — or null when there is none by that id. */
export async function read(id) {
  return transact("readonly", (store, done) => {
    const req = store.get(id);
    req.onsuccess = () => done(req.result ?? null);
  });
}

/**
 * Keep `sketch` under its own name: over the sketch `id` when given (made
 * afresh if it has gone), as a new one otherwise. → { id, name, modified,
 * sections }. Fails with "exists" when ANOTHER sketch has the name, and with
 * "bad-name" for an empty one.
 */
export async function write(sketch, { id = null } = {}) {
  const name = cleanName(sketch.name);
  if (!name) throw new LibraryError("bad-name");
  const rec = { id: id ?? newId(), name, modified: Date.now(), sketch: { ...sketch, name } };
  return transact("readwrite", (store, done, fail) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const other = req.result.find((r) => r.name === name && r.id !== rec.id);
      if (other) return fail(new LibraryError("exists", meta(other)));
      store.put(rec);
      done(meta(rec));
    };
  });
}

/** Rename a kept sketch (its name inside too). → meta. Fails with "exists",
 *  "bad-name" or "not-found". */
export async function rename(id, raw) {
  const name = cleanName(raw);
  if (!name) throw new LibraryError("bad-name");
  return transact("readwrite", (store, done, fail) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const rec = req.result.find((r) => r.id === id);
      if (!rec) return fail(new LibraryError("not-found"));
      const other = req.result.find((r) => r.name === name && r.id !== id);
      if (other) return fail(new LibraryError("exists", meta(other)));
      rec.name = name;
      rec.sketch = { ...rec.sketch, name };
      store.put(rec);
      done(meta(rec));
    };
  });
}

export async function remove(id) {
  await transact("readwrite", (store) => { store.delete(id); });
}
