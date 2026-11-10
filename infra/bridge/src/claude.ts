import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentModelChoice } from "@dorks/shared";
import { CHILD_ENV_DENY } from "./config";
import { FINAL_ANSWER_GUIDANCE } from "./guidance";
import { asIdentity, type Identity } from "./runas";
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
  /** `--model` / `--effort`; absent: the CLI's default. */
  model?: string;
  effort?: string;
  /** Hooks for the CLI (`--settings`); merged with the repo's own settings, see hooks.ts. */
  settingsFile?: string;
  /** The `dorks` MCP server for the CLI (`--mcp-config`), see mcp.ts. */
  mcpConfigFile?: string;
  runAs?: Identity | null;
  redactor: Redactor;
  log: Log;
  onRaw: (raw: unknown) => void;
  /** The models the CLI offers this account, from its answer to our `initialize` request. */
  onModels?: (models: AgentModelChoice[]) => void;
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

/** Boat's Cua Driver (docs/computer-use.md): present on every Boat sandbox, absent in the simulator and on a dev machine. */
export const BOAT_COMPUTER_DRIVER = "/opt/ascii/cua-driver/cua-driver";

/**
 * Boat registers its `computer` MCP server in ~/.claude.json, which the CLI loads next to our --mcp-config, so the tools are already
 * there. This only tells the agent the screen exists and that the owner is watching it, so it reaches for it to check its own work.
 */
export const COMPUTER_PROMPT = [
  "This sandbox has a Linux desktop (1920x1080, Google Chrome) that you drive with the `mcp__computer__*` tools: get_desktop_state for a screenshot,",
  "get_window_state for a window's elements, click/type_text/hotkey, launch_app, and browser_navigate/get_browser_state for Chrome.",
  "The owner watches this screen live in the Computer tab. Use it to look at what you build (open your dev server in Chrome) and for",
  "tasks that need a GUI or a real browser; prefer the shell for everything else.",
].join(" ");

export function computerArgs(driverPresent = existsSync(BOAT_COMPUTER_DRIVER)): string[] {
  return driverPresent ? ["--append-system-prompt", COMPUTER_PROMPT] : [];
}

/**
 * argv for the headless streaming CLI (verified against the Claude Code docs + a live run of v2.1.293):
 *   -p                              print/headless mode (required by the stream-json flags)
 *   --input-format stream-json      user turns arrive as JSON lines on stdin; stdin stays open between turns
 *   --output-format stream-json     one JSON event per stdout line
 *   --verbose                       required by stream-json output
 *   --include-partial-messages      emit stream_event deltas so text streams token by token
 *   --permission-mode <mode>        see README: bypassPermissions, because nobody can answer a prompt in an unattended box
 *   --settings <file>               the autonomy hooks (hooks.ts); applied above user/project settings, whose hooks still run
 *   --mcp-config <file>             the `dorks` MCP server (mcp.ts): PR subscription tools. Added on top of the repo's own MCP servers, not instead
 *   --model / --effort              the model and effort chosen in the UI (omitted: the CLI's default)
 *   --append-system-prompt          the standing final-answer guidance (guidance.ts), on top of Claude Code's own system prompt
 *   --resume <id>                   continue the stored session after a sleep/wake or restart
 * Not used on purpose: --bare (it never reads OAuth, and we authenticate with CLAUDE_CODE_OAUTH_TOKEN), --no-session-persistence
 * (the transcript on disk is what makes resume work).
 */
export function claudeArgs(o: { permissionMode: string; resumeSessionId: string | null; extraArgs?: string[]; settingsFile?: string; mcpConfigFile?: string; model?: string; effort?: string }): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", o.permissionMode,
    ...(o.model ? ["--model", o.model] : []),
    ...(o.effort ? ["--effort", o.effort] : []),
    "--append-system-prompt", FINAL_ANSWER_GUIDANCE,
    ...(o.settingsFile ? ["--settings", o.settingsFile] : []),
    ...(o.mcpConfigFile ? ["--mcp-config", o.mcpConfigFile] : []),
    ...(o.resumeSessionId ? ["--resume", o.resumeSessionId] : []),
    ...(o.extraArgs ?? []),
  ];
}

/** Builds the child's env: the bridge's own env minus its identity, plus the user's CLI secrets and the token. */
export function childEnv(base: NodeJS.ProcessEnv, cfgEnv: Record<string, string>, log?: Log, id?: Identity | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!CHILD_ENV_DENY.some((re) => re.test(k))) env[k] = v;
  for (const [k, v] of Object.entries(cfgEnv)) {
    if (CHILD_ENV_DENY.some((re) => re.test(k))) log?.("ignoring configured env var with a reserved name:", k);
    else env[k] = v;
  }
  if (id) Object.assign(env, { HOME: id.home, USER: id.user, LOGNAME: id.user });
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
  private initRequest = randomUUID();

  constructor(private o: AgentOptions) {
    this.sessionId = o.resumeSessionId;
    this.holding = !!o.resumeSessionId;
    const [bin, args] = asIdentity(o.runAs, o.bin, claudeArgs(o));
    this.child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
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
    // The SDK's handshake: the answer lists the models (and efforts) this account can use, which is what the UI offers.
    void this.write({ type: "control_request", request_id: this.initRequest, request: { subtype: "initialize" } }).catch(() => {});
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
    if (m.type === "control_response") return this.onControlResponse(msg); // receipts for our own requests
    if (m.type === "system" && m.subtype === "init") {
      this.sawInit = true;
      this.releaseHeld();
    } else if (this.holding && this.held.length < 200) {
      this.held.push(msg);
      return;
    } else this.releaseHeld(); // far more output than a failed start would produce: stop holding, keep order
    this.o.onRaw(msg);
  }

  private onControlResponse(msg: unknown) {
    const r = (msg as { response?: { request_id?: string; subtype?: string; response?: { models?: unknown } } }).response;
    if (r?.request_id !== this.initRequest || r.subtype !== "success" || !this.o.onModels) return;
    this.o.onModels(modelChoices(r.response?.models));
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

const MODEL_VALUE = /^[a-zA-Z0-9._:[\]-]{1,64}$/;
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/** The CLI's `initialize` model list (`{value, displayName, description, resolvedModel, supportedEffortLevels}`) in the wire shape. */
export function modelChoices(raw: unknown): AgentModelChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentModelChoice[] = [];
  for (const m of raw.slice(0, 100)) {
    const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
    if (typeof o.value !== "string" || !MODEL_VALUE.test(o.value)) continue;
    const name = typeof o.displayName === "string" && o.displayName ? o.displayName.slice(0, 80) : o.value;
    const efforts = Array.isArray(o.supportedEffortLevels) ? o.supportedEffortLevels.filter((e): e is AgentModelChoice["efforts"][number] => EFFORTS.includes(e)) : [];
    out.push({
      model: o.value,
      name,
      ...(typeof o.description === "string" && o.description ? { description: o.description.slice(0, 200) } : {}),
      ...(typeof o.resolvedModel === "string" && MODEL_VALUE.test(o.resolvedModel) ? { resolved: o.resolvedModel } : {}),
      efforts,
    });
  }
  return out;
}
