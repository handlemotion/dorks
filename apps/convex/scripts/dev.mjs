// `convex dev` after syncing function env vars from the repo-root .env (run from the repo root via `pnpm dev:convex`).
import { spawn } from "node:child_process";
import "./sync-env.mjs";

const dev = spawn("npx", ["convex", "dev", ...process.argv.slice(2)], { stdio: "inherit" });
dev.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
