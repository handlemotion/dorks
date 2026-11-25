import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asIdentity, type Identity } from "./runas";
import { errTag, type Log, type Redactor } from "./redact";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const clip = (v: string) => v.slice(0, 16 * 1024);
/** "provider/model", the form OpenCode names a model in (`opencode/deepseek-v4.1-flash`, `deepseek/deepseek-chat`). */
const MODEL = /^[a-zA-Z0-9._-]{1,64}\/[a-zA-Z0-9._:[\]/-]{1,128}$/;

export interface OpenCodeOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** "provider/model"; omitted: OpenCode's own default. */
  model?: string;
  resumeSessionId: string | null;
  runAs: Identity | null;
  mcpCommand: [string, string];
  sock: string;
  /** The owner's MCP servers in Claude Code's config form (hooks.ts `userMcpServers`), translated here. */
  userMcp: Record<string, unknown>;
  /** Where skills are synced (the Claude config dir's `skills`), so OpenCode loads the same ones. */
  skillsDir: string;
  stateDir: string;
  /** The standing instructions for every turn: final-answer, skills, crew and computer guidance. */
  system: string;
  redactor: Redactor;
  log: Log;
  onRaw: (raw: unknown) => void;
  onReady: () => void;
  onModels: (models: string[]) => void;
  onIssue: (message: string) => void;
  /** The done gate (hook.stop): a reason to keep going, sent as the next turn, or null. */
  onTurnFinished: (sessionId: string) => Promise<string | null>;
  /** A finished shell call (hook.postToolUse): subscribes the PRs it opened, drops the ones it merged or closed. */
  onShell: (command: string, output: string) => void;
  /** The autonomy briefing (hook.sessionStart), prepended to the first turn of a session and the first after a compaction. */
  sessionContext: () => Promise<string | null>;
  onExit: (info: { code: number | null; stderrTail: string; resumeMissing: boolean; pending: string[] }) => void;
}

/** `${NAME}` references (Claude Code's form) as OpenCode's `{env:NAME}`. */
const envRefs = (v: string) => v.replace(/\$\{([A-Z0-9_]+)\}/g, "{env:$1}");
const mapValues = (v: unknown) => Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, envRefs(text(x))]));

/** The config OpenCode runs with: no prompts, the dorks MCP server and the owner's, the shared skills. No secrets: values are references. */
export function openCodeConfig(o: Pick<OpenCodeOptions, "mcpCommand" | "sock" | "userMcp" | "skillsDir" | "model">) {
  const mcp: Json = {};
  for (const [name, raw] of Object.entries(o.userMcp)) {
    const s = obj(raw);
    if (s.type === "http") mcp[name] = { type: "remote", url: envRefs(text(s.url)), headers: mapValues(s.headers), oauth: false };
    else if (s.type === "stdio") mcp[name] = { type: "local", command: [text(s.command), ...(Array.isArray(s.args) ? s.args.map(text) : [])], environment: mapValues(s.env) };
  }
  mcp.dorks = { type: "local", command: [o.mcpCommand[0], o.mcpCommand[1], "dorks", "mcp"], environment: { DORKS_SOCK: o.sock } };
  return {
    $schema: "https://opencode.ai/config.json",
    // Nobody can answer a permission prompt in an unattended box (the Claude equivalent is bypassPermissions).
    permission: "allow",
    share: "disabled",
    autoupdate: false,
    skills: { paths: [o.skillsDir] },
    mcp,
    ...(o.model ? { model: o.model } : {}),
  };
}

/**
 * The OpenCode harness (`opencode serve`, its HTTP API and event stream), speaking the same transcript shape as the Claude agent.
 * The autonomy hooks Claude Code runs from its settings run here from the bridge: the done gate when a turn ends, the PR subscription
 * check on every finished shell call, and the briefing on a session's first turn (and after a compaction, which drops it).
 */
export class OpenCodeAgent {
  private child: ChildProcessWithoutNullStreams;
  private stdout = "";
  private stderr = "";
  private stopped = false;
  private exited = false;
  private base = "";
  private auth: string;
  private events = new AbortController();
  private queue: string[] = [];
  private current: string | null = null;
  private startedAt = 0;
  private turnError = "";
  private warned = false;
  private briefed = false;
  private finishing = false;
  private idleWaiters: (() => void)[] = [];
  private roles = new Map<string, string>();
  private started = new Set<string>();
  private parts = new Map<string, Json>();
  private shown = new Set<string>();
  /** Side sessions (one-shot turns such as the title): their events never reach the transcript. */
  private side = new Map<string, { texts: Map<string, string>; done: (text: string | null) => void }>();
  sessionId: string | null = null;
  idle = true;
  ready = false;

