#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version (default: the current one), for the GitHub release body and the
// updater's notes: `node scripts/release-notes.mjs [version]`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] ?? JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).version;
const lines = readFileSync(join(desktop, "CHANGELOG.md"), "utf8").split("\n");
const start = lines.findIndex((line) => line.trim() === `## ${version}`);
if (start === -1) {
  console.error(`release-notes: no "## ${version}" in CHANGELOG.md`);
  process.exit(1);
}
const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
console.log(
  lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim(),
);
