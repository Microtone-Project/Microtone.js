#!/usr/bin/env node
// The desktop app's updater end to end (src/updater.h): a local "release"
// (manifest + update, signed with a key of the test's own), the app told to
// look there and to trust that key, and the page's banner clicked through:
// offered → Download → progress → Restart now → the app quits and the update
// takes over.
//
//   node desktop-qt/tools/update-test.js <microtone executable> [--mode run|mac|windows|appimage|deb|notice] [--port 9344]
//
//   run      (any system; the default off macOS and Windows) the app in its
//            test mode: the "update" is a script, run at quit as the Windows
//            installer is; checked: it ran, with /P /R. Then a forged update
//            (signed by another key) is refused, and nothing runs.
//   mac      the executable inside a Microtone.app: a copy of the bundle in a
//            folder of the test's is the installed app, and the update is that
//            bundle again, marked; checked: the marked bundle took its place,
//            the old one went, and it was started again.
//   windows  the executable is the installed app (the installer put it where
//            its InstallLocation says): the update is the installer given as
//            --installer <exe>; checked: the app quit, the installer ran and
//            started the app again.
//   appimage the "executable" is an AppImage: a copy in a folder of the
//            test's is the installed app, and the update is the AppImage
//            again, marked (bytes after its file system, which nothing
//            reads); checked: the marked file took the copy's name, nothing
//            was left beside it, and it was started again.
//   deb      the executable is /opt/microtone/bin/microtone, installed from
//            the .deb given as --package <deb>; the update is that package
//            again as version 99.0.0 with a marker file, installed at quit
//            through `sudo -n` (MICROTONE_UPDATE_TEST=sudo) where a person's
//            copy asks pkexec; checked: dpkg has 99.0.0, the marker is there,
//            and the app was started again. Needs passwordless sudo (CI).
//   notice   the executable is a copy that does not update itself (a build,
//            a portable folder): it is told, with the manifest's page, and
//            nothing downloads; on Linux "Get it" is pressed, and the page
//            reaches the system's browser — a stand-in `xdg-open` first on
//            PATH, the desktop's own ways (KDE's, GNOME's) switched off, so
//            no real browser opens.
//
// Exit 0: all checks passed.
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const exe = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
if (!exe) {
  console.error("usage: node update-test.js <microtone executable> [--mode run|mac|windows|appimage|deb|notice] [--installer <exe>] [--package <deb>] [--port P]");
  process.exit(2);
}
const mode = opt("mode", process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "run");
const debugPort = Number(opt("port", "9344"));
const work = mkdtempSync(join(tmpdir(), "microtone-update-"));
const out = { mode, work, checks: {} };
const check = (name, ok, detail) => { out.checks[name] = ok ? "ok" : `FAIL ${JSON.stringify(detail)}`; };

// ── minisign, as Tauri's signer writes it: "ED" = Ed25519 over BLAKE2b-512 ──
function minisignKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pk = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const id = randomBytes(8);
  const keyFile = `untrusted comment: minisign public key: test\n${Buffer.concat([Buffer.from("Ed"), id, pk]).toString("base64")}\n`;
  return {
    pub: Buffer.from(keyFile).toString("base64"),  // Tauri's form
    sign(bytes, name) {
      const hash = createHash("blake2b512").update(bytes).digest();
      const sig = sign(null, hash, privateKey);
      const trusted = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${name}`;
      const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
      const file = `untrusted comment: signature from the update test\n${Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64")}\n` +
        `trusted comment: ${trusted}\n${global.toString("base64")}\n`;
      return Buffer.from(file).toString("base64");  // Tauri's form, as latest.json carries it
    },
  };
}

// ── the "release": a manifest and one file, over HTTP ──
const files = new Map();
const server = createServer((req, res) => {
  const body = files.get(req.url.split("?")[0]);
  if (!body) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-length": body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const PAGE = "https://example.invalid/microtone/releases/99.0.0";
function release(key, platform, bytes, name, signer = key) {
  files.set(`/${name}`, bytes);
  files.set("/desktop.json", Buffer.from(JSON.stringify({
    version: "99.0.0", notes: "the update test", pub_date: new Date().toISOString(), page: PAGE,
    platforms: { [platform]: { url: `${base}/${name}`, signature: signer.sign(bytes, name) } },
  })));
}

/** Linux: the processes whose environment has `name=value`. */
function processesWith(name, value) {
  const found = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`${name}=${value}`)) found.push(Number(pid));
    } catch { /* gone, or not ours */ }
  }
  return found;
}
const USER = "mt-update-test";

