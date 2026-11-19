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
//   stable   the latest release's desktop.json — from the switch from the
//            Tauri build on (until then no release has one, and copies hear
//            "nothing new")
//   preview  the desktop-preview pre-release's, published by hand
//            (.github/workflows/desktop-qt.yml) for testing before then

const RELEASES = "https://github.com/Microtone-Project/Microtone.js/releases";

export const CHANNELS = Object.freeze({
  stable: `${RELEASES}/latest/download/desktop.json`,
  preview: `${RELEASES}/download/desktop-preview/desktop.json`,
});

export const UPDATE_PATH = "/api/desktop/update";

export function desktopUpdate(request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" } });
  }
  const channel = new URL(request.url).searchParams.get("channel") || "stable";
  const to = Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel] : null;
  if (!to) return new Response("No such channel", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
}
