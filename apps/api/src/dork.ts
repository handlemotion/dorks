import { DurableObject } from "cloudflare:workers";
import { fromBridge, type ClientEvent, type ClientEventBody, type DorkState, type ToBridge } from "@dorks/shared";
import { createDeps, OnboardingError, type Deps, type SummaryPatch } from "./lifecycle/deps";
import { reduce, type Effect, type Input, type Result } from "./lifecycle/machine";
import { Timers } from "./lib/timers";
import { createNormalizer } from "./normalize";

const TICKET_TTL_MS = 60_000;
const PRESENCE_WINDOW_MS = 90_000;
const RAW_KEEP = 2000;
const WATCHDOG_MS = 3 * 60_000; // creating/waking must reach `ready` (or a lost bridge must return) within this
const GH_REFRESH_MS = 45 * 60_000; // installation tokens last 1h
const FLUSH_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_CHARS = 50_000;

export type ErrorCode = "archived" | "invalid" | "deleting" | "conflict" | "failed";
/** Expected, user-facing failures. Errors do not keep their class across Durable Object RPC, so these are returned as `Reply`. */
export class DorkError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}
export type Reply<T = DorkStatus> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

export interface DorkInit {
  dorkId: string;
  userId: string;
  repo: string; // owner/name
  branch: string;
  bridgeSecret: string;
}

export interface DorkStatus {
  state: DorkState;
  archived: boolean;
  boxId: string | null;
  claudeSessionId: string | null;
  pendingMessages: number;
}

/**
 * One per dork. Owns the box lifecycle (driven by the pure machine in lifecycle/machine.ts), the event log, client
 * fan-out (hibernatable sockets), the bridge socket and timers. Durability rules:
 *  - state/archived/box id live in SQLite and are written before effects run;
 *  - user messages go through a durable outbox and are redelivered until the bridge acks them;
 *  - every command is serialized, so effects of one command never interleave with another's;
 *  - watchdog timers turn a stuck create/wake into `error` (the next message retries).
 */
