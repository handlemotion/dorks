import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { BoxNotFoundError, type BoxProvider } from "@dorks/core/box";
import { bridgeSecret } from "@dorks/core/bridgeAuth";
import type { App } from "../app";
import { getDork, type DorkRow } from "../data";
import { githubToken } from "../services/settings";
import { ensureWorktree, removeWorktree, type Checkout, type GitAuth } from "./localGit";
import { AGENT_BINS, findOn, localTools } from "./localTools";

// The local box provider (docs/local-dorks.md): a "box" is a directory under `<data dir>/local/boxes/<dork id>` and one real bridge
// process (infra/bridge, run with the owner's Node.js) that this server starts as its child. The bridge listens on a loopback port of
// its own and the server dials it there, exactly as for a simulated box (lib/box.ts). The agent CLIs are the ones installed on this
// computer; they work in the dork's git worktree (lib/localGit.ts), unsandboxed, as the owner.
//
//   create  -> worktree (cloned and fetched first), then the bridge
//   pause   -> the bridge and everything it started stop; an archived dork's worktree is removed too
//   resume  -> the worktree is added again if it was removed, then the bridge
//   delete  -> stop, remove the worktree and the dork's local branch, remove the box directory
//
// The `local_boxes` row is the provider's own state, like a cloud provider's record of a sandbox: it survives a restart of the server,
// and a box that should be running gets its bridge started again the next time the server dials it.

export const LOCAL_BOX_PREFIX = "local-";
export const isLocalBox = (boxId: string) => boxId.startsWith(LOCAL_BOX_PREFIX);

const STOP_GRACE_MS = 5_000;
const RESPAWN_MS = 2_000;
const MAX_QUICK_EXITS = 5;
const QUICK_MS = 60_000;

/** A loopback port nothing listens on right now. */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });

type BoxRow = { name: string; dork_id: string; bridge_port: number; running: number };
type Proc = { child: ChildProcess; startedAt: number; stopping: boolean; exited: Promise<void> };
type Host = { procs: Map<string, Proc>; chains: Map<string, Promise<unknown>>; quickExits: Map<string, number> };

const hosts = new WeakMap<App, Host>();
const hostOf = (app: App): Host => {
  let h = hosts.get(app);
  if (!h) hosts.set(app, (h = { procs: new Map(), chains: new Map(), quickExits: new Map() }));
  return h;
};

export const localRoot = (app: App) => join(app.cfg.dataDir, "local");
const boxDir = (app: App, boxId: string) => join(localRoot(app), "boxes", boxId.slice(LOCAL_BOX_PREFIX.length));
const rowOf = (app: App, boxId: string) => app.db.get<BoxRow>("SELECT * FROM local_boxes WHERE name = ?", boxId);
const setRunning = (app: App, boxId: string, running: boolean) => app.db.run("UPDATE local_boxes SET running = ? WHERE name = ?", running ? 1 : 0, boxId);

/** One operation at a time per box: a pause must not run under a resume that is still adding the worktree. */
function serial<A>(app: App, boxId: string, f: () => Promise<A>): Promise<A> {
  const { chains } = hostOf(app);
  const run = (chains.get(boxId) ?? Promise.resolve()).then(f, f);
  const settled = run.catch(() => {});
  chains.set(boxId, settled);
  void settled.then(() => chains.get(boxId) === settled && chains.delete(boxId));
  return run;
}

export const checkoutOf = (app: App, boxId: string, dork: Pick<DorkRow, "repo" | "branch">): Checkout => ({
  reposDir: join(localRoot(app), "repos"),
  workDir: join(boxDir(app, boxId), "work"),
  repo: dork.repo,
  branch: dork.branch,
});

const gitAuth = async (app: App): Promise<GitAuth> => ({ baseUrl: app.cfg.localGitBaseUrl ?? "https://github.com", token: await githubToken(app) });

/** The owner's git identity (their global config), so a local dork's commits are theirs; the bridge falls back to `dorks` without one. */
function ownerIdentity(key: string): Promise<string> {
  return new Promise((resolve) => execFile("git", ["config", "--global", "--get", key], { timeout: 5_000 }, (err, out) => resolve(err ? "" : String(out).trim())));
}

async function writeGitConfig(file: string) {
  if (existsSync(file)) return;
  writeFileSync(file, "", { mode: 0o600 });
  for (const key of ["user.name", "user.email"]) {
    const v = await ownerIdentity(key);
    if (v) await new Promise<void>((r) => execFile("git", ["config", "--file", file, key, v], () => r()));
  }
}

/** The box's directories and, for a code session, its worktree. */
async function prepare(app: App, boxId: string, dork: DorkRow) {
  const dir = boxDir(app, boxId);
  for (const d of ["work", "state", "claude", "bin"]) mkdirSync(join(dir, d), { recursive: true, mode: 0o700 });
  await writeGitConfig(join(dir, "gitconfig"));
  if (dork.repo) await ensureWorktree(checkoutOf(app, boxId, dork), await gitAuth(app));
}

