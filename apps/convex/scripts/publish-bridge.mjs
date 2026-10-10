// Publishes the dorks-bridge bundle to a Convex deployment, where users' workstation images are built from it (convex/workstation.ts).
// Run after changing infra/bridge, and on every deploy of a new bridge version. Needs the deployment selected the usual way
// (local backend: pnpm dev:backend; others: `--prod` or CONVEX_DEPLOYMENT).
//
//   node apps/convex/scripts/publish-bridge.mjs [--prod] [--no-build]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const convexDir = join(root, "apps/convex");
const prod = process.argv.includes("--prod") ? ["--prod"] : [];
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return r.stdout;
};

if (!process.argv.includes("--no-build")) sh("pnpm", ["--filter", "@dorks/bridge", "build"], { cwd: root });
const bytes = readFileSync(join(root, "infra/bridge/dist/cli.mjs"));
const sha256 = createHash("sha256").update(bytes).digest("hex");

const url = JSON.parse(sh("npx", ["convex", "run", ...prod, "workstation:bundleUploadUrl"], { cwd: convexDir }).trim());
const res = await fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
const { storageId } = await res.json();
sh("npx", ["convex", "run", ...prod, "workstation:registerBundle", JSON.stringify({ storageId, sha256, bytes: bytes.length })], { cwd: convexDir });
console.log(`[publish-bridge] ${bytes.length} bytes, sha256 ${sha256.slice(0, 12)}...`);