export class Dork extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private timers: Timers = new Timers(this.ctx);
  private normalize = createNormalizer();
  private chain: Promise<unknown> = Promise.resolve();
  private flushWaiter: (() => void) | null = null;
  /** Tests replace this; production builds it from env on first use. */
  _deps?: Deps;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initSchema();
    // Answered by the runtime without waking the DO; the timestamp doubles as a "viewer is really there" signal.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS raw (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0);
    `);
  }

  private deps(): Deps {
    return (this._deps ??= createDeps(this.env));
  }

  // ---------------------------------------------------------------- meta
  private getMeta(key: string): string | undefined {
    return this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value as string | undefined;
  }
  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
  private delMeta(key: string) {
    this.sql.exec("DELETE FROM meta WHERE key = ?", key);
  }
  private get dorkId() {
    return this.getMeta("dork_id") ?? "";
  }
  private get userId() {
    return this.getMeta("user_id") ?? "";
  }
  private get state(): DorkState {
    return (this.getMeta("state") as DorkState | undefined) ?? "creating";
  }
  private get archived() {
    return this.getMeta("archived") === "1";
  }
  private get boxId() {
    return this.getMeta("box_id") ?? null;
  }
  private pending() {
    return this.sql.exec("SELECT COUNT(*) AS n FROM outbox WHERE acked = 0").one().n as number;
  }

  /** Runs a command serialized, turning failures into a `Reply` (never throws across RPC). */
  private command<T>(fn: () => Promise<T>): Promise<Reply<T>> {
    return this.serial(async () => {
      try {
        return { ok: true as const, value: await fn() };
      } catch (e) {
        if (e instanceof DorkError) return { ok: false as const, code: e.code, message: e.message };
        console.error("dork command failed", this.dorkId, e instanceof Error ? e.message.slice(0, 200) : "unknown");
        return { ok: false as const, code: "failed" as const, message: "internal error" };
      }
    });
  }

  /** One command at a time. A failed command does not poison the queue. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------- public RPC
  /** Idempotent for the same dork; refuses to re-bind to a different owner. */
  init(p: DorkInit): Reply<null> {
    if (this.getMeta("dork_id")) {
      if (this.userId !== p.userId || this.dorkId !== p.dorkId) return { ok: false, code: "conflict", message: "already initialised" };
      return { ok: true, value: null };
    }
    this.setMeta("dork_id", p.dorkId);
    this.setMeta("user_id", p.userId);
    this.setMeta("repo", p.repo);
    this.setMeta("branch", p.branch);
    this.setMeta("bridge_secret", p.bridgeSecret);
    this.setMeta("state", "creating");
    return { ok: true, value: null };
  }

  /** Persist the first message and start the box. Failures end in `error`, never throw: the next message retries. */
  create(firstMessage: string) {
    return this.command(async () => {
      this.persistMessage(this.checkText(firstMessage));
      await this.dispatch({ t: "start" });
      return this.status();
    });
  }

  sendMessage(text: string) {
    return this.command(async () => {
      const clean = this.checkText(text);
      const ctx = this.machineCtx();
      if (reduce(ctx, { t: "user_message" }).rejected) throw new DorkError("archived", "dork is archived");
      this.persistMessage(clean);
      await this.dispatch({ t: "user_message" });
      return this.status();
    });
  }

  interrupt() {
    return this.command(async () => {
      await this.dispatch({ t: "interrupt" });
      return this.status();
    });
  }

  setArchived(archived: boolean) {
    return this.command(async () => {
      await this.dispatch({ t: archived ? "archive" : "unarchive" });
      return this.status();
    });
  }

  /** Deletes the box first and only wipes local state if that succeeded, so a failed delete can simply be retried. */
  destroy() {
    return this.command(async () => {
      this.setMeta("deleting", "1");
      if (this.boxId) await this.deps().box.delete(this.boxId);
      for (const ws of this.ctx.getWebSockets()) ws.close(1000, "deleted");
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      // The live instance outlives the wipe: give it empty tables so late calls see "not initialised" instead of crashing.
      this.initSchema();
      this.timers = new Timers(this.ctx);
      this.flushWaiter = null;
      return null;
    });
  }

  reportPr(kind: "pr_opened" | "pr_merged", url: string, number: number) {
    return this.command(async () => {
      this.append({ type: kind, url, number });
      await this.syncSummary({ prUrl: url });
    });
  }

  status(): DorkStatus {
    return { state: this.state, archived: this.archived, boxId: this.boxId, claudeSessionId: this.getMeta("claude_session_id") ?? null, pendingMessages: this.pending() };
  }

  private checkText(text: string): string {
    if (this.getMeta("deleting")) throw new DorkError("deleting", "dork is being deleted");
    const t = typeof text === "string" ? text.trim() : "";
    if (!t) throw new DorkError("invalid", "message is empty");
    if (t.length > MAX_MESSAGE_CHARS) throw new DorkError("invalid", "message too long");
    return t;
  }

  private persistMessage(text: string) {
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO outbox (id, text) VALUES (?, ?)", id, text);
    this.append({ type: "user_message", text });
    this.setMeta("preview", text.slice(0, 140));
  }

  // ---------------------------------------------------------------- machine driver
  private machineCtx() {
    return { state: this.state, archived: this.archived, hasBox: !!this.boxId, queued: this.pending() > 0 };
  }

  /** Apply an input: persist the new state first, then run effects. An effect failure becomes an `op_failed` input. */
  private async dispatch(input: Input): Promise<Result> {
    const before = this.machineCtx();
    const r = reduce(before, input);
    if (r.rejected) return r;
    this.setMeta("state", r.state);
    this.setMeta("archived", r.archived ? "1" : "0");
    if (r.state !== before.state) this.append({ type: "status", state: r.state });
    if (r.state !== before.state || r.archived !== before.archived) {
      await this.syncSummary({ status: r.state, archivedAt: r.archived ? Date.now() : null });
    }
    for (const effect of r.effects) {
      try {
        await this.runEffect(effect);
      } catch (e) {
        const safe = e instanceof OnboardingError ? e.message : `${effect} failed`;
        console.error("effect failed", this.dorkId, effect, e instanceof Error ? e.message.slice(0, 200) : "unknown");
        this.append({ type: "error", message: safe });
        await this.dispatch({ t: "op_failed" });
        break;
      }
    }
    return r;
  }

  private async runEffect(effect: Effect) {
    const sleepMs = Number(this.getMeta("sleep_minutes") ?? 5) * 60_000;
    switch (effect) {
      case "create_box": {
        const rt = await this.deps().runtime.resolve(this.userId);
        this.setMeta("sleep_minutes", String(rt.sleepMinutes));
        const url = `${this.env.API_PUBLIC_URL.replace(/^http/, "ws")}/api/bridge/${this.dorkId}`;
        // Only bridge connection details go in the create-time env (it is frozen into snapshots); secrets arrive via `configure`.
        const box = await this.deps().box.createFromSnapshot(rt.snapshotId, {
          name: this.dorkId,
          initCommand: "dorks-bridge",
          env: { DORK_ID: this.dorkId, BRIDGE_URL: url, BRIDGE_SECRET: this.getMeta("bridge_secret")! },
        });
        this.setMeta("box_id", box.id);
        await this.syncSummary({ boxId: box.id, status: this.state });
        return;
      }
      case "resume_box": {
        await this.deps().box.resume(this.boxId!);
        // The bridge may already be connected (agent crashed but box stayed up): no new connect will trigger `configure`.
        const [ws] = this.ctx.getWebSockets("bridge");
        if (ws) await this.configureBridge(ws);
        return;
      }
      case "pause_box": {
        const [ws] = this.ctx.getWebSockets("bridge");
        if (ws) {
          const flushed = new Promise<void>((res) => (this.flushWaiter = res));
          this.sendToBridge({ t: "flush" });
          await Promise.race([flushed, new Promise((res) => setTimeout(res, FLUSH_TIMEOUT_MS))]);
          this.flushWaiter = null;
        }
        if (this.boxId) await this.deps().box.pause(this.boxId);
        for (const b of this.ctx.getWebSockets("bridge")) b.close(1000, "sleeping");
        await this.dispatch({ t: "paused" });
        return;
      }
      case "deliver_outbox":
        for (const row of this.sql.exec("SELECT id, text FROM outbox WHERE acked = 0 ORDER BY n").toArray()) {
          this.sendToBridge({ t: "user_message", id: row.id as string, text: row.text as string });
        }
        return;
      case "interrupt_agent":
        this.sendToBridge({ t: "interrupt" });
        return;
      case "arm_sleep":
        return this.timers.set("sleep", Date.now() + sleepMs);
      case "cancel_sleep":
        return this.timers.cancel("sleep");
      case "arm_watchdog":
        return this.timers.set("watchdog", Date.now() + WATCHDOG_MS);
      case "cancel_watchdog":
        return this.timers.cancel("watchdog");
      case "arm_gh_refresh":
        return this.timers.set("gh_token", Date.now() + GH_REFRESH_MS);
      case "cancel_gh_refresh":
        return this.timers.cancel("gh_token");
    }
  }

  private sendToBridge(frame: ToBridge): boolean {
    const [ws] = this.ctx.getWebSockets("bridge");
    if (!ws) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  /** Secrets are decrypted here and sent over the bridge socket only; never logged, never put in the event log. */
  private async configureBridge(ws: WebSocket) {
    const rt = await this.deps().runtime.resolve(this.userId);
    const ghToken = await this.deps().runtime.githubToken(this.userId);
    this.setMeta("sleep_minutes", String(rt.sleepMinutes));
    const frame: ToBridge = {
      t: "configure",
      env: { ...rt.cliSecrets, CLAUDE_CODE_OAUTH_TOKEN: rt.claudeToken },
      ghToken,
      repo: { fullName: this.getMeta("repo")!, branch: this.getMeta("branch")! },
      resumeSessionId: this.getMeta("claude_session_id") ?? null,
    };
    ws.send(JSON.stringify(frame));
  }

  // ---------------------------------------------------------------- timers
  async alarm() {
    for (const name of this.timers.takeDue(Date.now())) {
      try {
        await this.runTimer(name);
      } catch (e) {
        console.error("timer failed", name, e instanceof Error ? e.message.slice(0, 200) : "unknown");
      }
    }
    await this.timers.arm();
  }

  /** Public so tests can fire timers deterministically. */
  runTimer(name: string): Promise<void> {
    return this.serial(async () => {
      switch (name) {
        case "sleep":
          await this.dispatch({ t: "sleep_due" });
          break;
        case "watchdog":
          if (["creating", "waking", "working", "idle"].includes(this.state)) this.append({ type: "error", message: "timed out waiting for the sandbox" });
          await this.dispatch({ t: "watchdog" });
          break;
        case "gh_token": {
          if (!["working", "idle"].includes(this.state)) return;
          try {
            this.sendToBridge({ t: "gh_token", token: await this.deps().runtime.githubToken(this.userId) });
          } finally {
            await this.timers.set("gh_token", Date.now() + GH_REFRESH_MS);
          }
          break;
        }
        case "summary":
          await this.syncSummary({});
          break;
      }
    });
  }

  // ---------------------------------------------------------------- D1 mirror (best effort, retried)
  private async syncSummary(patch: SummaryPatch) {
    const pending = JSON.parse(this.getMeta("summary_pending") ?? "{}") as SummaryPatch;
    const merged: SummaryPatch = { ...pending, ...patch, lastActivityAt: Date.now(), lastPreview: this.getMeta("preview") };
    try {
      await this.deps().summary.update(this.dorkId, merged);
      this.delMeta("summary_pending");
    } catch {
      this.setMeta("summary_pending", JSON.stringify(merged));
      await this.timers.set("summary", Date.now() + 30_000);
    }
  }

  // ---------------------------------------------------------------- event log
  append(body: ClientEventBody): ClientEvent {
    const ts = Date.now();
    const row = this.sql.exec("INSERT INTO events (ts, json) VALUES (?, ?) RETURNING seq", ts, JSON.stringify(body)).one();
    const event = { ...body, seq: row.seq as number, dorkId: this.dorkId, ts } as ClientEvent;
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets("client")) ws.send(payload);
    return event;
  }

  eventsAfter(seq: number): ClientEvent[] {
    return this.sql
      .exec("SELECT seq, ts, json FROM events WHERE seq > ? ORDER BY seq", seq)
      .toArray()
      .map((r) => ({ ...JSON.parse(r.json as string), seq: r.seq, dorkId: this.dorkId, ts: r.ts }) as ClientEvent);
  }

  // ---------------------------------------------------------------- client access
  issueTicket(): string {
    const now = Date.now();
    this.sql.exec("DELETE FROM tickets WHERE expires < ?", now);
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    this.sql.exec("INSERT INTO tickets (token, expires) VALUES (?, ?)", token, now + TICKET_TTL_MS);
    return token;
  }

  private consumeTicket(token: string | null): boolean {
    if (!token) return false;
    const row = this.sql.exec("DELETE FROM tickets WHERE token = ? RETURNING expires", token).toArray()[0];
    return !!row && (row.expires as number) >= Date.now();
  }

  /** True if some client answered an auto-ping recently (a backgrounded iOS socket can look open but be dead). */
  hasActiveViewer(): boolean {
    const cutoff = Date.now() - PRESENCE_WINDOW_MS;
    return this.ctx.getWebSockets("client").some((ws) => (this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0) > cutoff);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (this.getMeta("deleting") || !this.getMeta("dork_id")) return new Response("not found", { status: 404 });
    const url = new URL(req.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (url.pathname === "/bridge") {
      const secret = this.getMeta("bridge_secret");
      if (!secret || req.headers.get("Authorization") !== `Bearer ${secret}`) return new Response("forbidden", { status: 403 });
      // A bridge that connects while we believe the box is asleep must not wake anything.
      if (this.state === "sleeping") return new Response("sleeping", { status: 409 });
      for (const old of this.ctx.getWebSockets("bridge")) old.close(1012, "replaced");
      this.ctx.acceptWebSocket(server, ["bridge"]);
      server.send(JSON.stringify({ t: "hello", afterBridgeSeq: Number(this.getMeta("bridge_seq") ?? 0) } satisfies ToBridge));
      this.ctx.waitUntil(
        this.serial(async () => {
          try {
            await this.configureBridge(server);
          } catch (e) {
            this.append({ type: "error", message: e instanceof OnboardingError ? e.message : "could not configure the sandbox" });
            await this.dispatch({ t: "op_failed" });
          }
        }),
      );
      return new Response(null, { status: 101, webSocket: client });
    }

    if (!this.consumeTicket(url.searchParams.get("ticket"))) return new Response("forbidden", { status: 403 });
    const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
    this.ctx.acceptWebSocket(server, ["client"]);
    // Replay and live fan-out happen in one synchronous turn, so nothing can interleave: no gaps, no dupes.
    for (const e of this.eventsAfter(after)) server.send(JSON.stringify(e));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || !this.ctx.getTags(ws).includes("bridge")) return; // clients only ping
    let parsed;
    try {
      parsed = fromBridge.safeParse(JSON.parse(message));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const frame = parsed.data;
    // `flushed` must bypass the queue: the pause that is waiting for it is itself running inside the queue.
    if (frame.t === "flushed") return void this.flushWaiter?.();
    await this.serial(() => this.onFrame(frame));
  }

  private async onFrame(frame: ReturnType<typeof fromBridge.parse>) {
    switch (frame.t) {
      case "ready":
        return void (await this.dispatch({ t: "agent_ready" }));
      case "ack":
        this.sql.exec("UPDATE outbox SET acked = 1 WHERE id = ?", frame.id);
        return;
      case "agent_exited":
        this.append({ type: "agent_exited", message: `agent exited (code ${frame.code ?? "?"})` });
        console.error("agent exited", this.dorkId, frame.code, frame.stderrTail.slice(-200));
        await this.dispatch({ t: "agent_exited" });
        return;
      case "event": {
        const last = Number(this.getMeta("bridge_seq") ?? 0);
        if (frame.bseq <= last) return; // replay overlap after a reconnect
        this.setMeta("bridge_seq", String(frame.bseq));
        this.sql.exec("INSERT INTO raw (json) VALUES (?)", JSON.stringify(frame.raw));
        this.sql.exec("DELETE FROM raw WHERE id <= (SELECT MAX(id) FROM raw) - ?", RAW_KEEP);
        for (const n of this.normalize(frame.raw)) {
          if (n.kind === "event") {
            this.append(n.body);
            if (n.body.type === "assistant_message") this.setMeta("preview", n.body.text.slice(0, 140));
            if (n.body.type === "turn_complete") await this.syncSummary({});
          } else if (n.kind === "session") {
            this.setMeta("claude_session_id", n.sessionId);
            await this.syncSummary({ claudeSessionId: n.sessionId });
          } else {
            await this.dispatch({ t: "turn_idle" });
          }
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
    if (!this.ctx.getTags(ws).includes("bridge")) return;
    await this.serial(async () => {
      const stillUp = this.ctx.getWebSockets("bridge").some((w) => w !== ws);
      if (!stillUp) await this.dispatch({ t: "bridge_lost" });
    });
  }
}
