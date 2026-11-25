// Where an installed desktop app looks for updates (desktop-qt/src/updater.cpp):
//
//   GET /api/desktop/update?channel=stable|preview[&version=…&platform=…]
//     → 302 to that channel's update manifest (the Tauri updater's latest.json
//       shape: version, notes, pub_date, platforms → url + signature)
//
// An address on this site rather than GitHub's, compiled into every copy, so
// the releases can move without stranding a copy anyone has installed: change
// CHANNELS here instead. `version` and `platform` are the asking copy's,
// ignored for now (one manifest serves every platform), and there so a later
// server can answer per copy.
//
//   stable   the latest release's desktop.json (5.1.0 on; the releases of
//            .github/workflows/desktop-qt.yml)
//   preview  the desktop-preview pre-release's, published by hand
//            (the same workflow) for testers
//
// The Tauri build asks here too from 5.0.6 on, with `from=tauri`
// (its tauri.conf.json; the Tauri build's source left the tree with 5.1.0,
// and test/node/desktop-update-tauri.test.js keeps the address): its move to the new app is the new app's
// manifest, installed by Tauri's own updater (the same key signs both). On the
// stable channel that waits for TAURI_MOVES — until then a Tauri copy hears
// 204, Tauri's "nothing new" — so the switch is thrown HERE, whenever the new
// app has been checked, independently of when it was released. The preview
// channel moves a Tauri copy at once: that is how the move is tried. Tauri
// copies up to 5.0.5 ask GitHub's latest release for latest.json instead, and
// every release from the switch on carries one that brings them to 5.0.6.

const RELEASES = "https://github.com/Microtone-Project/Microtone.js/releases";

export const CHANNELS = Object.freeze({
  stable: `${RELEASES}/latest/download/desktop.json`,
  preview: `${RELEASES}/download/desktop-preview/desktop.json`,
});

export const UPDATE_PATH = "/api/desktop/update";

/** Whether Tauri copies (5.0.6 on) are offered the new app on the stable
 *  channel. Thrown 2026-11-26, once 5.1.0 had been released and the move tried
 *  on Windows and macOS. */
export const TAURI_MOVES = true;

export function desktopUpdate(request, { tauriMoves = TAURI_MOVES } = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" } });
  }
  const params = new URL(request.url).searchParams;
  const channel = params.get("channel") || "stable";
  const to = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel] : null;
  if (!to) return new Response("No such channel", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (params.get("from") === "tauri" && channel === "stable" && !tauriMoves) {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
}
