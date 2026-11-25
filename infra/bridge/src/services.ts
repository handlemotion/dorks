import { buildService, type BuildService } from "@dorks/shared";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join, relative, resolve } from "node:path";
import type { Log } from "./redact";
import { RpcError, type RpcMethods } from "./rpc";
import { asIdentity, type Identity } from "./runas";

// Services (docs/services.md): the dev servers and backing services of the dork's build, started on demand by the agent
// (`service_start`), never at boot. The build checked and warmed each one at image time, so a start here is a warm start. A service runs
// as the agent's user with the agent's environment, in its own process group (so a stop takes its children with it), its output in a
// log file the agent can read. Ad hoc services (a command the agent names itself) get the same handling for this box's lifetime.

const DEFAULT_WAIT_S = 120;
const MAX_WAIT_S = 600;
const NO_PORT_SETTLE_MS = 3_000;
const LOG_TAIL_LINES = 30;
const MAX_ADHOC = 10;

export type ServiceState = "stopped" | "starting" | "running" | "exited";

export interface ServiceStatus {
  name: string;
  command: string;
  cwd: string;
  port: number | null;
  preview: boolean;
  /** From the build, or started ad hoc by the agent. */
  source: "build" | "adhoc";
  state: ServiceState;
  pid: number | null;
  exitCode: number | null;
  /** How long its last start took to listen, in ms. */
  readyMs: number | null;
  log: string;
  /** The preview URL, when it was shown. */
  url?: string;
}

interface Running {
  child: ChildProcess;
  startedAt: number;
  readyMs: number | null;
  exitCode: number | null;
  exited: boolean;
  url?: string;
}

export interface ServiceDeps {
  workDir: string;
  /** The directory logs go to. The service's own shell (the agent's user) creates it and the files, never the bridge. */
  logDir: string;
  runAs: Identity | null;
  /** The agent's environment (null before configure): a service sees what the agent sees. */
  env: () => NodeJS.ProcessEnv | null;
  /** Shows a port in the user's Artifacts (preview.show); resolves the URL. */
  showPreview: (port: number, title: string) => Promise<string | undefined>;
  /** Told about every start, for the verify gate (hooks.ts). */
  onStart?: (name: string) => void;
  log: Log;
}

export class Services {
  private defs = new Map<string, BuildService & { source: "build" | "adhoc" }>();
  private procs = new Map<string, Running>();

  constructor(private d: ServiceDeps) {}

  /** The build's services from configure. Ad hoc ones the agent started stay; a build service replaces an ad hoc one of the same name. */
  set(services: readonly BuildService[]) {
    for (const [name, def] of this.defs) if (def.source === "build") this.defs.delete(name);
    for (const s of services) this.defs.set(s.name, { ...s, source: "build" });
  }

  list(): ServiceStatus[] {
    return [...this.defs.values()].map((def) => this.status(def.name)!);
  }

  /** The build's services and their state, for the SessionStart context and the verify gate. */
  summary(): { name: string; port: number | null; preview: boolean; state: ServiceState }[] {
    return this.list().map((s) => ({ name: s.name, port: s.port, preview: s.preview, state: s.state }));
  }

  private status(name: string): ServiceStatus | null {
    const def = this.defs.get(name);
    if (!def) return null;
    const p = this.procs.get(name);
    return {
      name,
      command: def.command,
      cwd: this.dirOf(def),
      port: def.port ?? null,
      preview: !!def.preview,
      source: def.source,
      state: !p ? "stopped" : p.exited ? "exited" : p.readyMs === null ? "starting" : "running",
      pid: p && !p.exited ? (p.child.pid ?? null) : null,
      exitCode: p?.exitCode ?? null,
      readyMs: p?.readyMs ?? null,
      log: this.logPath(name),
      ...(p?.url ? { url: p.url } : {}),
    };
  }

  private dirOf(def: BuildService): string {
    const dir = resolve(this.d.workDir, def.cwd ?? "");
    const rel = relative(this.d.workDir, dir);
    if (rel.startsWith("..")) throw new RpcError("invalid", "cwd must be under the work directory");
    return dir;
  }

