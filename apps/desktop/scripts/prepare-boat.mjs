// Puts the Boat CLI where Tauri expects the `boat` externalBin: src-tauri/binaries/boat-<target-triple>.
//
//   node scripts/prepare-boat.mjs [--target aarch64-apple-darwin|x86_64-apple-darwin|universal-apple-darwin] [--release]
//
// The app bundles `boat` so it can connect Boat with the owner's Boat login even when the CLI is not installed (the server prefers
// one on PATH: apps/server/src/lib/boatCli.ts, docs/boat.md). It is downloaded from Boat's own installer endpoint and checked against
// the SHA-256 list Boat publishes next to it, as `curl -fsSL https://boat.dev/install | sh` does. Run by prepare-sidecar.mjs.
// A development build reuses a copy already there; --release always downloads the current one. The server runs it with
// BOAT_NO_UPDATE=1, so the signed copy inside the app is never rewritten.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binaries = resolve(here, "..", "src-tauri", "binaries");
const DOWNLOAD = "https://boat.dev/api/boat/cli/download";
const PLATFORMS = { "aarch64-apple-darwin": "darwin-arm64", "x86_64-apple-darwin": "darwin-x64" };

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const host = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const target = option("--target") ?? process.env.TAURI_TARGET_TRIPLE ?? host;
const release = args.includes("--release");
const out = (triple) => join(binaries, `boat-${triple}`);

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function download(triple) {
  const platform = PLATFORMS[triple];
  if (!platform) throw new Error(`no Boat CLI for ${triple}`);
  const url = `${DOWNLOAD}?platform=${platform}&channel=prod`;
  const sums = await (await fetchOk(`${url}&integrity=sha256`)).text();
  const expected = sums
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === `boat-${platform}` || name === `*boat-${platform}`)?.[0]
    ?.toLowerCase();
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`no SHA-256 for boat-${platform} in Boat's list`);
  const body = Buffer.from(await (await fetchOk(url)).arrayBuffer());
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== expected) throw new Error(`boat-${platform}: SHA-256 mismatch`);
  const tmp = `${out(triple)}.download`;
  writeFileSync(tmp, body, { mode: 0o755 });
  renameSync(tmp, out(triple));
  console.log(`prepare-boat: ${out(triple)} (${(body.length / 1e6).toFixed(1)} MB)`);
}

async function obtain(triple) {
  if (!release && existsSync(out(triple))) return;
  await download(triple);
}

mkdirSync(binaries, { recursive: true });
if (target === "universal-apple-darwin") {
  const triples = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  for (const t of triples) await obtain(t);
  rmSync(out(target), { force: true });
  execFileSync("lipo", ["-create", "-output", out(target), ...triples.map(out)], { stdio: "inherit" });
} else {
  await obtain(target);
}
chmodSync(out(target), 0o755);
