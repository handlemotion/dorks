import { appError, type AppErrorCode, type CommandFrame, type FromBridge, type PrRef, type ToBridge } from "@dorks/shared";
import { type GrantSource, TicketRefused } from "./grants";

export interface CommandEntry {
  cid: string;
  frame: CommandFrame;
}

/** What the push rpc may return. `{ ok: false, expectedBseq }` reports a gap. */
export type PushResult = void | null | { expectedBseq?: number } | Record<string, unknown>;

/** The bridge's whole view of the backend. `WsTransport` is the real one; tests plug in a fake. */
export interface Transport {
  /** Handshake. Resolves with the last bseq the backend stored; rejects with `{ data: { code: "sleeping" } }` when the box should not run. */
  connect(): Promise<{ afterBridgeSeq: number }>;
  push(frames: FromBridge[]): Promise<PushResult>;
  heartbeat(): Promise<void>;
  /** The only way secrets are obtained (an rpc over the authenticated socket; never part of the commands snapshot). */
  configure(): Promise<Extract<ToBridge, { t: "configure" }> | null>;
  ghToken(): Promise<string | null>;
  /** The snapshot of unacknowledged commands; delivered again whenever it changes and after every reconnect. */
  subscribeCommands(onCommands: (cmds: CommandEntry[]) => void, onError: () => void): () => void;
  /** Idempotent. `auto`: the gh shim saw this dork create the PR; `agent`: the agent asked (`dorks pr sub`). */
  subscribePr(ref: PrRef, source: "auto" | "agent"): Promise<void>;
  unsubscribePr(ref: PrRef): Promise<void>;
  /** Hosts a port of this box and shows it in the owner's Previews tab; resolves with the stored preview. */
  showPreview(port: number, opts: { title?: string; localhost?: boolean }): Promise<{ port: number; url: string; title?: string }>;
  /** Stores a screenshot (base64 PNG/JPEG/WebP/GIF) for the owner; resolves with its id, which `dorks-image:<id>` names in markdown. */
  shareImage(data: string, caption?: string): Promise<{ id: string; width?: number; height?: number }>;
  /** The agent's machine_* tools (docs/builds.md): one op, `action` picks get, draft, run, logs or submit. Scoped by the server to this dork's build. */
  build(args: Record<string, unknown>): Promise<unknown>;
  /** An image the owner attached to one of this dork's messages, as base64; null when it is not this dork's. */
  getImage(id: string): Promise<{ mime: string; data: string } | null>;
  /** This dork's non-ended PR subscriptions (SubscriptionView[], validated by the caller), pushed on every change. */
  subscribeSubscriptions(onList: (views: unknown) => void, onError: () => void): () => void;
  /** Fires each time the underlying connection comes back after a drop. */
  onReconnect(cb: () => void): () => void;
  /** True when an error means the backend will never accept this bridge (wrong secret / dork deleted): retrying is pointless. */
  isFatal(err: unknown): boolean;
  isSleeping(err: unknown): boolean;
  /** The backend's error code, if any: `event_too_large`, `too_many_frames`, ... */
  errorCode(err: unknown): AppErrorCode | undefined;
  close(): Promise<void>;
}

/** The backend's typed AppError code, or undefined when the rejection is not one (network drop, plain Error). */
const code = (e: unknown): AppErrorCode | undefined => {
  const r = appError.safeParse((e as { data?: unknown } | null)?.data);
  return r.success ? r.data.code : undefined;
};

const typed = (error: unknown) => Object.assign(new Error((error as { message?: string })?.message ?? "request failed"), { data: error });

const RPC_TIMEOUT_MS = 60_000;
const AUTH_TIMEOUT_MS = 10_000;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 15_000;
/** The server's "forbidden", and also Wurmhol's "grant revoked": both final. */
const CLOSE_FORBIDDEN = 4403;
/** Wurmhol: the grant this socket was opened with ran out. Get a new one and reconnect. */
const CLOSE_GRANT_EXPIRED = 4401;

type Pending = { resolve: (v: any) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };

/**
 * The bridge protocol (docs/architecture.md) over one WebSocket: a first `auth` frame, request/response `rpc` frames, and two
 * server pushes (the commands snapshot, the PR subscriptions). The socket is opened lazily, re-opened with backoff after a drop
 * while anything is subscribed, and the server re-sends the snapshots on every new connection, so nothing needs replaying here.
 */
