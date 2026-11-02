// The documentation's table of documents, and the pieces of the viewer that
// the browser and the site build share (item 281). Pure — no DOM, no fetch —
// so tools/docs-pages.js can import it under Node.
//
// The documents are read two ways:
//
//   - LIVE, by docs.html + docs.js: the page fetches assets/<file> and renders
//     it in the browser. A local server, the test suites and the desktop app
//     read them like this, with no build step.
//   - PRE-RENDERED, by the website's build (tools/docs-pages.js, run by
//     tools/stage-site.js --docs): each document becomes a page of its own at
//     docs/<id>/, already in HTML, and docs.html becomes a page that sends a
//     `docs.html#<id>/<heading>` address on to it.
//
// Both draw the contents list from the functions below, so the two cannot
// drift apart.

/** The site the build writes canonical addresses for. */
export const SITE = "https://microtone.cc";

/** The design system's docs page: a page of the site, not of this viewer.
 *  Absolute on purpose — /design-system/ exists only on the deployed site (the
 *  desktop app and a local server do not carry it), and in the desktop app an
 *  external link opens in the system browser. */
export const DESIGN_SYSTEM_URL = `${SITE}/design-system/`;

/** Every document, in the order the contents list shows them. `id` is its
 *  hash in docs.html and its directory under docs/ (never change one: it is
 *  an address people have bookmarked); `description` is the search engines'
 *  summary of the pre-rendered page. */
export const DOCS = [
  {
    id: "manual", title: "User Manual", file: "USER_MANUAL.md",
    description: "The Microtone user manual: the microtonal music tracker's views, keys and tools, from writing a first pattern to instruments, mixing, mastering and export.",
  },
  {
    id: "effects", title: "Note Effects", file: "TAUD_NOTE_EFFECTS.md",
    description: "Every effect command of the Taud tracker format — volume, pitch, vibrato, tempo, sample offsets, filters and more — with what it does and how an engine plays it.",
  },
  {
    id: "engine", title: "Engine Spec", file: "TAUD_ENGINE_SPEC.md",
    description: "The Taud engine specification: how a player turns a Taud song into sound — timing, pitch, triggering, envelopes, the sampler, filters, mixing and output.",
  },
  {
    id: "format", title: "File Format", file: "TAUD_FILE_FORMAT.md",
    description: "The Taud file format specification: the byte layout of .taud projects, .tsii instrument banks and .tpif files, and every structure a reader or writer must understand.",
  },
  {
    id: "conversion", title: "Conversion Notes", file: "TAUD_CONVERSION_NOTES.md",
    description: "How MOD, S3M, XM, IT, MIDI with SoundFont and other music formats become Taud songs: what maps cleanly, what has to be approximated, and the traps.",
  },
  {
    id: "sketch", title: "Sketch Format", file: "MICROTONE_SKETCH_FORMAT.md",
    description: "The .mtsk sketch file of Microtone Touch, the phone sketchpad that sends its ideas on to Microtone: its layout and its instrument pack.",
  },
  {
    id: "motif", title: "Motif Language", file: "TAUD_MOTIF_LANGUAGE.md",
    description: "The Taud Motif Language: writing a whole song as a program — notes, melodies, chords, instruments and arrangement, and the functions, chance and transformations that make them.",
  },
  {
    id: "patchnotes", title: "Patch Notes", file: "PATCH_NOTES.md",
    description: "What changed in each version of Microtone, the microtonal music tracker, newest first.",
  },
];

export const DEFAULT_DOC = DOCS[0].id;
export const docById = (id) => DOCS.find((d) => d.id === id) ?? null;

export function escapeText(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * The document a link in a document points at, as { id, slug } (slug null for
 * the top), or null when it points anywhere else. Recognised:
 *
 *   docs.html, docs.html#<id>[/<slug>], docs.html#<slug>   (the viewer's own addresses)
 *   #<id>                                                (a document by its hash)
 *   <FILE>.md[#<slug>], assets/<FILE>.md[#<slug>]          (a document by its file —
 *                                                         how the specifications cite one
 *                                                         another, and what works on GitHub)
 *
 * A bare `#<slug>` that names no document is a heading of the document it is
 * in, and is left alone (null). As in the viewer's own hash handling, a
 * document id wins over a heading slug that happens to spell the same.
 */
export function docTarget(url) {
  let m = url.match(/^(?:\.\/)?docs\.html(?:#(.*))?$/);
  if (m) {
    const h = m[1] ? decodeURIComponent(m[1]) : "";
    if (!h) return { id: DEFAULT_DOC, slug: null };
    const [id, slug] = h.split("/");
    return docById(id) ? { id, slug: slug || null } : { id: DEFAULT_DOC, slug: h };
  }
  m = url.match(/^#([^/]+)(?:\/(.*))?$/);
  if (m && docById(m[1])) return { id: m[1], slug: m[2] || null };
  m = url.match(/^(?:\.\/)?(?:assets\/)?([A-Z0-9_]+\.md)(?:#(.*))?$/);
  if (m) {
    const doc = DOCS.find((d) => d.file === m[1]);
    if (doc) return { id: doc.id, slug: m[2] || null };
  }
  return null;
}

/** The contents list's first part: one entry per document (the current one
 *  marked), then the design system. `href(id)` is the address of a document
 *  — `#<id>` in the live viewer, `../<id>/` on a pre-rendered page. */
export function docNavHtml(activeId, href) {
  const items = DOCS.map((d) => {
    const active = d.id === activeId;
    return `<a class="toc-doc${active ? " active" : ""}" href="${href(d.id)}" data-doc="${d.id}"${
      active ? ' aria-current="page"' : ""}>${escapeText(d.title)}</a>`;
  }).join("");
  const external = `<a class="toc-link" href="${DESIGN_SYSTEM_URL}" target="_blank" rel="noopener">Design System</a>`;
  return `<div class="toc-section">${items}${external}</div>`;
}

/** The contents list's second part: the document's own h2/h3 headings
 *  (markdown.js extractToc), each an in-page `#<slug>` link. */
export function headingsHtml(toc) {
  const links = toc.map((e) =>
    `<a class="toc-h${e.level}" href="#${e.slug}" data-slug="${e.slug}">${escapeText(e.text)}</a>`).join("");
  return links ? `<div class="toc-section toc-headings">${links}</div>` : "";
}
