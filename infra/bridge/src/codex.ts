import { FINAL_ANSWER_GUIDANCE } from "./guidance";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { asIdentity, type Identity } from "./runas";
import { errTag, type Log, type Redactor } from "./redact";
import { lightCodexModel, lowestEffort } from "./title";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const text = (v: unknown): string => typeof v === "string" ? v : "";
const clip = (v: string) => v.slice(0, 16 * 1024);

export interface CodexOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  model?: { model: string; effort: string };
  resumeSessionId: string | null;
  runAs: Identity | null;
  mcpCommand: [string, string];
  sock: string;
  redactor: Redactor;
  log: Log;
  onRaw: (raw: unknown) => void;
  onReady: () => void;
  onModels: (models: { model: string; efforts: ("none" | "low" | "medium" | "high" | "xhigh" | "max")[] }[]) => void;
  onIssue: (message: string) => void;
  onTurnFinished: (sessionId: string) => Promise<string | null>;
  onExit: (info: { code: number | null; stderrTail: string; resumeMissing: boolean; pending: string[] }) => void;
}

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
  private turnId: string | null = null;
  private startedAt = 0;
  private idleWaiters: (() => void)[] = [];
  private opening = false;
  private finishing = false;
  /** Every model the account listed, with its efforts (filled when the thread opens). */
  private models = new Map<string, string[]>();
  /** Side threads (one-shot turns such as the title): their notifications never reach the transcript. */
  private side = new Map<string, { text: string; done: (text: string | null) => void }>();
  sessionId: string | null = null;
  idle = true;
  ready = false;

  constructor(private o: CodexOptions) {
    const env: NodeJS.ProcessEnv = { ...o.env, CODEX_HOME: join(o.env.HOME || homedir(), ".codex") };
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
    this.child.stderr.on("data", (s: string) => { this.stderr = (this.stderr + s).slice(-2048); });
    this.child.stdin.on("error", () => {});
    this.child.on("error", (e) => { this.stderr = `spawn failed (${errTag(e)})`; this.finish(null); });
    this.child.on("close", (code) => this.finish(code));
    void this.open().catch(() => {
      this.o.onIssue("ChatGPT is not available from your Boat account. Connect ChatGPT in Boat Agents & Proxying, then send a message to retry.");
      this.child.kill();
    });
  }

  get alive() { return !this.exited && !this.stopped; }

  private write(value: Json) {
    return new Promise<void>((resolve, reject) => {
      if (!this.alive || !this.child.stdin.writable) return reject(new Error("Codex is not running"));
      this.child.stdin.write(`${JSON.stringify(value)}\n`, (e) => e ? reject(e) : resolve());
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
    try { await this.write({ id, method, params }); }
    catch (e) {
      const pending = this.requests.get(id);
      if (pending) { clearTimeout(pending.timer); this.requests.delete(id); pending.reject(e as Error); }
    }
    return result;
  }

  private async open() {
    await this.request("initialize", { clientInfo: { name: "dorks", title: "Dorks", version: "0.1.0" } });
    await this.write({ method: "initialized", params: {} });
    const state = await this.request("account/read", { refreshToken: false });
    if (obj(obj(state).account).type !== "chatgpt") throw new Error("Boat ChatGPT account is not connected");
    return this.openThread();
  }

  private async openThread() {
    if (this.opening || this.ready || !this.alive) return;
    this.opening = true;
    try {
      const state = await this.request("account/read", { refreshToken: true });
      if (obj(state.account).type !== "chatgpt") throw new Error("ChatGPT sign-in is required");
      const selected = this.o.model ?? { model: "gpt-6-sol", effort: "high" };
      const available = new Map<string, ("none" | "low" | "medium" | "high" | "xhigh" | "max")[]>();
      let cursor: string | null = null;
      let supported = false;
      do {
        const page = await this.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        for (const entry of Array.isArray(page.data) ? page.data : []) {
          const model = obj(entry);
          const id = text(model.model) || text(model.id);
          if (!/^[a-zA-Z0-9._-]{1,64}$/.test(id)) continue;
          const efforts = Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts.map((e: unknown) => obj(e).reasoningEffort)
              .filter((e): e is "none" | "low" | "medium" | "high" | "xhigh" | "max" => typeof e === "string" && ["none", "low", "medium", "high", "xhigh", "max"].includes(e))
            : [];
          available.set(id, efforts);
          this.models.set(id, efforts);
          if (id === selected.model && efforts.includes(selected.effort as typeof efforts[number])) supported = true;
        }
        cursor = text(page.nextCursor) || null;
      } while (!supported && cursor && available.size < 500);
      if (!supported) {
        const choices = [...available].filter(([, efforts]) => efforts.length).slice(0, 100);
        this.o.onModels(choices.map(([model, efforts]) => ({ model, efforts })));
        this.o.onIssue(`${selected.model} (${selected.effort}) is not available to this ChatGPT account. ${choices.length ? "Choose another model shown in the thread." : "No compatible model is available; check this ChatGPT account."} No other model or billing method was selected.`);
        throw new Error("model unavailable");
      }
      let result: Json;
      const developerInstructions = FINAL_ANSWER_GUIDANCE;
      if (this.o.resumeSessionId) {
        try { result = await this.request("thread/resume", { threadId: this.o.resumeSessionId, excludeTurns: true, developerInstructions }); }
        catch (e) {
          if (!/not found|does not exist|no such thread/i.test((e as Error).message)) throw e;
          result = await this.request("thread/start", { model: selected.model, cwd: this.o.cwd, approvalPolicy: "never", developerInstructions });
        }
      } else result = await this.request("thread/start", { model: selected.model, cwd: this.o.cwd, approvalPolicy: "never", developerInstructions });
      const id = text(obj(result.thread).id);
      if (!id) throw new Error("Codex did not return a thread");
      this.sessionId = id;
      this.o.onRaw({ type: "system", subtype: "init", session_id: id });
      this.ready = true;
      this.o.onReady();
    } catch (e) {
      if ((e as Error).message !== "model unavailable") this.o.onIssue("Codex could not use your Boat ChatGPT connection. Check Boat Agents & Proxying, then retry.");
      this.child.kill();
    }
  }

  private read(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      try { this.line(obj(JSON.parse(line))); } catch {}
    }
  }

  private line(m: Json) {
    if (typeof m.id === "number" && this.requests.has(m.id)) {
      const pending = this.requests.get(m.id)!;
      clearTimeout(pending.timer);
      this.requests.delete(m.id);
      if (m.error) pending.reject(new Error(text(obj(m.error).message) || "Codex request failed"));
      else pending.resolve(obj(m.result));
      return;
    }
    if (typeof m.id === "number") {
      void this.write({ id: m.id, error: { code: -32601, message: "Unsupported request" } }).catch(() => {});
      return;
    }
    const p = obj(m.params);
    const sideTurn = this.side.get(text(p.threadId));
    if (sideTurn) {
      const it = obj(p.item);
      if (m.method === "item/completed" && it.type === "agentMessage") sideTurn.text = text(it.text);
      if (m.method === "turn/completed") sideTurn.done(obj(p.turn).status === "completed" ? sideTurn.text : null);
      return;
    }
    if (m.method === "account/updated" && this.ready && p.authMode !== "chatgpt") {
      this.o.onIssue("Your Boat ChatGPT connection is no longer available. Reconnect it in Boat Agents & Proxying, then retry.");
      this.child.kill();
    }
    if (m.method === "item/agentMessage/delta") {
      const delta = text(p.delta);
      if (delta) this.o.onRaw({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } } });
    }
    const item = obj(p.item);
    const id = text(item.id);
    if (m.method === "item/started" && id) {
      if (item.type === "agentMessage") this.o.onRaw({ type: "stream_event", event: { type: "message_start", message: { id } } });
      const tool = this.tool(item);
      if (tool) this.o.onRaw({ type: "assistant", message: { id, content: [{ type: "tool_use", id, name: tool.name, input: { description: tool.summary } }] } });
    }
    if (m.method === "item/completed" && id) {
      if (item.type === "agentMessage" && text(item.text)) {
        this.o.onRaw({ type: "assistant", message: { id, content: [{ type: "text", text: item.text }] } });
      }
      const tool = this.tool(item);
      if (tool) this.o.onRaw({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0), content: clip(this.o.redactor.scrub(text(item.aggregatedOutput) || text(item.result) || text(item.error))) }] } });
    }
    if (m.method === "turn/started") {
      this.turnId = text(obj(p.turn).id);
      this.startedAt = Date.now();
    }
    if (m.method === "turn/completed") void this.complete(obj(p.turn));
  }

  private tool(item: Json): { name: string; summary: string } | null {
    const name = typeof item.type === "string" ? item.type : "";
    if (!["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(name)) return null;
    const summary = name === "commandExecution" ? text(item.command)
      : name === "fileChange" ? obj((item.changes as unknown[] | undefined)?.[0]).path
      : name === "mcpToolCall" ? `${text(item.server)}/${text(item.tool)}` : text(item.query);
    return { name, summary: clip(this.o.redactor.scrub(text(summary))) };
  }

  private async complete(turn: Json) {
    this.finishing = true;
    this.o.onRaw({ type: "result", is_error: turn.status !== "completed", result: clip(this.o.redactor.scrub(text(obj(turn.error).message) || text(turn.status))), duration_ms: Date.now() - this.startedAt });
    this.current = null;
    this.turnId = null;
    if (turn.status === "completed" && this.sessionId) {
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
    this.current = this.queue.shift()!;
    this.idle = false;
    try {
      const account = await this.request("account/read", { refreshToken: false });
      if (obj(account.account).type !== "chatgpt") {
        this.o.onIssue("Your Boat ChatGPT connection is no longer available. Reconnect it in Boat Agents & Proxying, then retry.");
        this.child.kill();
        return;
      }
      const r = await this.request("turn/start", {
        threadId: this.sessionId, input: [{ type: "text", text: this.current }], cwd: this.o.cwd,
        model: this.o.model?.model ?? "gpt-6-sol", effort: this.o.model?.effort ?? "high", approvalPolicy: "never",
        sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
      });
      if (this.current !== null) this.turnId = text(obj(r.turn).id) || this.turnId;
    } catch {
      if (this.alive) this.o.onIssue("Codex could not start the turn. Check ChatGPT access and plan limits before retrying.");
      this.child.kill();
    }
  }

  async sendUserMessage(message: string) {
    if (!this.ready) throw new Error("Codex is not ready");
    this.queue.push(message);
    await this.pump();
  }

  /**
   * One turn on a throwaway thread with the account's lightest model (or this dork's model at its lowest effort), read-only and
   * without approvals. Its events stay out of the transcript. Resolves to the reply, or null when the turn did not complete.
   */
  async oneShot(prompt: string, timeoutMs = 45_000): Promise<string | null> {
    if (!this.ready) throw new Error("Codex is not ready");
    const own = this.o.model ?? { model: "gpt-6-sol", effort: "high" };
    const pick = lightCodexModel(this.models) ?? { model: own.model, effort: lowestEffort(this.models.get(own.model) ?? [own.effort]) };
    const started = await this.request("thread/start", { model: pick.model, cwd: this.o.cwd, approvalPolicy: "never" });
    const threadId = text(obj(started.thread).id);
    if (!threadId) throw new Error("Codex did not return a thread");
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => finish(null), timeoutMs);
      const finish = (v: string | null) => { clearTimeout(timer); this.side.delete(threadId); resolve(v); };
      this.side.set(threadId, { text: "", done: finish });
      this.request("turn/start", {
        threadId, input: [{ type: "text", text: prompt }], cwd: this.o.cwd, model: pick.model, effort: pick.effort,
        approvalPolicy: "never", sandboxPolicy: { type: "readOnly" },
      }).catch((e) => { clearTimeout(timer); this.side.delete(threadId); reject(e); });
    });
  }

  async interrupt() {
    if (this.turnId) await this.request("turn/interrupt", { threadId: this.sessionId, turnId: this.turnId });
  }

  waitIdle(ms: number): Promise<boolean> {
    if (this.idle || this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.idle), ms);
      this.idleWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  private finish(code: number | null) {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex exited")); }
    this.requests.clear();
    for (const wake of this.idleWaiters.splice(0)) wake();
    if (!this.stopped) this.o.onExit({
      code, stderrTail: this.o.redactor.scrub(this.stderr), resumeMissing: false,
      pending: [this.current, ...this.queue].filter((s): s is string => s !== null),
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
