// The Microtone design system (design-system/, item 221): its machine-readable
// half must say what the app actually does. These pin
//
//   - tokens.json to the stylesheets it is generated from (a token changed in
//     microtone.css without `node tools/design-tokens.js` fails here), with a
//     usage note for every colour and every themed colour in every theme;
//   - components.json to the component library: every module listed, every
//     export it names real, every class it names styled, every token it names
//     declared;
//   - the dialog-actions rule: every action row in the tracker comes out of
//     actionRow() (no hand-built .modal-buttons, no Cancel of its own), in the
//     order Cancel · extras · alternatives · Proceed — and Microtone Touch's
//     sheets keep the same order by hand;
//   - the proceed-style rule: Proceed's label at least 200 heavier than every
//     other button's, its ink readable on its fill in every theme.
//
// The real-DOM half (geometry, computed weight and colour in all four themes)
// is test/browser/actions-smoke.html.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

import { buildTokens, serialise, contrast } from "../../../tools/design-tokens.js";

const REPO = new URL("../../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, REPO), "utf8");
const TOKENS = JSON.parse(read("design-system/tokens.json"));
const MANIFEST = JSON.parse(read("design-system/components.json"));
const CSS = read("microtone-worker/css/microtone.css");
const TOUCH_CSS = read("microtone-touch-worker/css/touch.css");
const COMPONENTS = "microtone-worker/src/ui/components/";

// ── tokens.json ─────────────────────────────────────────────────────────────

test("tokens.json is what tools/design-tokens.js makes of the stylesheets", () => {
  assert.equal(read("design-system/tokens.json"), serialise(buildTokens(new URL(".", REPO).pathname)),
    "stale — run: node tools/design-tokens.js");
});

test("every colour token has a usage note and a value in every theme", () => {
  const themes = TOKENS.color.themes.map((t) => t.id);
  assert.deepEqual(themes, ["dark", "dim", "light", "warmth"]);
  for (const tok of TOKENS.color.tokens) {
    assert.ok(tok.usage, `${tok.name} has no note: add one to design-system/notes.json`);
    assert.deepEqual(Object.keys(tok.value), themes, `${tok.name} is not declared in every theme`);
  }
  for (const tok of TOKENS.touch.tokens) assert.ok(tok.usage, `Touch's ${tok.name} has no note`);
});

test("the shared tokens of Touch keep the tracker's values", () => {
  // Known divergence, older than the design system: Touch's light keys sit on
  // a slightly darker panel-2. Anything else drifting apart is a mistake.
  const KNOWN = new Set(["panel-2/light"]);
  const tracker = new Map(TOKENS.color.tokens.map((t) => [t.name, t.value]));
  for (const tok of TOKENS.touch.tokens) {
    if (!tracker.has(tok.name)) continue;
    for (const [theme, v] of Object.entries(tok.value)) {
      if (KNOWN.has(`${tok.name}/${theme}`)) continue;
      assert.equal(v.toLowerCase(), tracker.get(tok.name)[theme].toLowerCase(), `${tok.name} in ${theme}`);
    }
  }
});

// ── the Proceed button ──────────────────────────────────────────────────────

test("Proceed's label is at least 200 heavier than any other button's, in both apps", () => {
  for (const [name, css] of [["tracker", CSS], ["Touch", TOUCH_CSS]]) {
    const weight = (n) => Number(new RegExp(`--weight-${n}:\\s*(\\d+)`).exec(css)?.[1]);
    assert.ok(weight("proceed") - weight("button") >= 200, `${name}: ${weight("proceed")} vs ${weight("button")}`);
  }
  assert.match(CSS, /button\.proceed\s*\{[^}]*font-weight:\s*var\(--weight-proceed\)/);
  assert.match(CSS, /^button\s*\{[^}]*font-weight:\s*var\(--weight-button\)/m);
  assert.match(TOUCH_CSS, /\.tbtn\.primary\s*\{[^}]*font-weight:\s*var\(--weight-proceed\)/);
});

test("Proceed is coloured apart from every other button, and readable, in every theme", () => {
  const val = (n, th) => TOKENS.color.tokens.find((t) => t.name === n).value[th];
  for (const th of TOKENS.color.themes.map((t) => t.id)) {
    assert.notEqual(val("proceed-bg", th), val("panel-2", th), `${th}: Proceed fill = the plain button's`);
    for (const fill of ["proceed-bg", "proceed-hover"]) {
      const r = contrast(val("proceed-fg", th), val(fill, th));
      assert.ok(r >= 4.5, `${th}: proceed-fg on ${fill} is ${r}:1`);
    }
  }
  for (const tok of TOKENS.touch.tokens.filter((t) => t.name.startsWith("proceed-"))) {
    assert.ok(Object.keys(tok.value).length === TOKENS.touch.themes.length, `Touch ${tok.name} in every theme`);
  }
});

// ── the component library ───────────────────────────────────────────────────

test("design-system/components is the link to the library", () => {
  assert.equal(readlinkSync(new URL("design-system/components", REPO)), "../microtone-worker/src/ui/components");
});

test("components.json lists every module, and every export, class and token it names exists", () => {
  const files = readdirSync(new URL(COMPONENTS, REPO)).filter((f) => f.endsWith(".js")).sort();
  const listed = MANIFEST.components.filter((c) => c.kind === "js").map((c) => c.module.split("/").pop()).sort();
  assert.deepEqual(listed, files, "a module under components/ is missing from components.json (or the reverse)");

  const tokenNames = new Set([
    ...TOKENS.color.tokens.map((t) => t.name),
    ...TOKENS.radius.tokens.map((t) => t.name),
    ...TOKENS.weight.tokens.map((t) => t.name),
    ...Object.keys(TOKENS.type.families),
  ]);
  for (const c of MANIFEST.components) {
    if (c.kind === "js") {
      const src = read(c.module);
      const exported = new Set([...src.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map((m) => m[1]));
      assert.deepEqual([...exported].sort(), [...c.exports].sort(), `${c.name}: exports`);
    }
    for (const cls of c.classes) {
      assert.ok(new RegExp(`\\.${cls}(?![\\w-])`).test(CSS), `${c.name}: .${cls} is not styled in microtone.css`);
    }
    // Role markers: classes the component sets for its callers and tests to
    // find a button by, with no style of their own.
    for (const cls of c.hooks ?? []) {
      assert.ok(read(c.module).includes(`"${cls}"`), `${c.name}: the hook .${cls} is not set by ${c.module}`);
    }
    for (const tok of c.tokens ?? []) assert.ok(tokenNames.has(tok), `${c.name}: no token ${tok}`);
    for (const r of c.rules ?? []) assert.ok(MANIFEST.rules.some((x) => x.id === r), `${c.name}: no rule ${r}`);
  }
  for (const r of MANIFEST.rules) for (const tok of r.tokens ?? []) assert.ok(tokenNames.has(tok), `${r.id}: ${tok}`);
});

// ── dialog actions: the rule holds by construction ──────────────────────────

/** Every .js file under the tracker's src/. */
function trackerSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir, REPO), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}${e.name}/`);
      else if (e.name.endsWith(".js")) out.push(`${dir}${e.name}`);
    }
  };
  walk("microtone-worker/src/");
  return out;
}

test("every tracker dialog builds its action row with actionRow()", () => {
  // The warmth splash is a parody advert with its own centred button.
  const EXEMPT = new Set(["microtone-worker/src/ui/popups/warmth.js", `${COMPONENTS}actions.js`]);
  for (const f of trackerSources()) {
    if (EXEMPT.has(f)) continue;
    const src = read(f);
    assert.doesNotMatch(src, /["' ]modal-buttons["' ]/, `${f} builds a .modal-buttons row by hand — use actionRow()`);
    assert.doesNotMatch(src, /t\("common\.cancel"\)/, `${f} makes a Cancel button of its own — use actionRow()`);
  }
});

/** Just enough DOM for actions.js: elements that hold children and classes. */
function fakeDom() {
  const el = (tag) => ({
    tagName: tag.toUpperCase(), className: "", textContent: "", children: [], dataset: {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
  });
  return { createElement: el };
}

test("actionRow lays out Cancel · extras · alternatives · Proceed, or one Dismiss", async () => {
  globalThis.document = fakeDom();
  try {
    const { actionRow, ROLE_CLASS } = await import("../../src/ui/components/actions.js");
    const extra = { tagName: "SPAN", className: "status" };
    const a = actionRow({
      proceed: "Apply", alternatives: ["Preview", null, "Record"], cancel: true, extras: [extra],
    });
    assert.deepEqual(a.row.children.map((b) => b.className || b.tagName),
      ["act-cancel", "status", "act-alt", "act-alt", "proceed"]);
    assert.deepEqual(a.row.children.map((b) => b.textContent ?? "(extra)"),
      ["Cancel", "(extra)", "Preview", "Record", "Apply"]);
    assert.equal(a.row.className, "modal-buttons");
    assert.equal(a.proceed, a.row.children.at(-1));
    assert.equal(a.cancel, a.row.children[0]);
    assert.ok(a.row.children.filter((b) => b.tagName === "BUTTON").every((b) => b.type === "button"));

    const d = actionRow({ dismiss: true });
    assert.deepEqual(d.row.children.map((b) => [b.className, b.textContent]), [["act-dismiss", "Close"]]);
    assert.throws(() => actionRow({ dismiss: true, cancel: true }), /stands alone/);
    assert.throws(() => actionRow({ dismiss: true, proceed: "OK" }), /stands alone/);

    const k = actionRow({ cancel: { className: "x-cancel" }, proceed: { label: "Go", className: "x-ok", disabled: true } });
    assert.equal(k.cancel.className, "act-cancel x-cancel");
    assert.equal(k.proceed.className, "proceed x-ok");
    assert.equal(k.proceed.disabled, true);
    assert.equal(ROLE_CLASS.proceed, "proceed");
  } finally {
    delete globalThis.document;
  }
});

test("Microtone Touch's sheets: Cancel first, the primary last, in every action row", () => {
  const dir = "microtone-touch-worker/src/";
  let rows = 0;
  for (const f of readdirSync(new URL(dir, REPO)).filter((n) => n.endsWith(".js"))) {
    const src = read(dir + f);
    // A Cancel anywhere must be the first button of an action row.
    for (const m of src.matchAll(/<div class="row( actions)?">([\s\S]*?)<\/div>/g)) {
      const buttons = [...m[2].matchAll(/<button[^>]*class="([^"]*)"[^>]*>(?:\$\{tHtml\("([^"]+)"\))?/g)]
        .map((b) => ({ cls: b[1], label: b[2] ?? "" }));
      const cancel = buttons.findIndex((b) => b.label === "sheet.cancel" || /\bcancel\b/.test(b.cls));
      const primary = buttons.findIndex((b) => /\bprimary\b/.test(b.cls));
      if (cancel < 0 && !/value="close"/.test(m[2])) continue; // not a sheet's own row
      rows++;
      assert.ok(m[1], `${f}: a row with Cancel/Close/Done is not marked .actions`);
      if (cancel >= 0) {
        assert.equal(cancel, 0, `${f}: Cancel is not the first button of its row`);
        assert.match(buttons[0].cls, /\bcancel\b/, `${f}: Cancel lacks .cancel`);
      }
      if (primary >= 0) assert.equal(primary, buttons.length - 1, `${f}: the primary is not the last button`);
    }
  }
  assert.ok(rows >= 8, `found only ${rows} action rows — has the markup moved?`);
});
