import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import type { LocalKind } from "@dorks/shared";
import { fail, touch, type App } from "../app";
import { getDork } from "../data";
import { insert, update } from "../db";
import { append, cancelTimer, setTimer } from "../lifecycle/dispatch";
import { readSettings } from "./settings";

// Local access (docs/local-access.md): a dork's agent runs in a cloud sandbox, but this server runs on the owner's own computer. When
// the agent needs something that only exists there (a CLI that is signed in, a file, a local service), it asks through its bridge
// ("can I run `xcrun simctl list` in ~/app?"). The owner answers once per session: the first request shows "Claude wants to access
// your computer", and Allow for this session lets that dork's later requests run without asking; Always allow (the
// `localAlwaysAllow` setting) lets every session in. Nothing runs or is read without one of the two.
//
// The request is a row; the owner's answer and the result are events in the transcript, so the chat is the audit log. The agent's tool
// call waits on the row (`waitLocal`, a short poll the bridge repeats) and gets the output back in the same turn.

export const REQUEST_TTL_MS = 10 * 60_000; // an unanswered request expires (the agent's tool call stops waiting before this)
export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 600;
export const MAX_COMMAND_CHARS = 4_000;
export const MAX_REASON_CHARS = 500;
export const MAX_PATH_CHARS = 1_024;
export const MAX_READ_BYTES = 256 * 1024;
export const OUTPUT_HEAD = 16 * 1024; // what the agent gets back from a command: the start and the end of its output
export const OUTPUT_TAIL = 48 * 1024;
export const PREVIEW_CHARS = 2_000; // what the transcript row shows
export const MAX_WAIT_MS = 8_000; // one wait; the bridge gives the backend 10 s per call
const KILL_GRACE_MS = 3_000;
const SETTING = "local_access";
const TIMER = "local:";

/** Where a Finder-launched app should also look for tools (its PATH is minimal), as for `gh` (lib/ghCli.ts). */
const EXTRA_PATH = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
/** Never handed to a command the agent runs: the server's own configuration and the credentials it was started with. */
const SCRUBBED_ENV = /^(DORKS_|CLAUDE_CODE_|ANTHROPIC_|BOAT_|SIM_|WURMHOL_|DOPPLER_)|^(GH_TOKEN|GITHUB_TOKEN|SESSION_INGRESS_URL)$/;

type Status = "pending" | "running" | "denied" | "expired" | "done" | "failed";

interface RequestRow {
  id: string;
  dork_id: string;
  kind: LocalKind;
  command: string | null;
  cwd: string | null;
  path: string | null;
  reason: string;
  timeout_ms: number;
  status: Status;
  exit_code: number | null;
  output: string | null;
  truncated: number;
  error: string | null;
  expires_at: number;
  created_at: number;
}

/** What the agent's tool gets back. `output` is the command's output or the file's text; `error` says why there is none. */
export interface LocalResultView {
  requestId: string;
  kind: LocalKind;
  status: Status;
  exitCode?: number | null;
  output?: string;
  truncated?: boolean;
  error?: string;
}

/** A session the owner allowed to use this computer (Allow for this session). */
export interface LocalSessionView {
  dorkId: string;
  dorkTitle: string;
  allowedAt: number;
}

// ---------------------------------------------------------------- the owner's switch and permissions

/** On unless the owner turned it off: a request only asks, so being able to ask is harmless. */
export const localAccessEnabled = (app: App) => app.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", SETTING)?.value !== "off";

/** Whether this dork may use the computer without asking: the owner allowed every session, or this one. */
function allowedVia(app: App, dorkId: string): "always" | "session" | null {
  if (readSettings(app).localAlwaysAllow) return "always";
  const row = app.db.get<{ local_allowed_at: number | null }>("SELECT local_allowed_at FROM dorks WHERE id = ?", dorkId);
  return row?.local_allowed_at != null ? "session" : null;
}

export function localAccessView(app: App): { enabled: boolean; sessions: LocalSessionView[] } {
  const sessions = app.db
    .all<{ id: string; title: string | null; local_allowed_at: number }>(
      "SELECT id, title, local_allowed_at FROM dorks WHERE local_allowed_at IS NOT NULL AND deleting = 0 ORDER BY local_allowed_at DESC",
    )
    .map((d) => ({ dorkId: d.id, dorkTitle: d.title ?? "", allowedAt: d.local_allowed_at }));
  return { enabled: localAccessEnabled(app), sessions };
}

