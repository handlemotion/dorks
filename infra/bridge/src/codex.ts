import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_AGENT_COMMANDS, type AgentCommand, type AgentModelChoice } from "@dorks/shared";
import { userContent, type LoadedImage } from "./claude";
import { asIdentity, type Identity } from "./runas";
import { errTag, type Log, type Redactor } from "./redact";
import { lightCodexModel, lowestEffort } from "./title";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const clip = (v: string) => v.slice(0, 16 * 1024);
type Effort = AgentModelChoice["efforts"][number];
const EFFORTS: string[] = ["none", "low", "medium", "high", "xhigh", "max"];
const MODEL_ID = /^[a-zA-Z0-9._-]{1,64}$/;
const DEFAULT_MODEL = { model: "gpt-6-sol", effort: "high" };
const effortsOf = (model: Json): Effort[] =>
  Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((e: unknown) => obj(e).reasoningEffort).filter((e): e is Effort => typeof e === "string" && EFFORTS.includes(e))
    : [];
/** `/name rest`: a skill the owner picked from the composer's `/` menu. */
const SLASH = /^\/([\w.:-]{1,80})(?:\s+([\s\S]*))?$/;
/** `/name` later in a message ("use the /writing skill"), also picked from the `/` menu. */
const INLINE_SLASH = /(?:^|\s)\/([\w.:-]{1,80})(?=[\s.,;:!?)]|$)/g;
/** Where the sign-in comes from, for the owner's next step: Dorks' own ChatGPT sign-in, or the Boat environment's. */
const signInHelp = (own: boolean) =>
  own ? "Sign in with ChatGPT again in Settings (Codex), then send a message to retry." : "Connect ChatGPT in Boat Agents & Proxying, then send a message to retry.";

/** An access token from Dorks' own ChatGPT sign-in, never its refresh token. */
export interface CodexAuth {
  accessToken: string;
  accountId: string;
  planType: string | null;
}

const authParams = (a: CodexAuth) => ({ accessToken: a.accessToken, chatgptAccountId: a.accountId, chatgptPlanType: a.planType });

export interface CodexOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  model?: { model: string; effort: string };
  resumeSessionId: string | null;
  runAs: Identity | null;
  mcpCommand: [string, string];
  sock: string;
  /** The owner's MCP servers in Claude Code's config form (hooks.ts `userMcpServers`), translated into Codex's per-thread config. */
  userMcp: Record<string, unknown>;
  /** Where skills are synced (the Claude config dir's `skills`): an extra skills root for Codex, so it loads the same ones. */
  skillsDir: string;
  /** The standing instructions (final answer, skills, crew, computer), as the thread's developer instructions. */
  system: string;
  /** Dorks' own ChatGPT sign-in (configure's `codexAuth`): signs Codex in with this access token instead of the Boat environment's. */
  auth?: CodexAuth;
  /** A fresh access token when Codex reports the current one refused (the `codex_token` rpc). */
  refreshAuth?: () => Promise<CodexAuth>;
  /** Loads an attached image by id (the backend's `get_image`); without it, attachments stay text. */
  loadImage?: (id: string) => Promise<LoadedImage | null>;
  redactor: Redactor;
  log: Log;
  onRaw: (raw: unknown) => void;
  onReady: () => void;
  /** Every model the account lists, with its efforts, and the effort this session runs at: the thread's model menu. */
  onModels: (models: AgentModelChoice[], effort: Effort | null) => void;
  /** The chosen model or effort is not on the plan: the models it can use instead (the paused session's form). */
  onUnavailable: (models: { model: string; efforts: Effort[] }[]) => void;
  /** The skills Codex loaded, for the composer's `/` menu. */
  onCommands: (commands: AgentCommand[]) => void;
  onIssue: (message: string) => void;
  /** The done gate (hook.stop): a reason to keep going, sent as the next turn, or null. `continued`: this turn was such a continuation. */
  onTurnFinished: (sessionId: string, turn: { lastMessage: string; continued: boolean }) => Promise<string | null>;
  /** A finished shell command (hook.postToolUse): subscribes the PRs it opened, drops the ones it merged or closed. */
  onShell: (command: string, output: string) => void;
  /** The autonomy briefing (hook.sessionStart), prepended to the first turn after a start, a resume or a compaction. */
  sessionContext: () => Promise<string | null>;
  onExit: (info: { code: number | null; stderrTail: string; resumeMissing: boolean; pending: string[] }) => void;
}

