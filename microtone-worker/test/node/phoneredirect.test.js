// index.html's phone redirect: a phone gets Microtone Touch — or player.html,
// when the link carries a song — everything else gets the tracker, and the
// "Open the tracker" escape hatch (Touch's and the player's) turns the
// decision off for good, until one of the tracker's links to Touch turns it
// back on.
//
// The script under test is the inline one at the top of index.html — it has to
// run before any module, so it cannot be imported. The test lifts it out of the
// page and runs THAT text, which is the only way this stays a test of what
// ships rather than of a copy that can drift. Everything it touches (the UA,
// the URL, the two storages) is stubbed, so the whole matrix runs in Node.
//
// A browser cannot stand in here either way: driving it needs a UA override per
// case, and the leg that matters most — the tracker page loading normally — is
// exactly the leg that takes a full app boot to prove.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { TOUCH_URL, linkTouch } from "../../src/ui/touchlink.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const indexHtml = readFileSync(root + "index.html", "utf8");
const playerHtml = readFileSync(root + "player.html", "utf8");
const playerJs = readFileSync(root + "src/ui/player.js", "utf8");

/** The inline <script> that owns the decision, identified by the key it keeps. */
function redirectScript() {
  const bodies = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes("microtone-tracker-on-phone"));
  assert.equal(bodies.length, 1, "exactly one inline script decides the redirect");
  return bodies[0];
}

const SCRIPT = redirectScript();

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipod: "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Mobile/15E148",
  androidPhone: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidFold: "Mozilla/5.0 (Linux; Android 14; SM-F946B) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  // iPadOS has reported itself as a Mac since 13 — the reason the test is by UA
  // string and not by "is it touch".
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  desktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/126.0.0.0 Safari/537.36",
};

/** A fake Storage that can also be made to throw, the way private mode does. */
function storage({ dead = false, seed = {} } = {}) {
  const map = new Map(Object.entries(seed));
  const boom = () => { throw new Error("SecurityError"); };
  return {
    getItem: dead ? boom : (k) => (map.has(k) ? map.get(k) : null),
    setItem: dead ? boom : (k, v) => { map.set(k, String(v)); },
    map,
  };
}

/**
 * Run index.html's script against one situation.
 * Returns where it navigated to (null = it stayed on the tracker).
 */
function visit(ua, url = "/index.html", { local = storage(), session = storage() } = {}) {
  const [path, rest = ""] = url.split("#");
  const q = path.indexOf("?");
  const location = {
    search: q < 0 ? "" : path.slice(q),
    hash: rest ? "#" + rest : "",
    replaced: null,
    replace(to) { this.replaced = to; },
  };
  runInNewContext(SCRIPT, {
    navigator: { userAgent: ua },
    location,
    localStorage: local,
    sessionStorage: session,
  });
  return location.replaced;
}

const TOUCH = "https://touch.microtone.cc/?from=tracker";

test("a phone gets Touch, everything else keeps the tracker", () => {
  for (const name of ["iphone", "ipod", "androidPhone", "androidFold"]) {
    assert.equal(visit(UA[name]), TOUCH, name);
  }
  assert.equal(visit(UA.iphone, "/index.html?theme=light"), TOUCH, "whatever else the address says");
  assert.ok(TOUCH.startsWith(TOUCH_URL), "where the tracker's own links to Touch go");
  // "Android" without "Mobile" is a tablet, and an iPad says it is a Mac.
  for (const name of ["androidTablet", "ipad", "desktop"]) {
    assert.equal(visit(UA[name]), null, name);
  }
  assert.equal(visit(""), null, "a UA-less client is not a phone");
});

test("a link that carries a song goes to the player, query string and fragment and all", () => {
  assert.equal(
    visit(UA.iphone, "/index.html?load=https://example.org/a.taud"),
    "player.html?load=https://example.org/a.taud");
  assert.equal(
    visit(UA.androidPhone, "/index.html?theme=light&load=a.taud#top"),
    "player.html?theme=light&load=a.taud#top");
  // a sibling player's handoff (handoff.js HANDOFF_PREFIX), which the
  // player's way back to the tracker carries on
  assert.equal(visit(UA.iphone, "/index.html#import=abc"), "player.html#import=abc");
  assert.equal(visit(UA.iphone, "/index.html#top"), TOUCH, "any other fragment is not a song");
  assert.equal(visit(UA.iphone, "/index.html?download=a.taud"), TOUCH, "nor a parameter that merely ends in load");
});

