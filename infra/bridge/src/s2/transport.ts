import { appError, commandFrame, httpProof, skillBundle, type AppErrorCode, type FromBridge, type PrRef, type ToBridge } from "@dorks/shared";
import type { CallHandler, CommandEntry, PushResult, Transport } from "../transport";
import { errTag, type Log } from "../redact";
import { SessionNormalizer, type StateFrame } from "./normalize";
import type { Command } from "./records";
import { S2 } from "./s2";
import { BridgeWriter, FencedError } from "./writer";

// The bridge's backend for a cloud org (Teams, Cloud): no server dials this box. The bridge appends the session's transcript to s2
// itself, tails its commands from s2, and calls the stateless Worker over HTTPS for everything else (docs/architecture.md, "Cloud
// sessions"; the Worker side is handlemotion/dorks-cloud docs/org-runtime.md and docs/realtime.md).
//
//   connect            POST /v1/bridge/:id/connect -> a grant: s2 token (1 h), fencing token, streams, encryption key. Every
//                      connect fences out the previous bridge of this session; afterBridgeSeq is the last bseq in the stream.
//   push (events)      normalized here into client events and appended to `events`, fenced and exactly once (writer.ts)
//   push (the rest)    POST /v1/bridge/:id/state {frames}: ready, ack, agent_exited, flushed, title, models, ... plus the
//                      session id, turn boundaries and preview derived from the stream (normalize.ts). Acks also append the
//                      command's echo to `events`: the commit point.
//   commands           a long-poll tail of `commands` from the cursor; each record's body is a CommandFrame (record id = cid,
//                      and = the frame's id for messages), or a transport frame: {t: "call", id, op, args} (answered in
//                      `events` as a "ret" record) or {t: "subscriptions", views}
//   heartbeat          POST /v1/bridge/:id/state {frames: []}
//   token              POST /v1/bridge/:id/token -> {token, expiresAt}: before the s2 token expires, and whenever s2 refuses it
//   every other op     POST /v1/bridge/:id/rpc {op, args} -> {result}: the ops and shapes of the WebSocket transport's rpc
// Every call carries `authorization: DorksBridge <ts>.<proof>` (httpProof in @dorks/shared): the per-session secret never
// leaves the box. A refusal is an AppError body ({code, message}): `forbidden` stops the bridge, `sleeping` exits it.

const RPC_TIMEOUT_MS = 60_000;
/** Renew the s2 token this long before it expires. */
const RENEW_BEFORE_MS = 5 * 60_000;
const CALL_CODES = new Set(["invalid", "not_found", "conflict"]);
const STATE_BATCH = 100;
/** How long (in 1 s tries) an input call waits for a writer to come back before it fails; the event stays pending either way. */
const INPUT_NOTE_ATTEMPTS = 60;

export type BridgeGrant = {
  basin: string;
  basinUrl?: string;
  streams: { events: string; commands: string };
  token: string;
  tokenExpiresAt: number;
  fence: string;
  encryptionKey: string | null;
};

export interface S2TransportOptions {
  dorkId: string;
  secret: string;
  /** The Worker's base URL (DORKS_WORKER_URL), e.g. https://api.dorks.build. */
  workerUrl: string;
  log: Log;
  /** For tests: the fetch used for the Worker, and the one used for s2. */
  fetch?: typeof fetch;
  s2Fetch?: typeof fetch;
}

const code = (e: unknown): AppErrorCode | undefined => {
  const r = appError.safeParse((e as { data?: unknown } | null)?.data);
  return r.success ? r.data.code : undefined;
};
const typed = (error: { code: string; message?: string }) => Object.assign(new Error(error.message ?? error.code), { data: error });

