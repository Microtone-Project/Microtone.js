// The transport bar's upkeep: the wordmark at its head, which takes the room
// the controls leave, and the menu behind the hamburger at its end.

/**
 * Keep the wordmark as long as the bar has room for: "Microtone™ Touch",
 * "Microtone™", or nothing. The room is the bar's width less its padding,
 * its controls and the gaps between them (`spacer` takes whatever is left
 * over, so it counts as nothing). Whatever shows, every part of the mark
 * stays laid out (touch.css only lifts it out of the flow), so its natural
 * width can always be read: "Microtone™" runs from the first span to the end
 * of the TM, and "Touch" is its own span and the space before it.
 *
 * Runs on a ResizeObserver over the bar and its controls — a turned phone,
 * a dragged splitter, "Section" becoming "Song" — and whenever a font
 * arrives (the mark is set in Geist, from Google Fonts), never per frame.
 * Changing the mark resizes none of those, so it cannot feed back on itself.
 */
export function fitBrand(bar, brand, spacer) {
  const first = brand.querySelector(".brand");
  const tm = brand.querySelector(".brand-tm");
  const touch = brand.querySelector(".brand-touch");
  const fit = () => {
    const cs = getComputedStyle(bar);
    const gap = parseFloat(cs.columnGap) || 0;
    let room = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    for (const el of bar.children) {
      // each control, and the gap after it (the spacer's own is the last)
      if (el !== brand && el !== spacer) room -= el.getBoundingClientRect().width + gap;
    }
    const own = getComputedStyle(brand);
    const short = tm.getBoundingClientRect().right - first.getBoundingClientRect().left +
      parseFloat(own.marginLeft) + parseFloat(own.marginRight) + gap; // the mark's own gap
    const full = short + touch.getBoundingClientRect().width + parseFloat(getComputedStyle(touch).marginLeft);
    const want = full <= room ? "full" : short <= room ? "short" : "none";
    if (brand.dataset.fit !== want) brand.dataset.fit = want;
  };
  const ro = new ResizeObserver(fit);
  ro.observe(bar);
  for (const el of bar.children) if (el !== brand && el !== spacer) ro.observe(el);
  document.fonts?.addEventListener("loadingdone", fit);
  document.fonts?.ready.then(fit);
  return fit;
}

/**
 * The menu: a modal dialog dropped from `button`, one level deep. `items`
 * maps each [data-act] inside it to what it does; `before()` brings what the
 * menu shows (the values, the caption) up to date just before it opens.
 */
export function initMenu(dialog, button, { items, before }) {
  const entries = () => [...dialog.querySelectorAll("[data-act]:not(:disabled)")];
  function open() {
    before?.();
    const r = button.getBoundingClientRect();
    dialog.style.top = `${Math.round(r.bottom + 4)}px`;
    dialog.style.right = `${Math.max(4, Math.round(document.documentElement.clientWidth - r.right))}px`;
    dialog.showModal();
    button.setAttribute("aria-expanded", "true");
    entries()[0]?.focus();
  }
  dialog.addEventListener("close", () => button.setAttribute("aria-expanded", "false"));
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) { dialog.close(); return; } // the backdrop
    const item = e.target.closest("[data-act]");
    if (!item || item.disabled) return;
    dialog.close();
    items[item.dataset.act]?.();
  });
  dialog.addEventListener("keydown", (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const list = entries();
    const at = list.indexOf(document.activeElement);
    list[(at + step + list.length) % list.length]?.focus();
  });
  button.addEventListener("click", open);
  return { open, close: () => dialog.close() };
}
