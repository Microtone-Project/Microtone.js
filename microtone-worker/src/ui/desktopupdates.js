// Updates in the desktop app (desktop-qt/src/updater.h). A few seconds after
// start the shell is asked whether a newer Microtone is out; if so a banner
// offers it, and nothing is downloaded until the person says Download. Then
// "Restart now" (after asking about unsaved work, as quitting would) or "When
// I quit": an update never takes the window from someone mid-song. The words
// are the Tauri build's (desktop/glue/desktop.js), so the offer reads the same
// in either app.
//
// The shell's side is /api/desktop/updates on the app's own server
// (window.__MICROTONE_NATIVE__.updates.api): GET the state, POST ?check,
// ?download, ?install=quit or ?install=now. A copy that cannot replace itself
// (Windows' portable folder, a Mac app run from its disk image, an AppImage
// in a folder it may not write, a build) is told instead: a new version is
// out, and "Get it" opens the release's page in the system browser.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percent = (p) => `${Math.round(Math.max(0, Math.min(1, p || 0)) * 100)}%`;

/**
 * The offer, wired to its surroundings: `showBanner` and `showModal`
 * (components/), `t` (i18n), `isDirty()` (is the open project unsaved?), and
 * — for tests — `fetch`, `api` and `wait`.
 */
export function updatePrompt({ showBanner, showModal, t, isDirty, fetch = globalThis.fetch.bind(globalThis),
  api = globalThis.__MICROTONE_NATIVE__?.updates?.api ?? null, wait = sleep, every = 250,
  openPage = (url) => globalThis.open(url, "_blank", "noopener") }) {
  const call = async (query = "") => {
    const res = await fetch(api + (query ? `?${query}` : ""), { method: query ? "POST" : "GET", cache: "no-store" });
    if (!res.ok) throw new Error(`updates: ${res.status}`);
    return res.json();
  };
  /** The state once it has moved on from `state`. */
  const settle = async (status, state) => {
    let s = status;
    while (s.state === state) {
      await wait(every);
      s = await call();
    }
    return s;
  };

  /** A copy that does not update itself: where to get the new one. */
  function notice(s) {
    return showBanner({
      text: t("update.availableElsewhere", { version: s.version, current: s.current }),
      actions: [
        { label: t("update.getIt"), primary: true, onClick: () => openPage(s.page) },
        { label: t("update.later") },
      ],
    });
  }

  function offer(s) {
    return showBanner({
      text: t("update.available", { version: s.version, current: s.current }),
      actions: [
        { label: t("update.download"), primary: true, onClick: () => download(s) },
        { label: t("update.later") },
      ],
    });
  }

  async function download(s) {
    const banner = showBanner({ text: t("update.downloading", { version: s.version, percent: percent(0) }) });
    let st = await call("download");
    while (st.state === "downloading") {
      banner.update({ text: t("update.downloading", { version: st.version, percent: percent(st.progress) }) });
      await wait(every);
      st = await call();
    }
    if (st.state !== "ready") {
      banner.update({ text: t("update.failed", { error: st.error || st.state }), actions: [{ label: t("sf.dismiss") }] });
      return st;
    }
    ready(st, banner);
    return st;
  }

  function ready(st, banner = null) {
    const content = {
      text: t("update.ready", { version: st.version }),
      actions: [
        { label: t("update.restart"), primary: true, onClick: () => restartNow(st) },
        { label: t("update.onQuit"), onClick: () => onQuit(st) },
      ],
    };
    if (banner) banner.update(content);
    else showBanner(content);
  }

  async function onQuit(st) {
    await call("install=quit");
    showBanner({ text: t("update.deferred", { version: st.version }), actions: [{ label: t("sf.dismiss") }] });
  }

  async function restartNow(st) {
    if (isDirty() && !(await showModal({ title: t("update.restartDirty"), okLabel: t("update.restart") }))) {
      ready(st);  // still on offer
      return false;
    }
    await call("install=now");  // the shell quits, installs, and starts again
    return true;
  }

  /** Ask the shell to look, and offer what it finds. → the state. */
  async function check() {
    const s = await settle(await call("check"), "checking");
    if (s.state === "available") {
      if (s.updatable) offer(s);
      else if (s.page) notice(s);
    }
    return s;
  }

  return { check, download, restartNow, call };
}

/** The app's start: a look a few seconds in — to offer the update where this
 *  copy can install it, to say where to get it where it cannot. */
export function startDesktopUpdates(deps, { delay = 5000 } = {}) {
  const updates = globalThis.__MICROTONE_NATIVE__?.updates;
  if (!updates || updates.asks === false) return null;
  const prompt = updatePrompt(deps);
  setTimeout(() => prompt.check().catch((err) => console.warn("checking for updates:", err)), delay);
  return prompt;
}