export class WsTransport implements Transport {
  private ws?: WebSocket;
  private opening?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly commandSubs = new Set<{ on: (c: CommandEntry[]) => void; err: () => void }>();
  private readonly listSubs = new Set<{ on: (v: unknown) => void; err: () => void }>();
  private readonly reconnects = new Set<() => void>();
  private lastCommands?: CommandEntry[];
  private lastList?: unknown;
  private everConnected = false;
  private closed = false;
  private fatalError?: unknown;
  private backoff = BACKOFF_START_MS;
  private retry?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly url: string,
    private readonly dorkId: string,
    private readonly secret: string,
    private readonly WS: typeof WebSocket = WebSocket,
    /** When the public URL is an embedded Wurmhol tunnel: its grants, sent as `x-wurmhol-grant` on every handshake. */
    private readonly grants: GrantSource | null = null,
  ) {}

  // ---------------------------------------------------------------- connection
  private open(): Promise<void> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.ws?.readyState === 1 && !this.opening) return Promise.resolve();
    this.opening ??= this.grant().then((grant) => this.dial(grant));
    return this.opening;
  }

  /** The grant to open with, or null without a tunnel. A refused ticket is final, like a refused secret. */
  private async grant(): Promise<string | null> {
    if (!this.grants) return null;
    try {
      return await this.grants.get();
    } catch (e) {
      this.opening = undefined;
      if (e instanceof TicketRefused) this.fatalError = typed({ code: "forbidden", message: e.message });
      throw this.fatalError ?? e;
    }
  }

  private dial(grant: string | null): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;
      // Node's built-in WebSocket takes request headers as a non-standard `headers` init option.
      const ws = grant ? new this.WS(this.url, { headers: { "x-wurmhol-grant": grant } } as unknown as string[]) : new this.WS(this.url);
      const done = (err?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.opening = undefined;
        // The relay refuses the handshake of a grant that just ran out or was revoked: try the next attempt with a fresh one.
        if (err && !opened) this.grants?.drop();
        if (err) {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
          reject(err);
        } else resolve();
      };
      const timer = setTimeout(() => done(new Error("connection timed out")), AUTH_TIMEOUT_MS);
      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({ t: "auth", dorkId: this.dorkId, secret: this.secret }));
      };
      ws.onmessage = (m) => {
        let msg: any;
        try {
          msg = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (msg.t === "auth_ok") {
          this.ws = ws;
          const re = this.everConnected;
          this.everConnected = true;
          this.backoff = BACKOFF_START_MS;
          done();
          if (re) for (const cb of [...this.reconnects]) cb();
        } else this.onFrame(msg);
      };
      ws.onerror = () => done(new Error("connection failed"));
      ws.onclose = (ev) => {
        if (ev.code === CLOSE_GRANT_EXPIRED) this.grants?.drop();
        if (ev.code === CLOSE_FORBIDDEN) {
          this.fatalError = typed({ code: "forbidden", message: "forbidden" });
          done(this.fatalError);
        } else done(new Error("connection closed"));
        if (this.ws === ws) {
          this.ws = undefined;
          this.lost();
        }
      };
    });
  }

  /** The socket dropped: fail what was in flight, tell subscribers, and reopen (with backoff) if anyone still listens. */
  private lost() {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("connection lost"));
      this.pending.delete(id);
    }
    if (this.closed) return;
    for (const s of [...this.commandSubs]) s.err();
    for (const s of [...this.listSubs]) s.err();
    if (this.fatalError || (!this.commandSubs.size && !this.listSubs.size)) return;
    this.retry = setTimeout(() => {
      this.open().catch(() => this.lost());
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  private onFrame(msg: any) {
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(typed(msg.error));
    } else if (msg.t === "commands") {
      this.lastCommands = msg.cmds as CommandEntry[];
      for (const s of [...this.commandSubs]) s.on(this.lastCommands);
    } else if (msg.t === "subscriptions") {
      this.lastList = msg.views;
      for (const s of [...this.listSubs]) s.on(this.lastList);
    }
  }

  private async rpc<T = unknown>(op: string, args: object = {}): Promise<T> {
    await this.open();
    const ws = this.ws;
    if (!ws) throw new Error("connection lost");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} timed out`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ t: "rpc", id, op, args }));
    });
  }

  // ---------------------------------------------------------------- Transport
  connect = async () => {
    const r = await this.rpc<{ afterBridgeSeq?: number }>("connect");
    return { afterBridgeSeq: Number(r?.afterBridgeSeq ?? 0) };
  };

  push = (frames: FromBridge[]) => this.rpc<PushResult>("push", { frames });

  heartbeat = async () => {
    await this.rpc("heartbeat");
  };

  configure = async () => ((await this.rpc("configure")) ?? null) as Extract<ToBridge, { t: "configure" }> | null;

  ghToken = async () => {
    const r = await this.rpc<{ token?: string } | null>("gh_token");
    return r?.token ?? null;
  };

  subscribeCommands(onCommands: (cmds: CommandEntry[]) => void, onError: () => void) {
    const sub = { on: onCommands, err: onError };
    this.commandSubs.add(sub);
    if (this.lastCommands) queueMicrotask(() => this.commandSubs.has(sub) && onCommands(this.lastCommands!));
    void this.open().catch(() => this.lost()); // the snapshot arrives with the connection
    return () => void this.commandSubs.delete(sub);
  }

  subscribePr = async (ref: PrRef, source: "auto" | "agent") => {
    await this.rpc("subscribe_pr", { ...ref, source });
  };

  unsubscribePr = async (ref: PrRef) => {
    await this.rpc("unsubscribe_pr", ref);
  };

  showPreview = async (port: number, opts: { title?: string; localhost?: boolean }) =>
    this.rpc<{ port: number; url: string; title?: string }>("show_preview", { port, ...opts });

  getImage = async (id: string) => this.rpc<{ mime: string; data: string } | null>("get_image", { id });

  build = async (args: Record<string, unknown>) => this.rpc<unknown>("build", args);
  shareImage = async (data: string, caption?: string) => this.rpc<{ id: string; width?: number; height?: number }>("share_image", { data, caption });

  subscribeSubscriptions(onList: (views: unknown) => void, onError: () => void) {
    const sub = { on: onList, err: onError };
    this.listSubs.add(sub);
    if (this.lastList !== undefined) queueMicrotask(() => this.listSubs.has(sub) && onList(this.lastList));
    void this.open().catch(() => this.lost());
    return () => void this.listSubs.delete(sub);
  }

  onReconnect(cb: () => void) {
    this.reconnects.add(cb);
    return () => void this.reconnects.delete(cb);
  }

  isFatal = (e: unknown) => code(e) === "forbidden";
  isSleeping = (e: unknown) => code(e) === "sleeping";
  errorCode = code;

  close = async () => {
    this.closed = true;
    clearTimeout(this.retry);
    this.lost();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  };
}