// ── the app and its page ──
let app = null;
async function launch(executable, env) {
  const full = { ...process.env, USER, USERNAME: USER, QTWEBENGINE_REMOTE_DEBUGGING: String(debugPort),
    QT_FORCE_STDERR_LOGGING: "1", MICROTONE_UPDATE_URL: `${base}/desktop.json`, MICROTONE_FILES_ROOT: join(work, "Microtone"),
    XDG_DATA_HOME: join(work, "data"), XDG_CONFIG_HOME: join(work, "config"), XDG_CACHE_HOME: join(work, "cache"),
    MICROTONE_OLDAPP_DIR: "none", ...env };
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];  // undefined: unset
  app = spawn(executable, ["--web-audio"], { env: full, stdio: ["ignore", "ignore", "pipe"] });
  app.exited = new Promise((r) => app.on("exit", (code, signal) => r({ code, signal })));
  app.stderr.on("data", (d) => { for (const l of String(d).split("\n")) if (/^updates:/.test(l.trim())) (out.log ??= []).push(l.trim()); });
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    await sleep(500);
    try {
      target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === "page" && t.url.includes("microtone.localhost"));
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error("the app's page never came up");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); waiting.delete(m.id); };
  ws.onclose = () => { for (const r of waiting.values()) r({}); };
  const evaluate = (expression) => new Promise((r) => {
    waiting.set(++id, (m) => r(m.result?.result?.value));
    try { ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); } catch { r(undefined); }
  });
  return { evaluate, close: () => ws.close() };
}
const bannerText = `[...document.querySelectorAll(".banner p")].map((p) => p.textContent).join(" | ")`;
async function waitFor(page, test, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    const text = await page.evaluate(bannerText);
    if (test(text ?? "")) return text;
    await sleep(250);
  }
  return page.evaluate(bannerText);
}
const press = (page, label) => page.evaluate(`(() => { const b = [...document.querySelectorAll(".banner button")].find((b) => b.textContent === ${JSON.stringify(label)}); b?.click(); return !!b; })()`);

/** Offered, downloaded with progress, restarted: → whether the app quit. */
async function cycle(page) {
  const offered = await waitFor(page, (t) => /Microtone 99\.0\.0 is out/.test(t));
  check("offered a few seconds after start", /Microtone 99\.0\.0 is out — you are running \d+\.\d+\.\d+/.test(offered), offered);
  const status = await page.evaluate(`fetch(window.__MICROTONE_NATIVE__.updates.api).then((r) => r.json())`);
  check("nothing downloaded until asked", status?.state === "available", status);
  await press(page, "Download");
  const ready = await waitFor(page, (t) => /is downloaded|could not/.test(t), 120);
  check("downloaded, and its signature good", /Microtone 99\.0\.0 is downloaded/.test(ready), ready);
  if (!/is downloaded/.test(ready)) return false;
  await press(page, "Restart now");
  const exit = await Promise.race([app.exited, sleep(30000).then(() => null)]);
  check("Restart now quits the app", exit !== null, exit);
  return exit !== null;
}

