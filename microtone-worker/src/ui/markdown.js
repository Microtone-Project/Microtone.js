// Small, dependency-free Markdown → HTML renderer for the documentation viewer
// (docs.html). Covers the constructs the Taud docs use: ATX headings (with slug
// ids for the TOC), fenced and indented code, GFM tables, block quotes,
// ordered/unordered lists (one level of nesting), horizontal rules, paragraphs,
// and inline bold/italic/code/links. Pure + Node-testable — no DOM, no fetch.

/** Escape the five HTML-significant characters. */
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** esc() undone (a link's URL is matched after the line was escaped). */
function unesc(s) {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({
    amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'",
  }[e]));
}

/** Kebab-ish slug for a heading's anchor id (stable for the TOC links). */
export function slug(text) {
  return text.toLowerCase().trim()
    .replace(/[`*_~]/g, "")
    // keep ascii alphanumerics + CJK / Hangul / kana; everything else -> hyphen
    .replace(/[^a-z0-9가-힣一-鿿぀-ヿ]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

/** Inline formatting on already-block-split text. `link` is renderMarkdown's
 *  option of that name. */
function inline(s, link) {
  // Pull out code spans first so their contents aren't further formatted.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  // links [text](url) — in-page anchors navigate in place, the rest new-tab,
  // unless the `link` option says otherwise. (The URL was escaped with the
  // rest of the line; the option is handed it as written.)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, txt, url) => {
    const raw = unesc(url);
    const to = link?.(raw) ?? { href: raw, newTab: !raw.startsWith("#") };
    return `<a href="${esc(to.href)}"${to.newTab ? ` target="_blank" rel="noopener"` : ""}>${txt}</a>`;
  });
  // bold then italic (bold first so ** isn't eaten by * )
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?=$|[^_\w])/g, "$1<em>$2</em>");
  // restore code spans
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
  return s;
}

/** A table row's cells. As in GFM, `\|` is a pipe that belongs to the cell —
 *  inside a code span too, which is the only way to show one there — and
 *  reaches it bare; a backslash before anything else is left as written. */
function tableRow(line) {
  const s = line.trim();
  const cells = [];
  let cur = "";
  let closed = false; // the row ended on an unescaped pipe
  for (let i = 0; i < s.length; i++) {
    closed = false;
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; }
    else if (s[i] === "|") { cells.push(cur); cur = ""; closed = true; }
    else cur += s[i];
  }
  if (!closed) cells.push(cur);
  if (s.startsWith("|")) cells.shift(); // the leading pipe opens the row
  return cells.map((c) => c.trim());
}
const INDENTED = /^(?: {4}| {0,3}\t)/;
const isSeparatorRow = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");

/**
 * Render Markdown to an HTML string. Headings carry id="<slug>".
 *
 * `link(url)`, if given, places a link: it returns { href, newTab } for a URL
 * it wants to send somewhere else (the documentation viewer and the site
 * build send one document's link to another to wherever that document is
 * shown), or null to leave it to the default — an in-page `#anchor` in place,
 * anything else in a new tab.
 */
export function renderMarkdown(md, { link } = {}) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^(\s*)```+\s*([\w-]*)\s*$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // closing fence
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    // indented code: four spaces or a tab, opened only after a blank line, so
    // it can neither interrupt a paragraph nor swallow a list item's run-on
    // line. Blank lines inside it are kept; trailing ones are not.
    if (INDENTED.test(line) && line.trim() !== "" && (i === 0 || lines[i - 1].trim() === "")) {
      const body = [];
      while (i < lines.length && (INDENTED.test(lines[i]) || lines[i].trim() === "")) {
        body.push(lines[i].replace(INDENTED, "")); i++;
      }
      while (body[body.length - 1].trim() === "") body.pop();
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    // ATX heading
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      out.push(`<h${level} id="${slug(text)}">${inline(text, link)}</h${level}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    // table (header row + separator)
    if (line.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])
        && line.trim() !== "") {
      const header = tableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(tableRow(lines[i])); i++;
      }
      const th = header.map((c) => `<th>${inline(c, link)}</th>`).join("");
      const trs = rows.map((r) =>
        `<tr>${header.map((_, ci) => `<td>${inline(r[ci] ?? "", link)}</td>`).join("")}</tr>`).join("");
      out.push(`<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`);
      continue;
    }

    // block quote
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, "")); i++;
      }
      out.push(`<blockquote>${inline(body.join(" "), link)}</blockquote>`);
      continue;
    }

    // list (unordered/ordered, one level of nesting via indent)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      i = renderList(lines, i, out, link);
      continue;
    }

    // blank
    if (line.trim() === "") { i++; continue; }

    // paragraph: gather until a blank line or a block starter
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" &&
           !/^(#{1,6}\s|\s*(-{3,}|\*{3,}|_{3,})\s*$|\s*>|\s*([-*+]|\d+\.)\s+|\s*```)/.test(lines[i]) &&
           !(lines[i].includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1]))) {
      para.push(lines[i]); i++;
    }
    out.push(`<p>${inline(para.join(" "), link)}</p>`);
  }
  return out.join("\n");
}

/** Render a list starting at `start`; returns the index after it. Supports one
 *  level of nesting by leading-space indent. */
