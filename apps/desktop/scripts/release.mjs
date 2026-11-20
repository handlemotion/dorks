#!/usr/bin/env node
// Cuts a desktop release: `pnpm --filter @dorks/desktop release 0.0.2 [--push]`.
//
// Sets the version in src-tauri/tauri.conf.json (the one the app and the updater compare), Cargo.toml and Cargo.lock, commits
// "Desktop <version>" and tags it `desktop-v<version>`. With --push it pushes the commit and the tag, which starts
// .github/workflows/desktop-release.yml: a signed, notarized build in a DRAFT release. Publishing that draft is what ships it:
// installed apps read latest.json from the latest published release (docs/desktop.md, "Updates").
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--"));
const push = args.includes("--push");

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail("usage: release <major.minor.patch> [--push]");

const confPath = join(root, "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split("-")[0].split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
if (!newer(version, conf.version)) fail(`${version} is not newer than the current ${conf.version}; the updater only offers newer versions`);
if (git("status", "--porcelain")) fail("the working tree has changes; commit or set them aside first");
const tag = `desktop-v${version}`;
if (git("tag", "--list", tag)) fail(`tag ${tag} already exists`);

conf.version = version;
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);

const cargoPath = join(root, "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
writeFileSync(cargoPath, cargo.replace(/^(name = "dorks-desktop"\nversion = )"[^"]*"/m, `$1"${version}"`));

const lockPath = join(root, "Cargo.lock");
const lock = readFileSync(lockPath, "utf8");
writeFileSync(lockPath, lock.replace(/^(name = "dorks-desktop"\nversion = )"[^"]*"/m, `$1"${version}"`));

git("add", confPath, cargoPath, lockPath);
git("commit", "-m", `Desktop ${version}`);
git("tag", "-a", tag, "-m", `Dorks ${version}`);
console.log(`Committed "Desktop ${version}" and tagged ${tag}.`);

if (push) {
  git("push", "origin", "HEAD");
  git("push", "origin", tag);
  console.log(`Pushed. The Desktop release workflow drafts the release; publish the draft to ship it to installed apps.`);
} else {
  console.log(`Push to build it:\n  git push origin HEAD && git push origin ${tag}`);
}
