// Small DOM helpers for the workbench's views. Text always goes in as text
// (textContent / text nodes): the strings being translated are data.

import { PLACEHOLDER, codes } from "./text.js";
import { findTerms } from "./glossary.js";

/** h("div", {className: "x", onclick}, child, "text", …) */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "className" || k === "textContent" || k === "value" || k === "checked" || k === "disabled" || k === "hidden" || k === "title" || k === "type") el[k] = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

/** Replace an element's children. */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  return el;
}

/** Set text only when it differs (a write re-lays-out the page). */
export function showText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

const NBSP = "\u00a0";

/** Text with no-break spaces and edge spaces made visible. */
function visibleText(text) {
  const frag = document.createDocumentFragment();
  const lead = /^ +/.exec(text)?.[0] ?? "";
  const trail = text.length > lead.length ? /( +)$/.exec(text)?.[1] ?? "" : "";
  const body = text.slice(lead.length, text.length - trail.length);
  if (lead) frag.append(h("span", { className: "cat-ws", title: "a space" }, "·".repeat(lead.length)));
  const parts = body.split(NBSP);
  parts.forEach((p, i) => {
    if (i) frag.append(h("span", { className: "cat-nbsp", title: "a no-break space" }, NBSP));
    if (p) frag.append(p);
  });
  if (trail) frag.append(h("span", { className: "cat-ws", title: "a space" }, "·".repeat(trail.length)));
  return frag;
}

/**
 * The English as the editor shows it: placeholders and codes marked, and the
 * glossary's terms underlined (`onTerm(entry)` on a click).
 */
export function sourceView(text, termsByKey, onTerm = null) {
  const marks = [];
  for (const m of text.matchAll(PLACEHOLDER)) marks.push({ start: m.index, end: m.index + m[0].length, cls: "cat-ph", title: "a placeholder — keep it as it is" });
  const seenCodes = new Set(codes(text));
  for (const c of seenCodes) {
    let i = -1;
    while ((i = text.indexOf(c, i + 1)) >= 0) marks.push({ start: i, end: i + c.length, cls: "cat-code", title: "the same in every language" });
  }
  if (termsByKey) {
    for (const t of findTerms(text, termsByKey)) {
      const want = t.entry.dnt ? `keep as “${t.entry.source}”` : t.entry.targets.join(" / ");
      marks.push({ start: t.start, end: t.end, cls: "cat-term", title: `glossary: ${want}${t.entry.note ? ` — ${t.entry.note}` : ""}`, entry: t.entry });
    }
  }
  marks.sort((a, b) => a.start - b.start || b.end - a.end);
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const m of marks) {
    if (m.start < at) continue; // overlaps an earlier mark
    if (m.start > at) frag.append(visibleText(text.slice(at, m.start)));
    const span = h("span", { className: m.cls, title: m.title }, visibleText(text.slice(m.start, m.end)));
    if (m.entry && onTerm) span.addEventListener("click", () => onTerm(m.entry));
    frag.append(span);
    at = m.end;
  }
  if (at < text.length) frag.append(visibleText(text.slice(at)));
  return frag;
}

/** A word diff (text.js wordDiff ops): "-" struck, "+" marked. */
export function diffView(ops) {
  const frag = document.createDocumentFragment();
  for (const o of ops) {
    if (o.op === "=") frag.append(visibleText(o.text));
    else frag.append(h(o.op === "-" ? "del" : "ins", { className: o.op === "-" ? "cat-del" : "cat-ins" }, visibleText(o.text)));
  }
  return frag;
}

/** Only the side of a diff that is `ops`' target, with what is new marked. */
export function diffNewSide(ops) {
  return diffView(ops.filter((o) => o.op !== "-"));
}

/** Text with every case-insensitive occurrence of `needle` marked. */
export function hitView(text, needle) {
  const frag = document.createDocumentFragment();
  const n = needle.trim().toLowerCase();
  if (!n) { frag.append(text); return frag; }
  const low = text.toLowerCase();
  let at = 0, i;
  while ((i = low.indexOf(n, at)) >= 0) {
    if (i > at) frag.append(text.slice(at, i));
    frag.append(h("mark", { className: "cat-hit" }, text.slice(i, i + n.length)));
    at = i + n.length;
  }
  if (at < text.length) frag.append(text.slice(at));
  return frag;
}

/** A segmented row of pushbuttons (design system: Pushbuttons, `.mst-seg`). */
export function segButtons(el, options, current, onPick) {
  fill(el, options.map((o) => {
    const b = h("button", { type: "button", className: o.value === current ? "active" : "", title: o.title }, o.label);
    if (o.count !== undefined) b.append(h("span", { className: "cat-n" }, String(o.count)));
    b.addEventListener("click", () => onPick(o.value));
    return b;
  }));
}
