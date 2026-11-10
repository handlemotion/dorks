// Runs the end-to-end suites in order and stops at the first failure.
//   node scripts/e2e.mjs [server|web|all]
// server: builds the compiled sidecar (needs Bun), then runs apps/server/scripts/e2e.mjs against it twice (sim bridge, then the real
//         in-box bridge with a fake Claude CLI). It includes the on-disk and log secret scan.
// web:    builds the SPA and drives it in headless Chrome against the in-memory mock server (set CHROME_PATH if Chrome is not found).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const which = process.argv[2] ?? "all";
const run = (label, cmd, args, env = {}) => {
  console.log(`\n=== ${label}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`\ne2e failed: ${label}`);
    process.exit(r.status ?? 1);
  }
};

if (which === "server" || which === "all") {
  run("build the server binary", "pnpm", ["--filter", "@dorks/server", "build"]);
  const SERVER_BIN = join(root, "apps/server/dist/dorks-server");
  run("server e2e (sim bridge)", "node", ["apps/server/scripts/e2e.mjs"], { SERVER_BIN });
  run("server e2e (real bridge, fake Claude CLI)", "node", ["apps/server/scripts/e2e.mjs"], { SERVER_BIN, BRIDGE_IMPL: "real" });
}
if (which === "web" || which === "all") {
  run("build the web app", "pnpm", ["--filter", "@dorks/web", "build"]);
  run("web e2e (mock server)", "pnpm", ["--filter", "@dorks/web", "e2e"]);
}