/** Turning it off also ends every permission (each session's and Always allow) and refuses whatever is still waiting. */
export function setLocalAccess(app: App, enabled: unknown) {
  if (typeof enabled !== "boolean") fail("invalid", "enabled must be a boolean");
  app.db.tx(() => {
    app.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", SETTING, enabled ? "ask" : "off");
    if (!enabled) {
      app.db.run("UPDATE dorks SET local_allowed_at = NULL WHERE local_allowed_at IS NOT NULL");
      update(app.db, "settings", { id: 1 }, { localAlwaysAllow: false });
      for (const r of app.db.all<RequestRow>("SELECT * FROM local_requests WHERE status = 'pending'")) settle(app, r, "denied");
    }
    touch(app, { t: "settings" });
  });
}

/** Ends one session's permission, or every session's: their next request asks again (unless Always allow is on). */
export function revokeSessions(app: App, dorkId?: string) {
  app.db.tx(() => {
    if (dorkId) app.db.run("UPDATE dorks SET local_allowed_at = NULL WHERE id = ?", dorkId);
    else app.db.run("UPDATE dorks SET local_allowed_at = NULL WHERE local_allowed_at IS NOT NULL");
    touch(app, { t: "settings" });
  });
}

// ---------------------------------------------------------------- paths

/** `~` and `~/x` are the owner's home; anything else must be absolute. Returns a normalized absolute path. */
export function expandPath(p: string, home = homedir()): string {
  const t = p.trim();
  const expanded = t === "~" ? home : t.startsWith("~/") ? join(home, t.slice(2)) : t;
  if (!isAbsolute(expanded)) fail("invalid", "Give an absolute path or one that starts with ~/ (the owner's home folder).");
  return resolve(expanded);
}

const realOrNull = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

const within = (file: string, dir: string) => file === dir || file.startsWith(dir.endsWith(sep) ? dir : dir + sep);

// ---------------------------------------------------------------- the agent's side (bridge op `local`)

const str = (v: unknown, what: string, max: number, required = true): string | undefined => {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) fail("invalid", `${what} is required.`);
    return undefined;
  }
  if (typeof v !== "string") return fail("invalid", `${what} must be a string.`);
  if (v.length > max) fail("invalid", `${what} is longer than ${max} characters.`);
  if (v.includes("\0")) fail("invalid", `${what} contains a NUL character.`);
  return v.trim();
};

/**
 * The agent asks. Refused at once when the owner turned local access off or another request of this dork is still waiting (one at a
 * time, so the owner is never asked twice at once). A session the owner already allowed (or Always allow) runs it right away;
 * otherwise it waits for the owner's answer.
 */
export function requestLocal(app: App, dorkId: string, args: Record<string, unknown>): LocalResultView {
  const kind = args.kind;
  if (kind !== "run" && kind !== "read") return fail("invalid", "kind must be run or read.");
  const reason = str(args.reason, "reason", MAX_REASON_CHARS)!;
  const command = kind === "run" ? str(args.command, "command", MAX_COMMAND_CHARS) : undefined;
  const cwd = kind === "run" ? expandPath(str(args.cwd, "cwd", MAX_PATH_CHARS, false) ?? "~") : undefined;
  const path = kind === "read" ? expandPath(str(args.path, "path", MAX_PATH_CHARS)!) : undefined;
  let timeoutS = DEFAULT_TIMEOUT_S;
  if (args.timeoutSeconds !== undefined) {
    const t = args.timeoutSeconds;
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_S) fail("invalid", `timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_S}.`);
    timeoutS = t as number;
  }
  const out = app.db.tx(() => {
    const dork = getDork(app.db, dorkId);
    if (!dork || dork.deleting) return fail("not_found", "This session no longer exists.");
    if (!localAccessEnabled(app))
      return fail("forbidden", "The owner turned off access to their computer (Settings, Your computer). Ask them in your reply to run it themselves, or to turn it back on.");
    const waiting = app.db.get<{ id: string }>("SELECT id FROM local_requests WHERE dork_id = ? AND status = 'pending'", dorkId);
    if (waiting) return fail("conflict", `Your earlier request (${waiting.id}) is still waiting for the owner. Wait for it with local_wait before asking again.`);
    const id = app.uuid();
    const now = app.now();
    insert(app.db, "local_requests", { id, dorkId, kind, command, cwd, path, reason, timeoutMs: timeoutS * 1000, status: "pending", expiresAt: now + REQUEST_TTL_MS, createdAt: now });
    append(app, dorkId, { type: "local_request", requestId: id, kind, ...(command ? { command } : {}), ...(cwd ? { cwd } : {}), ...(path ? { path } : {}), reason });
    if (allowedVia(app, dorkId)) {
      allow(app, requestRow(app, id)!, "standing");
      return { id, run: true };
    }
    setTimer(app, dorkId, TIMER + id, REQUEST_TTL_MS);
    return { id, run: false };
  });
  if (out.run) void execute(app, out.id);
  return { requestId: out.id, kind, status: out.run ? "running" : "pending" };
}