/** `${NAME}` references (Claude Code's config form) resolved from the agent's env, for values Codex has no reference syntax for. */
const resolveRefs = (v: string, env: NodeJS.ProcessEnv) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => env[name] ?? "");
const ONE_REF = /^\$\{([A-Z0-9_]+)\}$/;

/**
 * The owner's MCP servers as Codex config overrides for `thread/start`. Dotted keys, so they merge with the `dorks` server given on the
 * command line and Boat's `computer` server (which Boat writes into ~/.codex/config.toml) instead of replacing the table. They reach
 * Codex over its stdin, never argv or a file. A header that is one `${DORKS_MCP_…}` reference stays a reference (`env_http_headers`
 * names the variable, which is in the agent's env); anything else is resolved.
 */
export function codexMcpConfig(user: Record<string, unknown>, env: NodeJS.ProcessEnv): Json {
  const out: Json = {};
  for (const [name, raw] of Object.entries(user)) {
    if (name === "dorks" || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) continue;
    const s = obj(raw);
    if (s.type === "http" || (!s.type && text(s.url))) {
      const fixed: Record<string, string> = {};
      const fromEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj(s.headers))) {
        const ref = ONE_REF.exec(text(v));
        if (ref) fromEnv[k] = ref[1]!;
        else fixed[k] = resolveRefs(text(v), env);
      }
      out[`mcp_servers.${name}`] = {
        url: resolveRefs(text(s.url), env),
        ...(Object.keys(fixed).length ? { http_headers: fixed } : {}),
        ...(Object.keys(fromEnv).length ? { env_http_headers: fromEnv } : {}),
      };
    } else if (text(s.command)) {
      const vars = Object.fromEntries(Object.entries(obj(s.env)).map(([k, v]) => [k, resolveRefs(text(v), env)]));
      out[`mcp_servers.${name}`] = { command: text(s.command), args: Array.isArray(s.args) ? s.args.map(text) : [], ...(Object.keys(vars).length ? { env: vars } : {}) };
    }
  }
  return out;
}

/** The two sides of a unified diff (context in both), so an edit shows as a diff in the thread. */
export function diffSides(diff: string): { old_string: string; new_string: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) after.push(line.slice(1));
    else if (line.startsWith("-")) before.push(line.slice(1));
    else {
      const l = line.startsWith(" ") ? line.slice(1) : line;
      before.push(l);
      after.push(l);
    }
  }
  return { old_string: before.join("\n"), new_string: after.join("\n") };
}

type ToolCall = { id: string; name: string; input: Json };

/**
 * Codex's items as the tool calls the thread knows from Claude Code (Bash, Edit, Write, WebSearch, `mcp__server__tool`), so they read
 * the same: the same verbs and icons, diffs for edits, the Computer tab for `mcp__computer__*`, and the verify gate sees edits and
 * live checks. A file change is one call per file.
 */
export function codexToolCalls(item: Json): ToolCall[] {
  const id = text(item.id);
  if (!id) return [];
  switch (item.type) {
    case "commandExecution":
      return [{ id, name: "Bash", input: { command: text(item.command) } }];
    case "fileChange":
      return (Array.isArray(item.changes) ? item.changes : []).map((raw, i) => {
        const c = obj(raw);
        const kind = text(obj(c.kind).type);
        const path = text(c.path);
        const diff = text(c.diff);
        return kind === "add"
          ? { id: `${id}:${i}`, name: "Write", input: { file_path: path, content: diff } }
          : { id: `${id}:${i}`, name: "Edit", input: { file_path: path, ...(kind === "delete" ? { old_string: diff, new_string: "" } : diffSides(diff)) } };
      });
    case "mcpToolCall":
      return [{ id, name: `mcp__${text(item.server)}__${text(item.tool)}`, input: obj(item.arguments) }];
    case "dynamicToolCall":
      return [{ id, name: text(item.tool) || "tool", input: obj(item.arguments) }];
    case "webSearch":
      return [{ id, name: "WebSearch", input: { query: text(item.query) } }];
    case "imageView":
      return [{ id, name: "Read", input: { file_path: text(item.path) } }];
    case "collabAgentToolCall":
      return [{ id, name: "Agent", input: { description: text(item.prompt) || text(item.tool) } }];
    default:
      return [];
  }
}

