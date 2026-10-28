// The Issues view: every finding of the checks (checks.js), by check, each a
// link to its string.

import { h, fill, segButtons } from "./dom.js";
import { CHECKS } from "./checks.js";

const PAGE = 200;

export function createIssuesView(ctx) {
  const root = document.getElementById("view-issues");
  const ui = ctx.ui;
  const toolbar = h("div", { className: "cat-toolbar" });
  const wrap = h("div", { className: "cat-tablewrap" });
  root.append(toolbar, wrap);
  let shown = PAGE;
  const P = () => ctx.project;

  function render() {
    const p = P();
    const all = p.allIssues();
    const live = all.filter((i) => ui.showDismissed || !i.dismissed);
    const counts = {};
    for (const i of live) counts[i.check] = (counts[i.check] ?? 0) + 1;
    const checks = Object.keys(CHECKS).filter((c) => counts[c]);
    if (ui.issueCheck !== "all" && !counts[ui.issueCheck]) ui.issueCheck = "all";

    const seg = h("div", { className: "mst-seg" });
    segButtons(seg, [{ value: "all", label: "All", count: live.length },
      ...checks.map((c) => ({ value: c, label: CHECKS[c].title, count: counts[c], title: CHECKS[c].severity }))],
    ui.issueCheck, (v) => { ui.issueCheck = v; shown = PAGE; ctx.saveUi(); render(); });
    const dismissedBox = h("input", { type: "checkbox", checked: !!ui.showDismissed, onchange: () => { ui.showDismissed = dismissedBox.checked; ctx.saveUi(); render(); } });
    const list = live.filter((i) => ui.issueCheck === "all" || i.check === ui.issueCheck);
    fill(toolbar, seg,
      h("label", { className: "cat-note" }, dismissedBox, ` Show dismissed (${all.length - all.filter((i) => !i.dismissed).length})`),
      list.length ? h("button", { type: "button", title: "List these strings on the Strings tab", onclick: () => ctx.showStrings([...new Set(list.map((i) => i.segment.id))], ui.issueCheck === "all" ? "with issues" : CHECKS[ui.issueCheck].title.toLowerCase()) }, "Open as a list") : null);

    if (!list.length) { fill(wrap, h("div", { className: "cat-empty" }, all.length ? "Nothing here." : "No issues.")); return; }
    const sevRank = { error: 0, warning: 1, info: 2 };
    list.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.check.localeCompare(b.check) || a.segment.source.localeCompare(b.segment.source));
    const rows = list.slice(0, shown).map((i) => h("tr", { className: i.dismissed ? "dim" : "" },
      h("td", { className: "sev" }, h("span", { className: `cat-sev ${i.severity}` }, i.severity)),
      h("td", { className: "key" }, h("button", { type: "button", className: "cat-link", onclick: () => ctx.showStrings([i.segment.id], i.segment.key, { keepList: true }) }, i.segment.key),
        p.corpora.length > 1 ? h("div", {}, p.corpusOf(i.segment).def.name) : null),
      h("td", {}, i.segment.source),
      h("td", { lang: p.lang }, p.target(i.segment)),
      h("td", { className: "msg" }, `${CHECKS[i.check].title}: ${i.message}`),
      h("td", { className: "cat-acts" }, h("button", { type: "button", onclick: () => { p.setDismissed(i, !i.dismissed); ctx.changed(); } }, i.dismissed ? "Restore" : "Dismiss"))));
    fill(wrap, h("table", { className: "cat-table" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Key"), h("th", {}, "English"), h("th", {}, p.langName), h("th", {}, "Issue"), h("th", {}))),
      h("tbody", {}, rows)),
    list.length > shown ? h("div", { className: "cat-more" }, h("button", { type: "button", onclick: () => { shown += PAGE * 2; render(); } }, `Show more (${list.length - shown} left)`)) : null);
  }

  return { render };
}
