// Fills apps/desktop/dist (Tauri's frontendDist) with the static web UI.
//
// Uses the built SPA from $DORKS_WEB_DIST (default apps/web/dist/client) when it has an index.html. Until the web app builds
// as a static SPA, the small placeholder page in ui/ is used; it shows the server status and the runtime config.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(desktop, "dist");
const web = resolve(process.env.DORKS_WEB_DIST ?? join(desktop, "..", "web", "dist", "client"));

const useWeb = existsSync(join(web, "index.html"));
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(useWeb ? web : join(desktop, "ui"), dist, { recursive: true });
console.log(`prepare-ui: ${useWeb ? `web SPA from ${web}` : "placeholder page (the web app has no static build yet)"}`);