const key = minisignKey();
const stranger = minisignKey();
try {
  if (mode === "run") {
    // The "installer": a script that says how it was run.
    const marker = join(work, "ran.txt");
    const script = process.platform === "win32"
      ? Buffer.from(`@echo %* > "${marker}"\r\n`)
      : Buffer.from(`#!/bin/sh\necho "$@" > "${marker}"\n`);
    release(key, process.platform === "win32" ? "windows-x86_64" : process.platform === "darwin" ? "darwin-universal" : "linux-x86_64", script, "update");
    let page = await launch(exe, { MICROTONE_UPDATE_TEST: "run", MICROTONE_UPDATE_KEY: key.pub });
    if (await cycle(page)) {
      for (let i = 0; i < 40 && !existsSync(marker); i++) await sleep(250);
      const ran = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
      check("the update ran at quit, as an installer is (/P /R)", ran === "/P /R", ran);
    }
    page.close();

    // Signed by someone else: refused, and nothing runs.
    const forgedMarker = join(work, "forged.txt");
    release(key, process.platform === "darwin" ? "darwin-universal" : "linux-x86_64",
      Buffer.from(`#!/bin/sh\necho ran > "${forgedMarker}"\n`), "update", stranger);
    page = await launch(exe, { MICROTONE_UPDATE_TEST: "run", MICROTONE_UPDATE_KEY: key.pub });
    await waitFor(page, (t) => /is out/.test(t));
    await press(page, "Download");
    const refused = await waitFor(page, (t) => /could not|is downloaded/.test(t), 60);
    check("an update signed by another key is refused", /not signed by Microtone \(signed with another key\)/.test(refused), refused);
    page.close();
    app.kill("SIGTERM");
    await app.exited;
    check("…and never runs", !existsSync(forgedMarker));
  } else if (mode === "mac") {
    // The installed app: a copy of the bundle the executable is in.
    const bundle = resolve(dirname(exe), "../..");
    const apps = join(work, "Applications");
    mkdirSync(apps);
    const installed = join(apps, basename(bundle));
    cpSync(bundle, installed, { recursive: true, verbatimSymlinks: true });
    // The update: the same bundle, marked, as tauri's .app.tar.gz is made.
    const marked = join(work, "update", basename(bundle));
    mkdirSync(dirname(marked));
    cpSync(bundle, marked, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(marked, "Contents/Resources/update-test-marker"), "the new version");
    spawnSync("codesign", ["--force", "--deep", "--sign", "-", marked]);  // sealed again, as a release's is
    const tarball = join(work, "Microtone.app.tar.gz");
    spawnSync("tar", ["-czf", tarball, "-C", dirname(marked), basename(marked)]);
    release(key, "darwin-universal", readFileSync(tarball), "Microtone.app.tar.gz");
    const page = await launch(join(installed, "Contents/MacOS", basename(exe)), { MICROTONE_UPDATE_KEY: key.pub });
    if (await cycle(page)) {
      let relaunched = false;
      for (let i = 0; i < 80 && !relaunched; i++) {
        await sleep(250);
        relaunched = spawnSync("pgrep", ["-f", join(installed, "Contents/MacOS")]).status === 0;
      }
      check("the new bundle took the old one's place", existsSync(join(installed, "Contents/Resources/update-test-marker")));
      check("the old bundle is gone", !spawnSync("ls", [apps]).stdout.toString().includes(".old-"), spawnSync("ls", [apps]).stdout.toString());
      check("and the app started again", relaunched);
      spawnSync("pkill", ["-f", join(installed, "Contents/MacOS")]);
    }
    page.close();
  } else if (mode === "appimage") {
    // The installed app: a copy of the AppImage in a folder of the test's.
    const apps = join(work, "Applications");
    mkdirSync(apps);
    const installed = join(apps, "Microtone.AppImage");
    cpSync(exe, installed);
    chmodSync(installed, 0o755);
    const marker = Buffer.from("\nupdate-test-marker: the new version\n");
    release(key, "linux-x86_64-appimage", Buffer.concat([readFileSync(exe), marker]), "Microtone.AppImage");
    // Unpacked and run where there is no FUSE (CI); the runtime still says
    // which file it is (APPIMAGE), which is what the updater replaces.
    const page = await launch(installed, { MICROTONE_UPDATE_KEY: key.pub });
    if (await cycle(page)) {
      let relaunched = [];
      for (let i = 0; i < 120 && relaunched.length === 0; i++) {
        await sleep(250);
        relaunched = processesWith("APPIMAGE", installed);
      }
      const now = readFileSync(installed);
      check("the marked AppImage took the copy's name", now.subarray(-marker.length).equals(marker));
      check("…executable", (statSync(installed).mode & 0o111) !== 0);
      check("nothing left beside it", readdirSync(apps).length === 1, readdirSync(apps));
      check("and the app started again", relaunched.length > 0);
      for (const pid of relaunched) try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
    }
    page.close();
  } else if (mode === "deb") {
    const pkg = opt("package", null);
    if (!pkg) throw new Error("--package <deb> is needed in deb mode");
    // The update: the same package as 99.0.0, with a marker inside.
    const tree = join(work, "deb");
    const run = (cmd, a) => {
      const r = spawnSync(cmd, a, { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`${cmd} ${a.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    run("dpkg-deb", ["-R", pkg, tree]);
    const control = join(tree, "DEBIAN/control");
    writeFileSync(control, readFileSync(control, "utf8").replace(/^Version: .*$/m, "Version: 99.0.0"));
    writeFileSync(join(tree, "opt/microtone/share/microtone/update-test-marker"), "the new version\n");
    const update = join(work, "microtone-99.0.0.deb");
    run("dpkg-deb", ["--root-owner-group", "-b", tree, update]);
    release(key, "linux-x86_64-deb", readFileSync(update), "Microtone-99.0.0.deb");
    const page = await launch(exe, { MICROTONE_UPDATE_KEY: key.pub, MICROTONE_UPDATE_TEST: "sudo" });
    if (await cycle(page)) {
      let installed = "", relaunched = false;
      for (let i = 0; i < 240 && !(installed === "99.0.0" && relaunched); i++) {
        await sleep(500);
        installed = spawnSync("dpkg-query", ["-W", "-f=${Version}", "microtone"], { encoding: "utf8" }).stdout.trim();
        relaunched = processesWith("USER", USER).some((p) => {
          try { return readFileSync(`/proc/${p}/cmdline`, "latin1").startsWith(exe); } catch { return false; }
        });
      }
      check("dpkg installed 99.0.0 once the app had quit", installed === "99.0.0", installed);
      check("the new package's files are in place", existsSync("/opt/microtone/share/microtone/update-test-marker"));
      check("and the app started again", relaunched);
      spawnSync("pkill", ["-x", "microtone"]);
    }
    page.close();
  } else if (mode === "notice") {
    // The system's browser, as Qt finds it where the desktop has no way of
    // its own: xdg-open, first on PATH — here a script that writes down what
    // it was given. The desktop's own ways (a KDE or GNOME platform theme)
    // are switched off by leaving out the variables that name the desktop.
    const opened = join(work, "opened.txt");
    const bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\necho "$1" > "${opened}"\n`);
    chmodSync(join(bin, "xdg-open"), 0o755);
    const noDesktop = Object.fromEntries(["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "DESKTOP_SESSION", "KDE_FULL_SESSION",
      "KDE_SESSION_VERSION", "GNOME_DESKTOP_SESSION_ID", "QT_QPA_PLATFORMTHEME", "BROWSER", "DEFAULT_BROWSER"].map((k) => [k, undefined]));
    const platform = process.platform === "win32" ? "windows-x86_64" : process.platform === "darwin" ? "darwin-universal" : "linux-x86_64-appimage";
    release(key, platform, Buffer.from("not to be downloaded"), "update");
    const linux = process.platform === "linux";
    const page = await launch(exe, { MICROTONE_UPDATE_KEY: key.pub,
      ...(linux ? { PATH: `${bin}${delimiter}${process.env.PATH}`, ...noDesktop } : {}) });
    const told = await waitFor(page, (t) => /is out/.test(t));
    check("told that 99.0.0 is out, and that this copy does not update itself",
      /Microtone 99\.0\.0 is out .*This copy does not update itself/.test(told), told);
    const status = await page.evaluate(`fetch(window.__MICROTONE_NATIVE__.updates.api).then((r) => r.json())`);
    check("the copy says so, with the release's page", status?.updatable === false && status?.page === PAGE, status);
    const refused = await page.evaluate(`fetch(window.__MICROTONE_NATIVE__.updates.api + "?download", { method: "POST" }).then((r) => r.json())`);
    check("a download is refused", refused?.state === "available", refused);
    if (linux) {
      await press(page, "Get it");
      for (let i = 0; i < 40 && !existsSync(opened); i++) await sleep(250);
      const url = existsSync(opened) ? readFileSync(opened, "utf8").trim() : null;
      check("Get it opens the page in the system's browser", url === PAGE, url);
    }
    page.close();
    app.kill("SIGTERM");
    await app.exited;
  } else if (mode === "windows") {
    const installer = opt("installer", null);
    if (!installer) throw new Error("--installer <setup.exe> is needed in windows mode");
    release(key, "windows-x86_64", readFileSync(installer), basename(installer));
    const page = await launch(exe, { MICROTONE_UPDATE_KEY: key.pub });
    if (await cycle(page)) {
      // The installer waits for the app to be gone, installs, and starts it.
      let relaunched = false;
      for (let i = 0; i < 240 && !relaunched; i++) {
        await sleep(500);
        const list = spawnSync("tasklist", ["/FI", "IMAGENAME eq microtone.exe", "/NH"]).stdout.toString();
        relaunched = /microtone\.exe/i.test(list);
      }
      check("the installer ran and started the app again", relaunched);
      spawnSync("taskkill", ["/F", "/IM", "microtone.exe"]);
    }
    page.close();
  }
} catch (err) {
  out.error = String(err?.stack ?? err);
  app?.kill("SIGKILL");
}
server.close();
console.log(JSON.stringify(out, null, 1));
process.exit(!out.error && Object.values(out.checks).length && Object.values(out.checks).every((v) => v === "ok") ? 0 : 1);
