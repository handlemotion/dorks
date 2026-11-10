// Puts the `dorks-server` sidecar where Tauri expects it: src-tauri/binaries/dorks-server-<target-triple>.
//
//   node scripts/prepare-sidecar.mjs [--target aarch64-apple-darwin|x86_64-apple-darwin|universal-apple-darwin] [--release] [--stub]
//
// The real server (apps/server: Bun, Hono, SQLite) is the default. For each architecture it is taken from
// $DORKS_SERVER_DIST (default apps/server/dist) as dorks-server-<triple>, and built first when missing or older than the
// server sources: with `pnpm --filter @dorks/server run build` once that package has a build script, otherwise by compiling
// src/main.ts directly with `bun build --compile` (the same thing, one target at a time). Needs Bun on PATH.
// --stub swaps in the stand-in server from crates/shell-core instead, for working on the shell without Bun. It is never the
// default, so a release or a plain `pnpm build` cannot ship the stub by accident.
// `universal-apple-darwin` prepares both architectures and joins them with lipo.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, chmodSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const useStub = flag("--stub");
const serverDir = resolve(desktop, "..", "server");
const serverDist = resolve(process.env.DORKS_SERVER_DIST ?? join(serverDir, "dist"));
const BUN_TARGETS = { "aarch64-apple-darwin": "bun-darwin-arm64", "x86_64-apple-darwin": "bun-darwin-x64" };

/** Newest modification time under a directory (the server sources), 0 if it does not exist. */
function newest(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => {
    const path = join(dir, entry.name);
    return Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }, 0);
}

function stale(binary) {
  return !existsSync(binary) || statSync(binary).mtimeMs < Math.max(newest(join(serverDir, "src")), statSync(join(serverDir, "package.json")).mtimeMs);
}

let builtAll = false;
function buildServer(triple) {
  if (!BUN_TARGETS[triple]) throw new Error(`no Bun target for ${triple}`);
  if (existsSync(join(serverDir, "scripts", "build.ts"))) {
    // The server's own build writes every target into its dist; run it once.
    if (!builtAll) execFileSync("pnpm", ["--filter", "@dorks/server", "run", "build"], { cwd: desktop, stdio: "inherit" });
    builtAll = true;
    return;
  }
  mkdirSync(serverDist, { recursive: true });
  execFileSync(
    "bun",
    ["build", join(serverDir, "src", "main.ts"), "--compile", `--target=${BUN_TARGETS[triple]}`, "--outfile", join(serverDist, `dorks-server-${triple}`)],
    { cwd: serverDir, stdio: "inherit" },
  );
}

function obtain(triple) {
  if (!useStub) {
    const real = join(serverDist, `dorks-server-${triple}`);
    if (stale(real)) {
      console.log(`prepare-sidecar: building the server for ${triple}`);
      try {
        buildServer(triple);
      } catch (error) {
        console.error(`prepare-sidecar: could not build the server (${error.message}); is Bun installed? Use --stub to work without it.`);
        process.exit(1);
      }
    }
    if (!existsSync(real)) {
      console.error(`prepare-sidecar: ${real} not found after building`);
      process.exit(1);
    }
    return { path: real, kind: "server" };
  }
  console.log(`prepare-sidecar: --stub: building the stand-in server for ${triple}`);
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
