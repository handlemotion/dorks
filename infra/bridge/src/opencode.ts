import { toRaw, type AgentEvent } from "@dorks/shared";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Harness, HarnessOptions } from "./harness";
import { errTag } from "./redact";
import type { RpcMethods } from "./rpc";
import { asIdentity } from "./runas";

// The OpenCode harness. OpenCode is built as a server: `opencode serve` exposes a REST API (OpenAPI 3.1) and pushes every change as
// Server-Sent Events on GET /event. The bridge starts one server per agent, on loopback, inside the repo; then
//   send a turn  POST /session/{id}/prompt_async   (returns at once; the turn streams on /event)
//   interrupt    POST /session/{id}/abort
//   permission   POST /session/{id}/permissions/{permissionID}   (config allows everything; anything still asked is rejected)
// and translates the event stream into neutral agent events (`translate` below, the only place that knows OpenCode's event shapes).
//
// Claude Code's hooks have no OpenCode equivalent that a bridge can answer synchronously, so the harness calls the same handlers
// (hooks.ts) at the matching points: SessionStart's context goes in as each prompt's `system`, PostToolUse runs after each finished
// `bash` call, and the Stop gate runs when a turn goes idle: a block reason becomes the next prompt instead of the idle.

export interface OpenCodeOptions extends HarnessOptions {
  bin: string;
  /** `<provider>/<model>`, or null for OpenCode's default. */
  model: string | null;
  stateDir: string;
  /** The `dorks` MCP server (mcp.ts), as OpenCode's `mcp` config runs it. */
  mcpServer: { command: string[]; env: Record<string, string> };
  hooks: RpcMethods;
}

/** Where OpenCode keeps its data (sessions included): `$XDG_DATA_HOME/opencode`. */
export const dataDirOf = (env: NodeJS.ProcessEnv) => join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "opencode");

/** Session files on disk: `storage/session/<project>/<id>.json` (older layout) or a database next to `storage` (newer). */
function sessionFilesIn(env: NodeJS.ProcessEnv, sessionId: string): string[] {
  const data = dataDirOf(env);
  const out: string[] = [];
  const sessions = join(data, "storage", "session");
  try {
    for (const p of existsSync(sessions) ? readdirSync(sessions) : []) {
      const f = join(sessions, p, `${sessionId}.json`);
      if (existsSync(f)) out.push(f);
    }
    for (const f of existsSync(data) ? readdirSync(data) : []) if (/\.db(-wal)?$/.test(f)) out.push(join(data, f));
  } catch {
    /* unreadable: nothing to fsync */
  }
  return out;
}

/** Whether OpenCode can have this session on this box. A database layout cannot be checked from outside: the harness verifies it at start. */
export const hasOpenCodeSession = (env: NodeJS.ProcessEnv, sessionId: string) => sessionFilesIn(env, sessionId).length > 0;

