// The desktop app's file store, from the page's side (src/storage/opfs.js →
// native-files.js; the server is desktop-qt/src/filestore.cpp): opfs.js picks
// it where the shell says it has one, every path goes out encoded name by name,
// a rename is a real move, "not there" comes back as OPFS says it, and a name
// the store would refuse is refused first. The carry-over from OPFS
// (carry-over.js) makes names portable, and the copy from the earlier desktop
// app (the shell's, desktop-qt/src/oldapp.h) is waited for and said once.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.__MICROTONE_NATIVE__ = { files: { base: "/api/files", projects: "~/Microtone/Projects" } };
const sent = [];
let answer = () => new Response(null, { status: 204 });
globalThis.fetch = async (url, init = {}) => {
  sent.push({ url, method: init.method ?? "GET", body: init.body });
  return answer(url, init);
};

const opfs = await import("../../src/storage/opfs.js");
const { portableName, oldAppCopy, oldAppTold } = await import("../../src/storage/carry-over.js");

test("the shell's store is picked, and says where it is", () => {
  assert.equal(opfs.backend, "native");
  assert.equal(opfs.location("projects"), "~/Microtone/Projects");
});

test("paths go out encoded name by name; a rename is a move, a folder delete recursive", async () => {
  sent.length = 0;
  await opfs.write("Album 1/c%d #2.taud", new Uint8Array([1]));
  await opfs.rename("a.taud", "Album 1/b.taud");
  await opfs.removeFolder("Old/Stuff");
  await opfs.makeFolder("New");
  await opfs.writeAutosave("Album 1/song.taud", new Uint8Array([2]));
  assert.deepEqual(sent.map((s) => `${s.method} ${s.url}`), [
    "PUT /api/files/projects/Album%201/c%25d%20%232.taud",
    "POST /api/files/projects/a.taud?moveTo=Album%201%2Fb.taud",
    "DELETE /api/files/projects/Old/Stuff?recursive",
    "POST /api/files/projects/New?mkdir",
    // An autosave copy is one flat file named by the project's path.
    "PUT /api/files/autosave/Album%201%252Fsong.taud",
  ]);
});

test("not there is a NotFoundError, as OPFS throws it; exists() is false", async () => {
  answer = () => new Response("not found", { status: 404 });
  await assert.rejects(opfs.read("gone.taud"), (err) => err.name === "NotFoundError");
  assert.equal(await opfs.exists("gone.taud"), false);
  assert.deepEqual(await opfs.tree(), { files: [], folders: [] });
  answer = () => new Response(null, { status: 204 });
});

test("listings come back sorted, soundfonts without their index", async () => {
  answer = (url) => url.includes("/soundfonts?list")
    ? Response.json({ files: [{ name: "b.taud.sf2.gz" }, { name: "index.json" }, { name: "a.taud.sf2.gz" }], folders: [] })
    : Response.json({ files: [{ name: "z.taud" }, { name: "A/b.taud" }], folders: ["A"] });
  assert.deepEqual((await opfs.listSoundfonts()).map((s) => s.name), ["a.taud.sf2.gz", "b.taud.sf2.gz"]);
  assert.deepEqual((await opfs.list()).map((f) => f.name), ["A/b.taud", "z.taud"]);
  answer = () => new Response(null, { status: 204 });
});

test("names every system can hold, on the desktop", () => {
  for (const ok of ["song.taud", "Album 2", "한국어 곡.taud", "a.b.c"]) assert.equal(opfs.validName(ok), true, ok);
  for (const bad of ["a:b.taud", "what?.taud", "con", "NUL.taud", "trailing.", "trailing ", "a|b", "a/b", ".."]) {
    assert.equal(opfs.validName(bad), false, bad);
  }
});

test("the carry-over makes an earlier build's names portable", () => {
  assert.equal(portableName("bad:name?.taud"), "bad_name_.taud");
  assert.equal(portableName("con.taud"), "_con.taud");
  assert.equal(portableName("dots..."), "dots");
  assert.equal(portableName("fine.taud"), "fine.taud");
});

test("the earlier app's copy is waited for, then said once", async () => {
  const states = [{ state: "running" }, { state: "running" },
    { state: "done", found: true, projects: 3, soundfonts: 0, keymaps: 1, beside: 1, tell: true }];
  sent.length = 0;
  answer = (url) => (url.endsWith("/oldapp") ? Response.json(states.shift()) : new Response(null, { status: 204 }));
  const c = await oldAppCopy({ every: 1 });
  assert.deepEqual([c.projects, c.keymaps, c.beside, c.tell], [3, 1, 1, true]);
  assert.equal(sent.filter((s) => s.url === "/api/files/oldapp").length, 3);
  await oldAppTold();
  assert.deepEqual(sent.at(-1), { url: "/api/files/oldapp?told", method: "POST", body: undefined });

  // No earlier app on this computer: nothing to say.
  answer = () => Response.json({ state: "done", found: false });
  assert.equal(await oldAppCopy({ every: 1 }), null);
  answer = () => new Response(null, { status: 204 });
});
