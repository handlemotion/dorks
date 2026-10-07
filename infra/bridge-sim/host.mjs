// Stands in for Upstash Box hosting in local dev: watches the sim box table and runs/kills one convex-sim.mjs per running box.
// A "paused" box = killed process (its state lives in Convex, like a real paused box keeps only disk).
//   CONVEX_URL=… SIM_HOST_KEY=… BRIDGE_SECRET_KEY=… node host.mjs
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

const { CONVEX_URL, SIM_HOST_KEY, BRIDGE_SECRET_KEY } = process.env;
const sim = fileURLToPath(new URL("./convex-sim.mjs", import.meta.url));
const secretFor = (dorkId) => createHmac("sha256", BRIDGE_SECRET_KEY).update(`bridge|${dorkId}`).digest("hex");
const procs = new Map(); // box name -> { gen, child }
const client = new ConvexClient(CONVEX_URL);

client.onUpdate(anyApi.simbox.all, { hostKey: SIM_HOST_KEY }, (boxes) => {
  const names = new Set(boxes.map((b) => b.name));
  for (const [name, p] of procs) if (!names.has(name)) { p.child.kill("SIGKILL"); procs.delete(name); }
  for (const b of boxes) {
    const cur = procs.get(b.name);
    if (cur && (cur.gen === b.gen)) continue;
    if (cur) { cur.child.kill("SIGKILL"); procs.delete(b.name); console.log(`[host] ${b.name.slice(-6)} paused`); }
    if (!b.running) continue;
    console.log(`[host] ${b.name.slice(-6)} running (gen ${b.gen})`);
    const child = spawn("node", [sim], { stdio: "inherit", env: { ...process.env, DORK_ID: b.name, BRIDGE_URL: CONVEX_URL, BRIDGE_SECRET: secretFor(b.name) } });
    procs.set(b.name, { gen: b.gen, child });
  }
});
process.on("SIGINT", () => { for (const p of procs.values()) p.child.kill("SIGKILL"); process.exit(0); });
