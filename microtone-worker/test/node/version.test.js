// The About popup shows package.json's version — the one the desktop app takes
// as its own and its updater compares against — by reading the file where it
// is served, beside the pages. These keep that possible: the file ships, the
// popup's path to it is right, and the line exists in every language.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compilePattern, readPatterns } from "../../../tools/stage-site.js";
import en from "../../src/ui/lang/en.js";
import ko from "../../src/ui/lang/ko.js";

const SITE = new URL("../../", import.meta.url);
const ABOUT = new URL("src/ui/popups/about.js", SITE);

test("version: package.json ships with the site, for About to read", () => {
  const ignored = readPatterns(fileURLToPath(new URL(".assetsignore", SITE))).map(compilePattern);
  assert.ok(!ignored.some((matches) => matches("package.json")), ".assetsignore must not drop package.json");
  const { version } = JSON.parse(readFileSync(new URL("package.json", SITE), "utf8"));
  assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/, "a SemVer 2.0.0 version");
});

test("version: About's path to package.json finds it", () => {
  const path = readFileSync(ABOUT, "utf8").match(/new URL\("([^"]*package\.json)", import\.meta\.url\)/)?.[1];
  assert.ok(path, "about.js reads package.json relative to itself");
  assert.ok(existsSync(new URL(path, ABOUT)), `${path} from about.js`);
});

test("version: About says it in every language", () => {
  for (const [name, lang] of [["en", en], ["ko", ko]]) {
    assert.ok(lang["about.version"]?.includes("{version}"), `${name} has about.version with {version}`);
  }
});
