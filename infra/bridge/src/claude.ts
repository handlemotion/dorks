import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CHILD_ENV_DENY } from "./config";
import type { Log } from "./redact";
import { errTag, type Redactor } from "./redact";

export interface AgentOptions {
  bin: string;
  cwd: string;
  /** Final child env (already filtered + merged). */
  env: NodeJS.ProcessEnv;
  permissionMode: string;
  resumeSessionId: string | null;
  extraArgs: string[];
  redactor: Redactor;
  log: Log;
  onRaw: (raw: unknown) => void;
  /** Not called when the exit was requested through {@link Agent.stop}. */
  onExit: (info: ExitInfo) => void;
}

export interface ExitInfo {
  code: number | null;
  stderrTail: string;
  /** Started with --resume, died before init, and the CLI said it has no such conversation. Nothing was forwarded for this run. */
  resumeMissing: boolean;
  /** Messages written to the CLI that it never got to answer (for a resend on a fresh session). */
  pending: string[];
}

/** Where the CLI keeps transcripts: <config dir>/projects/<encoded cwd>/<session>.jsonl */
export function configDirOf(env: NodeJS.ProcessEnv) {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
}

export function findTranscripts(configDir: string, sessionId: string): string[] {
  const root = join(configDir, "projects");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root).map((d) => join(root, d, `${sessionId}.jsonl`)).filter((f) => existsSync(f));
  } catch {
    return [];
  }
}

const STDERR_TAIL = 2048;

/**
 * argv for the headless streaming CLI (verified against the Claude Code docs + a live run of v2.1.293):
 *   -p                              print/headless mode (required by the stream-json flags)
 *   --input-format stream-json      user turns arrive as JSON lines on stdin; stdin stays open between turns
 *   --output-format stream-json     one JSON event per stdout line
 *   --verbose                       required by stream-json output
 *   --include-partial-messages      emit stream_event deltas so text streams token by token
 *   --permission-mode <mode>        see README: bypassPermissions, because nobody can answer a prompt in an unattended box
 *   --resume <id>                   continue the stored session after a sleep/wake or restart
 * Not used on purpose: --bare (it never reads OAuth, and we authenticate with CLAUDE_CODE_OAUTH_TOKEN), --no-session-persistence
 * (the transcript on disk is what makes resume work).
 */
export function claudeArgs(o: { permissionMode: string; resumeSessionId: string | null; extraArgs?: string[] }): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", o.permissionMode,
    ...(o.resumeSessionId ? ["--resume", o.resumeSessionId] : []),
    ...(o.extraArgs ?? []),
  ];
}

/** Builds the child's env: the bridge's own env minus its identity, plus the user's CLI secrets and the token. */
export function childEnv(base: NodeJS.ProcessEnv, cfgEnv: Record<string, string>, log?: Log): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!CHILD_ENV_DENY.some((re) => re.test(k))) env[k] = v;
  for (const [k, v] of Object.entries(cfgEnv)) {
    if (CHILD_ENV_DENY.some((re) => re.test(k))) log?.("ignoring configured env var with a reserved name:", k);
    else env[k] = v;
  }
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1"; // without it the stream never says the turn is over (session_state_changed idle)
  env.GIT_TERMINAL_PROMPT = "0"; // a credential prompt would hang an unattended box
  return env;
}

export class Agent {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private stderr = "";
  private stopping = false;
  private exited = false;
  sessionId: string | null;
  /** False from the moment a user message is written until the CLI reports `idle`. */
  idle = true;
  private idleWaiters: (() => void)[] = [];
  private sawInit = false;
  private holding: boolean;
  private held: unknown[] = []; // a resumed CLI's output until it proves the session loaded (system/init)
  private pending: string[] = [];