export class S2Transport implements Transport {
  private writer: BridgeWriter | null = null;
  private tail: AbortController | null = null;
  private readonly norm = new SessionNormalizer();
  /** The last event bseq handed to the writer (events at or below it are resends). */
  private normalizedBseq = 0;
  /** Control frames already handled: the outbox retries a failed push with the same frame objects. */
  private readonly processed = new WeakSet<object>();
  private stateQueue: StateFrame[] = [];
  /** Normalized agent lines not known to be in the stream yet, by bseq (normalize.ts is stateful: a replay reuses these). */
  private readonly normalized = new Map<number, ReturnType<SessionNormalizer["line"]>>();
  private draining: Promise<void> = Promise.resolve();
  /** Commands handed to the bridge and not acked yet, by the id its ack names. */
  private readonly delivered = new Map<string, Command>();
  /** Acks for commands the current tail has not read (yet): sent before a reconnect, acked as soon as the new tail reaches them. */
  private readonly lateAcks = new Set<string>();
  /** `<requestId>|<type>` of the secure-input events already in the transcript. */
  private readonly inputNotes = new Set<string>();
  /** Secure-input events the Worker returned that are not in the transcript yet (a failed append): written after the reconnect. */
  private readonly pendingInputNotes = new Map<string, object>();
  private readonly inputNoteWrites = new Map<string, Promise<void>>();
  private snapshot: CommandEntry[] = [];
  private readonly commandSubs = new Set<{ on: (c: CommandEntry[]) => void; err: () => void }>();
  private readonly listSubs = new Set<{ on: (v: unknown) => void; err: () => void }>();
  private readonly reconnects = new Set<() => void>();
  private lastList?: unknown;
  private callHandler?: CallHandler;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnecting = false;
  private closed = false;
  private readonly fetch: typeof fetch;
  private readonly base: URL;

