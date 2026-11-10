// Creates the repo-root `.env` for local development with freshly generated secrets. Never overwrites an existing file.
// Fill in BOAT_API_KEY (and, if you use PR autonomy, the GitHub values) yourself; see docs/env.md.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const target = new URL("../.env", import.meta.url);
if (existsSync(target)) {
  console.log(".env already exists; leaving it alone");
  process.exit(0);
}
const hex = () => randomBytes(32).toString("hex");
const lines = [
  "# Local development settings. Never commit this file. Reference: docs/env.md",
  `BETTER_AUTH_SECRET=${hex()}`,
  `BRIDGE_SECRET_KEY=${hex()}`,
  `ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
  "SITE_URL=http://localhost:3000",
  "BOX_PROVIDER=sim",
  `SIM_HOST_KEY=${hex()}`,
  "BASE_SNAPSHOT_ID=sim-snapshot",
  "DORKS_OWNER_EMAIL=",
  "BOAT_API_KEY=",
  "BOAT_ORG=",
  "GITHUB_APP_ID=",
  "GITHUB_APP_PRIVATE_KEY=",
  "GITHUB_APP_CLIENT_ID=",
  "GITHUB_APP_CLIENT_SECRET=",
  "GITHUB_APP_SLUG=dorks-test",
  `GITHUB_WEBHOOK_SECRET=${hex()}`,
  "RESEND_API_KEY=re_test_local",
  "VITE_CONVEX_URL=http://127.0.0.1:3210",
  "VITE_CONVEX_SITE_URL=http://127.0.0.1:3211",
  "VITE_GITHUB_APP_SLUG=",
];
writeFileSync(target, lines.join("\n") + "\n", { mode: 0o600 });
console.log("wrote .env (mode 600)");
