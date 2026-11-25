import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, chownSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { asIdentity, type Identity } from "./runas";
import { errTag, type Log, type Redactor } from "./redact";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const clip = (v: string) => v.slice(0, 16 * 1024);
/** A model slug as `agy models` lists it (`gemini-4-neon-high`, `gemini-3.8-flash-medium`). */
const SLUG = /^[a-zA-Z0-9._:-]{1,64}$/;
/** `![name](dorks-image:<id>)`: an attached image. agy's stream input takes text blocks only, so it stays a note. */
const ATTACHED = /!\[([^\]]*)\]\(\s*dorks-image:[0-9a-f]{32}\s*\)/g;
/** The secrets that sign agy in (docs/env.md): the subscription's token file, or a Gemini API key. */
export const ANTIGRAVITY_TOKEN_VAR = "ANTIGRAVITY_OAUTH_TOKEN";
const AUTH_FAILURE = /authentication required|not (signed|logged) in|sign[- ]in|unauthenticated|401|login/i;

export interface AntigravityOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** A slug from `agy models`; omitted: the CLI's default. */
  model?: string;
  resumeSessionId: string | null;
  runAs: Identity | null;
  mcpCommand: [string, string];
  sock: string;
  /** The owner's MCP servers in Claude Code's config form (hooks.ts `userMcpServers`), translated here. */
  userMcp: Record<string, unknown>;
  /** Where skills are synced (the Claude config dir's `skills`), so agy loads the same ones. */
  skillsDir: string;
  /** The standing instructions (final answer, skills, crew, computer), as an always-on rule. */
  system: string;
  bin?: string;
  redactor: Redactor;
  log: Log;
  onRaw: (raw: unknown) => void;
  onReady: () => void;
  onModels: (models: { model: string; name: string }[]) => void;
  onIssue: (message: string) => void;
  /** The done gate (hook.stop): a reason to keep going, sent as the next turn, or null. */
  onTurnFinished: (sessionId: string) => Promise<string | null>;
  /** A finished shell call (hook.postToolUse): subscribes the PRs it opened, drops the ones it merged or closed. */
  onShell: (command: string, output: string) => void;
  /** The autonomy briefing (hook.sessionStart), prepended to the first turn of a fresh conversation. */
  sessionContext: () => Promise<string | null>;
  onExit: (info: { code: number | null; stderrTail: string; resumeMissing: boolean; pending: string[] }) => void;
}

/** `${NAME}` references (Claude Code's config form) resolved from the agent's env: agy's mcp_config.json has no interpolation. */
const resolveRefs = (v: string, env: NodeJS.ProcessEnv) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => env[name] ?? "");
const mapValues = (v: unknown, env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, resolveRefs(text(x), env)]));

/** agy's `mcp_config.json` servers: the dorks server plus the owner's (remote servers use `serverUrl`, stdio ones `command`/`args`/`env`). */
export function antigravityMcpServers(o: Pick<AntigravityOptions, "mcpCommand" | "sock" | "userMcp">, env: NodeJS.ProcessEnv): Json {
  const servers: Json = {};
  for (const [name, raw] of Object.entries(o.userMcp)) {
    const s = obj(raw);
    if (s.type === "http") servers[name] = { serverUrl: resolveRefs(text(s.url), env), headers: mapValues(s.headers, env) };
    else if (s.type === "stdio") servers[name] = { command: text(s.command), args: Array.isArray(s.args) ? s.args.map(text) : [], env: mapValues(s.env, env) };
  }
  servers.dorks = { command: o.mcpCommand[0], args: [o.mcpCommand[1], "dorks", "mcp"], env: { DORKS_SOCK: o.sock } };
  return servers;
}

/** argv for agy's streaming headless mode: prompts as JSON lines on stdin, events as JSON lines on stdout, one process for the session. */
export function antigravityArgs(o: { model?: string; resumeSessionId: string | null }): string[] {
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    // Nobody can answer a permission prompt in an unattended box (the Claude equivalent is bypassPermissions).
    "--dangerously-skip-permissions",
    "--print-timeout",
    "0s",
    ...(o.model ? ["--model", o.model] : []),
    ...(o.resumeSessionId ? ["--conversation", o.resumeSessionId] : []),
  ];
}

