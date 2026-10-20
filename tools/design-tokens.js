#!/usr/bin/env node
// design-tokens.js — write design-system/tokens.json, the machine-readable
// token list of the Microtone design system, from the two stylesheets.
//
//   node tools/design-tokens.js           write it
//   node tools/design-tokens.js --check   exit 1 if the committed file is stale
//
// The stylesheets are the source of truth: every colour, shape and weight is a
// custom property declared once per theme in microtone-worker/css/microtone.css
// (Microtone Touch's own set in microtone-touch-worker/css/touch.css), and the
// app reads them from there. This only COPIES them out — the values, which
// theme each belongs to, and the trailing comment as a fallback note — and
// merges in design-system/notes.json, the curated half: what each token is
// for, the text styles, which ink/ground pairs to report contrast for.
// test/node/design-system.test.js runs the --check, so a token changed in the
// CSS without a regenerated tokens.json fails the suite.
//
// The shape follows the Design System artifact format (lists of
// {name, value, usage}, colours as {theme: value}), so the same file can be
// published to the claude.ai design-system artifact unchanged.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRACKER_CSS = "microtone-worker/css/microtone.css";
const TOUCH_CSS = "microtone-touch-worker/css/touch.css";
const OUT = "design-system/tokens.json";
const NOTES = "design-system/notes.json";

const THEME_NAMES = { dark: "Dark", dim: "Dim", light: "Light", warmth: "Warmth" };

/** Colour-token groups, by name. First match wins. */
const GROUPS = [
  [/^(bg|panel|panel-2|fg|fg2|dim|border)$/, "Grounds and ink"],
  [/^(accent|accent-2|meter|meter-bg)$/, "Accents"],
  [/^proceed-/, "Actions"],
  [/^(ok|err|rec)-/, "Status"],
  [/^brand2?$/, "Brand"],
  [/^scrim$/, "Overlay"],
  [/^cv-fx-/, "Canvas: effect column"],
  [/^cv-(oct|pitch)-/, "Canvas: pitch plot"],
  [/^cv-pool-/, "Canvas: sample memory"],
  [/^cv-(wave|env|play-cursor|live)/, "Canvas: samples and envelopes"],
  [/^cv-/, "Canvas: pattern grids"],
  [/^code-/, "Motif editor"],
];
const groupOf = (name) => GROUPS.find(([re]) => re.test(name))?.[1] ?? "Other";

const isColour = (v) => /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch)\([^()]*\))$/i.test(v);

/**
 * The custom-property blocks of a stylesheet: `:root[data-theme="x"]` (and the
 * `:root,` that precedes the default theme's) → theme x; a bare `:root` → null
 * (theme-independent). Each declaration keeps the comment that trails it on
 * its own line.
 */
export function parseBlocks(css) {
  const blocks = [];
  const head = /^(:root,\s*\n)?:root(?:\[data-theme="([a-z]+)"\])?\s*\{/gm;
  let m;
  while ((m = head.exec(css))) {
    const start = m.index + m[0].length;
    const end = css.indexOf("\n}", start);
    blocks.push({ theme: m[2] ?? null, isDefault: !!m[1], decls: parseDecls(css.slice(start, end)) });
  }
  return blocks;
}

function parseDecls(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    if (body.startsWith("/*", i)) { i = body.indexOf("*/", i) + 2; continue; }
    const m = /^--([a-z0-9-]+)\s*:/.exec(body.slice(i, i + 80));
    if (!m) { i++; continue; }
    i += m[0].length;
    // The value runs to the `;` outside quotes and parentheses (a data: URL,
    // a gradient, a shadow list over several lines).
    let depth = 0, quote = null, v = "";
    for (; i < body.length; i++) {
      const c = body[i];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === ";" && depth === 0) break;
      v += c;
    }
    i++;
    // A comment after the `;` and before the line ends is this token's note.
    const rest = body.slice(i);
    const trail = /^[ \t]*\/\*([\s\S]*?)\*\//.exec(rest);
    const sameLine = trail && !/\n/.test(rest.slice(0, rest.indexOf("/*")));
    out.push({
      name: m[1],
      value: v.replace(/\s+/g, " ").trim(),
      note: sameLine ? trail[1].replace(/\s+/g, " ").trim() : null,
    });
  }
  return out;
}

/** Fonts the stylesheet ships (`@font-face`), path relative to the repo. */
function parseFontFaces(css, cssPath) {
  const faces = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const family = /font-family:\s*"([^"]+)"/.exec(body)?.[1];
    const src = /url\("([^"]+)"\)/.exec(body)?.[1];
    if (!family || !src) continue;
    faces.push({
      family,
      file: join(dirname(cssPath), src).replace(/^microtone-worker\/core\//, "core/"),
      weight: /font-weight:\s*([^;]+);/.exec(body)?.[1].trim() ?? "400",
      style: /font-style:\s*([^;]+);/.exec(body)?.[1].trim() ?? "normal",
    });
  }
  return faces;
}

