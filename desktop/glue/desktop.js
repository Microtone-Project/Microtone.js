// Microtone desktop glue. desktop/src/main.rs injects this into every page of
// the Tauri build as an initialization script — it runs before the page's own
// scripts, on every load, with window.__MICROTONE_DESKTOP__ = { platform,
// window } set just ahead of it. microtone-worker knows nothing about it: the
// desktop app is a shell around the website, not a fork of it, so this only
// does what a browser would have done for the page:
//
//   - requestClose(): closing the window runs the page's beforeunload, which
//     is how the app guards an unsaved project (desktop/src/closing.rs)
//   - the update banner, in the main window (desktop/src/updates.rs)
//   - notice(): a line from the Rust side, e.g. a save that failed
//   - online projects: the page's fetch() to /api/online and its sign-in
//     window go through the app, which holds the access token
//     (desktop/src/online.rs)
//   - alert() and confirm() on macOS, which WKWebView lacks
//     (desktop/src/mac_dialogs.rs)
//   - hides the welcome screen's "Get the desktop app" (.wc-desktop), the
//     website's offer of the very app this is
//   - copies the projects, soundfonts and keymaps out of OPFS into
//     ~/Microtone, where the next desktop app keeps them (desktop/src/
//     handover.rs; desktop-qt/src/filestore.cpp)
//
// Its strings are its own, in the app's two languages, chosen by <html lang>
// (which the app's i18n sets). Its colours are the app's theme tokens, and the
// banner wears the context menu's look.
(() => {
  "use strict";

  const config = window.__MICROTONE_DESKTOP__ || {};
  const invoke = (cmd, args, options) => window.__TAURI_INTERNALS__.invoke(cmd, args, options);

  const STRINGS = {
    en: {
      available: "Microtone {version} is out — you are running {current}.",
      download: "Download",
      later: "Not now",
      downloading: "Downloading Microtone {version}… {percent}",
      ready: "Microtone {version} is downloaded.",
      restart: "Restart now",
      onQuit: "When I quit",
      deferred: "Microtone {version} will be installed when you quit.",
      failed: "The update could not be downloaded: {error}",
      installFailed: "The update could not be installed: {error}",
      dismiss: "Close",
      quitDirty: "Quit and discard unsaved changes?",
      restartDirty: "Restart and discard unsaved changes?",
      saveFailed: "{name} could not be saved: {error}",
      exportFailed: "{name} could not be saved.",
      signInBrowser: "Sign in in the browser that just opened; Microtone picks it up from there.",
      signInFailed: "Signing in did not complete: {error}",
      handedOver: "Your projects are now also in {folder}, where the next version of Microtone keeps them. Nothing here was moved or deleted.",
    },
    ko: {
      available: "Microtone {version} 업데이트가 나왔습니다 — 지금 쓰는 버전은 {current}입니다.",
      download: "내려받기",
      later: "나중에",
      downloading: "Microtone {version} 내려받는 중… {percent}",
      ready: "Microtone {version} 내려받기가 끝났습니다.",
      restart: "지금 다시 시작",
      onQuit: "끝낼 때 설치",
      deferred: "Microtone을 끝내면 {version} 업데이트가 설치됩니다.",
      failed: "업데이트를 내려받지 못했습니다: {error}",
      installFailed: "업데이트를 설치하지 못했습니다: {error}",
      dismiss: "닫기",
      quitDirty: "저장하지 않은 변경 사항을 버리고 끝낼까요?",
      restartDirty: "저장하지 않은 변경 사항을 버리고 다시 시작할까요?",
      saveFailed: "{name}을(를) 저장하지 못했습니다: {error}",
      exportFailed: "{name}을(를) 저장하지 못했습니다.",
      signInBrowser: "방금 열린 브라우저에서 로그인하세요. 그러면 Microtone이 이어받습니다.",
      signInFailed: "로그인을 마치지 못했습니다: {error}",
      handedOver: "이제 프로젝트가 {folder}에도 있습니다. 다음 버전의 Microtone은 그곳에 프로젝트를 보관합니다. 여기 있는 것은 옮기거나 지우지 않았습니다.",
    },
  };

  function text(key, params = {}) {
    const table = STRINGS[document.documentElement.lang] || STRINGS.en;
    return (table[key] ?? STRINGS.en[key]).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
  }

  /** The app's own unsaved-changes test: its beforeunload handler cancels
   *  the event while the project is dirty (src/ui/app.js). */
  function pageWouldStay() {
    return !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  }

  // ── the website's offer of this app ──
  //
  // The welcome screen offers the desktop app to a browser
  // (src/ui/views/welcome.js); the page does not know it is in one, so the
  // shell takes the offer down. Hidden from the first paint: a constructed
  // sheet needs no <head>, which an initialization script runs too early to
  // have. An older webview without one gets a <style> once the head is there.

  const WEB_ONLY = ".wc-desktop { display: none !important; }";

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(WEB_ONLY);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    const add = () => {
      const style = document.createElement("style");
      style.textContent = WEB_ONLY;
      document.head.appendChild(style);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add, { once: true });
    else add();
  }

  // ── closing ──

  function requestClose() {
    invoke("close_ack").catch(() => {});
    if (pageWouldStay() && !confirm(text("quitDirty"))) return;
    invoke("close_confirmed").catch(() => {});
  }

  // ── banners ──

  const STYLE = `
    .mt-desktop-banners {
      position: fixed; right: 1rem; bottom: 2.6rem; z-index: 2147483000;
      display: flex; flex-direction: column; align-items: flex-end; gap: 0.5rem;
      pointer-events: none;
    }
    .mt-desktop-banner {
      pointer-events: auto;
      max-width: 27rem; padding: 0.7rem 0.85rem;
      background: var(--panel); color: var(--fg);
      border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.45);
      font-size: 0.87rem;
    }
    .mt-desktop-banner p { margin: 0; }
    .mt-desktop-banner .mt-desktop-buttons {
      display: flex; justify-content: flex-end; gap: 0.4rem; margin-top: 0.6rem;
    }
    .mt-desktop-banner button.mt-desktop-go { border-color: var(--accent); }`;

  let stack = null;

  function banner() {
    if (!stack) {
      const style = document.createElement("style");
      style.textContent = STYLE;
      document.head.appendChild(style);
      stack = document.createElement("div");
      stack.className = "mt-desktop-banners";
      document.body.appendChild(stack);
    }
    const el = document.createElement("div");
    el.className = "mt-desktop-banner";
    el.setAttribute("role", "status");
    stack.appendChild(el);
    return el;
  }

  /** Fill `el` with a line and its buttons: [label, action, primary?]. */
  function fill(el, line, buttons = []) {
    const p = document.createElement("p");
    p.textContent = line;
    const parts = [p];
    if (buttons.length) {
      const row = document.createElement("div");
      row.className = "mt-desktop-buttons";
      for (const [label, action, primary] of buttons) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        if (primary) button.className = "mt-desktop-go";
        // Blur first, so Space afterwards plays the song instead of pressing this again.
        button.addEventListener("click", () => { button.blur(); action(); });
        row.appendChild(button);
      }
      parts.push(row);
    }
    el.replaceChildren(...parts);
  }

  function notice(key, params) {
    const el = banner();
    fill(el, text(key, params), [[text("dismiss"), () => el.remove()]]);
  }

  // ── updates (main window) ──

  const DAY = 24 * 60 * 60 * 1000;
  let updateBanner = null;
  let downloading = null; // the version, while its bytes arrive

  async function checkForUpdate() {
    let found = null;
    try {
      found = await invoke("update_check");
    } catch (err) {
      console.info("desktop: no update check:", err); // offline is a normal state
    }
    if (found) offer(found);
    else setTimeout(checkForUpdate, DAY);
  }

  function offer(found) {
    updateBanner = banner();
    fill(updateBanner, text("available", found), [
      [text("download"), () => download(found), true],
      [text("later"), dismissUpdate],
    ]);
  }

  function dismissUpdate() {
    updateBanner?.remove();
    updateBanner = null;
  }

  async function download(found) {
    downloading = found.version;
    fill(updateBanner, text("downloading", { version: found.version, percent: "" }));
    try {
      await invoke("update_download");
    } catch (err) {
      fill(updateBanner, text("failed", { error: err }), [[text("dismiss"), dismissUpdate]]);
      return;
    } finally {
      downloading = null;
    }
    fill(updateBanner, text("ready", found), [
      [text("restart"), () => restartNow(found), true],
      [text("onQuit"), () => installOnQuit(found)],
    ]);
  }

  /** From updates.rs while the update downloads. Writes only on change. */
  function updateProgress(percent) {
    const line = updateBanner?.firstChild;
    if (!line || downloading === null) return;
    const next = text("downloading", { version: downloading, percent: `${percent}%` });
    if (line.textContent !== next) line.textContent = next;
  }

  async function restartNow(found) {
    if (pageWouldStay() && !confirm(text("restartDirty"))) return;
    try {
      await invoke("update_install", { restart: true }); // comes back only if it failed
    } catch (err) {
      fill(updateBanner, text("installFailed", { error: err }), [[text("dismiss"), dismissUpdate]]);
    }
  }

  async function installOnQuit(found) {
    await invoke("update_install", { restart: false });
    fill(updateBanner, text("deferred", found), [[text("dismiss"), dismissUpdate]]);
  }

  // ── online projects ──
  //
  // core/storage/online.js is the website's own client, unchanged: it fetches
  // /api/online on its own origin and signs in through a window it opens.
  // Here its origin is the app, so both are handed to desktop/src/online.rs,
  // which sends the requests to the server with the access token and signs in
  // through the system's browser. The answer comes back as the page expects
  // it — a Response, and "signed-in" on the channel the website's sign-in
  // window announces on (AUTH_CHANNEL in online.js).

  const ONLINE_API = /^\/api\/online(\/|$)/;
  const AUTH_CHANNEL = "microtone-online";
  const pageFetch = window.fetch.bind(window);

  window.fetch = function fetch(input, init = {}) {
    const request = input instanceof Request ? input : null;
    let url = null;
    try { url = new URL(request ? request.url : String(input), location.href); } catch { /* not ours */ }
    if (!url || url.origin !== location.origin || !ONLINE_API.test(url.pathname)) return pageFetch(input, init);
    return onlineFetch(url, request, init);
  };

  async function onlineFetch(url, request, init) {
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? request?.headers);
    let body = init.body ?? null;
    if (body === null && request && method !== "GET" && method !== "HEAD") body = await request.arrayBuffer();
    const bytes = new Uint8Array(body === null ? 0 : await new Response(body).arrayBuffer());
    let packet;
    try {
      packet = await window.__TAURI_INTERNALS__.invoke("online_request", bytes, {
        headers: {
          "x-mt-method": method,
          "x-mt-path": url.pathname + url.search,
          "x-mt-headers": JSON.stringify([...headers]),
        },
      });
    } catch (err) {
      throw new TypeError(`Failed to fetch (${err})`); // what a fetch() that never got an answer throws
    }
    // [u32 BE length][{status, headers}][body] — see online_request.
    const view = new DataView(packet);
    const length = view.getUint32(0);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(packet, 4, length)));
    const noBody = [101, 204, 205, 304].includes(meta.status);
    return new Response(noBody ? null : new Uint8Array(packet, 4 + length), { status: meta.status, headers: meta.headers });
  }

  const pageOpen = window.open.bind(window);
  let signInBanner = null;

  window.open = function open(url, ...rest) {
    let target = null;
    try { target = new URL(String(url), location.href); } catch { /* not ours */ }
    if (target?.origin === location.origin && /^\/api\/online\/auth\/(login|dev-login)$/.test(target.pathname)) {
      invoke("online_sign_in").catch((err) => onlineAuth("sign-in-failed", String(err)));
      signInBanner?.remove();
      signInBanner = banner();
      fill(signInBanner, text("signInBrowser"), [[text("dismiss"), () => signInBanner?.remove()]]);
      // online.js only asks whether a window opened.
      return { closed: false, close() {}, focus() {} };
    }
    return pageOpen(url, ...rest);
  };

  /** From online.rs when the browser's sign-in comes back (or does not). */
  function onlineAuth(type, error = "") {
    signInBanner?.remove();
    signInBanner = null;
    try {
      const channel = new BroadcastChannel(AUTH_CHANNEL);
      channel.postMessage({ type });
      channel.close();
    } catch { /* no BroadcastChannel: the File tab refreshes when next shown */ }
    if (type === "sign-in-failed") notice("signInFailed", { error });
  }

  // ── alert() and confirm() on macOS ──

  if (config.platform === "macos") {
    const ask = (kind, message) => {
      try {
        const request = new XMLHttpRequest();
        request.open("POST", `mtdialog://localhost/${kind}`, false); // synchronous, as the originals are
        request.send(message === undefined ? "" : String(message));
        return request.responseText === "1";
      } catch (err) {
        console.warn("desktop: no native dialog:", err);
        return false; // a confirm that cannot ask does not agree
      }
    };
    window.alert = function alert(message) { ask("alert", message); };
    window.confirm = function confirm(message) { return ask("confirm", message); };
  }

  // ── the projects, for the next desktop app ──
  //
  // The next Microtone (desktop-qt) keeps projects, soundfonts and keymaps as
  // files in ~/Microtone; this one keeps them in OPFS, which only this webview
  // can read. So this copies them across through the page's own OPFS API and
  // desktop/src/handover.rs, now and every minute while the app runs: what was
  // made or changed here since reaches the folder.
  //
  // A manifest (localStorage, one per destination folder — a trial with
  // MICROTONE_FILES_ROOT must not count for ~/Microtone) remembers what went
  // where, with the times on both sides: an unchanged file is not sent again, and a changed one
  // replaces its copy only if nothing else has touched that copy since —
  // otherwise it goes beside it as "name (from the old app)". Nothing is ever
  // deleted, here or there. The soundfonts' notes (index.json) are merged in.

  const HANDOVER_KEY = "microtone-handover";
  const HANDOVER_TOLD = "microtone-handover-told";
  const SOUNDFONT_INDEX = "index.json";
  let handingOver = false;

  /** A name every system can hold, made from one that maybe is not. */
  function portableName(name) {
    let n = name.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = "_" + n;
    return n || "_";
  }

  /** "Album/song.taud" → "Album/song (from the old app).taud". */
  function besideName(path) {
    const at = path.lastIndexOf("/");
    const folder = at < 0 ? "" : path.slice(0, at + 1);
    const name = path.slice(at + 1);
    const dot = name.indexOf(".", 1);
    return dot < 0 ? `${folder}${name} (from the old app)` : `${folder}${name.slice(0, dot)} (from the old app)${name.slice(dot)}`;
  }

  async function* walkOpfs(dir, prefix, deep) {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        if (!deep) continue;
        yield { path, folder: true };
        yield* walkOpfs(handle, path, deep);
      } else {
        yield { path, handle };
      }
    }
  }

  function put(store, path, bytes, replace) {
    return invoke("handover_write", bytes, {
      headers: {
        "x-mt-store": store,
        "x-mt-path": path.split("/").map(encodeURIComponent).join("/"),
        "x-mt-replace": replace,
      },
    });
  }

  async function handover() {
    if (handingOver) return null;
    handingOver = true;
    const counts = { written: 0, replaced: 0, beside: 0 };
    try {
      let root;
      try { root = await navigator.storage.getDirectory(); } catch { return null; }
      const info = await invoke("handover_info");
      const manifestKey = `${HANDOVER_KEY}:${info.root}`;
      const toldKey = `${HANDOVER_TOLD}:${info.root}`;
      let manifest = {};
      try { manifest = JSON.parse(localStorage.getItem(manifestKey) || "{}"); } catch { /* start afresh */ }
      const keep = () => { try { localStorage.setItem(manifestKey, JSON.stringify(manifest)); } catch { /* next time */ } };
      const portablePath = (path) => path.split("/").map(portableName).join("/");

      for (const store of ["projects", "soundfonts", "keymaps"]) {
        let dir;
        try { dir = await root.getDirectoryHandle(store); } catch { continue; }
        for await (const entry of walkOpfs(dir, "", store === "projects")) {
          if (entry.folder) {
            await invoke("handover_folder", { store, path: portablePath(entry.path) });
            continue;
          }
          if (store === "soundfonts" && entry.path === SOUNDFONT_INDEX) continue;  // merged below
          const key = `${store}/${entry.path}`;
          const file = await entry.handle.getFile();
          const was = manifest[key];
          if (was && was.src === file.lastModified) continue;  // copied, and unchanged since
          const bytes = new Uint8Array(await file.arrayBuffer());
          let to = was?.to ?? portablePath(entry.path);
          let done = await put(store, to, bytes, was ? String(was.dst) : "");
          if (!done.written && !done.same) {
            // Someone else's file there, or ours changed since: beside the
            // original name (never beside a copy beside it).
            to = besideName(portablePath(entry.path));
            done = await put(store, to, bytes, "");
            if (!done.written && !done.same) continue;  // that too: leave it be
            if (done.written) counts.beside++;
          } else if (done.written) {
            if (was) counts.replaced++;
            else counts.written++;
          }
          manifest[key] = { src: file.lastModified, dst: done.mtime, to };
          keep();
        }
      }

      // The soundfonts' notes, keyed by file name: merged into the folder's
      // index (what is already there wins), when this side's changed.
      try {
        const sfDir = await root.getDirectoryHandle("soundfonts");
        const file = await (await sfDir.getFileHandle(SOUNDFONT_INDEX)).getFile();
        const key = `soundfonts/${SOUNDFONT_INDEX}`;
        if (manifest[key]?.src !== file.lastModified) {
          const ours = JSON.parse(await file.text());
          let theirs = {};
          try {
            theirs = JSON.parse(new TextDecoder().decode(new Uint8Array(await invoke("handover_read", { store: "soundfonts", path: SOUNDFONT_INDEX }))));
          } catch { /* none yet */ }
          const merged = { ...theirs };
          for (const [name, value] of Object.entries(ours)) {
            const to = manifest[`soundfonts/${name}`]?.to ?? portableName(name);
            if (!(to in merged)) merged[to] = value;
          }
          const done = await put("soundfonts", SOUNDFONT_INDEX, new TextEncoder().encode(JSON.stringify(merged, null, 1)), "*");
          manifest[key] = { src: file.lastModified, dst: done.mtime, to: SOUNDFONT_INDEX };
          keep();
        }
      } catch { /* no soundfonts, or no index */ }

      config.handover = counts;  // what the last pass did (for whoever looks)
      if (counts.written + counts.replaced + counts.beside > 0) {
        let told = false;
        try { told = !!localStorage.getItem(toldKey); } catch { /* tell */ }
        if (!told) {
          notice("handedOver", { folder: info.root });
          try { localStorage.setItem(toldKey, "1"); } catch { /* once more next time */ }
        }
      }
      return counts;
    } catch (err) {
      console.warn("desktop: copying the projects to the next app:", err);
      return null;
    } finally {
      handingOver = false;
    }
  }

  window.__microtoneDesktop = { requestClose, notice, updateProgress, onlineAuth, handover };

  if (config.window === "main") {
    const start = () => {
      setTimeout(checkForUpdate, 3000);
      setTimeout(handover, 5000);
      setInterval(handover, 60000);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  }
})();
