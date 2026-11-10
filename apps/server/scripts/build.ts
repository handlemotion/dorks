// Compiles the server into one self-contained executable per target with `bun build --compile`.
//   bun run scripts/build.ts            the machine's own target
//   bun run scripts/build.ts --all      both macOS targets (cross-compiling downloads that target's Bun runtime)
// Output: dist/dorks-server-<target triple>, the naming Tauri expects for sidecars (externalBin). Also dist/dorks-server (host copy).
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const TARGETS: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
};

const root = join(import.meta.dir, "..");
const out = join(root, "dist");
mkdirSync(out, { recursive: true });

const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const host = process.platform === "darwin" ? `${arch}-apple-darwin` : `${arch}-unknown-linux-gnu`;
if (!TARGETS[host]) throw new Error(`unsupported host: ${process.platform}/${process.arch}`);
const wanted = process.argv.includes("--all") ? ["aarch64-apple-darwin", "x86_64-apple-darwin"] : [host];

for (const triple of wanted) {
  const outfile = join(out, `dorks-server-${triple}`);
  const proc = Bun.spawnSync(["bun", "build", "--compile", `--target=${TARGETS[triple]}`, join(root, "src/main.ts"), "--outfile", outfile], { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
  console.log(`${triple}: ${(statSync(outfile).size / 1e6).toFixed(1)} MB -> ${outfile}`);
  if (triple === host) copyFileSync(outfile, join(out, "dorks-server"));
}
