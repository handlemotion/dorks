// One-command local dev loop: the real server (Bun) with simulated sandboxes, the sandbox host, and the web app with HMR.
//   pnpm dev                 server + sim host + web (http://localhost:3000)
//   pnpm dev:server          server + sim host only
// Data lives in .dev-data (git-ignored) so sessions survive restarts; delete it for a fresh start. No secrets or .env needed:
// the owner token and sim host key are fixed, dev-only values (override with DORKS_OWNER_TOKEN, SIM_HOST_KEY, DORKS_DATA_DIR,
// DORKS_UI_PORT, DORKS_BRIDGE_PORT). BRIDGE_IMPL=real runs the real in-box bridge with a fake Claude CLI instead of the sim bridge.
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const onlyServer = process.argv.includes("--only") && process.argv[process.argv.indexOf("--only") + 1] === "server";

if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error("Bun is required to run the server from source (https://bun.sh). The desktop app ships it compiled.");
  process.exit(1);
}

// Pick the web port before starting the API so its CORS allowlist and the printed link agree with Vite.
const availablePort = (port) => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(port, "localhost", () => {
    const chosen = probe.address().port;
    probe.close(() => resolve(chosen));
  });
});
const webPort = onlyServer ? null : await availablePort(3000).catch(() => availablePort(0));
const token = process.env.DORKS_OWNER_TOKEN || "dev-owner-token";
const simKey = process.env.SIM_HOST_KEY || "dev-sim-host-key";
const env = {
  ...process.env,
  DORKS_DATA_DIR: process.env.DORKS_DATA_DIR || join(root, ".dev-data"),
  DORKS_OWNER_TOKEN: token,
  BOX_PROVIDER: "sim",
  SIM_HOST_KEY: simKey,
  ...(!onlyServer ? { DORKS_UI_ORIGINS: [
    process.env.DORKS_UI_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000",
    `http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`,
  ].join(",") } : {}),
};
delete env.DORKS_PUBLIC_URL;

const children = [];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
const run = (name, cmd, args, opts) => {
  const child = spawn(cmd, args, opts);
  children.push(child);
  child.on("exit", (code) => {
    if (!stopping) console.error(`[dev] ${name} exited (${code}); stopping`);
    stop(code ?? 1);
  });
  return child;
};

const server = run("server", "bun", ["run", join(root, "apps/server/src/main.ts")], { env, stdio: ["ignore", "pipe", "inherit"] });
const ready = await new Promise((resolve) => {
  let buf = "";
  server.stdout.on("data", (d) => {
    buf += d;
    const line = buf.split("\n").find((l) => l.startsWith("{"));
    if (line) resolve(JSON.parse(line));
    else process.stdout.write(d);
  });
});
console.log(`[dev] server: UI ${ready.ui}, bridge ${ready.bridge}`);

// The simulator never calls Boat, GitHub or an AI provider. Seed only missing settings so the real UI can create a
// session immediately, without asking the developer to paste live credentials into a simulated sandbox.
const api = async (path, method = "GET", body) => {
  const res = await fetch(`${ready.ui}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Dev setup failed (${res.status})`);
  return res.json();
};
try {
  const settings = await api("settings");
  await api("settings", "PUT", {
    ...(!settings.boatKey ? { boatKey: "dev-simulated-boat" } : {}),
    ...(!settings.claudeToken ? { claudeToken: "dev-simulated-claude" } : {}),
    ...(!settings.github.configured ? { githubToken: "dev-simulated-github" } : {}),
  });
  if (!settings.baseSnapshotId) await api("snapshot/build", "POST", {});
} catch (error) {
  console.error(error.message);
  stop(1);
}
console.log("[dev] Simulated sandboxes and AI replies; no live credentials required.");

run("sim host", "node", [join(root, "infra/bridge-sim/host.mjs")], {
  env: { ...env, SIM_UI_URL: ready.ui, SIM_BRIDGE_URL: ready.bridge },
  stdio: "inherit",
});

if (!onlyServer) {
  run("web", "pnpm", ["--filter", "@dorks/web", "dev", "--port", String(webPort), "--strictPort"], { env, stdio: "inherit" });
  if (!process.env.DORKS_OWNER_TOKEN) {
    console.log(`\n[dev] open http://localhost:${webPort}/?server=${encodeURIComponent(ready.ui)}&token=dev-owner-token\n`);
  } else {
    console.log(`[dev] open http://localhost:${webPort}/ and connect to ${ready.ui} with your configured DORKS_OWNER_TOKEN`);
  }
} else {
  console.log(process.env.DORKS_OWNER_TOKEN ? "[dev] use your configured DORKS_OWNER_TOKEN to connect" : "[dev] owner token: dev-owner-token");
}
