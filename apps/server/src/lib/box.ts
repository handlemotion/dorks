import { randomUUID } from "node:crypto";
import type { App } from "../app";
import { BoxNotFoundError, unconfiguredBox, type BoxProvider } from "../core/box";
import type { SnapshotDriver } from "../core/snapshot";
import { boatBox } from "./boat";
import { boatSnapshotDriver } from "./boatSnapshots";
import { boatKey, readSettings } from "../services/settings";

/** A per-installation id: scopes the labels of Boat sandboxes so two Dorks installs on one Boat account never adopt each other's boxes. */
export function instanceId(app: App): string {
  const row = app.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'instance_id'");
  if (row) return row.value;
  const id = randomUUID();
  app.db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('instance_id', ?)", id);
  return app.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'instance_id'")!.value;
}

/**
 * Box seam (core/box.ts). BOX_PROVIDER=boat (default) or sim; the Boat key and organization come from settings, so the user can
 * change them in the UI. Actions are stateless, so the sim keeps its "remote" state in the sim_boxes table (the same way a real
 * provider holds it remotely).
 */
export async function getBox(app: App): Promise<BoxProvider> {
  if (app.cfg.boxProvider === "sim") return simBox(app);
  const apiKey = await boatKey(app);
  if (!apiKey) return unconfiguredBox("Boat API key not set");
  return boatBox({ apiKey, scope: instanceId(app), org: readSettings(app).boatOrg || undefined, fetch: app.fetch });
}

/** The base-snapshot build's provider calls: Boat, or an instant in-memory stand-in under BOX_PROVIDER=sim. */
export async function getSnapshotDriver(app: App): Promise<SnapshotDriver> {
  if (app.cfg.boxProvider === "sim") return simSnapshotDriver(Number(process.env.SIM_BUILD_STEP_MS ?? 400));
  const apiKey = await boatKey(app);
  if (!apiKey) throw new Error("Boat API key not set");
  return boatSnapshotDriver({ apiKey, org: readSettings(app).boatOrg || undefined, fetch: app.fetch });
}

// Module-level, because drivers are created per call and the simulated provider's "remote" state has to outlive them.
const simSaved = new Map<string, { sourceSandboxId: string }>();
const simFiles = new Map<string, string>(); // `${sandbox}\0${path}` -> content
const simProcs = new Map<number, { sandbox: string; command: string }>();
let simPid = 0;
function simSnapshotDriver(stepMs: number): SnapshotDriver {
  const pause = () => (stepMs > 0 ? new Promise<void>((r) => setTimeout(r, stepMs)) : Promise.resolve());
  const boxes = new Set<string>();
  return {
    async listBuildSandboxes() {
      return [...boxes].map((id) => ({ id }));
    },
    async createBuildSandbox({ key }) {
      await pause();
      boxes.add(`sim-build-${key}`);
      return { id: `sim-build-${key}` };
    },
    async waitReady() {
      await pause();
    },
    async writeFile(id, path, content, encoding) {
      simFiles.set(`${id}\0${path}`, encoding === "base64" ? Buffer.from(content, "base64").toString("utf8") : content);
      await pause();
    },
    async run() {
      await pause();
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
    async saveSnapshot(id, name) {
      await pause();
      simSaved.set(name, { sourceSandboxId: id });
    },
    async getSnapshot(name) {
      const s = simSaved.get(name);
      return s ? { name, status: "ready", sourceSandboxId: s.sourceSandboxId } : null;
    },
    async deleteSandbox(id) {
      boxes.delete(id);
      for (const k of [...simFiles.keys()]) if (k.startsWith(`${id}\0`)) simFiles.delete(k);
    },
    async runDetached(id, command) {
      simPid += 1;
      simProcs.set(simPid, { sandbox: id, command });
      return { processId: simPid, commandId: `sim-cmd-${simPid}` };
    },
    // "Runs" the uploaded setup scripts by echoing their lines; a line that is `false` or `exit <n>` fails the run, so failures can be tried.
    async attach(id, processId, _offsets, onOutput) {
      const proc = simProcs.get(processId);
      if (proc && !proc.command.includes("dorks-build/run")) return { t: "exit", exitCode: 0, offsets: { stdout: 0, stderr: 0 } }; // a clone or the secret scan
      const scripts = [...simFiles.entries()].filter(([k]) => k.startsWith(`${id}\0`) && k.endsWith(".sh")).map(([, v]) => v);
      for (const line of scripts
        .join("\n")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))) {
        await pause();
        onOutput("stdout", `+ ${line}\n`);
        const failed = line === "false" ? 1 : /^exit\s+(\d+)$/.exec(line) ? Number(/^exit\s+(\d+)$/.exec(line)![1]) : 0;
        if (failed) {
          onOutput("stderr", `simulated failure at: ${line}\n`);
          return { t: "exit", exitCode: failed, offsets: { stdout: 0, stderr: 0 } };
        }
      }
      if (!proc) return { t: "exit", exitCode: 1, offsets: { stdout: 0, stderr: 0 } };
      onOutput("stdout", "simulated setup finished\n");
      return { t: "exit", exitCode: 0, offsets: { stdout: 0, stderr: 0 } };
    },
    async killCommand(_id, processId) {
      simProcs.delete(processId);
    },
    async deleteSnapshot(name) {
      simSaved.delete(name);
    },
  };
}

// A real provider takes seconds to stop or start a sandbox. The simulated host only notices a change when it next polls, so the sim
// takes a little longer than that: otherwise a pause followed at once by a wake would never look "down" to the host, and the old
// bridge process (still connected) would be handed the next message and then killed with it.
const simLatency = () => new Promise((r) => setTimeout(r, Number(process.env.SIM_LATENCY_MS ?? 700)));

function simBox(app: App): BoxProvider {
  const { db } = app;
  return {
    async createFromSnapshot(_snap, opts) {
      const existing = db.get("SELECT name FROM sim_boxes WHERE name = ?", opts.name); // idempotent on name
      if (!existing) db.run("INSERT INTO sim_boxes (name, running, gen) VALUES (?, 1, 1)", opts.name);
      return { id: opts.name };
    },
    async resume(id) {
      await simLatency();
      const b = db.get<{ running: number; gen: number }>("SELECT running, gen FROM sim_boxes WHERE name = ?", id);
      if (!b) throw new BoxNotFoundError("no such box");
      if (!b.running) db.run("UPDATE sim_boxes SET running = 1, gen = gen + 1 WHERE name = ?", id);
    },
    async pause(id) {
      await simLatency();
      const b = db.get<{ running: number }>("SELECT running FROM sim_boxes WHERE name = ?", id);
      if (b?.running) db.run("UPDATE sim_boxes SET running = 0, gen = gen + 1 WHERE name = ?", id);
    },
    async delete(id) {
      db.run("DELETE FROM sim_boxes WHERE name = ?", id);
    },
    async desktopUrl(id, { theme }) {
      // A stand-in page on the UI listener (http/ui.ts), relative so the client resolves it against the server it talks to; lets
      // the Computer tab be built and checked without Boat.
      const b = db.get<{ running: number }>("SELECT running FROM sim_boxes WHERE name = ?", id);
      if (!b) throw new BoxNotFoundError("no such box");
      return `/sim/desktop?${new URLSearchParams({ theme })}`;
    },
    async hostPort(id, port) {
      // A sim box's bridge and agent run on this machine, so its dev server already answers on localhost.
      if (!db.get("SELECT name FROM sim_boxes WHERE name = ?", id)) throw new BoxNotFoundError("no such box");
      return { url: `http://localhost:${port}/` };
    },
  };
}
