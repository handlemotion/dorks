// Stands in for sandbox hosting in local dev and tests (BOX_PROVIDER=sim): polls the server's sim box table and runs/kills one
// sim-bridge.mjs per running box. A "paused" box = a killed process (its state lives in the server, like a real paused box keeps only disk).
//   SIM_HOST_KEY=… node host.mjs
// Where things are (all optional): SIM_UI_URL (default http://127.0.0.1:4747), SIM_BRIDGE_URL (default ws://127.0.0.1:4748/bridge),
// BRIDGE_SECRET_KEY (default: read from <DORKS_DATA_DIR>/secrets.json, the file the server generates).
// Opt in to the real in-box bridge (infra/bridge) instead of sim-bridge.mjs: BRIDGE_IMPL=real (CLAUDE_BIN=<claude> to override the fake CLI).
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { SIM_HOST_KEY } = process.env;
if (!SIM_HOST_KEY) throw new Error("SIM_HOST_KEY is required");
const uiUrl = (process.env.SIM_UI_URL || "http://127.0.0.1:4747").replace(/\/+$/, "");
const bridgeUrl = process.env.SIM_BRIDGE_URL || "ws://127.0.0.1:4748/bridge";
const dataDir =
  process.env.DORKS_DATA_DIR ||
  (process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "Dorks") : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "dorks"));
const bridgeSecretKey = process.env.BRIDGE_SECRET_KEY || JSON.parse(readFileSync(join(dataDir, "secrets.json"), "utf8")).bridgeSecretKey;
const sim = fileURLToPath(new URL("./sim-bridge.mjs", import.meta.url));
const secretFor = (dorkId) => createHmac("sha256", bridgeSecretKey).update(`bridge|${dorkId}`).digest("hex");
const procs = new Map(); // box name -> { gen, child }
const real = process.env.BRIDGE_IMPL === "real" ? (await import("../bridge/scripts/sim-host.mjs")).prepareRealBridge() : null;
const POLL_MS = Number(process.env.SIM_POLL_MS ?? 300);

function reconcile(boxes) {
  const names = new Set(boxes.map((b) => b.name));
  for (const [name, p] of procs)
    if (!names.has(name)) {
      p.child.kill("SIGKILL");
      procs.delete(name);
    }
  for (const b of boxes) {
    const cur = procs.get(b.name);
    if (cur && cur.gen === b.gen) continue;
    if (cur) {
      cur.child.kill("SIGKILL");
      procs.delete(b.name);
      console.log(`[host] ${b.name.slice(-6)} paused`);
    }
    if (!b.running) continue;
    console.log(`[host] ${b.name.slice(-6)} running (gen ${b.gen})`);
    const child = real
      ? spawn(process.execPath, [real.cli], { stdio: "inherit", env: real.envFor(b.name, secretFor(b.name), bridgeUrl) })
      : spawn("node", [sim], { stdio: "inherit", env: { ...process.env, DORK_ID: b.name, BRIDGE_URL: bridgeUrl, BRIDGE_SECRET: secretFor(b.name) } });
    procs.set(b.name, { gen: b.gen, child });
  }
}

let warned = false;
setInterval(async () => {
  try {
    const res = await fetch(`${uiUrl}/sim/boxes`, { headers: { "x-sim-host-key": SIM_HOST_KEY } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    warned = false;
    reconcile(await res.json());
  } catch (e) {
    if (!warned) console.log(`[host] cannot read ${uiUrl}/sim/boxes (${e.message}); retrying`);
    warned = true;
  }
}, POLL_MS);
process.on("SIGINT", () => {
  for (const p of procs.values()) p.child.kill("SIGKILL");
  process.exit(0);
});
process.on("SIGTERM", () => {
  for (const p of procs.values()) p.child.kill("SIGKILL");
  process.exit(0);
});