  constructor(private o: AgentOptions) {
    this.sessionId = o.resumeSessionId;
    this.holding = !!o.resumeSessionId;
    this.child = spawn(o.bin, claudeArgs(o), { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d: string) => this.onStdout(d));
    // stderr can echo env or tokens: keep a tail for the exit report (scrubbed), never log it.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d: string) => {
      this.stderr = (this.stderr + d).slice(-STDERR_TAIL);
    });
    this.child.stdin.on("error", () => {}); // EPIPE after death is reported through 'close'
    this.child.on("error", (e) => {
      this.stderr = `spawn failed (${errTag(e)})`;
      this.finish(null);
    });
    this.child.on("close", (code) => this.finish(code));
  }

  get pid() {
    return this.child.pid;
  }

  get alive() {
    return !this.exited && !this.stopping;
  }

  private finish(code: number | null) {
    if (this.exited) return;
    this.exited = true;
    if (this.buf.trim()) this.line(this.buf);
    this.buf = "";
    for (const w of this.idleWaiters.splice(0)) w();
    // `claude --resume <unknown id>` prints "No conversation found..." (as an error result and/or on stderr) and exits 1.
    const resumeMissing = !!this.o.resumeSessionId && !this.sawInit && /No conversation found/i.test(this.stderr + JSON.stringify(this.held));
    if (resumeMissing) this.held = [];
    else this.releaseHeld();
    if (!this.stopping) this.o.onExit({ code, stderrTail: this.o.redactor.scrub(this.stderr), resumeMissing, pending: [...this.pending] });
  }

  private onStdout(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const l = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.line(l);
    }
  }

  private line(l: string) {
    if (!l.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(l);
    } catch {
      return; // not ours to log: a non-JSON stdout line is arbitrary CLI output
    }
    const m = msg as { type?: string; subtype?: string; state?: string; session_id?: string; request_id?: string; request?: { subtype?: string } };
    if (typeof m.session_id === "string" && m.type !== "control_response") this.sessionId = m.session_id;
    if (m.type === "system" && m.subtype === "session_state_changed") {
      this.idle = m.state === "idle";
      if (this.idle) {
        if (this.sawInit) this.pending = [];
        for (const w of this.idleWaiters.splice(0)) w();
      }
    }
    if (m.type === "control_request") return this.answerControlRequest(m);
    if (m.type === "control_response") return; // receipts for our own interrupt requests
    if (m.type === "system" && m.subtype === "init") {
      this.sawInit = true;
      this.releaseHeld();
    } else if (this.holding && this.held.length < 200) {
      this.held.push(msg);
      return;
    } else this.releaseHeld(); // far more output than a failed start would produce: stop holding, keep order
    this.o.onRaw(msg);
  }

  private releaseHeld() {
    this.holding = false;
    for (const h of this.held.splice(0)) this.o.onRaw(h);
  }

  /**
   * The CLI asks its host (us) to decide permission prompts, hooks, MCP and elicitation. Nobody is here to answer: deny, so the turn
   * continues instead of hanging forever. Under bypassPermissions only the few always-prompt safety checks reach this path.
   */
  private answerControlRequest(m: { request_id?: string; request?: { subtype?: string } }) {
    const id = m.request_id;
    if (!id) return;
    const reply =
      m.request?.subtype === "can_use_tool"
        ? { subtype: "success", request_id: id, response: { behavior: "deny", message: "This is an unattended sandbox: nobody can approve this action. Choose a different approach." } }
        : { subtype: "error", request_id: id, error: "not supported by the unattended bridge" };
    void this.write({ type: "control_response", response: reply });
  }

  private write(obj: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child.stdin.writable) return reject(new Error("agent not running"));
      this.child.stdin.write(`${JSON.stringify(obj)}\n`, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Resolves once the line is flushed to the CLI's stdin. */
  async sendUserMessage(text: string) {
    await this.write({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    this.idle = false;
    this.pending.push(text);
  }

  /** The documented way to stop the current turn in streaming-input mode: a control_request, not a signal (SIGTERM would end the session). */
  interrupt() {
    return this.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
  }

  /** Resolves when the CLI is between turns, or after `ms`. Returns whether it is idle. */
  waitIdle(ms: number): Promise<boolean> {
    if (this.idle || this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.idle), ms);
      this.idleWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  /** Ends stdin (the CLI finishes the turn and exits), then escalates to SIGTERM / SIGKILL. Does not report agent_exited. */
  async stop(graceMs = 5000) {
    if (this.exited) return;
    this.stopping = true;
    this.child.stdin.end();
    const done = new Promise<void>((r) => this.child.once("close", () => r()));
    const t1 = setTimeout(() => this.child.kill("SIGTERM"), graceMs);
    const t2 = setTimeout(() => this.child.kill("SIGKILL"), graceMs * 2);
    await done;
    clearTimeout(t1);
    clearTimeout(t2);
  }
}