const requestRow = (app: App, id: string) => app.db.get<RequestRow>("SELECT * FROM local_requests WHERE id = ?", id);

export function resultView(r: RequestRow): LocalResultView {
  return {
    requestId: r.id,
    kind: r.kind,
    status: r.status,
    ...(r.exit_code !== null || r.status === "done" || r.status === "failed" ? { exitCode: r.exit_code } : {}),
    ...(r.output !== null ? { output: r.output, truncated: !!r.truncated } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

/** The agent waits for the answer and the result: returns once the request is settled, or after `waitMs` with its current status. */
export async function waitLocal(app: App, dorkId: string, requestId: unknown, waitMs: unknown): Promise<LocalResultView> {
  if (typeof requestId !== "string") return fail("invalid", "requestId is required.");
  const budget = typeof waitMs === "number" && Number.isFinite(waitMs) ? Math.min(Math.max(waitMs, 0), MAX_WAIT_MS) : MAX_WAIT_MS;
  const deadline = app.now() + budget;
  for (;;) {
    const r = requestRow(app, requestId);
    if (!r || r.dork_id !== dorkId) return fail("not_found", "There is no such request for this session.");
    if ((r.status !== "pending" && r.status !== "running") || app.now() >= deadline) return resultView(r);
    await app.sleep(250);
  }
}

// ---------------------------------------------------------------- the owner's side

/**
 * The owner answers the access prompt: `deny` this request, `session` (it and every later request of this dork run without asking),
 * or `always` (turns on the `localAlwaysAllow` setting: no session asks again, and whatever other session is waiting runs too).
 */
export function decideLocal(app: App, dorkId: string, requestId: string, decision: unknown) {
  if (decision !== "deny" && decision !== "session" && decision !== "always") fail("invalid", "decision must be deny, session or always");
  const started = app.db.tx(() => {
    const r = requestRow(app, requestId);
    if (!r || r.dork_id !== dorkId) return fail("not_found", "This request no longer exists.");
    if (r.status !== "pending") return fail("conflict", "This request was already answered.");
    if (r.expires_at <= app.now()) {
      settle(app, r, "expired");
      return "expired" as const;
    }
    if (decision === "deny") {
      settle(app, r, "denied");
      return [];
    }
    if (decision === "session") app.db.run("UPDATE dorks SET local_allowed_at = ? WHERE id = ?", app.now(), dorkId);
    else update(app.db, "settings", { id: 1 }, { localAlwaysAllow: true });
    touch(app, { t: "settings" });
    allow(app, r, decision);
    if (decision === "session") return [r.id];
    return [r.id, ...allowWaiting(app)]; // Always allow covers the sessions that are waiting right now, too
  });
  if (started === "expired") fail("conflict", "This request expired.");
  for (const id of started) void execute(app, id);
}

/** In a transaction: every request still waiting for an answer is allowed (Always allow was just turned on). Returns their ids. */
function allowWaiting(app: App): string[] {
  const waiting = app.db.all<RequestRow>("SELECT * FROM local_requests WHERE status = 'pending' AND expires_at > ?", app.now());
  for (const r of waiting) allow(app, r, "standing");
  return waiting.map((r) => r.id);
}

/** Always allow was turned on in Settings: run what is waiting, as answering "Always allow" in the chat does. */
export function startWaitingLocal(app: App) {
  for (const id of app.db.tx(() => allowWaiting(app))) void execute(app, id);
}

/** `session` / `always`: the owner just answered this request so; `standing`: an earlier answer (or Always allow) covered it. */
function allow(app: App, r: RequestRow, via: "session" | "always" | "standing") {
  update(app.db, "local_requests", { id: r.id }, { status: "running", decidedAt: app.now() });
  cancelTimer(app, r.dork_id, TIMER + r.id);
  append(app, r.dork_id, { type: "local_decision", requestId: r.id, decision: "allowed", via });
}

function settle(app: App, r: RequestRow, decision: "denied" | "expired") {
  update(app.db, "local_requests", { id: r.id }, { status: decision, decidedAt: app.now(), error: decision === "denied" ? "The owner declined." : "The owner did not answer in time." });
  cancelTimer(app, r.dork_id, TIMER + r.id);
  if (getDork(app.db, r.dork_id)) append(app, r.dork_id, { type: "local_decision", requestId: r.id, decision });
}

/** The request's expiry timer fired (lifecycle/lifecycle.ts). */
export function expireLocal(app: App, dorkId: string, timerName: string): boolean {
  if (!timerName.startsWith(TIMER)) return false;
  const r = requestRow(app, timerName.slice(TIMER.length));
  if (r && r.dork_id === dorkId && r.status === "pending") settle(app, r, "expired");
  return true;
}

/** A restart lost whatever was running: say so, rather than leave the agent waiting. */
export function recoverLocal(app: App) {
  app.db.tx(() => {
    for (const r of app.db.all<RequestRow>("SELECT * FROM local_requests WHERE status = 'running'"))
      finish(app, r.id, { ok: false, exitCode: null, output: null, truncated: false, error: "Dorks restarted while this ran; it may or may not have finished." });
  });
}

// ---------------------------------------------------------------- doing it

interface Outcome {
  ok: boolean;
  exitCode: number | null;
  output: string | null;
  truncated: boolean;
  error?: string;
}

async function execute(app: App, requestId: string) {
  const r = requestRow(app, requestId);
  if (!r || r.status !== "running") return;
  let outcome: Outcome;
  try {
    outcome = r.kind === "run" ? await runCommand(r.command!, r.cwd!, r.timeout_ms) : readText(app, r.path!);
  } catch (e) {
    outcome = { ok: false, exitCode: null, output: null, truncated: false, error: e instanceof Error ? e.message.slice(0, 300) : "failed" };
  }
  app.db.tx(() => finish(app, requestId, outcome));
}

function finish(app: App, requestId: string, o: Outcome) {
  const r = requestRow(app, requestId);
  if (!r || r.status !== "running") return;
  update(app.db, "local_requests", { id: r.id }, { status: o.ok ? "done" : "failed", exitCode: o.exitCode, output: o.output, truncated: o.truncated, error: o.error ?? null, finishedAt: app.now() });
  if (!getDork(app.db, r.dork_id)) return;
  const text = o.error ?? o.output ?? "";
  const preview = text.length > PREVIEW_CHARS ? "…" + text.slice(-PREVIEW_CHARS) : text;
  append(app, r.dork_id, {
    type: "local_result",
    requestId: r.id,
    ok: o.ok,
    ...(r.kind === "run" ? { exitCode: o.exitCode } : {}),
    preview,
    ...(o.truncated || text.length > PREVIEW_CHARS ? { truncated: true } : {}),
  });
}

/** The owner's login shell and PATH (as a terminal would have them), without the server's own variables. */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SCRUBBED_ENV.test(k)) out[k] = v;
  const path = (out.PATH ?? "").split(delimiter).filter(Boolean);
  out.PATH = [...path, ...EXTRA_PATH.filter((d) => !path.includes(d))].join(delimiter);
  out.HOME ??= homedir();
  out.TERM = "dumb";
  out.NO_COLOR = "1";
  out.CI = "1"; // most tools then skip prompts and spinners: there is no one at a keyboard
  return out;
}

export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SHELL;
  if (s && isAbsolute(s) && existsSync(s)) return s;
  return process.platform === "darwin" ? "/bin/zsh" : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/** Keeps the start and the end of a stream, counting what falls between. */
export class HeadTail {
  private head = "";
  private tail = "";
  private dropped = 0;
  constructor(
    private readonly headMax = OUTPUT_HEAD,
    private readonly tailMax = OUTPUT_TAIL,
  ) {}
  push(s: string) {
    if (this.head.length < this.headMax) {
      const take = s.slice(0, this.headMax - this.head.length);
      this.head += take;
      s = s.slice(take.length);
    }
    if (!s) return;
    this.tail += s;
    if (this.tail.length > this.tailMax) {
      this.dropped += this.tail.length - this.tailMax;
      this.tail = this.tail.slice(-this.tailMax);
    }
  }
  get truncated() {
    return this.dropped > 0;
  }
  text() {
    return this.dropped ? `${this.head}\n… ${this.dropped} characters omitted …\n${this.tail}` : this.head + this.tail;
  }
}

/**
 * Process groups of allowed commands still running. Their time limits are timers in this process, so when the server exits (quit,
 * restart, crash) it ends them too: a command must never outlive its time limit.
 */
const runningGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number) {
  runningGroups.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const g of runningGroups) {
      try {
        process.kill(-g, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

/** Runs one command in the owner's login shell, stdin closed, its whole process group killed at the timeout. */
export function runCommand(command: string, cwd: string, timeoutMs: number, env = process.env): Promise<Outcome> {
  let st;
  try {
    st = statSync(cwd);
  } catch {
    return Promise.resolve({ ok: false, exitCode: null, output: null, truncated: false, error: `The folder ${cwd} does not exist on the owner's computer.` });
  }
  if (!st.isDirectory()) return Promise.resolve({ ok: false, exitCode: null, output: null, truncated: false, error: `${cwd} is not a folder.` });
  return new Promise((done) => {
    const out = new HeadTail();
    const child = spawn(loginShell(env), ["-lc", command], { cwd, env: commandEnv(env), stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
    if (child.pid) trackGroup(child.pid);
    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref?.();
    }, timeoutMs);
    child.stdout!.setEncoding("utf8").on("data", (d: string) => out.push(d));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => out.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      if (child.pid) runningGroups.delete(child.pid);
      done({ ok: false, exitCode: null, output: null, truncated: false, error: `Could not start the shell: ${e.message.slice(0, 200)}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // Whatever the command left running in the background (`cmd &`) would escape its time limit: end the rest of its group too.
      killGroup("SIGKILL");
      if (child.pid) runningGroups.delete(child.pid);
      const output = out.text();
      if (timedOut) return done({ ok: false, exitCode: code, output, truncated: out.truncated, error: `Stopped after ${Math.round(timeoutMs / 1000)} s (the time limit).` });
      done({ ok: code === 0, exitCode: code ?? (signal ? 128 : null), output, truncated: out.truncated });
    });
  });
}

/** Reads one text file. Never Dorks' own data (its keys and database), never a binary, at most MAX_READ_BYTES. */
export function readText(app: App, path: string): Outcome {
  const real = realOrNull(path);
  if (!real) return { ok: false, exitCode: null, output: null, truncated: false, error: `${path} does not exist on the owner's computer.` };
  const dataDir = realOrNull(app.cfg.dataDir) ?? app.cfg.dataDir;
  if (within(real, dataDir)) return { ok: false, exitCode: null, output: null, truncated: false, error: "That file belongs to Dorks itself and is never shared." };
  const st = statSync(real);
  if (!st.isFile()) return { ok: false, exitCode: null, output: null, truncated: false, error: `${path} is not a file.` };
  const fd = openSync(real, "r");
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, n);
    if (bytes.subarray(0, 8192).includes(0)) return { ok: false, exitCode: null, output: null, truncated: false, error: `${path} is a binary file; only text files can be read.` };
    return { ok: true, exitCode: null, output: bytes.toString("utf8"), truncated: st.size > MAX_READ_BYTES };
  } finally {
    closeSync(fd);
  }
}

/** The bridge op: `request` asks (and starts right away in a session the owner allowed), `wait` waits for the answer and the result. */
export async function localOp(app: App, dorkId: string, args: Record<string, unknown>): Promise<unknown> {
  if (args.action === "request") return requestLocal(app, dorkId, args);
  if (args.action === "wait") return waitLocal(app, dorkId, args.requestId, args.waitMs);
  return fail("invalid", "unknown local action");
}