/** The bridge bundle this server carries, written once per version under the data directory. */
async function bridgeBundle(app: App): Promise<string> {
  const assets = await app.snapshotAssets();
  if (assets.bridge.length < 1024) throw new Error("The bridge bundle is not available. Build it with `pnpm --filter @dorks/bridge build`, or use a release build of the app.");
  const dir = join(localRoot(app), "bridge");
  const file = join(dir, `dorks-bridge-${assets.bridgeSha256.slice(0, 12)}.mjs`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, assets.bridge, { mode: 0o755 });
    renameSync(`${file}.tmp`, file);
  }
  return file;
}

/** `dorks` and `gh` on the agent's PATH are the bridge's own entry points, as in a sandbox (infra/snapshot/boat-install.sh). */
function linkShims(binDir: string, bundle: string) {
  for (const name of ["dorks", "gh"]) {
    const link = join(binDir, name);
    rmSync(link, { force: true });
    symlinkSync(bundle, link);
  }
}

const PASS = ["USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "XDG_RUNTIME_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

/** What the bridge runs with: only what a box would give it, plus this computer's PATH and CLIs. No server keys. */
async function bridgeEnv(app: App, boxId: string, row: BoxRow, dork: DorkRow, secretFile: string) {
  const dir = boxDir(app, boxId);
  const tools = await localTools(app.cfg.localNodeBin);
  if (!tools.node) throw new Error("Node.js is not installed on this computer");
  const agent = findOn(tools.path, AGENT_BINS[dork.provider] ?? "claude");
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(PASS.filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
    PATH: [join(dir, "bin"), tools.path].join(process.platform === "win32" ? ";" : ":"),
    HOME: homedir(),
    DORK_ID: dork.id,
    BRIDGE_PORT: String(row.bridge_port),
    BRIDGE_SECRET_FILE: secretFile,
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    DORKS_GIT_BASE_URL: app.cfg.localGitBaseUrl ?? "https://github.com",
    DORKS_STATE_DIR: join(dir, "state"),
    DORKS_WORKDIR: join(dir, "work"),
    CLAUDE_CONFIG_DIR: join(dir, "claude"),
    DORKS_PARENT_PID: String(process.pid),
    DORKS_LOCAL_BOX: "1",
    ...(tools.gh ? { DORKS_REAL_GH: tools.gh } : {}),
    ...(dork.provider === "claude" && agent ? { CLAUDE_BIN: agent } : {}),
  };
  return { node: tools.node, env };
}

/** Starts the box's bridge unless it already runs. */
async function ensureRunning(app: App, boxId: string) {
  const host = hostOf(app);
  if (host.procs.has(boxId)) return;
  const row = rowOf(app, boxId);
  const dork = row && getDork(app.db, row.dork_id);
  if (!row || !dork) throw new BoxNotFoundError("no such box");
  const dir = boxDir(app, boxId);
  const bundle = await bridgeBundle(app);
  linkShims(join(dir, "bin"), bundle);
  // The secret goes in a 0400 file the bridge reads and unlinks at once, never in its environment (config.ts, readSecret).
  const secretFile = join(dir, "bridge.secret");
  rmSync(secretFile, { force: true });
  writeFileSync(secretFile, await bridgeSecret(app.cfg.bridgeSecretKey, dork.id), { mode: 0o400 });
  const { node, env } = await bridgeEnv(app, boxId, row, dork, secretFile);
  if (host.procs.has(boxId)) return;
  const log = openSync(join(dir, "bridge.log"), "a", 0o600);
  // Its own process group, so a pause stops the agent and whatever it started (dev servers) with it.
  const child = spawn(node, [bundle], { cwd: dir, env, detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  const proc: Proc = { child, startedAt: Date.now(), stopping: false, exited: new Promise((r) => child.once("exit", () => r())) };
  host.procs.set(boxId, proc);
  child.once("error", (e) => console.error("local: bridge failed to start", boxId.slice(-6), e.message.slice(0, 200)));
  child.once("exit", (code, signal) => onExit(app, boxId, proc, code, signal));
}

/** A bridge that exits by itself while its box should run is started again, unless it keeps dying right away. */
function onExit(app: App, boxId: string, proc: Proc, code: number | null, signal: NodeJS.Signals | null) {
  const host = hostOf(app);
  if (host.procs.get(boxId) === proc) host.procs.delete(boxId);
  killGroup(proc.child.pid, "SIGKILL"); // what the agent started outlives the bridge otherwise
  if (proc.stopping) return;
  console.error("local: bridge exited", boxId.slice(-6), code ?? signal);
  const quick = Date.now() - proc.startedAt < QUICK_MS ? (host.quickExits.get(boxId) ?? 0) + 1 : 0;
  host.quickExits.set(boxId, quick);
  if (quick > MAX_QUICK_EXITS) {
    console.error("local: bridge keeps exiting; not starting it again until the next wake", boxId.slice(-6));
    return;
  }
  setTimeout(() => {
    if (rowOf(app, boxId)?.running) void serial(app, boxId, () => ensureRunning(app, boxId)).catch(() => {});
  }, RESPAWN_MS).unref?.();
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // gone already
  }
}

/** Stops the bridge (SIGTERM, then SIGKILL after a grace period) and every process of its group. */
async function stop(app: App, boxId: string) {
  const proc = hostOf(app).procs.get(boxId);
  if (!proc) return;
  proc.stopping = true;
  killGroup(proc.child.pid, "SIGTERM");
  const timedOut = await Promise.race([proc.exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), STOP_GRACE_MS))]);
  if (timedOut) killGroup(proc.child.pid, "SIGKILL");
  await proc.exited;
  hostOf(app).procs.delete(boxId);
}