  constructor(private readonly o: S2TransportOptions) {
    this.fetch = o.fetch ?? fetch;
    this.base = new URL(o.workerUrl.replace(/\/*$/, "/"));
  }

  // ---------------------------------------------------------------- the Worker
  private async worker<T>(op: string, body: unknown = {}): Promise<T> {
    if (this.closed) throw new Error("transport closed");
    const url = new URL(`v1/bridge/${encodeURIComponent(this.o.dorkId)}/${op}`, this.base);
    const text = JSON.stringify(body);
    const ts = Date.now();
    const proof = await httpProof(this.o.secret, { method: "POST", path: url.pathname, body: text, ts });
    const res = await this.fetch(url, {
      method: "POST",
      headers: { authorization: `DorksBridge ${ts}.${proof}`, "content-type": "application/json" },
      body: text,
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const out = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const err = out?.error ?? out;
      if (err && typeof err.code === "string") throw typed(err);
      throw new Error(`worker ${op}: ${res.status}`);
    }
    return out as T;
  }

  private rpc = async <T = unknown>(op: string, args: object = {}): Promise<T> => ((await this.worker<{ result?: T }>("rpc", { op, args }))?.result ?? null) as T;

  // ---------------------------------------------------------------- s2
  connect = async () => {
    const g = await this.worker<BridgeGrant>("connect");
    this.stopTail();
    const s2 = new S2({ token: g.token, basin: g.basin, basinUrl: g.basinUrl, encryptionKey: g.encryptionKey ?? undefined, fetch: this.o.s2Fetch });
    const w = await BridgeWriter.open({ s2, streams: g.streams, fence: g.fence, refreshToken: () => this.renew() });
    this.writer = w;
    this.reconnecting = false;
    this.normalizedBseq = w.lastBseq;
    // What the previous tail handed out and nobody acked comes again from the cursor (the bridge dedupes by id).
    this.delivered.clear();
    this.snapshot = [];
    this.scheduleRenew(g.tokenExpiresAt);
    this.startTail(w);
    for (const [key, ev] of this.pendingInputNotes) void this.inputNote(key, ev).catch(() => {});
    this.o.log("s2: connected; events at", w.nextSeq, "bseq", w.lastBseq, "commands from", w.cursor);
    return { afterBridgeSeq: w.lastBseq };
  };

  private async renew() {
    const r = await this.worker<{ token: string; expiresAt: number }>("token");
    this.scheduleRenew(r.expiresAt);
    return r.token;
  }

  private scheduleRenew(expiresAt: number) {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    const ms = Math.max(10_000, expiresAt - Date.now() - RENEW_BEFORE_MS);
    this.renewTimer = setTimeout(() => {
      this.renewTimer = null;
      this.renew()
        .then((t) => this.writer?.setToken(t))
        .catch((e) => {
          this.o.log("s2: token renewal failed, retrying:", errTag(e));
          this.scheduleRenew(Date.now() + RENEW_BEFORE_MS + 30_000);
        });
    }, ms);
    this.renewTimer.unref?.();
  }

  private startTail(w: BridgeWriter) {
    const ac = new AbortController();
    this.tail = ac;
    void (async () => {
      try {
        for await (const cmd of w.commands(ac.signal)) this.onCommand(w, cmd);
      } catch (e) {
        if (!ac.signal.aborted) this.broken(e, w);
      }
    })();
  }

  private stopTail() {
    this.tail?.abort();
    this.tail = null;
  }

  /** The writer or the tail failed for good: a replaced bridge stops; anything else reconnects (a new fence, a new writer). */
  private broken(e: unknown, w: BridgeWriter | null = this.writer) {
    if (this.closed || e instanceof FencedError || w !== this.writer) return; // a writer already replaced fails quietly
    this.o.log("s2: session stream failed, reconnecting:", errTag(e));
    this.writer = null;
    this.stopTail();
    for (const s of [...this.commandSubs]) s.err();
    if (this.reconnecting) return;
    this.reconnecting = true;
    for (const cb of [...this.reconnects]) cb();
  }

  private onCommand(w: BridgeWriter, cmd: Command) {
    let body: any = null;
    try {
      body = JSON.parse(cmd.body);
    } catch {
      /* not JSON: skipped below */
    }
    if (body?.t === "call") return void this.answerCall(w, cmd, body);
    if (body?.t === "subscriptions") {
      this.lastList = body.views;
      for (const s of [...this.listSubs]) s.on(this.lastList);
      return void w.ack(cmd).catch((e) => this.broken(e, w));
    }
    const parsed = commandFrame.safeParse(body);
    if (!parsed.success) {
      this.o.log("s2: skipped a command this bridge does not know");
      return void w.ack(cmd).catch((e) => this.broken(e, w));
    }
    const frame = parsed.data;
    const id = frame.t === "user_message" || frame.t === "notify" ? frame.id : cmd.cid;
    if (this.lateAcks.delete(id)) return void w.ack(cmd).catch((e) => this.broken(e, w));
    if (frame.t === "interrupt") this.norm.interruptRequested = true;
    this.delivered.set(id, cmd);
    this.snapshot = [...this.snapshot, { cid: cmd.cid, frame }];
    for (const s of [...this.commandSubs]) s.on(this.snapshot);
  }

  private async answerCall(w: BridgeWriter, cmd: Command, msg: { id?: unknown; op?: unknown; args?: unknown }) {
    let reply: object;
    try {
      if (!this.callHandler || typeof msg.op !== "string") throw Object.assign(new Error("This bridge does not answer that call."), { code: "invalid" });
      const args = msg.args && typeof msg.args === "object" ? (msg.args as Record<string, unknown>) : {};
      reply = { id: msg.id, ok: true, result: (await this.callHandler(msg.op, args)) ?? null };
    } catch (e) {
      const c = (e as { code?: unknown })?.code;
      reply = { id: msg.id, ok: false, error: typeof c === "string" && CALL_CODES.has(c) ? { code: c, message: (e as Error).message } : { code: "failed", message: "The sandbox could not do that." } };
    }
    await w.ack(cmd, JSON.stringify(reply)).catch((e) => this.broken(e, w));
  }

  // ---------------------------------------------------------------- Transport
  push = async (frames: FromBridge[]): Promise<PushResult> => {
    const w = this.writer;
    if (!w || w.error) {
      if (w?.error) this.broken(w.error, w); // failed outside a push (a call's answer, an internal ack): reconnect now
      throw w?.error instanceof FencedError ? w.error : new Error("not connected");
    }
    const durable: Promise<void>[] = [];
    // State frames wait for the events before them to be durable: a heartbeat's drain must not send them early. Each entry
    // remembers the agent line it came from (none for control frames), so a partial failure keeps what was committed.
    const state: { bseq?: number; frame: StateFrame }[] = [];
    const handled: object[] = [];
    const lines: number[] = [];
    for (const f of frames) {
      if (f.t === "event") {
        if (f.bseq <= this.normalizedBseq) continue; // a resend of what is already in the stream
        this.normalizedBseq = f.bseq;
        lines.push(f.bseq);
        this.appendLine(w, f.bseq, f.raw, state, durable);
        continue;
      }
      if (this.processed.has(f)) continue;
      this.processed.add(f);
      handled.push(f);
      if (f.t === "ack") this.ackFrame(w, f.id, durable);
      const notes = SessionNormalizer.noteFor(f);
      if (notes.length) durable.push(w.note(JSON.stringify(notes)));
      state.push({ frame: f });
    }
    try {
      await Promise.all(durable);
    } catch (e) {
      // Not durable: the outbox retries these frames after the reconnect, so they must be handled again then. What the lines
      // already in the stream implied is kept (a resend skips them); the others replay from `normalized`, unchanged.
      this.pushFailed(e, w, handled, state, lines);
      throw e;
    }
    for (const b of lines) this.normalized.delete(b);
    this.stateQueue.push(...state.map((s) => s.frame));
    await this.flushState();
    return { ok: true };
  };

  /**
   * One agent line, normalized once: a line whose append failed is replayed after the reconnect with the output it had (the
   * normalizer's turn state moved on when it was first seen), not normalized again.
   */
  private appendLine(w: BridgeWriter, bseq: number, raw: unknown, state: { bseq?: number; frame: StateFrame }[], durable: Promise<void>[]) {
    const line = this.normalized.get(bseq) ?? this.norm.line(raw);
    this.normalized.set(bseq, line);
    for (const frame of line.state) state.push({ bseq, frame });
    if (line.events.length) durable.push(w.append([{ bseq, body: JSON.stringify(line.events) }]));
  }

  private pushFailed(e: unknown, w: BridgeWriter, handled: object[], state: { bseq?: number; frame: StateFrame }[], lines: number[]) {
    for (const f of handled) this.processed.delete(f);
    for (const s of state) if (s.bseq !== undefined && s.bseq <= w.lastBseq) this.stateQueue.push(s.frame);
    for (const b of lines) if (b <= w.lastBseq) this.normalized.delete(b);
    this.broken(e, w);
  }

  private ackFrame(w: BridgeWriter, id: string, durable: Promise<void>[]) {
    const cmd = this.delivered.get(id);
    if (!cmd) return void this.lateAcks.add(id); // delivered by an earlier tail: acked when this one reads it again
    this.delivered.delete(id);
    this.snapshot = this.snapshot.filter((e) => e.cid !== cmd.cid);
    durable.push(w.ack(cmd));
  }

  /**
   * Sends the queued state frames, one drain at a time (a heartbeat and a push may overlap: each sends and removes only what it
   * sent). Only the last preview of a batch matters.
   */
  private flushState(always = false): Promise<void> {
    const run = this.draining.catch(() => {}).then(() => this.drainState(always));
    this.draining = run;
    return run;
  }

  private async drainState(always: boolean) {
    if (!this.stateQueue.length && always) return void (await this.worker("state", { frames: [] }));
    while (this.stateQueue.length) {
      const batch = this.stateQueue.slice(0, STATE_BATCH);
      const lastPreview = batch.findLastIndex((f) => f.t === "preview");
      await this.worker("state", { frames: batch.filter((f, i) => f.t !== "preview" || i === lastPreview) });
      this.stateQueue.splice(0, batch.length);
    }
  }

  heartbeat = () => this.flushState(true);

  configure = async () => ((await this.rpc("configure")) ?? null) as Extract<ToBridge, { t: "configure" }> | null;

  ghToken = async () => (await this.rpc<{ token?: string } | null>("gh_token"))?.token ?? null;

  subscribeCommands(onCommands: (cmds: CommandEntry[]) => void, onError: () => void) {
    const sub = { on: onCommands, err: onError };
    this.commandSubs.add(sub);
    if (this.snapshot.length) queueMicrotask(() => this.commandSubs.has(sub) && onCommands(this.snapshot));
    return () => void this.commandSubs.delete(sub);
  }

  subscribePr = async (ref: PrRef, source: "auto" | "agent") => void (await this.rpc("subscribe_pr", { ...ref, source }));
  unsubscribePr = async (ref: PrRef) => void (await this.rpc("unsubscribe_pr", ref));
  showPreview = (port: number, opts: { title?: string; localhost?: boolean; via?: number }) => this.rpc<{ port: number; url: string; title?: string }>("show_preview", { port, ...opts });
  mcpToken = (name: string, stale?: string) => this.rpc<{ authorization: string; expiresAt: number | null }>("mcp_token", { name, ...(stale ? { stale } : {}) });
  skill = async (name: string) => skillBundle.parse(await this.rpc<unknown>("skill", { name }));
  getImage = (id: string) => this.rpc<{ mime: string; data: string } | null>("get_image", { id });
  build = (args: Record<string, unknown>) => this.rpc<unknown>("build", args);
  local = (args: Record<string, unknown>) => this.rpc<unknown>("local", args);
  /**
   * Secure inputs: in a cloud org only the bridge writes the transcript, so the Worker hands back the client event a request or its
   * answer adds (`input_request`, `input_response`) and the bridge appends it as a note before answering the agent. Several waits
   * may return the same answer: each event is written once per request id and type. The agent gets the result without it.
   */
  input = async (args: Record<string, unknown>) => {
    const r = await this.rpc<Record<string, unknown> | null>("input", args);
    const ev = r?.event as { type?: unknown; requestId?: unknown } | undefined;
    if (!r || !ev || typeof ev.type !== "string" || typeof ev.requestId !== "string") return r;
    await this.inputNote(`${ev.requestId}|${ev.type}`, ev);
    const { event: _event, ...rest } = r;
    return rest;
  };

  /**
   * Writes one secure-input event, once. The Worker has already recorded the request, so a failed append is not the end of it: the
   * event waits in `pendingInputNotes` through the reconnect and is written by the new writer (also replayed by `connect`).
   */
  private inputNote(key: string, ev: object): Promise<void> {
    if (this.inputNotes.has(key)) return Promise.resolve();
    this.pendingInputNotes.set(key, ev);
    const inFlight = this.inputNoteWrites.get(key);
    if (inFlight) return inFlight;
    const p = (async () => {
      for (let attempt = 0; ; attempt++) {
        const w = this.writer;
        if (w && !w.error) {
          try {
            await w.note(JSON.stringify([ev]));
            this.pendingInputNotes.delete(key);
            this.inputNotes.add(key);
            return;
          } catch (e) {
            this.broken(e, w);
          }
        } else if (w?.error) this.broken(w.error, w);
        if (this.closed || attempt >= INPUT_NOTE_ATTEMPTS) throw new Error("not connected");
        await new Promise((r) => setTimeout(r, 1000));
      }
    })().finally(() => this.inputNoteWrites.delete(key));
    this.inputNoteWrites.set(key, p);
    return p;
  }
  crew = (args: Record<string, unknown>) => this.rpc<unknown>("crew", args);
  comment = (args: Record<string, unknown>) => this.rpc<unknown>("comment", args);
  ship = (args: Record<string, unknown>) => this.rpc<unknown>("ship", args);
  shareImage = (data: string, caption?: string) => this.rpc<{ id: string; width?: number; height?: number }>("share_image", { data, caption });

  subscribeSubscriptions(onList: (views: unknown) => void, onError: () => void) {
    const sub = { on: onList, err: onError };
    this.listSubs.add(sub);
    if (this.lastList !== undefined) queueMicrotask(() => this.listSubs.has(sub) && onList(this.lastList));
    return () => void this.listSubs.delete(sub);
  }

  onCall(handler: CallHandler) {
    this.callHandler = handler;
  }

  onReconnect(cb: () => void) {
    this.reconnects.add(cb);
    return () => void this.reconnects.delete(cb);
  }

  /** Refused for good: the Worker says `forbidden` (session gone, wrong secret), or a newer bridge fenced this one out. */
  isFatal = (e: unknown) => code(e) === "forbidden" || e instanceof FencedError;
  isSleeping = (e: unknown) => code(e) === "sleeping";
  errorCode = code;

  close = async () => {
    this.closed = true;
    this.stopTail();
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = null;
  };
}