/** The config handed to OpenCode in OPENCODE_CONFIG_CONTENT: unattended, no prompts, the dorks MCP server, nothing phoning home. */
export function opencodeConfig(o: Pick<OpenCodeOptions, "model" | "mcpServer">) {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    // Nobody is attached to answer a prompt (same reasoning as Claude's bypassPermissions, see the bridge README).
    permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow", doom_loop: "allow" },
    ...(o.model ? { model: o.model } : {}),
    mcp: { dorks: { type: "local", command: o.mcpServer.command, environment: o.mcpServer.env, enabled: true } },
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** One OpenCode SSE event of our session -> neutral events, plus what the harness itself must act on. Pure: tests drive it directly. */
export interface Translation {
  events: AgentEvent[];
  /** The session finished a turn (went idle). */
  idle?: boolean;
  /** A finished `bash` call, for the PostToolUse handler. */
  bash?: { command: string; output: string };
  /** A permission OpenCode is waiting on. */
  permission?: string;
  /** The turn failed: carried to the `turn_complete`. */
  error?: string;
}

export interface TranslateState {
  /** Ids of messages whose role is `user` (their parts are our own prompt echoed back). */
  userMessages: Set<string>;
  /** Text parts already streamed: part id -> text length sent. */
  textSent: Map<string, number>;
  /** Tool calls already announced / finished. */
  toolsStarted: Set<string>;
  toolsDone: Set<string>;
}
export const newTranslateState = (): TranslateState => ({ userMessages: new Set(), textSent: new Map(), toolsStarted: new Set(), toolsDone: new Set() });

const errorText = (e: unknown) => {
  const x = obj(e);
  if (!x) return undefined;
  const msg = str(obj(x.data)?.message) ?? str(x.message);
  const name = str(x.name);
  return name && msg ? `${name}: ${msg}` : (msg ?? name ?? "turn failed");
};

export function translate(raw: unknown, sessionId: string, st: TranslateState): Translation {
  const out: Translation = { events: [] };
  const ev = obj(raw);
  const p = obj(ev?.properties);
  if (!ev || !p) return out;
  const sid = str(p.sessionID) ?? str(obj(p.info)?.sessionID) ?? str(obj(p.part)?.sessionID);
  if (sid !== undefined && sid !== sessionId) return out;

  switch (ev.type) {
    case "message.updated": {
      const info = obj(p.info);
      const id = str(info?.id);
      if (id && info?.role === "user") st.userMessages.add(id);
      if (info?.role === "assistant" && info.error) out.error = errorText(info.error);
      break;
    }
    case "message.part.updated": {
      const part = obj(p.part);
      const mid = str(part?.messageID);
      const pid = str(part?.id);
      if (!part || !mid || !pid || st.userMessages.has(mid)) break;
      if (part.type === "text" && !part.synthetic) {
        const text = str(part.text) ?? "";
        const sent = st.textSent.get(pid) ?? 0;
        const done = !!obj(part.time)?.end;
        // A delta, when OpenCode sends one, is the new tail; otherwise the tail is whatever grew since the last update.
        const delta = str(p.delta) ?? (text.length > sent ? text.slice(sent) : "");
        if (delta && !done) out.events.push({ type: "text_delta", messageId: pid, text: delta });
        st.textSent.set(pid, Math.max(sent + (str(p.delta)?.length ?? 0), text.length));
        if (done && text) out.events.push({ type: "text", messageId: pid, text });
      } else if (part.type === "tool") {
        const call = str(part.callID) ?? pid;
        const state = obj(part.state);
        const status = str(state?.status);
        if (!st.toolsStarted.has(call) && (status === "running" || status === "completed" || status === "error")) {
          st.toolsStarted.add(call);
          out.events.push({ type: "tool_use", toolId: call, name: str(part.tool) ?? "tool", input: state?.input ?? {} });
        }
        if ((status === "completed" || status === "error") && !st.toolsDone.has(call)) {
          st.toolsDone.add(call);
          const output = status === "completed" ? (str(state?.output) ?? "") : (str(state?.error) ?? "tool failed");
          out.events.push({ type: "tool_result", toolId: call, ok: status === "completed", output });
          if (part.tool === "bash") out.bash = { command: str(obj(state?.input)?.command) ?? "", output };
        }
      }
      break;
    }
    case "session.error":
      out.error = errorText(p.error);
      break;
    case "session.idle":
      out.idle = true;
      break;
    case "session.status":
      if (obj(p.status)?.type === "idle") out.idle = true;
      break;
    case "permission.updated":
    case "permission.asked": {
      const id = str(p.id);
      if (id) out.permission = id;
      break;
    }
  }
  return out;
}

const STDERR_TAIL = 2048;
const READY = /listening on (https?:\/\/[^\s]+)/;

export class OpenCodeAgent implements Harness {
  readonly engine = "opencode" as const;
  private child: ChildProcessWithoutNullStreams;
  private base: string | null = null;
  private stderr = "";
  private stopping = false;
  private exited = false;
  private sse: AbortController | null = null;
  private st = newTranslateState();
  sessionId: string | null;
  idle = true;
  private idleWaiters: (() => void)[] = [];
  private pending: string[] = [];
  private queue: string[] = []; // prompts waiting for the server/session to be ready, or for the current turn to end
  private ready: Promise<void>;
  private turnStart = 0;
  private turnError: string | undefined;
  private gateContinuing = false; // the running turn was started by the Stop gate (never gate twice in a row)
  private forwarded = false;

  constructor(private o: OpenCodeOptions) {
    this.sessionId = o.resumeSessionId;
    const env = { ...o.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(o)), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1" };
    const [bin, args] = asIdentity(o.runAs, o.bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    this.child = spawn(bin, args, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    this.ready = new Promise<void>((resolve, reject) => {
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (d: string) => {
        if (this.base) return;
        out = (out + d).slice(-4096);
        const m = READY.exec(out);
        if (m) {
          this.base = m[1]!.replace(/\/+$/, "");
          resolve();
        }
      });
      this.child.once("close", () => reject(new Error("opencode exited before it was ready")));
    }).then(() => this.openSession());
    this.ready.catch(() => {});
    // stderr can echo env or tokens: keep a tail for the exit report (scrubbed), never log it.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d: string) => {
      this.stderr = (this.stderr + d).slice(-STDERR_TAIL);
    });
    this.child.stdin.on("error", () => {});
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

  private async api(method: string, path: string, body?: unknown): Promise<Response> {
    if (!this.base) throw new Error("opencode is not ready");
    return fetch(`${this.base}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** Resume the stored session if the server knows it, else start a fresh one; then follow its events. */
  private async openSession() {
    let missing = false;
    if (this.sessionId) {
      const r = await this.api("GET", `/session/${encodeURIComponent(this.sessionId)}`);
      if (r.status === 404) missing = true;
      else if (!r.ok) throw new Error(`opencode session lookup failed (${r.status})`);
    }
    if (!this.sessionId || missing) {
      if (missing) {
        // Same contract as Claude's "No conversation found": the bridge restarts us on a fresh session.
        this.resumeMissing = true;
        void this.stop(1000).then(() => this.finish(1, true));
        return;
      }
      const r = await this.api("POST", "/session", {});
      if (!r.ok) throw new Error(`opencode session create failed (${r.status})`);
      this.sessionId = str(obj(await r.json())?.id) ?? null;
      if (!this.sessionId) throw new Error("opencode returned no session id");
    }
    this.emit({ type: "session", sessionId: this.sessionId });
    await this.followEvents();
    for (const t of this.queue.splice(0)) await this.prompt(t);
  }

  private resumeMissing = false;

  private async followEvents() {
    this.sse = new AbortController();
    const r = await fetch(`${this.base}/event`, { headers: { accept: "text/event-stream" }, signal: this.sse.signal });
    if (!r.ok || !r.body) throw new Error(`opencode event stream failed (${r.status})`);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    void (async () => {
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (data) {
              try {
                await this.onEvent(JSON.parse(data));
              } catch (e) {
                this.o.log("opencode event handling failed:", errTag(e));
              }
            }
          }
        }
      } catch {
        /* aborted on stop, or the server died: 'close' reports it */
      }
    })();
  }

  private emit(e: AgentEvent) {
    this.forwarded = true;
    this.o.onRaw(toRaw(e));
  }

  private async onEvent(raw: unknown) {
    if (!this.sessionId) return;
    const t = translate(raw, this.sessionId, this.st);
    for (const e of t.events) this.emit(e);
    if (t.error) this.turnError = t.error;
    if (t.permission) {
      // Config allows everything; whatever is still asked (nobody can approve it) is rejected so the turn continues.
      void this.api("POST", `/session/${encodeURIComponent(this.sessionId)}/permissions/${encodeURIComponent(t.permission)}`, { response: "reject" }).catch(() => {});
    }
    if (t.bash) void this.o.hooks["hook.postToolUse"]?.({ tool_name: "Bash", tool_input: { command: t.bash.command }, tool_response: { stdout: t.bash.output, stderr: "" } });
    if (t.idle && !this.idle) await this.turnEnded();
  }

  private async turnEnded() {
    this.emit({ type: "turn_complete", durationMs: Date.now() - this.turnStart, ...(this.turnError !== undefined ? { error: this.turnError } : {}) });
    const failed = this.turnError !== undefined;
    this.turnError = undefined;
    // The Stop gate (hooks.ts), as Claude's Stop hook would run it: a block reason is the next turn instead of the idle.
    if (!failed && this.queue.length === 0) {
      const gate = (await Promise.resolve(this.o.hooks["hook.stop"]?.({ session_id: this.sessionId, stop_hook_active: this.gateContinuing })).catch(() => null)) as { decision?: string; reason?: string } | null;
      if (gate?.decision === "block" && gate.reason) {
        this.gateContinuing = true;
        return void this.prompt(gate.reason).catch(() => this.markIdle());
      }
    }
    this.gateContinuing = false;
    const next = this.queue.shift();
    if (next !== undefined) return void this.prompt(next).catch(() => this.markIdle());
    this.markIdle();
  }

  private markIdle() {
    this.idle = true;
    this.pending = [];
    this.emit({ type: "idle" });
    for (const w of this.idleWaiters.splice(0)) w();
  }

  private async prompt(text: string) {
    this.idle = false;
    this.turnStart = Date.now();
    this.st.textSent.clear();
    const ctx = (await Promise.resolve(this.o.hooks["hook.sessionStart"]?.({})).catch(() => null)) as { hookSpecificOutput?: { additionalContext?: string } } | null;
    const system = ctx?.hookSpecificOutput?.additionalContext;
    const [providerID, ...rest] = (this.o.model ?? "").split("/");
    const r = await this.api("POST", `/session/${encodeURIComponent(this.sessionId!)}/prompt_async`, {
      parts: [{ type: "text", text }],
      ...(this.o.model ? { model: { providerID, modelID: rest.join("/") } } : {}),
      ...(system ? { system } : {}),
    });
    if (!r.ok) throw new Error(`opencode prompt failed (${r.status})`);
  }

  async sendUserMessage(text: string) {
    if (this.exited || this.stopping) throw new Error("agent not running");
    this.pending.push(text);
    // One turn at a time, like Claude's stdin queue: a message sent mid-turn runs when the turn ends.
    if (!this.sessionId || !this.base || !this.idle || this.queue.length) {
      this.queue.push(text);
      this.idle = false;
      return;
    }
    this.gateContinuing = false;
    await this.prompt(text);
  }

  async interrupt() {
    await this.ready;
    if (!this.sessionId) return;
    const r = await this.api("POST", `/session/${encodeURIComponent(this.sessionId)}/abort`);
    if (!r.ok) throw new Error(`opencode abort failed (${r.status})`);
  }

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

  sessionFiles() {
    return this.sessionId ? sessionFilesIn(this.o.env, this.sessionId) : [];
  }

  private finish(code: number | null, resumeMissing = this.resumeMissing) {
    if (this.exited) return;
    this.exited = true;
    this.sse?.abort();
    for (const w of this.idleWaiters.splice(0)) w();
    const missing = resumeMissing && !this.forwarded;
    if (!this.stopping || missing) this.o.onExit({ code, stderrTail: this.o.redactor.scrub(this.stderr), resumeMissing: missing, pending: [...this.pending] });
  }

  async stop(graceMs = 5000) {
    if (this.exited) return;
    this.stopping = true;
    this.sse?.abort();
    const done = new Promise<void>((r) => this.child.once("close", () => r()));
    this.child.kill("SIGTERM");
    const t = setTimeout(() => this.child.kill("SIGKILL"), graceMs);
    await done;
    clearTimeout(t);
  }
}