/** `agy models`: `<slug>\t<label>` per line when piped (1.5.14), `<slug>   <label>` in a terminal. */
export function parseModels(out: string): { model: string; name: string }[] {
  const models: { model: string; name: string }[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\S+)(?:\t+|\s{2,})(\S.*?)\s*$/.exec(line);
    if (m && SLUG.test(m[1]!) && !models.some((x) => x.model === m[1])) models.push({ model: m[1]!, name: m[2]!.slice(0, 80) });
  }
  return models.slice(0, 100);
}

/** agy's parameters that say what a call is about, most telling first (a command, a file, a search). */
const SUMMARY_KEYS = [
  "CommandLine",
  "TargetFile",
  "AbsolutePath",
  "Path",
  "File",
  "DirectoryPath",
  "SearchPath",
  "SearchDirectory",
  "Query",
  "query",
  "Pattern",
  "Url",
  "Uri",
  "Prompt",
  "Description",
  "Message",
];

/** A short line for a tool call in the transcript, from agy's tool parameters: a known field, else its first short one-line string. */
function toolSummary(params: Json): string {
  for (const k of SUMMARY_KEYS) {
    const v = params[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  for (const v of Object.values(params)) if (typeof v === "string" && v.trim() && v.length <= 300 && !v.includes("\n")) return v;
  return "";
}

/**
 * The Antigravity CLI (`agy`, Google's Gemini agent), in its streaming headless mode, speaking the same transcript shape as the Claude
 * agent. The autonomy hooks Claude Code runs from its settings run here from the bridge: the done gate when a turn's result arrives, the
 * PR subscription check on every finished `run_command`, and the briefing on a fresh conversation's first turn. agy keeps its
 * conversations on disk (`~/.gemini/antigravity-cli`), so a restart resumes with `--conversation`.
 */
export class AntigravityAgent {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buf = "";
  private stderr = "";
  private stopped = false;
  private exited = false;
  private respawning = false;
  /** agy announces the conversation (`init`) before it reads a prompt: the first turn waits for it, to know whether it resumed. */
  private initSeen = false;
  private queue: string[] = [];
  private current: string | null = null;
  private startedAt = 0;
  private briefed: boolean;
  private finishing = false;
  private turnsDone = 0;
  private idleWaiters: (() => void)[] = [];
  /** Streamed answer text by step, until the step is DONE and the whole text is sent as one assistant message. */
  private texts = new Map<string, string>();
  private shown = new Set<string>();
  private home: string;
  sessionId: string | null;
  idle = true;
  ready = false;
  /** The agy binary in use: `bin`, or `agy` from PATH, or the one installed into this box (ensureAgy). */
  private bin = "agy";

  constructor(private o: AntigravityOptions) {
    this.sessionId = o.resumeSessionId;
    this.briefed = !!o.resumeSessionId; // a resumed conversation had its briefing on its first turn
    this.home = o.env.HOME || homedir();
    try {
      this.prepareHome();
    } catch (e) {
      o.log("antigravity: could not prepare its config:", errTag(e));
    }
    void this.start();
  }

  /** agy, installed first when the image lacks it (a build made before Antigravity), then the session and the model list. */
  private async start() {
    try {
      this.bin = await ensureAgy(this.o.bin, this.o.env, this.o.log);
    } catch (e) {
      this.o.log("antigravity: could not install the Antigravity CLI:", errTag(e));
      this.o.onIssue("This sandbox has no Antigravity CLI and it could not be installed. Rebuild this machine's build (Builds), or start the session on the base machine.");
      this.stderr = `agy is not installed (${errTag(e)})`;
      this.exited = true;
      return this.o.onExit({ code: null, stderrTail: this.stderr, resumeMissing: false, pending: [...this.queue] });
    }
    if (this.stopped) return;
    this.spawn();
    void this.listModels();
  }

  get alive() {
    return !this.exited && !this.stopped;
  }

  /** The agent user's files, created (or merged into) before agy starts. All of them stay in that user's home. */
  private prepareHome() {
    const cli = join(this.home, ".gemini", "antigravity-cli");
    const config = join(this.home, ".gemini", "config");
    this.ensureDir(cli);
    this.ensureDir(join(config, "rules"));
    const env = this.o.env;
    const token = env[ANTIGRAVITY_TOKEN_VAR]?.trim();
    // The subscription: agy keeps its sign-in in this file when no keyring is reachable (a sandbox has none).
    if (token) this.writeOwned(join(cli, "antigravity-oauth-token"), decodeToken(token), 0o600);
    const settingsFile = join(cli, "settings.json");
    const settings = { ...readJson(settingsFile) };
    Object.assign(settings, {
      toolPermission: "always-proceed",
      artifactReviewPolicy: "always-proceed",
      notifications: false,
      showTips: false,
      showFeedbackSurvey: false,
      trustedWorkspaces: [...new Set([...(Array.isArray(settings.trustedWorkspaces) ? settings.trustedWorkspaces.map(text) : []), this.o.cwd])],
    });
    // A Gemini API key instead of the subscription: agy only uses it with this provider set.
    if (!token && env.GEMINI_API_KEY) settings.modelProvider = "gemini";
    else delete settings.modelProvider;
    this.writeOwned(settingsFile, JSON.stringify(settings, null, 2) + "\n", 0o600);
    // MCP: the dorks server and the owner's, beside whatever the box already registered. Values are real (agy has no references), so 0600.
    const mcpFile = join(config, "mcp_config.json");
    const mcp = readJson(mcpFile);
    this.writeOwned(mcpFile, JSON.stringify({ ...mcp, mcpServers: { ...obj(mcp.mcpServers), ...antigravityMcpServers(this.o, env) } }, null, 2) + "\n", 0o600);
    this.writeOwned(join(config, "rules", "dorks.md"), `---\ntrigger: always_on\n---\n\n${this.o.system}\n`, 0o644);
    // Skills: agy reads ~/.gemini/antigravity-cli/skills; point it at the folder the bridge syncs for Claude Code.
    const skills = join(cli, "skills");
    if (!present(skills) && existsSync(this.o.skillsDir)) {
      symlinkSync(this.o.skillsDir, skills);
      if (this.o.runAs) lchown(skills, this.o.runAs);
    }
  }

  private ensureDir(dir: string) {
    if (existsSync(dir)) return;
    this.ensureDir(dirname(dir));
    mkdirSync(dir, { mode: 0o700 });
    if (this.o.runAs) chownSync(dir, this.o.runAs.uid, this.o.runAs.gid);
  }

  private writeOwned(file: string, body: string | Buffer, mode: number) {
    writeFileSync(file, body, { mode });
    chmodSync(file, mode);
    if (this.o.runAs) chownSync(file, this.o.runAs.uid, this.o.runAs.gid);
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.o.env };
    delete env[ANTIGRAVITY_TOKEN_VAR]; // written to the token file; the agent's shell has no use for it
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    // No keyring in a sandbox: an unreachable bus makes agy use its token file at once instead of trying one.
    env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/nonexistent/dorks-no-keyring";
    return env;
  }

  private spawn() {
    const [bin, args] = asIdentity(this.o.runAs, this.bin, antigravityArgs({ model: this.o.model, resumeSessionId: this.sessionId }));
    const child = spawn(bin, args, { cwd: this.o.cwd, env: this.childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buf = "";
    this.initSeen = false;
    // Never wait on it forever: an agy that says nothing still gets the turn (its exit is reported as usual).
    setTimeout(() => {
      if (this.child === child && !this.initSeen) {
        this.initSeen = true;
        void this.pump();
      }
    }, 20_000).unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (s: string) => this.read(s));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (s: string) => {
      this.stderr = (this.stderr + s).slice(-2048);
    });
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      this.stderr = `spawn failed (${errTag(e)})`;
      this.closed(child, null);
    });
    child.on("close", (code) => this.closed(child, code));
    // agy reads prompts as soon as it starts: the bridge can send at once, as with Claude Code.
    if (!this.ready) {
      this.ready = true;
      queueMicrotask(() => this.alive && this.o.onReady());
    }
    void this.pump();
  }

  /** The models this account can use (`agy models`), for the thread's model menu. Best effort. */
  private async listModels() {
    const out = await this.run(["models"], 30_000).catch(() => "");
    const models = parseModels(out);
    if (models.length) this.o.onModels(models);
  }

  /** A separate agy command as the agent user (models, the title turn). Resolves to its stdout. */
  private run(args: string[], timeoutMs: number): Promise<string> {
    const [bin, argv] = asIdentity(this.o.runAs, this.bin, args);
    return new Promise((resolve, reject) =>
      execFile(bin, argv, { cwd: this.o.cwd, env: this.childEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
    );
  }

  private read(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        this.event(obj(JSON.parse(line)));
      } catch {
        // not an event: arbitrary CLI output
      }
    }
  }

  private event(e: Json) {
    switch (e.event) {
      case "init": {
        const id = text(e.conversation_id);
        // agy starts a new conversation, without an error, when the one to resume is gone (a box recreated without its disk): brief it.
        if (id && this.o.resumeSessionId && id !== this.o.resumeSessionId && this.turnsDone === 0) this.briefed = false;
        if (id) this.sessionId = id;
        const model = text(obj(e.init).model);
        this.o.onRaw({ type: "system", subtype: "init", session_id: this.sessionId, ...(model ? { model } : {}) });
        this.initSeen = true;
        void this.pump();
        return;
      }
      case "step_update":
        return this.step(obj(e.step_update));
      case "result":
        return void this.result(obj(e.result));
    }
  }

  private step(s: Json) {
    const conversation = text(s.conversation_id);
    if (conversation && !this.sessionId) this.sessionId = conversation;
    const id = `${conversation || this.sessionId}:${String(s.step_index)}`;
    const done = s.state === "DONE";
    if (s.step_type === "agent_response") {
      const delta = text(s.text_delta);
      if (delta) {
        if (!this.texts.has(id)) this.o.onRaw({ type: "stream_event", event: { type: "message_start", message: { id } } });
        this.texts.set(id, (this.texts.get(id) ?? "") + delta);
        this.o.onRaw({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } } });
      }
      if (done) this.showText(id);
      return;
    }
    if (s.step_type === "tool" || s.tool_info || s.subagent_info) this.tool(id, s, done);
  }

  private showText(id: string) {
    const body = this.texts.get(id);
    this.texts.delete(id);
    if (!body?.trim() || this.shown.has(id)) return;
    this.shown.add(id);
    this.o.onRaw({ type: "assistant", message: { id, content: [{ type: "text", text: body }] } });
  }

  private tool(id: string, s: Json, done: boolean) {
    const info = obj(s.tool_info);
    const name = text(info.name) || text(s.tool_name) || (s.subagent_info ? "invoke_subagent" : "tool");
    const params = obj(info.parameters);
    // agy announces a call before its parameters are in (the model is still writing it): the call waits until they say what it does,
    // or until the step ends, so it is never shown (and kept) with an empty input.
    if (!this.shown.has(id) && !done && !toolSummary(params)) return;
    if (!this.shown.has(id)) {
      this.shown.add(id);
      this.o.onRaw({ type: "assistant", message: { id: `${id}:use`, content: [{ type: "tool_use", id, name, input: { description: clip(this.o.redactor.scrub(toolSummary(params))) } }] } });
    }
    if (!done || this.shown.has(`${id}:done`)) return;
    this.shown.add(`${id}:done`);
    const error = obj(info.error);
    const failed = !!(text(error.message) || text(error.type));
    const output = text(info.output) || text(error.message) || (s.subagent_info ? "subagents started" : "");
    this.o.onRaw({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: failed, content: clip(this.o.redactor.scrub(output)) }] } });
    if (name === "run_command" && !failed) this.o.onShell(text(params.CommandLine), text(info.output));
  }

  /** A turn's `result`: shows any text the stream left open, runs the done gate, then the next queued message. */
  private async result(r: Json) {
    if (this.finishing) return;
    this.finishing = true;
    for (const id of [...this.texts.keys()]) this.showText(id);
    const id = text(r.conversation_id);
    if (id) this.sessionId = id;
    const status = text(r.status);
    const failed = status !== "SUCCESS";
    const error = text(r.error) || (status === "INTERRUPTED" || status === "CANCELED" ? "interrupted" : status ? `Antigravity ended the turn: ${status}` : "");
    if (failed && AUTH_FAILURE.test(error)) this.authIssue();
    this.o.onRaw({ type: "result", is_error: failed, result: clip(this.o.redactor.scrub(failed ? error : "completed")), duration_ms: Date.now() - this.startedAt, session_id: this.sessionId });
    if (!failed) this.turnsDone++;
    this.current = null;
    if (!failed && this.sessionId) {
      const reason = await this.o.onTurnFinished(this.sessionId).catch(() => null);
      if (reason) this.queue.unshift(reason);
    }
    this.finishing = false;
    if (!this.queue.length) {
      this.idle = true;
      this.o.onRaw({ type: "system", subtype: "session_state_changed", state: "idle" });
      for (const wake of this.idleWaiters.splice(0)) wake();
    } else void this.pump();
  }

  private authIssue() {
    this.o.onIssue(`Antigravity is not signed in. Save your Antigravity sign-in as the shared secret ${ANTIGRAVITY_TOKEN_VAR} (or a Gemini API key as GEMINI_API_KEY), then send a message to retry.`);
  }

  private async pump() {
    if (!this.ready || !this.initSeen || this.current !== null || this.finishing || this.respawning || !this.queue.length || !this.alive) return;
    // Everything that waited goes in one turn. agy takes nothing mid-turn, so messages sent while it works (steering, notifications)
    // pile up here; one turn each made the agent answer them one by one, late, and a Stop only skipped to the next of them.
    this.current = this.queue.splice(0).join("\n\n");
    this.idle = false;
    this.startedAt = Date.now();
    let prompt = this.current.replace(ATTACHED, (_all, name: string) => `[${name.trim() || "image"}: attached, but Antigravity takes text only]`);
    if (!this.briefed) {
      this.briefed = true;
      const context = await this.o.sessionContext().catch(() => null);
      if (context) prompt = `<system-reminder>\n${context}\n</system-reminder>\n\n${prompt}`;
    }
    try {
      await this.write({ event: "user", message: { content: prompt } });
    } catch (e) {
      this.o.log("antigravity: could not send the turn:", errTag(e));
    }
  }

  private write(value: Json) {
    return new Promise<void>((resolve, reject) => {
      const child = this.child;
      if (!this.alive || !child?.stdin.writable) return reject(new Error("Antigravity is not running"));
      child.stdin.write(`${JSON.stringify(value)}\n`, (e) => (e ? reject(e) : resolve()));
    });
  }

  async sendUserMessage(message: string) {
    if (!this.alive) throw new Error("Antigravity is not running");
    this.queue.push(message);
    this.idle = false; // busy from the moment it is queued, so a restart waits for it (waitIdle) instead of dropping it
    await this.pump();
  }

  /** One turn beside the session (the title), in its own short-lived `agy -p` run. Resolves to the reply, or null. */
  async oneShot(prompt: string, timeoutMs = 45_000): Promise<string | null> {
    const args = ["-p", prompt, "--output-format", "json", "--disable-slash-commands", ...(this.o.model ? ["--model", this.o.model] : [])];
    const out = await this.run(args, timeoutMs).catch(() => "");
    const r = obj(
      (() => {
        try {
          return JSON.parse(out.trim().split("\n").pop() ?? "");
        } catch {
          return null;
        }
      })(),
    );
    return r.status === "SUCCESS" ? text(r.response) || null : null;
  }

  /**
   * agy's stream input has no interrupt message (a control request ends the session), so the turn is stopped the way its terminal
   * does it, with SIGINT. If the CLI exits on it, it is started again on the same conversation with the queue intact.
   */
  async interrupt() {
    if (this.current === null || !this.alive || !this.child) return;
    this.respawning = true;
    const child = this.child;
    child.kill("SIGINT");
    // Still running and the turn ended: SIGINT only cancelled the turn. agy may take a while to end it (a tool still finishing), so
    // keep checking until it does or the process exits (then `closed` restarts it); otherwise the queue would wait forever.
    const check = () => {
      if (!this.respawning || this.child !== child || child.exitCode !== null || this.stopped) return;
      if (this.current !== null) return void setTimeout(check, 1000).unref();
      this.respawning = false;
      void this.pump();
    };
    setTimeout(check, 3000).unref();
  }

  waitIdle(ms: number): Promise<boolean> {
    if (this.idle || this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.idle), ms);
      this.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private closed(child: ChildProcessWithoutNullStreams, code: number | null) {
    if (child !== this.child || this.exited) return;
    if (this.buf.trim()) this.read("\n");
    if (this.respawning && !this.stopped) {
      // An interrupt: the turn is over (say so if agy did not), and the conversation goes on in a new process.
      this.respawning = false;
      if (this.current !== null) {
        this.o.onRaw({ type: "result", is_error: true, result: "interrupted", duration_ms: Date.now() - this.startedAt, session_id: this.sessionId });
        this.current = null;
      }
      if (!this.queue.length) {
        this.idle = true;
        this.o.onRaw({ type: "system", subtype: "session_state_changed", state: "idle" });
        for (const wake of this.idleWaiters.splice(0)) wake();
      }
      this.spawn();
      return;
    }
    this.exited = true;
    for (const wake of this.idleWaiters.splice(0)) wake();
    const stderrTail = this.o.redactor.scrub(this.stderr);
    if (!this.stopped && AUTH_FAILURE.test(stderrTail)) this.authIssue();
    // A missing conversation is never an exit: agy starts a new one (see the init handler).
    if (!this.stopped) this.o.onExit({ code, stderrTail, resumeMissing: false, pending: [this.current, ...this.queue].filter((s): s is string => s !== null) });
  }

  /** Ends stdin (agy finishes the turn and exits), then escalates to SIGTERM / SIGKILL. Does not report agent_exited. */
  async stop(graceMs = 5000) {
    if (this.exited) return;
    this.stopped = true;
    const child = this.child;
    if (!child) return void (this.exited = true); // still installing agy: start() sees `stopped` and never spawns
    const done = new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once("close", () => resolve())));
    child.stdin.end();
    const t1 = setTimeout(() => child.kill("SIGTERM"), graceMs);
    const t2 = setTimeout(() => child.kill("SIGKILL"), graceMs * 2);
    await done;
    clearTimeout(t1);
    clearTimeout(t2);
    this.exited = true;
  }
}

