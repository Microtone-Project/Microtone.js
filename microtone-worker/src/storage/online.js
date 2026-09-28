// Online projects — the browser's side of /api/online (server/online/). A
// handful of working projects kept with a person's SceneID account, so the
// song they are in the middle of follows them to another machine. Not a
// backup and not an archive: a handful of slots, and the File tab says so.
//
// Every failure is an OnlineError whose `code` is the server's own error code
// (see server/online/) or "offline" when the request never got an answer; the
// UI turns codes into sentences, so nothing here is prose.
//
// Where there is no API at all — a static server, the offline build, a
// deploy without its bindings, or one with no way to sign in yet — status()
// says `available: false` and the app shows no online section whatsoever.

const API = "/api/online";

/** The BroadcastChannel name the server's completion page broadcasts under
 *  when a sign-in window finishes (server/online/auth.js AUTH_CHANNEL);
 *  signOut() broadcasts under it too. Every open tab of the app hears both. */
export const AUTH_CHANNEL = "microtone-online";

export class OnlineError extends Error {
  constructor(code, status = 0) {
    super(`online: ${code}`);
    this.code = code;
    this.status = status;
  }
}

async function call(path, init = {}) {
  let res;
  try {
    res = await fetch(API + path, { cache: "no-store", ...init });
  } catch {
    throw new OnlineError("offline");
  }
  if (res.ok) return res;
  let code = "server-error";
  try { code = (await res.json()).error ?? code; } catch { /* not the API's answer */ }
  throw new OnlineError(code, res.status);
}

const unquote = (etag) => (etag ?? "").replace(/^W\//, "").replace(/"/g, "");

/**
 * What the File tab needs to decide whether to show anything:
 *   { available, signedIn, signIn: "sceneid" | "dev" | null, user: {name} | null }
 * Never throws. A reply that is not the API's JSON (a static host's 404, an
 * SPA fallback's index.html) counts as no API.
 */
export async function status() {
  const none = { available: false, signedIn: false, signIn: null, user: null };
  let me;
  try {
    const res = await fetch(API + "/me", { cache: "no-store" });
    if (!res.ok) return none;
    me = await res.json();
  } catch {
    return none;
  }
  if (typeof me?.signedIn !== "boolean") return none;
  return {
    available: me.signedIn || !!me.signIn,
    signedIn: me.signedIn,
    signIn: me.signIn ?? null,
    user: me.user ?? null,
  };
}

/** → { projects: [{ id, name, size, etag, modified }], limit, sizeLimit } */
export async function list() {
  return (await call("/projects")).json();
}

/** → { bytes, etag } — keep the etag: the next save() quotes it. */
export async function read(id) {
  const res = await call(`/projects/${encodeURIComponent(id)}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), etag: unquote(res.headers.get("etag")) };
}

/** A new online project. → project. Fails with "exists", "quota",
 *  "too-large" or "not-taud" as well as the usual. */
export async function create(name, bytes) {
  const res = await call(`/projects?name=${encodeURIComponent(name)}`, {
    method: "POST", body: bytes, headers: { "content-type": "application/octet-stream" },
  });
  return (await res.json()).project;
}

/**
 * Save over an online project. `etag` is the one it was opened or last saved
 * with; if it has been saved from somewhere else since, nothing is written and
 * this fails with "conflict". `etag` null overwrites whatever is there — only
 * ever on the person's say-so. → project (with the new etag).
 */
export async function save(id, bytes, etag) {
  const res = await call(`/projects/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": "application/octet-stream", "if-match": etag ? `"${etag}"` : "*" },
  });
  return (await res.json()).project;
}

/** → project. Fails with "exists" if the person already has one by that name. */
export async function rename(id, name) {
  const res = await call(`/projects/${encodeURIComponent(id)}`, {
    method: "PATCH", body: JSON.stringify({ name }), headers: { "content-type": "application/json" },
  });
  return (await res.json()).project;
}

export async function remove(id) {
  await call(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Open the sign-in window. It finishes on its own and announces the result on
 * AUTH_CHANNEL — so the app never navigates away from unsaved work, and needs
 * no opener link (the COOP isolation the app runs under would cut it anyway).
 * `mode` is status().signIn; "dev" signs in to a local test account named
 * `name`. Returns false if the browser blocked the window.
 */
export function signIn(mode, { name = "" } = {}) {
  const url = mode === "dev"
    ? `${API}/auth/dev-login?name=${encodeURIComponent(name)}`
    : `${API}/auth/login`;
  return window.open(url, "microtone-sign-in", "popup,width=520,height=720") !== null;
}

export async function signOut() {
  await call("/auth/logout", { method: "POST" });
  announce("signed-out");
}

/** Call `callback(type)` whenever any tab signs in or out ("signed-in",
 *  "sign-in-failed", "signed-out"). Returns the unsubscribe. */
export function onAuthChange(callback) {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(AUTH_CHANNEL);
  channel.onmessage = (e) => callback(e.data?.type);
  return () => channel.close();
}

function announce(type) {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(AUTH_CHANNEL);
  channel.postMessage({ type });
  channel.close();
}
