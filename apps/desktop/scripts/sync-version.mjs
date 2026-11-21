#!/usr/bin/env node
// Copies the version Changesets wrote to apps/desktop/package.json into the files the app is built from:
// src-tauri/tauri.conf.json (the version the app reports and the updater compares), Cargo.toml and Cargo.lock.
// Run by `pnpm release:version` (the release workflow's version step), right after `changeset version`.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = join(desktop, "src-tauri");
const { version } = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));

// Each file's version line is replaced in place, so the rest keeps its formatting (`pnpm check` passes on the release PR).
const files = {
  "tauri.conf.json": /^(  "version": )"[^"]*"/m,
  "Cargo.toml": /^(name = "dorks-desktop"\nversion = )"[^"]*"/m,
  "Cargo.lock": /^(name = "dorks-desktop"\nversion = )"[^"]*"/m,
};
for (const [file, pattern] of Object.entries(files)) {
  const path = join(tauri, file);
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) {
    console.error(`sync-version: no version line in ${file}`);
    process.exit(1);
  }
  writeFileSync(path, text.replace(pattern, `$1"${version}"`));
}
console.log(`sync-version: Dorks ${version}`);
