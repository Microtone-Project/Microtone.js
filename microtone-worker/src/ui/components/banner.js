// A banner — a short notice at the bottom-right corner of the window, for
// something that finished while you were doing something else: a soundfont
// converted in the background, a conversion that failed. It is the web app's
// twin of the desktop app's update notice (desktop/glue/desktop.js draws that
// one itself, since the page must not know it is in a desktop shell), and it
// looks the same: a panel with a hairline border, a line of text, its buttons
// at the right.
//
// It never takes the keyboard: it is not a dialog, nothing waits on it, and
// the song keeps playing under it. Banners stack upwards, newest at the
// bottom; a button press runs its action and takes the banner away. A button
// is blurred before its action runs, so Space afterwards plays the song
// instead of pressing it again.

let stack = null;

/**
 * Show a banner. `actions` = [{ label, onClick?, primary? }], left to right;
 * the primary one (at most one: what the banner is for) wears the accent
 * border. Returns { element, update({ text, actions }), close() }.
 */
export function showBanner({ text, actions = [] }) {
  if (!stack || !stack.isConnected) {
    stack = document.createElement("div");
    stack.className = "banner-stack";
    document.body.appendChild(stack);
  }
  const el = document.createElement("div");
  el.className = "banner";
  el.setAttribute("role", "status");
  const close = () => {
    el.remove();
    if (stack && stack.childElementCount === 0) { stack.remove(); stack = null; }
  };
  const update = ({ text: line, actions: buttons = [] }) => {
    const p = document.createElement("p");
    p.textContent = line;
    const parts = [p];
    if (buttons.length) {
      const row = document.createElement("div");
      row.className = "banner-actions";
      for (const { label, onClick, primary } of buttons) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        if (primary) b.className = "banner-go";
        b.addEventListener("click", () => { b.blur(); close(); onClick?.(); });
        row.appendChild(b);
      }
      parts.push(row);
    }
    el.replaceChildren(...parts);
  };
  update({ text, actions });
  stack.appendChild(el);
  return { element: el, update, close };
}