/** An archived (or deleted) dork's worktree goes; what it committed stays on its branch. */
async function dropCheckout(app: App, boxId: string, dork: Pick<DorkRow, "repo" | "branch"> | undefined, deleting = false) {
  if (!dork?.repo) return;
  await removeWorktree(checkoutOf(app, boxId, dork), deleting);
}

export interface LocalBoxProvider extends BoxProvider {
  retire(boxId: string): Promise<void>;
}

export function localBox(app: App): LocalBoxProvider {
  const live = (boxId: string) => {
    const row = rowOf(app, boxId);
    if (!row) throw new BoxNotFoundError("no such box");
    return row;
  };
  const dorkOfRow = (row: BoxRow) => {
    const dork = getDork(app.db, row.dork_id);
    if (!dork) throw new BoxNotFoundError("no such box");
    return dork;
  };
  const start = async (boxId: string) => {
    const dork = dorkOfRow(live(boxId));
    await prepare(app, boxId, dork);
    setRunning(app, boxId, true);
    hostOf(app).quickExits.delete(boxId);
    await ensureRunning(app, boxId);
  };
  return {
    async createFromSnapshot(_snapshot, opts) {
      const boxId = LOCAL_BOX_PREFIX + opts.name; // idempotent on name, like a cloud box
      if (!getDork(app.db, opts.name)) throw new Error("no such dork");
      if (!rowOf(app, boxId)) app.db.run("INSERT OR IGNORE INTO local_boxes (name, dork_id, bridge_port, running, created_at) VALUES (?, ?, ?, 1, ?)", boxId, opts.name, await freePort(), app.now());
      await serial(app, boxId, () => start(boxId));
      return { id: boxId };
    },
    resume: (boxId) => serial(app, boxId, () => start(boxId)),
    pause: (boxId) =>
      serial(app, boxId, async () => {
        const row = rowOf(app, boxId);
        if (!row) return;
        setRunning(app, boxId, false);
        await stop(app, boxId);
        const dork = getDork(app.db, row.dork_id);
        if (!dork || dork.archived) await dropCheckout(app, boxId, dork);
      }),
    delete: (boxId) =>
      serial(app, boxId, async () => {
        const row = rowOf(app, boxId);
        if (!row) return;
        setRunning(app, boxId, false);
        await stop(app, boxId);
        await dropCheckout(app, boxId, getDork(app.db, row.dork_id), true);
        rmSync(boxDir(app, boxId), { recursive: true, force: true });
        app.db.run("DELETE FROM local_boxes WHERE name = ?", boxId);
      }),
    retire: (boxId) =>
      serial(app, boxId, async () => {
        const row = rowOf(app, boxId);
        const dork = row && getDork(app.db, row.dork_id);
        if (row && !row.running && dork?.archived) await dropCheckout(app, boxId, dork);
      }),
    async bridgeEndpoint(boxId) {
      const row = live(boxId);
      // After a restart of the server the box's bridge is not running yet: start it, and the dial that follows reaches it.
      if (row.running) await serial(app, boxId, () => ensureRunning(app, boxId));
      return { url: `ws://127.0.0.1:${row.bridge_port}/`, headers: {} };
    },
    async hostPort(boxId, port) {
      live(boxId);
      return { url: `http://localhost:${port}/` }; // the dev server runs on this computer
    },
  };
}

/** Stops every local bridge this process started (the server is shutting down). Their boxes stay `running`: the next start resumes them. */
export async function stopLocalBridges(app: App) {
  const host = hosts.get(app);
  if (!host) return;
  await Promise.all([...host.procs.keys()].map((id) => stop(app, id).catch(() => {})));
}

/** Whether a box's bridge process is up in this server (tests and checks). */
export const localBridgeRunning = (app: App, boxId: string) => hostOf(app).procs.has(boxId);