  private logPath(name: string) {
    return join(this.d.logDir, `${name}.log`);
  }

  /** Defines an ad hoc service from the agent's arguments (validated like a build's). */
  private define(args: Record<string, unknown>) {
    const name = args.name;
    const existing = typeof name === "string" ? this.defs.get(name) : undefined;
    if (args.command === undefined) {
      if (existing) return existing;
      const known = [...this.defs.keys()];
      throw new RpcError(
        "invalid",
        `No service named "${String(name)}".${known.length ? ` This box has: ${known.join(", ")}.` : " This build defines none."} To start another server, pass its command (and port).`,
      );
    }
    if (existing?.source === "build") throw new RpcError("invalid", `"${existing.name}" is one of the build's services: start it by name, without a command.`);
    const parsed = buildService.safeParse({ name, command: args.command, cwd: args.cwd, port: args.port, preview: args.preview });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RpcError("invalid", `${issue?.path.join(".") || "service"}: ${issue?.message ?? "invalid"}`);
    }
    if (!existing && [...this.defs.values()].filter((d) => d.source === "adhoc").length >= MAX_ADHOC) throw new RpcError("denied", `At most ${MAX_ADHOC} ad hoc services.`);
    if (existing && this.isUp(existing.name)) throw new RpcError("denied", `"${existing.name}" is running: stop it before changing its command.`);
    const def = { ...parsed.data, source: "adhoc" as const };
    this.defs.set(def.name, def);
    return def;
  }

  private isUp(name: string) {
    const p = this.procs.get(name);
    return !!p && !p.exited;
  }

  /** Starts a service (or finds it running) and waits until it listens. */
  async start(args: Record<string, unknown>): Promise<ServiceStatus & { already: boolean; tail: string }> {
    const def = this.define(args);
    const env = this.d.env();
    if (!env) throw new RpcError("unavailable", "The agent is not configured yet: try again in a moment.");
    const waitS = typeof args.waitSeconds === "number" && args.waitSeconds > 0 ? Math.min(args.waitSeconds, MAX_WAIT_S) : DEFAULT_WAIT_S;
    if (args.restart === true) await this.stop(def.name);
    this.d.onStart?.(def.name);
    let p = this.procs.get(def.name);
    const already = !!p && !p.exited;
    if (!p || p.exited) {
      // Something else holds the port: readiness would pass on it and the agent would test the wrong program.
      if (def.port && (await listening(def.port)))
        throw new RpcError(
          "denied",
          `Port ${def.port} is already in use by another process, so ${def.name} cannot listen on it. Find it with \`ss -ltnp 'sport = :${def.port}'\` and stop it, or start this service on another port.`,
        );
      p = this.spawn(def, env);
    }
    if (p.readyMs === null) await this.waitReady(def, p, waitS * 1000);
    if (p.readyMs !== null && def.preview && def.port && !p.url) {
      p.url = await this.d.showPreview(def.port, def.name).catch((e) => {
        this.d.log("service preview failed:", def.name, String(e?.message ?? e));
        return undefined;
      });
    }
    return { ...this.status(def.name)!, already, tail: this.tail(def.name, LOG_TAIL_LINES) };
  }

  private spawn(def: BuildService, env: NodeJS.ProcessEnv): Running {
    const dir = this.dirOf(def);
    try {
      if (!statSync(dir).isDirectory()) throw new Error();
    } catch {
      throw new RpcError("invalid", `The directory ${dir} does not exist in this box.`);
    }
    // The shell opens its own log as the agent's user: the bridge (root under privilege separation) never writes where the agent can
    // plant a symlink. Not a login shell, so the service sees the same environment as the agent's own commands.
    const wrapper = 'mkdir -p -- "$1" && exec >"$1/$2.log" 2>&1 </dev/null && exec bash -c "$3"';
    const [bin, argv] = asIdentity(this.d.runAs, "bash", ["-c", wrapper, "dorks-service", this.d.logDir, def.name, def.command]);
    // detached: its own process group, so a stop signals the dev server's children too (pnpm -> vite -> esbuild).
    const child = spawn(bin, argv, { cwd: dir, env, detached: true, stdio: "ignore" });
    child.unref();
    const p: Running = { child, startedAt: Date.now(), readyMs: null, exitCode: null, exited: false };
    child.on("exit", (code, signal) => {
      p.exited = true;
      p.exitCode = code ?? (signal ? 128 : null);
    });
    child.on("error", () => {
      p.exited = true;
    });
    this.procs.set(def.name, p);
    this.d.log("service started:", def.name);
    return p;
  }

  private async waitReady(def: BuildService, p: Running, ms: number) {
    const deadline = Date.now() + ms;
    if (!def.port) {
      await new Promise((r) => setTimeout(r, Math.min(NO_PORT_SETTLE_MS, ms)));
      if (!p.exited) p.readyMs = Date.now() - p.startedAt;
      return;
    }
    while (Date.now() < deadline) {
      if (await listening(def.port)) {
        p.readyMs = Date.now() - p.startedAt;
        return;
      }
      // A wrapper that exits after starting a daemon (`docker compose up -d`) is fine as long as the port comes up.
      if (p.exited && Date.now() - p.startedAt > 2_000 && !(await listening(def.port))) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async stop(name: unknown): Promise<ServiceStatus> {
    const def = typeof name === "string" ? this.defs.get(name) : undefined;
    if (!def) throw new RpcError("invalid", `No service named "${String(name)}".`);
    const p = this.procs.get(def.name);
    // The group, not its leader: the shell may exit on SIGTERM while a child that ignores it keeps the port.
    const pid = p?.child.pid;
    if (pid && groupAlive(pid)) {
      signalGroup(pid, "SIGTERM");
      for (let i = 0; i < 20 && groupAlive(pid); i++) await new Promise((r) => setTimeout(r, 250));
      if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
      for (let i = 0; i < 20 && groupAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      this.d.log("service stopped:", def.name);
    }
    this.procs.delete(def.name);
    return this.status(def.name)!;
  }

  logs(name: unknown, lines: unknown): { name: string; log: string; text: string } {
    const def = typeof name === "string" ? this.defs.get(name) : undefined;
    if (!def) throw new RpcError("invalid", `No service named "${String(name)}".`);
    const n = typeof lines === "number" && lines > 0 ? Math.min(Math.trunc(lines), 2000) : 100;
    return { name: def.name, log: this.logPath(def.name), text: this.tail(def.name, n) };
  }

  /** The end of a service's log. Never follows a symlink, and only reads a file the agent's user owns: the agent controls that directory. */
  private tail(name: string, n: number) {
    let fd: number | undefined;
    try {
      fd = openSync(this.logPath(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || (this.d.runAs && st.uid !== this.d.runAs.uid)) return "";
      const size = Math.min(st.size, 256 * 1024);
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, st.size - size);
      return buf
        .toString("utf8")
        .split("\n")
        .slice(-n - 1)
        .join("\n")
        .slice(-64 * 1024);
    } catch {
      return "";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** On bridge shutdown: the box is pausing, nothing would survive it anyway. */
  stopAll() {
    for (const p of this.procs.values()) if (p.child.pid && groupAlive(p.child.pid)) signalGroup(p.child.pid, "SIGTERM");
  }

  readonly methods: RpcMethods = {
    service: async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      switch (p.action) {
        case "list":
          return { services: this.list() };
        case "start":
          return this.start(p);
        case "stop":
          return this.stop(p.name);
        case "logs":
          return this.logs(p.name, p.lines);
        default:
          throw new RpcError("invalid", "unknown service action");
      }
    },
  };
}

/** Any process of the service's group is still alive (its leader may be gone). */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Something accepts connections on the port, over IPv4 or IPv6 loopback (Vite on `localhost` may bind ::1 only). */
export async function listening(port: number): Promise<boolean> {
  const probe = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = connect({ host, port });
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(1_000, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });
  return (await probe("127.0.0.1")) || (await probe("::1"));
}