/** A finished item's result for each of its calls: the output and whether it failed. */
function toolResult(item: Json): { output: string; failed: boolean } {
  const status = text(item.status);
  const failed = status === "failed" || status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0) || item.success === false;
  if (item.type === "mcpToolCall") {
    const blocks = Array.isArray(obj(item.result).content) ? (obj(item.result).content as unknown[]) : [];
    const out = blocks
      .map((b) => text(obj(b).text))
      .filter(Boolean)
      .join("\n");
    return { output: out || text(obj(item.error).message), failed: failed || !!text(obj(item.error).message) };
  }
  if (item.type === "dynamicToolCall") {
    const blocks = Array.isArray(item.contentItems) ? item.contentItems : [];
    return {
      output: blocks
        .map((b) => text(obj(b).text))
        .filter(Boolean)
        .join("\n"),
      failed,
    };
  }
  return { output: text(item.aggregatedOutput) || text(item.result) || text(item.error), failed };
}

/** Codex's plan, as the to-do list the thread shows for Claude Code's TodoWrite. */
function planTodos(plan: unknown): Json {
  const status = (s: string) => (s === "inProgress" ? "in_progress" : s === "completed" ? "completed" : "pending");
  return {
    todos: (Array.isArray(plan) ? plan : []).slice(0, 50).map((p) => ({ content: clip(text(obj(p).step)), status: status(text(obj(p).status)), activeForm: clip(text(obj(p).step)) })),
  };
}

/**
 * The Codex CLI's app-server (JSON-RPC over stdio), signed in with Dorks' own ChatGPT sign-in (an access token the server hands out,
 * refreshed through it) or, without one, the Boat account's ChatGPT environment, speaking the same
 * transcript shape as the Claude agent. A message sent mid-turn steers it (`turn/steer`), as Claude Code reads one at its next tool
 * call. The autonomy hooks Claude Code runs from its settings run here from the bridge: the done gate when a turn completes, the PR
 * subscription check on every finished command, and the briefing on the first turn after a start, a resume or a compaction.
 */
export class CodexAgent {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private stderr = "";
  private stopped = false;
  private exited = false;
  private requestId = 0;
  private requests = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private queue: string[] = [];
  private current: string | null = null;
  /** Messages steered into the running turn, for a resend if Codex dies before it ends. */
  private steered: string[] = [];
  private turnId: string | null = null;
  /** Settles once the turn being started has an id (or failed to start): a steer waits for it. */
  private starting: Promise<void> | null = null;
  private startedAt = 0;
  private idleWaiters: (() => void)[] = [];
  private opening = false;
  private finishing = false;
  private briefed = false;
  /** The turn running now was started by the done gate (Claude Code's `stop_hook_active`): it is not sent back again. */
  private continuing = false;
  private lastMessage = "";
  /** Every model the account listed, with its efforts (filled when the thread opens). */
  private models = new Map<string, string[]>();
  /** Skills Codex loaded, by name: a `/name` message invokes one. */
  private skills = new Map<string, string>();
  private skillsListed: Promise<void> = Promise.resolve();
  /** Calls already shown, so a started and a completed item never show one twice. */
  private shown = new Set<string>();
  /** Side threads (one-shot turns such as the title): their notifications never reach the transcript. */
  private side = new Map<string, { text: string; done: (text: string | null) => void }>();
  sessionId: string | null = null;
  idle = true;
  ready = false;