function readJson(file: string): Json {
  try {
    return obj(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

/** Whether anything is at the path, a dangling symlink included (existsSync follows links). */
function present(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function lchown(path: string, id: Identity) {
  try {
    if (lstatSync(path).isSymbolicLink()) execFile("chown", ["-h", `${id.uid}:${id.gid}`, path], () => {});
  } catch {}
}

/** The token file as saved: its text, or base64 of it (`base64 < antigravity-oauth-token`), which survives any binary content. */
export function decodeToken(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 === 0 && !/^[\[{]/.test(value)) {
    const raw = Buffer.from(compact, "base64");
    if (raw.length && raw.toString("base64") === compact) return raw;
  }
  return Buffer.from(value);
}

const MANIFESTS = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The agy to run. A box whose image predates Antigravity (a build made on an older base snapshot) has none: the bridge, which runs
 * as root in a sandbox, installs Google's current build into /usr/local/bin, checksum-verified against Google's manifest, the
 * same file infra/snapshot/boat-install.sh installs. Once per box; it takes about a minute.
 */
export async function ensureAgy(configured: string | undefined, env: NodeJS.ProcessEnv, log: Log, fetchFn: typeof fetch = fetch): Promise<string> {
  if (configured) return configured;
  for (const d of [...(env.PATH ?? "").split(delimiter).filter(Boolean), "/usr/local/bin"]) if (executable(join(d, "agy"))) return join(d, "agy");
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0) throw new Error("agy not found");
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!arch) throw new Error(`no agy for ${process.arch}`);
  log("antigravity: agy is not in this image, installing it");
  const manifest = await (await fetchFn(`${MANIFESTS}/linux_${arch}.json`)).text();
  const field = (k: string) => new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`).exec(manifest)?.[1];
  const url = field("url");
  const sha512 = field("sha512");
  if (!url?.startsWith("https://") || !sha512) throw new Error("bad agy manifest");
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`agy download ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (createHash("sha512").update(body).digest("hex") !== sha512) throw new Error("agy checksum mismatch");
  const work = mkdtempSync(join(tmpdir(), "agy-install-"));
  try {
    if (url.includes(".tar.gz")) {
      writeFileSync(join(work, "pkg.tar.gz"), body);
      await new Promise<void>((resolve, reject) => execFile("tar", ["-xzf", join(work, "pkg.tar.gz"), "-C", work, "antigravity"], (e) => (e ? reject(e) : resolve())));
      renameSync(join(work, "antigravity"), join(work, "agy"));
    } else writeFileSync(join(work, "agy"), body);
    chmodSync(join(work, "agy"), 0o755);
    // `install` (coreutils), so the binary lands whole even across file systems.
    execFileSync("install", ["-m", "0755", join(work, "agy"), "/usr/local/bin/agy"], { stdio: "ignore" });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  log("antigravity: installed agy");
  return "/usr/local/bin/agy";
}