function renderList(lines, start, out, link) {
  const baseIndent = lines[start].match(/^(\s*)/)[1].length;
  const ordered = /^\s*\d+\.\s/.test(lines[start]);
  const tag = ordered ? "ol" : "ul";
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (!m) {
      // a blank line inside a list is tolerated only if the next line continues it
      if (lines[i].trim() === "" && i + 1 < lines.length &&
          /^(\s*)([-*+]|\d+\.)\s+/.test(lines[i + 1])) { i++; continue; }
      break;
    }
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      // nested list — attach to the previous item
      const nested = [];
      i = renderList(lines, i, nested, link);
      if (items.length) items[items.length - 1] += nested.join("");
      else items.push(nested.join(""));
      continue;
    }
    items.push(inline(m[3], link));
    i++;
  }
  out.push(`<${tag}>${items.map((it) => `<li>${it}</li>`).join("")}</${tag}>`);
  return i;
}

/**
 * The document's FIRST section at `level` as {title, body} — the heading's own
 * text plus everything under it, up to the next heading of that level or above.
 * Anything before that first heading (a document's preamble) is skipped, and
 * fenced code is stepped over so a `##` inside a listing can neither open nor
 * close a section. Null when the document has no heading at that level.
 * Item 104: the welcome screen's "what's new" panel reads the newest dated
 * section straight out of PATCH_NOTES.md with this.
 */
export function firstSection(md, level = 2) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const anyHead = new RegExp(`^#{1,${level}}\\s+(.*?)\\s*#*\\s*$`);
  const thisHead = new RegExp(`^#{${level}}\\s`);
  let inFence = false;
  let start = -1;
  let title = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = lines[i].match(anyHead);
    if (!h) continue;
    if (start < 0) {
      if (!thisHead.test(lines[i])) continue; // a shallower heading only precedes it
      start = i + 1;
      title = h[1];
    } else {
      return { title, body: lines.slice(start, i).join("\n").trim() };
    }
  }
  return start < 0 ? null : { title, body: lines.slice(start).join("\n").trim() };
}

/** True for a line that opens a block other than a paragraph. */
function opensBlock(line) {
  return /^([-*+]|\d+\.)\s/.test(line)   // list item
    || /^#{1,6}\s/.test(line)             // heading
    || /^\s*```/.test(line)               // fence
    || /^\s*>/.test(line)                 // quote
    || /^\s*\|/.test(line)                // table row
    || /^\s*(\*\s*){3,}$/.test(line)      // hr
    || /^\s*(-\s*){3,}$/.test(line);
}

/**
 * The first PARAGRAPH of a block, as one line of Markdown — the headline a
 * patch-notes section opens with, before its bullet list.
 *
 * Returns "" when the block leads with anything else, which most of the
 * changelog's older sections do: they were generated retroactively as bare
 * bullet lists, and only sections written from 2026-09-03 on carry a headline.
 * A caller therefore MUST treat the empty string as "this section has no
 * headline" and fall back, not as a fetch or parse failure.
 */
export function firstParagraph(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (out.length === 0) {
      if (line === "") continue;            // leading blank lines
      if (opensBlock(raw)) return "";       // not a paragraph at all
      out.push(line);
      continue;
    }
    if (line === "" || opensBlock(raw)) break;
    out.push(line);                         // a soft-wrapped continuation
  }
  return out.join(" ");
}

/** `md` split into blank-line-delimited blocks, each joined back into one
 *  string. A fenced code block is kept whole even if a blank line sits inside
 *  it. Leading/trailing blank lines produce no empty blocks. */
function blocks(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let cur = [];
  let inFence = false;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) inFence = !inFence;
    if (!inFence && raw.trim() === "") {
      if (cur.length) { out.push(cur.join("\n")); cur = []; }
      continue;
    }
    cur.push(raw);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

/**
 * The headline paragraph opening EACH bullet-list group in a block — the
 * convention CLAUDE.md's patch-notes rules describe for a batch that touches
 * several unrelated things: a one-sentence paragraph, a blank line, its list,
 * repeated newest first. Returns one string per group, in document order.
 *
 * A block with none of that shape yields `[]` — a bare bullet list (most of
 * the changelog's older sections, generated retroactively with no headline
 * at all) as much as a paragraph that happens to precede something other
 * than a list. Relies on the convention's blank line between a headline and
 * its list; a run-together `"Headline.\n- item"` (no blank line) is not
 * recognised here the way [firstParagraph] recognises it, because nothing in
 * this repository's actual patch notes writes it that way.
 */
export function sectionHeadlines(md) {
  const bs = blocks(md);
  const heads = [];
  for (let i = 0; i < bs.length - 1; i++) {
    const first = bs[i].split("\n")[0];
    if (opensBlock(first)) continue;                    // this block isn't a paragraph
    const nextFirst = bs[i + 1].split("\n")[0];
    if (/^([-*+]|\d+\.)\s/.test(nextFirst)) {
      heads.push(bs[i].split("\n").map((l) => l.trim()).join(" "));
    }
  }
  return heads;
}

/** The TOP-LEVEL bullet lines of a block, each stripped of its marker. Indented
 *  (nested) bullets are dropped: a teaser wants the headline items, not their
 *  sub-points. */
export function topLevelBullets(md) {
  const out = [];
  let inFence = false;
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = raw.match(/^([-*+]|\d+\.)\s+(.*)$/); // no leading space ⇒ top level
    if (m) out.push(m[2]);
  }
  return out;
}

/** Extract h2/h3 headings for a table of contents: [{level, text, slug}]. */
export function extractToc(md) {
  const toc = [];
  let inFence = false;
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = raw.match(/^(#{2,3})\s+(.*?)\s*#*\s*$/);
    if (h) toc.push({ level: h[1].length, text: h[2].replace(/[`*_]/g, ""), slug: slug(h[2]) });
  }
  return toc;
}
