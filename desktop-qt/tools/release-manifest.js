#!/usr/bin/env node
// The update manifest of a release (.github/workflows/desktop-qt.yml):
//
//   node desktop-qt/tools/release-manifest.js <dist> <version> <tag> [notes]
//
// reads the signed updates in <dist> (Microtone-<version>-… and their .sig)
// and writes <dist>/desktop.json: the Tauri updater's latest.json shape
// (desktop-qt/src/updater.h), each platform's file under the GitHub release
// <tag>, and `page` (ours alone), where a copy that does not update itself
// sends people. The keys are the ones the Tauri updater looks for too, so the
// Tauri build's copies install from the same manifest.
//
// Node only, no dependencies (the repository's rule).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dist, version, tag, notes = `Microtone ${version}.`] = process.argv.slice(2);
if (!dist || !version || !tag) {
  console.error("usage: release-manifest.js <dist> <version> <tag> [notes]");
  process.exit(2);
}

const repo = process.env.GITHUB_REPOSITORY || "Microtone-Project/Microtone.js";
const releases = `https://github.com/${repo}/releases`;
const entry = (file) => ({
  url: `${releases}/download/${tag}/${file}`,
  signature: readFileSync(join(dist, `${file}.sig`), "utf8").trim(),
});

const win = entry(`Microtone-${version}-windows-x64-setup.exe`);
const mac = entry(`Microtone-${version}-macos.app.tar.gz`);
const appimage = entry(`Microtone-${version}-linux-x86_64.AppImage`);

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  page: `${releases}/tag/${tag}`,
  platforms: {
    "windows-x86_64": win,
    "windows-x86_64-nsis": win,
    "darwin-universal": mac,
    "darwin-aarch64": mac,
    "darwin-x86_64": mac,
    "linux-x86_64": appimage,
    "linux-x86_64-appimage": appimage,
    "linux-x86_64-deb": entry(`Microtone-${version}-linux-amd64.deb`),
    "linux-x86_64-rpm": entry(`Microtone-${version}-linux-x86_64.rpm`),
  },
};
writeFileSync(join(dist, "desktop.json"), JSON.stringify(manifest, null, 1));
console.log(`desktop.json: ${version}, ${Object.keys(manifest.platforms).length} platforms, ${manifest.page}`);