test("?tracker=1 overrides the redirect, and is remembered afterwards", () => {
  const local = storage();
  assert.equal(visit(UA.iphone, "/index.html?tracker=1", { local }), null);
  assert.equal(local.map.get("microtone-tracker-on-phone"), "1");
  // …so the next visit, without the parameter, stays on the tracker too.
  assert.equal(visit(UA.iphone, "/index.html", { local }), null);
  assert.equal(visit(UA.androidPhone, "/index.html?load=a.taud", { local }), null);
  // The parameter is only honoured whole: a partial match must not free it.
  assert.equal(visit(UA.iphone, "/index.html?tracker=10"), TOUCH);
  assert.equal(visit(UA.iphone, "/index.html?nottracker=1&load=a.taud"), "player.html?nottracker=1&load=a.taud");
  // …and it is still read when it is not the first parameter.
  assert.equal(visit(UA.iphone, "/index.html?load=a.taud&tracker=1"), null);
});

test("private mode: the parameter still works, the memory just does not stick", () => {
  const local = storage({ dead: true });
  assert.equal(visit(UA.iphone, "/index.html?tracker=1", { local }), null);
  assert.equal(visit(UA.iphone, "/index.html", { local }), TOUCH);
  // A storage that throws must never take the page down with it.
  assert.equal(visit(UA.iphone, "/index.html?load=a.taud", { session: storage({ dead: true }) }),
    "player.html?load=a.taud");
});

test("the player is told it was redirected to, not asked for", () => {
  const session = storage();
  assert.equal(visit(UA.iphone, "/index.html?load=a.taud", { session }), "player.html?load=a.taud");
  assert.equal(session.map.get("microtone-phone-redirect"), "1");
  // Touch is another site, and is told by its own address (`from=tracker`).
  const touch = storage();
  visit(UA.iphone, "/index.html", { session: touch });
  assert.equal(touch.map.size, 0);
  // Nothing is flagged when the visit was deliberate.
  const quiet = storage();
  visit(UA.desktop, "/index.html", { session: quiet });
  assert.equal(quiet.map.size, 0);
});

test("the player carries the way back", () => {
  // Both the standing link and the one inside the redirect note, so a false
  // positive is never a dead end.
  assert.match(playerHtml, /id="trackerLink"/);
  assert.match(playerHtml, /id="trackerLink2"/);
  assert.match(playerJs, /back\.set\("tracker", "1"\)/);
  assert.match(playerJs, /"microtone-phone-redirect"/);
  // The hrefs in the markup work even if the module never runs.
  for (const m of playerHtml.matchAll(/<a [^>]*id="trackerLink2?"[^>]*>/g)) {
    assert.match(m[0], /href="index\.html\?tracker=1"/);
  }
});

test("the tracker's links to Touch forget the tracker on this phone", () => {
  // Following one is the opposite choice to `tracker=1`: the last of the two
  // made is what microtone.cc opens.
  const local = storage({ seed: { "microtone-tracker-on-phone": "1" } });
  local.removeItem = (k) => local.map.delete(k);
  const was = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
  try {
    const handlers = {};
    const a = linkTouch({ addEventListener: (type, fn) => { handlers[type] = fn; } });
    assert.equal(a.href, TOUCH_URL);
    assert.equal(a.target, "_blank");
    assert.equal(visit(UA.iphone, "/index.html", { local }), null, "remembered, before");
    handlers.click();
    assert.equal(visit(UA.iphone, "/index.html", { local }), TOUCH, "forgotten, after");
    assert.ok(handlers.auxclick, "a middle click counts too");
  } finally {
    if (was) Object.defineProperty(globalThis, "localStorage", was);
    else delete globalThis.localStorage;
  }
});
