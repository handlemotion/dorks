// Runs cargo in src-tauri, or skips politely when Rust is not installed, so `pnpm typecheck` and `pnpm test` at the repo root
// still work for contributors who only touch the TypeScript side. In CI (CI=true) a missing cargo is an error.
//
//   node scripts/cargo.mjs clippy -p dorks-shell-core --all-targets -- -D warnings
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "src-tauri");
const probe = spawnSync("cargo", ["--version"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  if (process.env.CI) {
    console.error("cargo is required in CI");
    process.exit(1);
  }
  console.log("desktop: cargo not found, skipping (install Rust from https://rustup.rs to check the desktop shell)");
  process.exit(0);
}
const run = spawnSync("cargo", process.argv.slice(2), { cwd, stdio: "inherit" });
process.exit(run.status ?? 1);
