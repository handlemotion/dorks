// Push the function env vars the Convex code reads from the process env (loaded from the repo-root `.env` by scripts/with-env.sh) to the deployment.
// Dev: imported by dev.mjs (`pnpm dev:convex`). Point CONVEX_DEPLOY_KEY (or CONVEX_SELF_HOSTED_URL and its admin key) at another deployment to push there. Placeholders (`REPLACE_ME__*`) are never pushed.
//
// Convex functions read `process.env.X` from the *deployment's* env, not from the shell that runs
// `convex dev`, so each var the functions use is pushed with `convex env set`. The names are found
// by scanning convex/ for `process.env.NAME` and the `requireEnv("NAME")` / `limit("NAME", n)` helpers, so this list can't drift from the code. CONVEX_*
// vars are built in or CLI config (deployment selection, admin key) and are never pushed.
// Values go over stdin, never argv or disk.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../convex", import.meta.url).pathname;
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith("_") ? [] : e.isDirectory() ? walk(join(d, e.name)) : /\.[tj]sx?$/.test(e.name) ? [join(d, e.name)] : [],
  );
const names = new Set();
// Direct reads (`process.env.NAME`) plus the two helpers in auth.ts that read by name: `requireEnv("NAME")`, `limit("NAME", n)`.
const READ = /process\.env\.([A-Z][A-Z0-9_]*)|\b(?:requireEnv|limit)\("([A-Z][A-Z0-9_]*)"/g;
for (const f of walk(dir)) for (const m of readFileSync(f, "utf8").matchAll(READ)) names.add(m[1] ?? m[2]);
for (const n of [...names]) if (n.startsWith("CONVEX_")) names.delete(n);

const set = [], missing = [];
for (const n of [...names].sort()) (process.env[n] && !process.env[n].startsWith("REPLACE_ME__") ? set : missing).push(n);

let failed = [];
for (const n of set) {
  const r = spawnSync("npx", ["convex", "env", "set", n], { input: process.env[n], encoding: "utf8" });
  if (r.status !== 0) failed.push(n);
}
console.log(`[convex env] synced: ${set.length - failed.length} set` + (failed.length ? `, FAILED: ${failed.join(", ")}` : ""));
if (failed.length) process.exitCode = 1;
if (missing.length) console.log(`[convex env] missing or placeholder in the environment (left as-is on the deployment): ${missing.join(", ")}`);
