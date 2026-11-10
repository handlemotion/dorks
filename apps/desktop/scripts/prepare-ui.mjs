// Fills apps/desktop/dist (Tauri's frontendDist) with the static web UI.
//
//   node scripts/prepare-ui.mjs [--no-build] [--placeholder]
//
// Builds apps/web (`pnpm --filter @dorks/web build`, output apps/web/dist/client, or $DORKS_WEB_DIST) and copies it. --no-build
// reuses an existing build. --placeholder uses the small status page in ui/ instead, for working on the shell alone. A web build
// that is missing or fails is an error: the app never silently ships the placeholder.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(desktop, "dist");
const web = resolve(process.env.DORKS_WEB_DIST ?? join(desktop, "..", "web", "dist", "client"));
const args = process.argv.slice(2);

const placeholder = args.includes("--placeholder");
if (!placeholder && !args.includes("--no-build")) {
  execFileSync("pnpm", ["--filter", "@dorks/web", "build"], { cwd: desktop, stdio: "inherit" });
}
if (!placeholder && !existsSync(join(web, "index.html"))) {
  console.error(`prepare-ui: ${join(web, "index.html")} not found; build apps/web or use --placeholder`);
  process.exit(1);
}
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(placeholder ? join(desktop, "ui") : web, dist, { recursive: true });
console.log(`prepare-ui: ${placeholder ? "placeholder page" : `web SPA from ${web}`}`);
