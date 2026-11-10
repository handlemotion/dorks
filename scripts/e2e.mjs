// The one end-to-end test: builds the compiled sidecar (needs Bun), then runs apps/server/scripts/e2e.mjs against it twice (sim
// bridge, then the real in-box bridge with a fake Claude CLI). It includes the on-disk and log secret scan.
//   node scripts/e2e.mjs
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const run = (label, cmd, args, env = {}) => {
  console.log(`\n=== ${label}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`\ne2e failed: ${label}`);
    process.exit(r.status ?? 1);
  }
};

run("build the server binary", "pnpm", ["--filter", "@dorks/server", "build"]);
const SERVER_BIN = join(root, "apps/server/dist/dorks-server");
run("server e2e (sim bridge)", "node", ["apps/server/scripts/e2e.mjs"], { SERVER_BIN });
run("server e2e (real bridge, fake Claude CLI)", "node", ["apps/server/scripts/e2e.mjs"], { SERVER_BIN, BRIDGE_IMPL: "real" });
