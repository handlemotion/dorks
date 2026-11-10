// Puts the `dorks-server` sidecar where Tauri expects it: src-tauri/binaries/dorks-server-<target-triple>.
//
//   node scripts/prepare-sidecar.mjs [--target aarch64-apple-darwin|x86_64-apple-darwin|universal-apple-darwin] [--release] [--require-server]
//
// The real server (apps/server: Bun, Hono, SQLite) is looked up as dorks-server-<triple> in $DORKS_SERVER_DIST (default
// apps/server/dist). Until it exists, the stub from crates/shell-core is built instead, so the shell can be built and run now.
// --require-server (used by the release workflow) fails instead of falling back to the stub. `universal-apple-darwin`
// builds both architectures and joins them with lipo.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, chmodSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const tauri = join(desktop, "src-tauri");
const binaries = join(tauri, "binaries");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const host = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const target = option("--target") ?? process.env.TAURI_TARGET_TRIPLE ?? host;
const release = flag("--release");
const requireServer = flag("--require-server");
const serverDist = resolve(process.env.DORKS_SERVER_DIST ?? join(desktop, "..", "server", "dist"));

function obtain(triple) {
  const real = join(serverDist, `dorks-server-${triple}`);
  if (existsSync(real)) return { path: real, kind: "server" };
  if (requireServer) {
    console.error(`prepare-sidecar: ${real} not found and --require-server is set`);
    process.exit(1);
  }
  console.log(`prepare-sidecar: no real server for ${triple} in ${serverDist}; building the stub`);
  execFileSync("cargo", ["build", "-p", "dorks-shell-core", "--bin", "dorks-server-stub", "--target", triple, ...(release ? ["--release"] : [])], {
    cwd: tauri,
    stdio: "inherit",
  });
  return { path: join(tauri, "target", triple, release ? "release" : "debug", "dorks-server-stub"), kind: "stub" };
}

mkdirSync(binaries, { recursive: true });
const out = (triple) => join(binaries, `dorks-server-${triple}`);

if (target === "universal-apple-darwin") {
  // Tauri's build script checks each architecture's own file, and the bundler wants the joined one: provide all three.
  const triples = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  const parts = triples.map((t) => obtain(t));
  triples.forEach((t, i) => {
    copyFileSync(parts[i].path, out(t));
    chmodSync(out(t), 0o755);
  });
  rmSync(out(target), { force: true });
  execFileSync("lipo", ["-create", "-output", out(target), ...parts.map((p) => p.path)], { stdio: "inherit" });
  writeFileSync(join(binaries, ".kind"), parts[0].kind);
} else {
  const part = obtain(target);
  copyFileSync(part.path, out(target));
  writeFileSync(join(binaries, ".kind"), part.kind);
}
chmodSync(out(target), 0o755);
console.log(`prepare-sidecar: ${out(target)}`);
