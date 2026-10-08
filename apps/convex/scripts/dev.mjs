// `convex dev` with function env vars synced from the process env (injected by dotenvx; run from the repo root via `pnpm dev:convex`).
//
// Convex functions read `process.env.X` from the *deployment's* env, not from the shell that runs
// `convex dev`, so each var the functions use is pushed with `convex env set`. The names are found
// by scanning convex/ for `process.env.NAME`, so this list can't drift from the code. CONVEX_*
// vars are built in or CLI config (deployment selection, admin key) and are never pushed.
// Values go over stdin, never argv or disk.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../convex", import.meta.url).pathname;
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith("_") ? [] : e.isDirectory() ? walk(join(d, e.name)) : /\.[tj]sx?$/.test(e.name) ? [join(d, e.name)] : [],
  );
const names = new Set();
for (const f of walk(dir)) for (const m of readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
for (const n of [...names]) if (n.startsWith("CONVEX_")) names.delete(n);

const set = [], missing = [];
for (const n of [...names].sort()) (process.env[n] ? set : missing).push(n);

let failed = [];
for (const n of set) {
  const r = spawnSync("npx", ["convex", "env", "set", n], { input: process.env[n], encoding: "utf8" });
  if (r.status !== 0) failed.push(n);
}
console.log(`[convex dev] env synced: ${set.length - failed.length} set` + (failed.length ? `, FAILED: ${failed.join(", ")}` : ""));
if (missing.length) console.log(`[convex dev] not in secrets/.env.dev (left as-is on the deployment): ${missing.join(", ")}`);

const dev = spawn("npx", ["convex", "dev", ...process.argv.slice(2)], { stdio: "inherit" });
dev.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