  constructor(private o: OpenCodeOptions) {
    const password = randomBytes(24).toString("base64url");
    o.redactor.add(password);
    this.auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const config = join(o.stateDir, "opencode.json");
    writeFileSync(config, JSON.stringify(openCodeConfig(o), null, 2) + "\n");
    chmodSync(config, 0o644); // the agent's user reads it; references only, no values
    const env: NodeJS.ProcessEnv = { ...o.env, OPENCODE_CONFIG: config, OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: "1" };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const [bin, args] = asIdentity(o.runAs, "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    this.child = spawn(bin, args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (s: string) => this.listening(s));
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
  }

  get alive() {
    return !this.exited && !this.stopped;
  }

  /** `opencode server listening on http://127.0.0.1:<port>` on stdout: the address, then the session. */
  private listening(chunk: string) {
    if (this.base) return;
    this.stdout = (this.stdout + chunk).slice(-4096);
    const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(this.stdout);
    if (!m) return;
    this.base = m[1]!;
    void this.open().catch((e) => {
      if (!this.alive) return;
      this.o.log("opencode: could not open the session:", errTag(e));
      this.o.onIssue("OpenCode could not start a session. Check its provider key (a shared secret such as OPENCODE_API_KEY or DEEPSEEK_API_KEY) and the model, then retry.");
      this.child.kill();
    });
  }

  private async api(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const url = `${this.base}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(this.o.cwd)}`;
    const r = await fetch(url, {
      method,
      headers: { authorization: this.auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await r.text();
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {}
    if (r.status >= 400) throw new Error(`${method} ${path.split("?")[0]} ${r.status}`);
    return { status: r.status, body: parsed };
  }

  private async open() {
    void this.subscribe();
    const providers = obj((await this.api("GET", "/config/providers")).body);
    const models = (Array.isArray(providers.providers) ? providers.providers : []).flatMap((p) => Object.keys(obj(obj(p).models)).map((m) => `${text(obj(p).id)}/${m}`));
    const listed = models.filter((m) => MODEL.test(m)).slice(0, 200);
    this.o.onModels(listed);
    if (this.o.model && !listed.includes(this.o.model)) {
      this.o.onIssue(`${this.o.model} is not available to OpenCode here. Add its provider key as a shared secret, or choose another model shown in the thread. No other model was selected.`);
      this.child.kill();
      return;
    }
    this.sessionId = await this.session();
    this.o.onRaw({ type: "system", subtype: "init", session_id: this.sessionId });
    this.ready = true;
    this.o.onReady();
    void this.pump();
  }

  /** Resumes the saved session when OpenCode still has it (its storage lives in the box's home), else starts one. */
  private async session(): Promise<string> {
    if (this.o.resumeSessionId) {
      try {
        await this.api("GET", `/session/${encodeURIComponent(this.o.resumeSessionId)}`);
        this.briefed = true; // its first turn already had the briefing
        return this.o.resumeSessionId;
      } catch {
        this.o.log("opencode: saved session not found, starting a fresh one");
      }
    }
    const id = text(obj((await this.api("POST", "/session", { title: "dork" })).body).id);
    if (!id) throw new Error("OpenCode did not return a session");
    return id;
  }

  /** The server's event stream (server-sent events). Losing it loses the transcript, so the agent exits and is restarted. */
  private async subscribe() {
    try {
      const r = await fetch(`${this.base}/event?directory=${encodeURIComponent(this.o.cwd)}`, { headers: { authorization: this.auth }, signal: this.events.signal });
      if (!r.ok || !r.body) throw new Error(`event stream ${r.status}`);
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buf.indexOf("\n\n")) !== -1) {
          const data = buf
            .slice(0, end)
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          buf = buf.slice(end + 2);
          if (!data) continue;
          try {
            this.event(obj(JSON.parse(data)));
          } catch (e) {
            this.o.log("opencode: bad event:", errTag(e));
          }
        }
      }
      throw new Error("event stream ended");
    } catch (e) {
      if (!this.alive) return;
      this.o.log("opencode: lost the event stream:", errTag(e));
      this.child.kill();
    }
  }

  private event(e: Json) {
    const p = obj(e.properties);
    const part = obj(p.part);
    const info = obj(p.info);
    const sid = text(p.sessionID) || text(part.sessionID) || text(info.sessionID);
    const sideTurn = this.side.get(sid);
    if (sideTurn) return this.sideEvent(sideTurn, e.type, p);
    if (!sid || sid !== this.sessionId) return;
    switch (e.type) {
      case "message.updated":
        if (info.id) this.roles.set(text(info.id), text(info.role));
        if (info.role === "assistant" && obj(info.error).name) this.turnError = errorText(info.error);
        return;
      case "message.part.delta":
        return this.delta(p);
      case "message.part.updated":
        return this.part(part);
      case "session.status":
        return this.status(obj(p.status));
      case "session.error":
        this.turnError = errorText(p.error);
        return;
      case "session.compacted":
        this.briefed = false; // the summary drops the briefing: the next turn carries it again
        return;
      case "session.idle":
        if (this.current !== null) void this.complete();
        return;
    }
  }

  private delta(p: Json) {
    const messageId = text(p.messageID);
    if (this.roles.get(messageId) !== "assistant" || text(p.field) !== "text") return;
    const type = text(obj(this.parts.get(text(p.partID))).type);
    if (type && type !== "text") return; // reasoning streams too; only the answer is shown
    const delta = text(p.delta);
    if (!delta) return;
    this.messageStart(messageId);
    this.o.onRaw({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } } });
  }

  private messageStart(messageId: string) {
    if (this.started.has(messageId)) return;
    this.started.add(messageId);
    this.o.onRaw({ type: "stream_event", event: { type: "message_start", message: { id: messageId } } });
  }

  private part(part: Json) {
    const id = text(part.id);
    if (!id) return;
    this.parts.set(id, part);
    const messageId = text(part.messageID);
    if (this.roles.get(messageId) !== "assistant") return;
    if (part.type === "text" && obj(part.time).end) this.showText(part);
    if (part.type === "tool") this.tool(part);
  }

  private showText(part: Json) {
    const id = text(part.id);
    if (this.shown.has(id) || !text(part.text).trim() || part.synthetic) return;
    this.shown.add(id);
    this.messageStart(text(part.messageID));
    this.o.onRaw({ type: "assistant", message: { id, content: [{ type: "text", text: part.text }] } });
  }

  private tool(part: Json) {
    const id = text(part.callID) || text(part.id);
    const state = obj(part.state);
    const status = text(state.status);
    const name = text(part.tool);
    const input = obj(state.input);
    if (status === "pending") return; // the input is still streaming
    if (!this.shown.has(id)) {
      this.shown.add(id);
      const summary = text(input.command) || text(input.filePath) || text(input.pattern) || text(input.url) || text(input.description) || text(state.title);
      this.o.onRaw({ type: "assistant", message: { id: `${id}:use`, content: [{ type: "tool_use", id, name, input: { description: clip(this.o.redactor.scrub(summary)) } }] } });
    }
    if (status !== "completed" && status !== "error") return;
    if (this.shown.has(`${id}:done`)) return;
    this.shown.add(`${id}:done`);
    const output = text(state.output) || text(state.error);
    this.o.onRaw({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: status === "error", content: clip(this.o.redactor.scrub(output)) }] } });
    if (name === "bash" && status === "completed") this.o.onShell(text(input.command), text(obj(state.metadata).output) || output);
  }

  /** A provider that keeps refusing (a free tier used up, a missing key) retries for hours: say so once and end the turn. */
  private status(s: Json) {
    if (s.type !== "retry" || this.current === null) return;
    const action = obj(s.action);
    const message = clip(this.o.redactor.scrub(text(action.message) || text(s.message)));
    if (!this.warned) {
      this.warned = true;
      this.o.onIssue(`OpenCode's provider refused the request: ${message || "no reason given"}${text(action.link) ? ` (${text(action.link)})` : ""}`);
    }
    if (text(action.reason) || Number(s.attempt) >= 3) {
      this.turnError = message || "the provider refused the request";
      void this.interrupt().catch(() => {});
    }
  }

  private async complete() {
    if (this.finishing) return;
    this.finishing = true;
    for (const part of this.parts.values()) if (part.type === "text" && this.roles.get(text(part.messageID)) === "assistant") this.showText(part); // a text part the stream never closed
    const failed = !!this.turnError;
    this.o.onRaw({ type: "result", is_error: failed, result: clip(this.o.redactor.scrub(this.turnError || "completed")), duration_ms: Date.now() - this.startedAt });
    this.current = null;
    this.turnError = "";
    this.parts.clear();
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

  private async pump() {
    if (!this.ready || this.current !== null || this.finishing || !this.queue.length || !this.alive) return;
    // Everything that waited goes in one turn (see AntigravityAgent.pump): never one turn per message sent mid-turn.
    this.current = this.queue.splice(0).join("\n\n");
    this.idle = false;
    this.warned = false;
    this.startedAt = Date.now();
    try {
      let prompt = this.current;
      if (!this.briefed) {
        const context = await this.o.sessionContext().catch(() => null);
        if (context) prompt = `<system-reminder>\n${context}\n</system-reminder>\n\n${prompt}`;
        this.briefed = true;
      }
      await this.api("POST", `/session/${this.sessionId}/prompt_async`, { parts: [{ type: "text", text: prompt }], system: this.o.system, ...modelRef(this.o.model) });
    } catch (e) {
      this.o.log("opencode: could not start the turn:", errTag(e));
      if (this.alive) this.o.onIssue("OpenCode could not start the turn. Check its provider key and plan limits before retrying.");
      this.child.kill();
    }
  }

  async sendUserMessage(message: string) {
    if (!this.ready) throw new Error("OpenCode is not ready");
    this.queue.push(message);
    await this.pump();
  }

  private sideEvent(sideTurn: { texts: Map<string, string>; done: (text: string | null) => void }, type: unknown, p: Json) {
    const part = obj(p.part);
    if (type === "message.part.updated" && part.type === "text" && !part.synthetic) sideTurn.texts.set(text(part.id), text(part.text));
    if (type === "session.error") sideTurn.done(null);
    if (type === "session.idle") sideTurn.done([...sideTurn.texts.values()].pop() ?? null);
  }

  /** One turn on a throwaway session with no tools. Its events stay out of the transcript. Resolves to the reply, or null. */
  async oneShot(prompt: string, timeoutMs = 45_000): Promise<string | null> {
    if (!this.ready) throw new Error("OpenCode is not ready");
    const id = text(obj((await this.api("POST", "/session", { title: "title" })).body).id);
    if (!id) throw new Error("OpenCode did not return a session");
    const reply = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => finish(null), timeoutMs);
      const finish = (v: string | null) => {
        clearTimeout(timer);
        this.side.delete(id);
        resolve(v);
      };
      this.side.set(id, { texts: new Map(), done: finish });
      this.api("POST", `/session/${id}/prompt_async`, { parts: [{ type: "text", text: prompt }], tools: NO_TOOLS, ...modelRef(this.o.model) }).catch(() => finish(null));
    });
    void this.api("DELETE", `/session/${id}`).catch(() => {});
    return reply;
  }

  async interrupt() {
    if (this.sessionId && this.current !== null) await this.api("POST", `/session/${this.sessionId}/abort`);
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
    this.events.abort();
    for (const wake of this.idleWaiters.splice(0)) wake();
    for (const s of this.side.values()) s.done(null);
    if (!this.stopped)
      this.o.onExit({
        code,
        stderrTail: this.o.redactor.scrub(this.stderr),
        resumeMissing: false,
        pending: [this.current, ...this.queue].filter((s): s is string => s !== null),
      });
  }

  async stop(graceMs = 5000) {
    if (this.exited) return;
    this.stopped = true;
    this.events.abort();
    const done = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    this.child.kill("SIGTERM");
    const kill = setTimeout(() => this.child.kill("SIGKILL"), graceMs);
    await done;
    clearTimeout(kill);
  }
}

/** A title turn needs no tools; the named ones change things, the wildcard covers the rest where OpenCode honours it. */
const NO_TOOLS = { "*": false, bash: false, edit: false, write: false, patch: false, apply_patch: false, task: false, webfetch: false };

const modelRef = (model?: string) => {
  if (!model) return {};
  const slash = model.indexOf("/");
  return { model: { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } };
};

function errorText(error: unknown): string {
  const e = obj(error);
  if (e.name === "MessageAbortedError") return "interrupted";
  return text(obj(e.data).message) || text(e.message) || text(e.name) || "OpenCode reported an error";
}
