// The desktop app's update offer (src/ui/desktopupdates.js) against a fake
// shell: nothing is downloaded until asked, the progress shows, "Restart now"
// asks about unsaved work first, and the shell's steps are asked in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { updatePrompt } from "../../src/ui/desktopupdates.js";
import en from "../../src/ui/lang/en.js";
import ko from "../../src/ui/lang/ko.js";

function fakeShell(script) {
  const asked = [];
  let state = { state: "idle", current: "5.0.5" };
  const fetch = async (url, init) => {
    const query = url.split("?")[1] ?? "";
    asked.push(`${init.method} ${query}`);
    state = script(query, state);
    return new Response(JSON.stringify(state), { status: 200 });
  };
  return { fetch, asked };
}

function ui() {
  const banners = [];
  const t = (key, p = {}) => `${key}${Object.keys(p).length ? " " + JSON.stringify(p) : ""}`;
  const showBanner = (content) => {
    const b = { history: [content], update(c) { this.history.push(c); }, get now() { return this.history.at(-1); } };
    banners.push(b);
    return b;
  };
  return { banners, t, showBanner };
}

const click = (banner, key) => banner.now.actions.find((a) => a.label === key).onClick();

test("found, downloaded with progress, then restarted — unsaved work asked about first", async () => {
  let downloads = 0;
  const shell = fakeShell((q, s) => {
    if (q === "check") return { ...s, state: "checking" };
    if (q === "" && s.state === "checking") return { ...s, state: "available", version: "5.1.0" };
    if (q === "download") return { ...s, state: "downloading", progress: 0 };
    if (q === "" && s.state === "downloading") return ++downloads < 3 ? { ...s, progress: downloads / 3 } : { ...s, state: "ready", progress: 1 };
    if (q === "install=now") return { ...s, installOnQuit: true };
    return s;
  });
  const u = ui();
  let dirty = true;
  const modals = [];
  const prompt = updatePrompt({ ...u, fetch: shell.fetch, api: "/api/desktop/updates", isDirty: () => dirty,
    showModal: async (m) => { modals.push(m); return modals.length > 1; }, wait: async () => {} });

  const found = await prompt.check();
  assert.equal(found.state, "available");
  assert.equal(u.banners.length, 1);
  assert.equal(u.banners[0].now.text, 'update.available {"version":"5.1.0","current":"5.0.5"}');
  assert.deepEqual(u.banners[0].now.actions.map((a) => a.label), ["update.download", "update.later"]);
  assert.ok(!shell.asked.includes("POST download"), "nothing downloaded until asked");

  await click(u.banners[0], "update.download");
  const progress = u.banners[1].history.map((c) => c.text);
  assert.deepEqual(progress.slice(0, 4), [
    'update.downloading {"version":"5.1.0","percent":"0%"}',
    'update.downloading {"version":"5.1.0","percent":"0%"}',
    'update.downloading {"version":"5.1.0","percent":"33%"}',
    'update.downloading {"version":"5.1.0","percent":"67%"}',
  ]);
  assert.equal(u.banners[1].now.text, 'update.ready {"version":"5.1.0"}');

  // Unsaved, and the person says Cancel: still on offer, nothing installed.
  assert.equal(await click(u.banners[1], "update.restart"), false);
  assert.equal(modals[0].title, "update.restartDirty");
  assert.ok(!shell.asked.includes("POST install=now"));
  assert.equal(u.banners.at(-1).now.text, 'update.ready {"version":"5.1.0"}');
  // …then says Restart.
  assert.equal(await click(u.banners.at(-1), "update.restart"), true);
  assert.equal(shell.asked.at(-1), "POST install=now");
  dirty = false;
});

test("nothing new is nothing to say; a failed download says why; When I quit", async () => {
  const quiet = fakeShell((q, s) => (q === "check" ? { ...s, state: "none" } : s));
  const u = ui();
  const p = updatePrompt({ ...u, fetch: quiet.fetch, api: "/u", isDirty: () => false, showModal: async () => true, wait: async () => {} });
  assert.equal((await p.check()).state, "none");
  assert.equal(u.banners.length, 0);

  const failing = fakeShell((q, s) => (q === "download" ? { ...s, state: "error", error: "not signed by Microtone" } : s));
  const v = ui();
  const q = updatePrompt({ ...v, fetch: failing.fetch, api: "/u", isDirty: () => false, showModal: async () => true, wait: async () => {} });
  await q.download({ version: "5.1.0" });
  assert.equal(v.banners[0].now.text, 'update.failed {"error":"not signed by Microtone"}');

  const later = fakeShell((q, s) => (q === "download" ? { ...s, state: "ready", version: "5.1.0" } : s));
  const w = ui();
  const r = updatePrompt({ ...w, fetch: later.fetch, api: "/u", isDirty: () => false, showModal: async () => true, wait: async () => {} });
  await r.download({ version: "5.1.0" });
  await click(w.banners[0], "update.onQuit");
  assert.equal(later.asked.at(-1), "POST install=quit");
  assert.equal(w.banners.at(-1).now.text, 'update.deferred {"version":"5.1.0"}');
});

test("every word is in both languages", () => {
  for (const key of ["available", "download", "later", "downloading", "ready", "restart", "onQuit", "deferred", "failed", "restartDirty"]) {
    assert.ok(en[`update.${key}`], key);
    assert.ok(ko[`update.${key}`], key);
  }
});
