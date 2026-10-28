// The checks a declaration's options go through (music.js, chain.js): each
// takes the value and what it is called, and returns the value the score
// keeps — or throws, saying what is wrong and, for a misspelt option, what was
// probably meant.

import { asString, asRecord, asInt, asNumber, fail, typeName } from "./values.js";

export const str = (v, what) => asString(v, what);
export const bool = (v, what) => { if (typeof v !== "boolean") throw fail(`${what} must be true or false, not ${typeName(v)}`); return v; };
export const int = (lo, hi) => (v, what) => {
  asInt(v, what);
  if (v < lo || v > hi) throw fail(`${what} must be ${lo}…${hi}, not ${v}`);
  return v;
};
export const num = (lo, hi) => (v, what) => {
  asNumber(v, what);
  if (v < lo || v > hi) throw fail(`${what} must be ${lo}…${hi}, not ${v}`);
  return v;
};
export const oneOf = (map) => (v, what) => {
  if (typeof v === "string" && Object.prototype.hasOwnProperty.call(map, v)) return map[v];
  throw fail(`${what} must be one of ${Object.keys(map).map((k) => `"${k}"`).join(", ")}`);
};
export const any = (v) => v;

/** "did you mean …?" for a misspelt option. */
export function suggest(word, options) {
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  };
  let best = null, bd = 3;
  for (const o of options) { const x = dist(word, o); if (x < bd) { bd = x; best = o; } }
  return best ? ` (did you mean "${best}"?)` : "";
}

export function readOptions(value, schema, what) {
  const r = asRecord(value, what);
  const out = {};
  for (const [k, v] of r.m) {
    const check = schema[k];
    if (!check) throw fail(`${what} has no option "${k}"${suggest(k, Object.keys(schema))}`);
    out[k] = check(v, `${what}'s ${k}`);
  }
  return out;
}