  constructor(private o: CodexOptions) {
    const home = o.env.HOME || homedir();
    const codexHome = join(home, ".codex");
    // app-server refuses to start when CODEX_HOME does not exist (a box Boat has not signed in yet still gets the issue below).
    try {
      if (!existsSync(codexHome)) {
        mkdirSync(codexHome, { recursive: true, mode: 0o700 });
        chmodSync(codexHome, 0o700);
        if (o.runAs) chownSync(codexHome, o.runAs.uid, o.runAs.gid);
      }
    } catch (e) {
      o.log("codex: could not create its home:", errTag(e));
    }
    const env: NodeJS.ProcessEnv = { ...o.env, CODEX_HOME: codexHome };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.OPENAI_BASE_URL;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const config = [
      `mcp_servers.dorks.command=${JSON.stringify(o.mcpCommand[0])}`,
      `mcp_servers.dorks.args=${JSON.stringify([o.mcpCommand[1], "dorks", "mcp"])}`,
      `mcp_servers.dorks.env.DORKS_SOCK=${JSON.stringify(o.sock)}`,
    ];
    const [bin, args] = asIdentity(o.runAs, "codex", ["app-server", "--listen", "stdio://", ...config.flatMap((c) => ["-c", c])]);
    this.child = spawn(bin, args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (s: string) => this.read(s));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (s: string) => {
      this.stderr = (this.stderr + s).slice(-2048);
    });
    this.child.stdin.on("error", () => {});
    this.child.on("error", (e) => {
      this.stderr = `spawn failed (${errTag(e)})`;
      this.finish(null);
    });
    this.child.on("close", (code) => this.finish(code));
    void this.open().catch(() => {
      this.o.onIssue(`Codex is not signed in to ChatGPT. ${signInHelp(!!this.o.auth)}`);
      this.child.kill();
    });
  }

  get alive() {
    return !this.exited && !this.stopped;
  }

  private write(value: Json) {
    return new Promise<void>((resolve, reject) => {
      if (!this.alive || !this.child.stdin.writable) return reject(new Error("Codex is not running"));
      this.child.stdin.write(`${JSON.stringify(value)}\n`, (e) => (e ? reject(e) : resolve()));
    });
  }

  private async request(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.requestId;
    const result = new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      this.requests.set(id, { resolve, reject, timer });
    });
    try {
      await this.write({ id, method, params });
    } catch (e) {
      const pending = this.requests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.requests.delete(id);
        pending.reject(e as Error);
      }
    }
    return result;
  }

  private async open() {
    // Signing in with a token we supply (`chatgptAuthTokens`) is part of the app-server's experimental API.
    await this.request("initialize", { clientInfo: { name: "dorks", title: "Dorks", version: "0.1.0" }, ...(this.o.auth ? { capabilities: { experimentalApi: true } } : {}) });
    await this.write({ method: "initialized", params: {} });
    // Dorks' own sign-in: the access token only, kept in memory by Codex; it asks for a new one when it is refused (serverRequest).
    if (this.o.auth) await this.request("account/login/start", { type: "chatgptAuthTokens", ...authParams(this.o.auth) });
    const state = await this.request("account/read", { refreshToken: false });
    if (obj(obj(state).account).type !== "chatgpt") throw new Error("ChatGPT account is not connected");
    // The owner's skills, synced for Claude Code, as a second user skills root (Codex keeps its own in ~/.codex/skills).
    if (existsSync(this.o.skillsDir)) await this.request("skills/extraRoots/set", { extraRoots: [this.o.skillsDir] }).catch((e) => this.o.log("codex: could not add the skills:", errTag(e)));
    return this.openThread();
  }

  private async openThread() {
    if (this.opening || this.ready || !this.alive) return;
    this.opening = true;
    try {
      const state = await this.request("account/read", { refreshToken: true });
      if (obj(state.account).type !== "chatgpt") throw new Error("ChatGPT sign-in is required");
      const selected = this.o.model ?? DEFAULT_MODEL;
      const { available, choices } = await this.listModels();
      this.o.onModels(choices, EFFORTS.includes(selected.effort) ? (selected.effort as Effort) : null);
      if (!available.get(selected.model)?.includes(selected.effort as Effort)) {
        const usable = [...available].filter(([, efforts]) => efforts.length).slice(0, 100);
        this.o.onUnavailable(usable.map(([model, efforts]) => ({ model, efforts })));
        this.o.onIssue(
          `${selected.model} (${selected.effort}) is not available to this ChatGPT account. ${usable.length ? "Choose another model shown in the thread." : "No compatible model is available; check this ChatGPT account."} No other model or billing method was selected.`,
        );
        throw new Error("model unavailable");
      }
      const result = await this.startThread(selected.model);
      const id = text(obj(result.thread).id);
      if (!id) throw new Error("Codex did not return a thread");
      this.sessionId = id;
      this.o.onRaw({ type: "system", subtype: "init", session_id: id, model: text(result.model) || selected.model });
      this.ready = true;
      this.o.onReady();
      // The first message may name a skill: its turn waits for the list (best effort, it never throws).
      this.skillsListed = this.listSkills();
      void this.pump();
    } catch (e) {
      if ((e as Error).message !== "model unavailable") this.o.onIssue(`Codex could not use the ChatGPT sign-in. ${signInHelp(!!this.o.auth)}`);
      this.child.kill();
    }
  }

  /** Pages through every model the account lists (recording each one's efforts). */
  private async listModels() {
    const available = new Map<string, Effort[]>();
    const choices: AgentModelChoice[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const entry of Array.isArray(page.data) ? page.data : []) {
        const model = obj(entry);
        const id = text(model.model) || text(model.id);
        if (!MODEL_ID.test(id) || available.has(id)) continue;
        const efforts = effortsOf(model);
        available.set(id, efforts);
        this.models.set(id, efforts);
        const description = text(model.description).trim();
        choices.push({ model: id, name: (text(model.displayName) || id).slice(0, 80), ...(description ? { description: description.slice(0, 200) } : {}), efforts });
      }
      cursor = text(page.nextCursor) || null;
    } while (cursor && available.size < 500);
    return { available, choices: choices.slice(0, 100) };
  }

  /** The skills this thread can use, for the `/` menu. Best effort. */
  private async listSkills() {
    try {
      const r = await this.request("skills/list", { cwds: [this.o.cwd] });
      const commands: AgentCommand[] = [];
      for (const entry of Array.isArray(r.data) ? r.data : [])
        for (const raw of Array.isArray(obj(entry).skills) ? (obj(entry).skills as unknown[]) : []) {
          const s = obj(raw);
          const name = text(s.name);
          if (!/^[\w.:-]{1,80}$/.test(name) || s.enabled === false || this.skills.has(name)) continue;
          this.skills.set(name, text(s.path));
          const description = (text(s.shortDescription) || text(s.description)).trim();
          commands.push({ name, ...(description ? { description: description.slice(0, 300) } : {}) });
        }
      if (commands.length) this.o.onCommands(commands.slice(0, MAX_AGENT_COMMANDS));
    } catch (e) {
      this.o.log("codex: could not list the skills:", errTag(e));
    }
  }

  /** The per-thread settings: the standing instructions and the MCP servers beside `dorks`. */
  private threadParams() {
    return { developerInstructions: this.o.system, config: codexMcpConfig(this.o.userMcp, this.o.env) };
  }

  /** Resumes the saved thread, or starts a new one when there is none or Codex no longer has it. */
  private async startThread(model: string): Promise<Json> {
    const start = () => this.request("thread/start", { model, cwd: this.o.cwd, approvalPolicy: "never", ...this.threadParams() });
    if (!this.o.resumeSessionId) return start();
    try {
      return await this.request("thread/resume", { threadId: this.o.resumeSessionId, model, cwd: this.o.cwd, approvalPolicy: "never", excludeTurns: true, ...this.threadParams() });
    } catch (e) {
      if (!/not found|does not exist|no such thread|no rollout/i.test((e as Error).message)) throw e;
      return start();
    }
  }

  private read(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      try {
        this.line(obj(JSON.parse(line)));
      } catch {}
    }
  }

  private line(m: Json) {
    // A request from Codex (an approval, an elicitation) shares the id space with our own: answer it, never match it to ours.
    if (m.id !== undefined && typeof m.method === "string") return this.serverRequest(m);
    if (typeof m.id === "number") return this.response(m.id, m);
    const p = obj(m.params);
    const sideTurn = this.side.get(text(p.threadId));
    if (sideTurn) return this.sideNotification(sideTurn, m.method, p);
    if (p.threadId !== undefined && this.sessionId && p.threadId !== this.sessionId) return; // a subagent's thread: its parent's items say enough
    this.notification(text(m.method), p);
  }

  private notification(method: string, p: Json) {
    switch (method) {
      case "account/updated":
        if (this.ready && p.authMode !== "chatgpt" && p.authMode !== "chatgptAuthTokens") {
          this.o.onIssue(`Codex lost its ChatGPT sign-in. ${signInHelp(!!this.o.auth)}`);
          this.child.kill();
        }
        return;
      case "item/agentMessage/delta": {
        const delta = text(p.delta);
        if (delta) this.o.onRaw({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } } });
        return;
      }
      case "item/started":
        return this.itemStarted(obj(p.item));
      case "item/completed":
        return this.itemCompleted(obj(p.item));
      case "turn/plan/updated":
        return this.plan(p);
      case "thread/compacted":
        this.briefed = false; // the briefing went with the compacted history: the next turn gets it again
        return;
      case "turn/started":
        this.turnId = text(obj(p.turn).id) || this.turnId;
        if (!this.startedAt) this.startedAt = Date.now();
        return;
      case "turn/completed":
        return void this.complete(obj(p.turn));
    }
  }

  /** Nobody is here to approve anything (approvals are off, so these should not come): decline, so the turn goes on. */
  private serverRequest(m: Json) {
    const method = text(m.method);
    if (method === "account/chatgptAuthTokens/refresh") return void this.refreshAuth(m.id);
    const decision =
      method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval"
        ? "decline"
        : method === "applyPatchApproval" || method === "execCommandApproval"
          ? "denied"
          : null;
    void this.write(decision ? { id: m.id, result: { decision } } : { id: m.id, error: { code: -32601, message: "Unsupported request: this is an unattended sandbox" } }).catch(() => {});
  }

  /** Codex's access token was refused: a fresh one from the server (Dorks' sign-in, refreshed on the owner's computer). */
  private async refreshAuth(id: unknown) {
    try {
      if (!this.o.refreshAuth) throw new Error("no sign-in to refresh");
      const auth = await this.o.refreshAuth();
      this.o.redactor.add(auth.accessToken);
      await this.write({ id, result: { accessToken: auth.accessToken, chatgptAccountId: auth.accountId, chatgptPlanType: auth.planType } });
    } catch (e) {
      this.o.log("codex: could not refresh the ChatGPT sign-in:", errTag(e));
      await this.write({ id, error: { code: -32603, message: "The ChatGPT sign-in could not be refreshed" } }).catch(() => {});
    }
  }

  /** A reply to one of our requests. */
  private response(id: number, m: Json) {
    const pending = this.requests.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.requests.delete(id);
    if (m.error) pending.reject(new Error(text(obj(m.error).message) || "Codex request failed"));
    else pending.resolve(obj(m.result));
  }

  private sideNotification(sideTurn: { text: string; done: (text: string | null) => void }, method: unknown, p: Json) {
    const it = obj(p.item);
    if (method === "item/completed" && it.type === "agentMessage") sideTurn.text = text(it.text);
    if (method === "turn/completed") sideTurn.done(obj(p.turn).status === "completed" ? sideTurn.text : null);
  }

  /** Scrubs and clips every string of a call's input before it leaves the box. */
  private scrubbed(v: unknown): unknown {
    if (typeof v === "string") return clip(this.o.redactor.scrub(v));
    if (Array.isArray(v)) return v.slice(0, 100).map((x) => this.scrubbed(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.scrubbed(x)]));
    return v;
  }

  private showCalls(item: Json) {
    for (const call of codexToolCalls(item)) {
      if (this.shown.has(call.id)) continue;
      this.shown.add(call.id);
      this.o.onRaw({ type: "assistant", message: { id: `${call.id}:use`, content: [{ type: "tool_use", id: call.id, name: call.name, input: this.scrubbed(call.input) }] } });
    }
  }

  private itemStarted(item: Json) {
    const id = text(item.id);
    if (!id) return;
    if (item.type === "agentMessage") this.o.onRaw({ type: "stream_event", event: { type: "message_start", message: { id } } });
    this.showCalls(item);
  }

  private itemCompleted(item: Json) {
    const id = text(item.id);
    if (!id) return;
    if (item.type === "agentMessage" && text(item.text)) {
      this.lastMessage = text(item.text);
      this.o.onRaw({ type: "assistant", message: { id, content: [{ type: "text", text: item.text }] } });
    }
    if (item.type === "contextCompaction") this.briefed = false;
    const calls = codexToolCalls(item);
    if (!calls.length) return;
    this.showCalls(item); // a file change may name its files only once applied
    const { output, failed } = toolResult(item);
    const content = clip(this.o.redactor.scrub(output));
    for (const call of calls) {
      if (this.shown.has(`${call.id}:done`)) continue;
      this.shown.add(`${call.id}:done`);
      this.o.onRaw({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: call.id, is_error: failed, content }] } });
    }
    if (item.type === "commandExecution" && !failed) this.o.onShell(text(item.command), text(item.aggregatedOutput));
  }

  /** Each plan update as one finished to-do call, so the thread keeps one card with the latest list. */
  private plan(p: Json) {
    const id = `plan:${text(p.turnId) || this.turnId || "turn"}:${Date.now()}`;
    this.o.onRaw({ type: "assistant", message: { id: `${id}:use`, content: [{ type: "tool_use", id, name: "TodoWrite", input: planTodos(p.plan) }] } });
    this.o.onRaw({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: "plan updated" }] } });
  }

  private async complete(turn: Json) {
    if (this.finishing) return;
    this.finishing = true;
    const completed = turn.status === "completed";
    this.o.onRaw({
      type: "result",
      is_error: !completed,
      result: clip(this.o.redactor.scrub(text(obj(turn.error).message) || text(turn.status))),
      duration_ms: typeof turn.durationMs === "number" ? turn.durationMs : Date.now() - this.startedAt,
      session_id: this.sessionId,
    });
    const finished = { lastMessage: this.lastMessage, continued: this.continuing };
    this.current = null;
    this.steered = [];
    this.turnId = null;
    this.startedAt = 0;
    this.lastMessage = "";
    this.continuing = false;
    if (completed && this.sessionId) {
      const reason = await this.o.onTurnFinished(this.sessionId, finished).catch(() => null);
      if (reason) {
        this.queue.unshift(reason);
        this.continuing = true;
      }
    }
    this.finishing = false;
    if (!this.queue.length) {
      this.idle = true;
      this.o.onRaw({ type: "system", subtype: "session_state_changed", state: "idle" });
      for (const wake of this.idleWaiters.splice(0)) wake();
    } else void this.pump();
  }

  /**
   * A message as Codex input: a `/skill` invokes that skill (as the first word, or named later in the text, which stays as written),
   * and attached images go as images (Codex takes data URLs).
   */
  private async input(message: string): Promise<Json[]> {
    const slash = SLASH.exec(message.trim());
    const skill = slash ? this.skills.get(slash[1]!) : undefined;
    if (slash && skill) {
      const rest = slash[2]?.trim() || `Use the ${slash[1]} skill.`;
      return [{ type: "skill", name: slash[1], path: skill }, ...(await this.input(rest))];
    }
    const named = [...new Set([...message.matchAll(INLINE_SLASH)].map((m) => m[1]!))].filter((n) => this.skills.has(n));
    const skills: Json[] = named.map((name) => ({ type: "skill", name, path: this.skills.get(name) }));
    return [...skills, ...(await this.content(message))];
  }

  private async content(message: string): Promise<Json[]> {
    const content = await userContent(message, this.o.loadImage);
    if (typeof content === "string") return [{ type: "text", text: content, text_elements: [] }];
    return content.map((raw) => {
      const b = obj(raw);
      if (b.type === "image") {
        const src = obj(b.source);
        return { type: "image", url: `data:${text(src.media_type)};base64,${text(src.data)}` };
      }
      return { type: "text", text: text(b.text), text_elements: [] };
    });
  }

  private async pump() {
    if (!this.ready || this.current !== null || this.finishing || !this.queue.length || !this.alive) return;
    // Everything that waited (a notification after a done-gate reason, messages that came while the turn ended) goes in one turn.
    this.current = this.queue.splice(0).join("\n\n");
    this.idle = false;
    this.startedAt = Date.now();
    let started!: () => void;
    this.starting = new Promise<void>((resolve) => (started = resolve));
    try {
      const account = await this.request("account/read", { refreshToken: false });
      if (obj(account.account).type !== "chatgpt") {
        this.o.onIssue(`Codex lost its ChatGPT sign-in. ${signInHelp(!!this.o.auth)}`);
        this.child.kill();
        return;
      }
      await this.skillsListed;
      const input = await this.input(this.current);
      if (!this.briefed) {
        // Its own input item ahead of the message, so a `/skill` message still reads as one.
        this.briefed = true;
        const context = await this.o.sessionContext().catch(() => null);
        if (context) input.unshift({ type: "text", text: `<system-reminder>\n${context}\n</system-reminder>`, text_elements: [] });
      }
      const r = await this.request("turn/start", {
        threadId: this.sessionId,
        input,
        cwd: this.o.cwd,
        model: this.o.model?.model ?? DEFAULT_MODEL.model,
        effort: this.o.model?.effort ?? DEFAULT_MODEL.effort,
        approvalPolicy: "never",
        sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
      });
      if (this.current !== null) this.turnId = text(obj(r.turn).id) || this.turnId;
    } catch {
      if (this.alive) this.o.onIssue("Codex could not start the turn. Check ChatGPT access and plan limits before retrying.");
      this.child.kill();
    } finally {
      started();
      this.starting = null;
    }
  }

  /**
   * A message for the agent. Mid-turn it steers the running turn (`turn/steer`, read at Codex's next step), as Claude Code does;
   * otherwise, or when the turn ended as it was sent, it starts the next turn.
   */
  async sendUserMessage(message: string) {
    if (!this.ready) throw new Error("Codex is not ready");
    if (this.current !== null && !this.finishing) {
      await this.starting;
      const turnId = this.turnId;
      if (turnId && this.current !== null && !this.finishing) {
        try {
          await this.request("turn/steer", { threadId: this.sessionId, input: await this.input(message), expectedTurnId: turnId });
          this.steered.push(message);
          return;
        } catch (e) {
          this.o.log("codex: steer missed the turn, queued instead:", errTag(e)); // the turn ended meanwhile
        }
      }
    }
    this.queue.push(message);
    this.idle = false; // busy from the moment it is queued, so a restart waits for it (waitIdle) instead of dropping it
    await this.pump();
  }

  /**
   * One turn on a throwaway (ephemeral) thread with the account's lightest model (or this dork's model at its lowest effort),
   * read-only and without approvals: the title and the verify judge. Its events stay out of the transcript. Resolves to the reply,
   * or null when the turn did not complete in time.
   */
  async oneShot(prompt: string, timeoutMs = 45_000): Promise<string | null> {
    if (!this.ready) throw new Error("Codex is not ready");
    const own = this.o.model ?? DEFAULT_MODEL;
    const pick = lightCodexModel(this.models) ?? { model: own.model, effort: lowestEffort(this.models.get(own.model) ?? [own.effort]) };
    const started = await this.request("thread/start", { model: pick.model, cwd: this.o.cwd, approvalPolicy: "never", ephemeral: true });
    const threadId = text(obj(started.thread).id);
    if (!threadId) throw new Error("Codex did not return a thread");
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => finish(null), timeoutMs);
      const finish = (v: string | null) => {
        clearTimeout(timer);
        this.side.delete(threadId);
        resolve(v);
      };
      this.side.set(threadId, { text: "", done: finish });
      this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        cwd: this.o.cwd,
        model: pick.model,
        effort: pick.effort,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      }).catch((e) => {
        clearTimeout(timer);
        this.side.delete(threadId);
        reject(e);
      });
    });
  }

  async interrupt() {
    if (this.current !== null) await this.starting;
    if (this.turnId) await this.request("turn/interrupt", { threadId: this.sessionId, turnId: this.turnId });
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

  private finish(code: number | null) {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex exited"));
    }
    this.requests.clear();
    for (const wake of this.idleWaiters.splice(0)) wake();
    if (!this.stopped)
      this.o.onExit({
        code,
        stderrTail: this.o.redactor.scrub(this.stderr),
        resumeMissing: false,
        pending: [this.current, ...this.steered, ...this.queue].filter((s): s is string => s !== null),
      });
  }

  async stop(graceMs = 5000) {
    if (this.exited) return;
    this.stopped = true;
    this.child.stdin.end();
    const done = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    const term = setTimeout(() => this.child.kill("SIGTERM"), graceMs);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), graceMs * 2);
    await done;
    clearTimeout(term);
    clearTimeout(kill);
  }
}