/** WCAG 2 contrast ratio of two #rrggbb colours (alpha ignored). */
export function contrast(a, b) {
  const lum = (hex) => {
    let h = hex.replace("#", "");
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const [r, g, bl] = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

/** One stylesheet's tokens: { themes, colour: Map, other: Map } where each
 *  map is name → { value: {theme|"all": v}, note }. */
function collect(css) {
  const blocks = parseBlocks(css);
  const themes = [];
  const colour = new Map(), other = new Map();
  for (const b of blocks) {
    if (b.theme && !themes.includes(b.theme)) {
      if (b.isDefault) themes.unshift(b.theme); else themes.push(b.theme);
    }
    for (const d of b.decls) {
      const map = isColour(d.value) ? colour : other;
      const e = map.get(d.name) ?? { value: {}, note: null };
      e.value[b.theme ?? "all"] = d.value;
      e.note ??= d.note;
      map.set(d.name, e);
    }
  }
  return { themes, colour, other };
}

export function buildTokens(root = ROOT) {
  const read = (p) => readFileSync(join(root, p), "utf8");
  const notes = JSON.parse(read(NOTES));
  const css = read(TRACKER_CSS);
  const { themes, colour, other } = collect(css);
  const usage = (name, e) => notes.usage[name] ?? e.note ?? null;
  const themed = (e) => (e.value.all !== undefined
    ? Object.fromEntries(themes.map((t) => [t, e.value.all]))
    : Object.fromEntries(themes.filter((t) => e.value[t] !== undefined).map((t) => [t, e.value[t]])));
  const valueOf = (name, theme) => colour.get(name)?.value[theme] ?? colour.get(name)?.value.all;

  const list = (pred) => [...other].filter(([n]) => pred(n))
    .map(([name, e]) => ({ name, value: e.value.all ?? themed(e), usage: usage(name, e) }));

  const touch = collect(read(TOUCH_CSS));
  return {
    name: "Microtone",
    version: 2,
    $comment: `GENERATED by tools/design-tokens.js from ${TRACKER_CSS}, ${TOUCH_CSS} and ${NOTES} — never edit by hand.`,
    meta: {
      source: "repo",
      paths: { tokens: [TRACKER_CSS, TOUCH_CSS], notes: NOTES, components: "microtone-worker/src/ui/components/" },
      defaultTheme: "dim",
    },
    color: {
      themes: themes.map((id) => ({ id, name: THEME_NAMES[id] ?? id, note: notes.themes[id] ?? null })),
      tokens: [...colour].map(([name, e]) => ({
        name, group: groupOf(name), value: themed(e), usage: usage(name, e),
      })),
    },
    contrast: notes.contrast.flatMap(([ink, grounds]) => grounds.map((ground) => ({
      ink, ground,
      ratio: Object.fromEntries(themes.map((t) => [t, contrast(valueOf(ink, t), valueOf(ground, t))])),
    }))),
    type: {
      fonts: [
        ...parseFontFaces(css, TRACKER_CSS),
        { family: "Open Sans", hosted: "Google Fonts", weight: "300 800", axes: "wdth 75–100" },
        { family: "Geist", hosted: "Google Fonts", weight: "400 900" },
      ],
      families: {
        ui: "\"Open Sans\", sans-serif",
        display: "\"Geist\", sans-serif",
        ...Object.fromEntries([...other].filter(([n]) => n.endsWith("-font")).map(([n, e]) => [n, e.value.all])),
      },
      groups: notes.textStyles,
    },
    radius: { tokens: list((n) => n.startsWith("radius-")) },
    weight: { tokens: list((n) => n.startsWith("weight-")) },
    texture: { note: "Warmth only.", tokens: list((n) => n.startsWith("abs-")) },
    touch: {
      note: `Microtone Touch's own set (${TOUCH_CSS}): the tracker's names and palettes wherever the two share a token, plus the keyboard, lane and grid inks of its own.`,
      themes: touch.themes.map((id) => ({ id, name: THEME_NAMES[id] ?? id })),
      tokens: [...touch.colour].map(([name, e]) => ({
        name,
        value: Object.fromEntries(touch.themes.filter((t) => e.value[t] ?? e.value.all).map((t) => [t, e.value[t] ?? e.value.all])),
        usage: notes.touchUsage[name] ?? e.note ?? (colour.has(name) ? `As the tracker's ${name}.` : null),
      })),
      other: [...touch.other].map(([name, e]) => ({
        name, value: e.value.all ?? e.value, usage: notes.touchUsage[name] ?? notes.usage[name] ?? e.note ?? null,
      })),
    },
  };
}

export const serialise = (tokens) => JSON.stringify(tokens, null, 2) + "\n";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = serialise(buildTokens());
  if (process.argv.includes("--check")) {
    const now = readFileSync(join(ROOT, OUT), "utf8");
    if (now !== text) {
      console.error(`${OUT} is stale — run: node tools/design-tokens.js`);
      process.exit(1);
    }
    console.log(`${OUT} is up to date`);
  } else {
    writeFileSync(join(ROOT, OUT), text);
    console.log(`wrote ${OUT}`);
  }
}
