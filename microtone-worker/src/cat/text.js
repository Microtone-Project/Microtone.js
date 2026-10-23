// Text primitives shared by the translation memory, the glossary and the
// checks: tokens, English lemmas, the things a translation must carry over
// verbatim, and a weighted word diff.

/** `{name}` placeholders, filled in at run time — a translation must keep every one. */
export const PLACEHOLDER = /\{[A-Za-z_][\w.]*\}/g;

export const placeholders = (s) => (s.match(PLACEHOLDER) ?? []).sort();

// Things that are the same in every language and must survive translation:
// key chords, function keys, a bare key named in brackets, hex values, effect
// codes. (Numbers are their own check: a translation may legitimately spell
// one out.)
const MOD = "(?:Ctrl|Shift|Alt|Cmd|Meta|Option|Super)";
const KEY = "Space|Enter|Return|Esc|Escape|Tab|Delete|Del|Backspace|Insert|Ins|Home|End|PgUp|PgDn|PageUp|PageDown|Up|Down|Left|Right|F1[0-2]|F[1-9]";
const CODE = new RegExp([
  // Ctrl+Z, Shift+Alt+←, Ctrl+]; in "Ctrl+click" only "Ctrl+" is a code —
  // the action after it is a word, and is translated.
  `(?:${MOD}\\+)+(?:(?:${KEY})\\b|[A-Za-z0-9](?![A-Za-z0-9])|[^\\s\\p{L}\\p{N},;:)\\]])?`,
  "\\bF(?:1[0-2]|[1-9])\\b", // F1 … F12
  "(?<=\\()(?:Space|Insert|Enter|Esc|Tab|Delete|Backspace|Home|End|PgUp|PgDn|PageUp|PageDown|\\?|`)(?=\\))",
  "\\$[0-9A-Fa-f]+\\b", // $FF, S $7300's argument
].join("|"), "gu");

export const codes = (s) => (s.replace(PLACEHOLDER, " ").match(CODE) ?? []).sort();

export const numbers = (s) => (s.replace(PLACEHOLDER, " ").replace(CODE, " ").match(/\d+(?:[.,]\d+)*/g) ?? []).sort();

/** Words: runs of letters and digits, an apostrophe or hyphen inside one kept. */
const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}]|['’\-](?=[\p{L}\p{N}]))*/gu;

export function words(s) {
  return s.replace(PLACEHOLDER, " ").match(WORD) ?? [];
}

// Function words: a term never starts or ends with one, and the memory does
// not index them.
export const STOPWORDS = new Set((
  "a an the and or but nor of to in on at by for with from into onto over under as is are was were be been " +
  "being it its this that these those there here than then so if when while which what who whom whose " +
  "not no yes do does did done can could will would shall should may might must has have had having " +
  "you your yours we our us they them their he she his her i me my one ones any some each every all both " +
  "either neither more most less least only also just very too again once about above " +
  "below between after before through until upon via per how why where own same such other another " +
  "s t e g i.e e.g etc"
).split(" "));

/** English singular, by rule — enough to put `lane` and `lanes` together. */
export function lemma(word) {
  let w = word.toLowerCase().replace(/['’]s$/, "");
  if (w.length <= 3 || /[^a-z\-]/.test(w)) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  if (/(?:ss|us|is|ous|ics)$/.test(w)) return w;
  if (/(?:sses|xes|ches|shes|zes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Text split into word and non-word tokens; joined back they are the text. */
export function tokens(s) {
  const out = [];
  let last = 0;
  const re = new RegExp(`${PLACEHOLDER.source}|${WORD.source}`, "gu");
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push(...s.slice(last, m.index).split(/(?<=\s)(?=\S)|(?<=\S)(?=\s)/));
    out.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(...s.slice(last).split(/(?<=\s)(?=\S)|(?<=\S)(?=\s)/));
  return out.filter((t) => t !== "");
}

/** The comparison form of a token: case, placeholder names and digits do not count. */
export function normToken(t) {
  if (/^\{.*\}$/.test(t)) return "{}";
  if (/^\s+$/.test(t)) return " ";
  return t.toLowerCase().replace(/\d/g, "0");
}

/**
 * Word diff of `a` against `b` (LCS over tokens, each weighed by its length),
 * and the similarity it implies: 1 − (deleted + inserted) / (|a| + |b|), in
 * characters, compared in normToken's form. Identical normal forms whose raw
 * text differs score just under 1, so an exact match is always 1.
 * @returns {{ score: number, ops: {op: "="|"-"|"+", text: string}[] }}
 */
export function wordDiff(a, b) {
  const ta = tokens(a), tb = tokens(b);
  const na = ta.map(normToken), nb = tb.map(normToken);
  const n = ta.length, m = tb.length;
  // LCS table, weights = token length.
  const w = (t) => Math.max(1, t.length);
  const L = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = na[i] === nb[j] ? L[i + 1][j + 1] + w(na[i]) : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const ops = [];
  const push = (op, text) => {
    const last = ops[ops.length - 1];
    if (last && last.op === op) last.text += text; else ops.push({ op, text });
  };
  let i = 0, j = 0, same = 0;
  while (i < n || j < m) {
    if (i < n && j < m && na[i] === nb[j]) { push("=", tb[j]); same += w(na[i]); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { push("+", tb[j]); j++; }
    else { push("-", ta[i]); i++; }
  }
  const total = na.reduce((s, t) => s + w(t), 0) + nb.reduce((s, t) => s + w(t), 0);
  let score = total ? (2 * same) / total : 1;
  if (score === 1 && a !== b) score = 0.99;
  return { score, ops };
}

/** Writing systems with no spaces between words: every character can start a term. */
export const isDenseScript = (ch) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(ch);
