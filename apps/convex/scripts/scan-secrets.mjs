// Greps everything persisted or logged for the secrets the e2e planted. Exits 1 on any hit.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
const out = process.argv[2];
const needles = JSON.parse(readFileSync(`${out}/needles.json`, "utf8"));
needles.encryptionKey = execSync("npx convex env get ENCRYPTION_KEY", { encoding: "utf8" }).trim();
needles.authSecret = execSync("npx convex env get BETTER_AUTH_SECRET", { encoding: "utf8" }).trim();
needles.bridgeKey = execSync("npx convex env get BRIDGE_SECRET_KEY", { encoding: "utf8" }).trim();
needles.webhookSecret = execSync("npx convex env get GITHUB_WEBHOOK_SECRET", { encoding: "utf8" }).trim();
let bad = 0;
const targets = { "table export (all tables incl. auth component)": `${out}/export`, "convex function logs": `${out}/convex.log`, "bridge host log": `${out}/host.log`, "backend container logs": "docker" };
for (const [label, path] of Object.entries(targets)) {
  for (const [name, n] of Object.entries(needles)) {
    const hit = path === "docker"
      ? execSync(`docker logs convex-local 2>&1 | grep -c -F -- '${n}' || true`, { encoding: "utf8" }).trim() !== "0"
      : execSync(`grep -r -l -F -- '${n}' ${path} || true`, { encoding: "utf8" }).trim() !== "";
    if (hit) { bad++; console.log(`LEAK  ${name} found in ${label}`); }
  }
  console.log(`scanned ${label}`);
}
const users = readFileSync(`${out}/export/_components/betterAuth/user/documents.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l).email);
const foreign = users.filter((e) => !e.endsWith("@jaantonio.com"));
console.log(foreign.length ? `LEAK  accounts for foreign domains exist: ${foreign}` : `PASS  auth user table holds only @jaantonio.com accounts (${users.length})`);
bad += foreign.length;
console.log(bad ? `${bad} leak(s)` : `PASS  no secret (claude token, CLI secret, GitHub token, bridge secret, encryption/auth keys) in tables, logs or exports`);
process.exit(bad ? 1 : 0);
