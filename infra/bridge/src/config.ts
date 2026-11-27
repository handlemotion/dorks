import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The bridge's port inside a box when BRIDGE_PORT is unset (the server sets it; the local simulator gives each box its own). */
export const DEFAULT_BRIDGE_PORT = 4748;

/** Everything the bridge reads from its own environment. The box provides DORK_ID, BRIDGE_SECRET and BRIDGE_PORT; the rest are optional knobs. */
export interface Config {
  dorkId: string;
  /** The loopback port the bridge listens on; the box provider exposes it, and the server dials it (docs/architecture.md). */
  bridgePort: number;
  /** Never logged, never forwarded to the Claude child. */
  bridgeSecret: string;
  /**
   * How the bridge reaches its backend. `ws` (default): the owner's server dials this box's bridge port (a Mac, Dorks Local).
   * `s2`: a cloud org's session; the bridge talks to s2 and to the Worker at `workerUrl`, and listens on nothing (s2/transport.ts).
   */
  transport: "ws" | "s2";
  workerUrl: string | null;
  /** `DORKS_LOCAL_BOX=1`: a local dork's bridge, run by the owner's server on their own computer (docs/local-dorks.md). */
  local: boolean;
  claudeBin: string;
  /** Appended to the claude argv (space separated). Escape hatch, e.g. `--model sonnet`. */
  claudeExtraArgs: string[];
  permissionMode: string;
  /** Run claude (and its git setup) as this unprivileged user; the bridge must then be root. See runas.ts. */
  runAs: string | null;
  /** Base URL repos are cloned from: `<gitBaseUrl>/<owner>/<repo>.git`. */
  gitBaseUrl: string;
  /** Holds the dedupe journal and the files handed to Claude. Not secrets at rest: the token only ever lives in memory. */
  stateDir: string;
  /** Where the local RPC socket lives (`stateDir` when unset). Never under a lazily restored home: see `runtimeSockDir`. */
  sockDir?: string;
  workDir: string;
  heartbeatMs: number;
  deltaBatchMs: number;
  batchMs: number;
  flushIdleWaitMs: number;
  flushInterruptWaitMs: number;
  /** How long a flush waits for the whole-filesystem `sync` before reporting `flushed` anyway (the transcript is fsynced first). */
  flushSyncWaitMs: number;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

/**
 * The bridge secret comes from a file (BRIDGE_SECRET_FILE, mode 0400) that is unlinked right after reading, so it never sits in the
 * process environment (/proc/<pid>/environ) where a same-uid child could read it. BRIDGE_SECRET in env is the fallback.
 */
function readSecret(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.BRIDGE_SECRET_FILE;
  if (!file) return env.BRIDGE_SECRET;
  try {
    const v = readFileSync(file, "utf8").trim();
    try {
      unlinkSync(file);
    } catch {
      /* read-only mount etc.: the file is still 0400 */
    }
    return v || env.BRIDGE_SECRET;
  } catch {
    return env.BRIDGE_SECRET; // file already consumed (restart after a pause): the entrypoint must provide it again, or env
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { DORK_ID: dorkId } = env;
  const bridgeSecret = readSecret(env);
  if (!dorkId || !bridgeSecret) throw new Error("DORK_ID and BRIDGE_SECRET (or BRIDGE_SECRET_FILE) are required");
  const bridgePort = Number(env.BRIDGE_PORT || DEFAULT_BRIDGE_PORT);
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) throw new Error("BRIDGE_PORT must be a port number");
  const stateDir = env.DORKS_STATE_DIR || join(homedir(), ".dorks-bridge");
  return {
    dorkId,
    bridgePort,
    bridgeSecret,
    ...transportOf(env),
    local: env.DORKS_LOCAL_BOX === "1",
    claudeBin: env.CLAUDE_BIN || "claude",
    claudeExtraArgs: (env.DORKS_CLAUDE_ARGS ?? "").split(/\s+/).filter(Boolean),
    permissionMode: env.DORKS_PERMISSION_MODE || "bypassPermissions",
    runAs: env.CLAUDE_RUN_AS || null,
    gitBaseUrl: (env.DORKS_GIT_BASE_URL || "https://github.com").replace(/\/+$/, ""),
    stateDir,
    sockDir: env.DORKS_SOCK_DIR || runtimeSockDir(env),
    workDir: env.DORKS_WORKDIR || join(homedir(), "work"),
    heartbeatMs: num(env.HEARTBEAT_MS, 30_000),
    deltaBatchMs: num(env.DELTA_BATCH_MS, 150),
    batchMs: num(env.DORKS_BATCH_MS, 50),
    flushIdleWaitMs: num(env.DORKS_FLUSH_IDLE_WAIT_MS, 20_000),
    flushInterruptWaitMs: num(env.DORKS_FLUSH_INTERRUPT_WAIT_MS, 5_000),
    flushSyncWaitMs: num(env.DORKS_FLUSH_SYNC_WAIT_MS, 5_000),
  };
}

/** `DORKS_TRANSPORT=s2` (a cloud org's box) needs the Worker's URL; anything else is the WebSocket transport. */
function transportOf(env: NodeJS.ProcessEnv): Pick<Config, "transport" | "workerUrl"> {
  const workerUrl = env.DORKS_WORKER_URL?.replace(/\/+$/, "") || null;
  if (env.DORKS_TRANSPORT !== "s2") return { transport: "ws", workerUrl };
  if (!workerUrl?.match(/^https?:\/\//)) throw new Error("DORKS_TRANSPORT=s2 needs DORKS_WORKER_URL (the Worker's base URL)");
  return { transport: "s2", workerUrl };
}

/**
 * Variables that must never reach the Claude child (or anything it spawns): the bridge's own identity and the dev host's keys.
 * `DORKS_REAL_GH` is the exception: it tells the gh shim (a child of the CLI) where the real gh is.
 */
export const CHILD_ENV_DENY = [/^BRIDGE_/, /^CLAUDE_RUN_AS$/, /^DORK_ID$/, /^DORKS_(?!REAL_GH$)/, /^SIM_HOST_KEY$/, /^CLAUDE_BIN$/];

/**
 * A directory for the RPC socket that is not under the home directory. A Boat sandbox restored from a snapshot serves `/home/user`
 * lazily through FUSE and, once it is hydrated (about a minute after boot), swaps the real directory in. Files written by path
 * survive the swap, but a socket bound before it does not: the path then names a copied, dead socket file and every connect is
 * refused, so git, `gh`, `dorks` and the hooks lose the bridge. `/run` (tmpfs) is outside the lazy mount; `/tmp` is the fallback.
 */
export function runtimeSockDir(env: NodeJS.ProcessEnv = process.env, tmp = tmpdir()): string {
  const uid = process.getuid?.() ?? -1;
  // One dir per dork: several bridges under one user (the local simulator with the real bridge) must not share a socket.
  const name = `dorks-bridge-${(env.DORK_ID ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 36) || "default"}`;
  if (uid === 0) return join("/run", name);
  if (env.XDG_RUNTIME_DIR && existsSync(env.XDG_RUNTIME_DIR)) return join(env.XDG_RUNTIME_DIR, name);
  const dir = join(tmp, `${name}-${uid}`);
  // macOS caps a socket path at 104 bytes, and its per-user TMPDIR (/var/folders/xx/…/T) is long enough that a local dork's socket
  // would not fit: its bridge then dies on start. /tmp is short; RpcServer refuses a dir there it does not own.
  return Buffer.byteLength(join(dir, SOCK_SUFFIX)) > MAX_SOCK_PATH ? join("/tmp", `${name}-${uid}`) : dir;
}

/** The longest socket path under the dir (bridge.ts: `cred/cred.sock` when the agent runs as another user). */
const SOCK_SUFFIX = "cred/cred.sock";
/** `sun_path` is 104 bytes on macOS and 108 on Linux, with the terminating NUL. */
const MAX_SOCK_PATH = 103;
