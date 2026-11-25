import { appError, checkProof, isNonce, newNonce, proof, skillBundle, type SkillBundle, type AppErrorCode, type CommandFrame, type FromBridge, type PrRef, type ToBridge } from "@dorks/shared";

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
  /** Hosts a port of this box and shows it in the owner's Artifacts as a running preview; resolves with the stored preview. */
  /** `via`: the preview proxy's port in front of `port` (src/preview-proxy.ts); the provider hosts that one instead. */
  showPreview(port: number, opts: { title?: string; localhost?: boolean; via?: number }): Promise<{ port: number; url: string; title?: string }>;
  /** Stores a screenshot (base64 PNG/JPEG/WebP/GIF) for the owner; resolves with its id, which `dorks-image:<id>` names in markdown. */
  shareImage(data: string, caption?: string): Promise<{ id: string; width?: number; height?: number }>;
  /** The agent's machine_* tools (docs/builds.md): one op, `action` picks get, draft, run, logs or submit. Scoped by the server to this dork's build. */
  build(args: Record<string, unknown>): Promise<unknown>;
  /** Local access (docs/local-access.md): `action` request asks to run a command or read a file on the owner's computer, wait waits for the answer. */
  local(args: Record<string, unknown>): Promise<unknown>;
  /** Secure inputs (docs/secure-inputs.md): `action` request asks the owner for values, wait waits for the answer, values fetches them. */
  input(args: Record<string, unknown>): Promise<unknown>;
  /** Crew tools (docs/crew.md): `{tool, args}` from a coordinator's or worker's MCP server, scoped by the server to this dork's crew. */
  crew(args: Record<string, unknown>): Promise<unknown>;
  /** The comment_* MCP tools: the owner's comments on the running preview (docs/architecture.md, "Preview comments"). */
  comment(args: Record<string, unknown>): Promise<unknown>;
  /** The ship_verify MCP tool: the agent's check of a merged PR's live deployment (docs/shipping.md, "The agent"). */
  ship(args: Record<string, unknown>): Promise<unknown>;
  /**
   * A current access token for the owner's OAuth MCP server `name` (docs/mcp.md, "OAuth"). `stale` is a token the server just
   * refused, so the backend refreshes even before it expires.
   */
  mcpToken(name: string, stale?: string): Promise<{ authorization: string; expiresAt: number | null }>;
  /** One of the owner's skills (docs/skills.md): its files, fetched when `configure` lists a digest this box does not have. */
  skill(name: string): Promise<SkillBundle>;
  /** An image the owner attached to one of this dork's messages, as base64; null when it is not this dork's. */
  getImage(id: string): Promise<{ mime: string; data: string } | null>;
  /** This dork's non-ended PR subscriptions (SubscriptionView[], validated by the caller), pushed on every change. */
  subscribeSubscriptions(onList: (views: unknown) => void, onError: () => void): () => void;
  /**
   * Answers the server's `call` frames (requests from the server to this bridge: the Files tab's reads and writes). A rejection with
   * an `invalid`, `not_found` or `conflict` `code` reaches the owner as that error; anything else as `failed`.
   */
  onCall?(handler: CallHandler): void;
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
/** How long an rpc waits for the server to (re)connect before it fails; callers retry. */
const OPEN_WAIT_MS = 15_000;
/** A socket that has not finished the handshake by then is closed. */
const HANDSHAKE_MS = 10_000;
/** At most this many sockets may be mid-handshake at once; more are turned away. */
const MAX_HANDSHAKES = 4;

export type CallHandler = (op: string, args: Record<string, unknown>) => Promise<unknown>;
/** The codes a call may answer with; any other failure is `failed`, so nothing internal leaks. */
const CALL_CODES = new Set(["invalid", "not_found", "conflict"]);

type Pending = { resolve: (v: any) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };
type Waiter = { resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };

/** The part of a WebSocket the transport uses: both the `ws` library's server-side socket and a test's in-process one fit. */
export interface BridgeSocket {
  readonly readyState: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((m: { data: unknown }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
}

/** Starts handing every incoming socket to `onSocket`; the function it returns stops listening. */
export type Accept = (onSocket: (ws: BridgeSocket) => void) => () => void;

/**
 * The bridge protocol (docs/architecture.md) over one WebSocket that the server opens to this bridge: a handshake in which each
 * side proves it holds the per-dork secret without sending it, then request/response `rpc` frames from here and two server pushes
 * (the commands snapshot, the PR subscriptions). The server reconnects after a drop and re-sends the snapshots on every new
 * connection, so nothing needs replaying here. A socket that fails the handshake is closed and changes nothing.
 */
export class WsTransport implements Transport {
  private ws?: BridgeSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly waiters = new Set<Waiter>();
  private readonly commandSubs = new Set<{ on: (c: CommandEntry[]) => void; err: () => void }>();
  private readonly listSubs = new Set<{ on: (v: unknown) => void; err: () => void }>();
  private readonly reconnects = new Set<() => void>();
  private lastCommands?: CommandEntry[];
  private lastList?: unknown;
  private everConnected = false;
  private callHandler?: CallHandler;
  private closed = false;
  private handshaking = 0;
  private readonly stopAccepting: () => void;

  constructor(
    accept: Accept,
    private readonly dorkId: string,
    private readonly secret: string,
  ) {
    this.stopAccepting = accept((ws) => this.incoming(ws));
  }

  // ---------------------------------------------------------------- connection
  /** Resolves once a verified server socket is up; rejects if none comes within OPEN_WAIT_MS. */
  private open(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("transport closed"));
    if (this.ws?.readyState === 1) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(w);
          reject(new Error("not connected"));
        }, OPEN_WAIT_MS),
      };
      this.waiters.add(w);
    });
  }

  /**
   * A socket from the server: it sends `hello` with its nonce, this bridge answers `auth` with its own nonce and its proof, and the
   * server's `auth_ok` must carry the server's proof. Frames are handled one at a time in arrival order, so a snapshot sent right
   * after `auth_ok` waits for the proof check.
   */
  private incoming(ws: BridgeSocket) {
    if (this.closed || this.handshaking >= MAX_HANDSHAKES) return ws.close(1013, "busy");
    this.handshaking++;
    const mine = newNonce();
    let theirs = "";
    let stage: "hello" | "auth" | "done" = "hello";
    const finish = (ok: boolean) => {
      if (stage === "done") return;
      stage = "done";
      clearTimeout(timer);
      this.handshaking--;
      if (ok) this.adopt(ws);
      else
        try {
          ws.close(1008, "handshake failed");
        } catch {
          /* already closed */
        }
    };
    const timer = setTimeout(() => finish(false), HANDSHAKE_MS);
    const handle = async (raw: unknown) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return stage === "done" ? undefined : finish(false);
      }
      if (stage === "done") {
        if (this.ws === ws) this.onFrame(msg, ws);
      } else if (stage === "hello") {
        if (msg?.t !== "hello" || !isNonce(msg.nonce)) return finish(false);
        theirs = msg.nonce;
        stage = "auth";
        ws.send(JSON.stringify({ t: "auth", dorkId: this.dorkId, nonce: mine, proof: await proof(this.secret, "bridge", theirs, mine) }));
      } else {
        finish(msg?.t === "auth_ok" && (await checkProof(this.secret, "server", mine, theirs, msg.proof)));
      }
    };
    let chain = Promise.resolve();
    ws.onmessage = (m) => {
      chain = chain.then(() => handle(m.data)).catch(() => finish(false));
    };
    ws.onclose = () => finish(false);
  }

  /** A verified socket becomes the connection; one it replaces (the server reconnected before this side saw the drop) is closed. */
  private adopt(ws: BridgeSocket) {
    const old = this.ws;
    this.ws = ws;
    if (old) {
      this.dropped();
      try {
        old.close(4000, "replaced");
      } catch {
        /* already closed */
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.dropped();
    };
    const re = this.everConnected;
    this.everConnected = true;
    for (const w of [...this.waiters]) {
      clearTimeout(w.timer);
      w.resolve();
    }
    this.waiters.clear();
    if (re) for (const cb of [...this.reconnects]) cb();
  }

  /** The connection is gone: fail what was in flight and tell subscribers. The server reconnects; nothing is scheduled here. */
  private dropped() {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("connection lost"));
      this.pending.delete(id);
    }
    if (this.closed) return;
    for (const s of [...this.commandSubs]) s.err();
    for (const s of [...this.listSubs]) s.err();
  }

  private onFrame(msg: any, ws: BridgeSocket) {
    if (msg.t === "call") void this.answerCall(msg, ws);
    else if (msg.t === "res") {
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

  /** One `call` from the server, answered with a `ret` frame on the socket it came on (dropped if that socket is gone). */
  private async answerCall(msg: { id?: unknown; op?: unknown; args?: unknown }, ws: BridgeSocket) {
    if (typeof msg.id !== "number") return;
    let reply: object;
    try {
      if (!this.callHandler || typeof msg.op !== "string") throw Object.assign(new Error("This bridge does not answer that call."), { code: "invalid" });
      const args = msg.args && typeof msg.args === "object" ? (msg.args as Record<string, unknown>) : {};
      reply = { t: "ret", id: msg.id, ok: true, result: (await this.callHandler(msg.op, args)) ?? null };
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      reply = {
        t: "ret",
        id: msg.id,
        ok: false,
        error: typeof code === "string" && CALL_CODES.has(code) ? { code, message: (e as Error).message } : { code: "failed", message: "The sandbox could not do that." },
      };
    }
    if (ws.readyState === 1) ws.send(JSON.stringify(reply));
  }

  onCall(handler: CallHandler) {
    this.callHandler = handler;
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
    return () => void this.commandSubs.delete(sub);
  }

  subscribePr = async (ref: PrRef, source: "auto" | "agent") => {
    await this.rpc("subscribe_pr", { ...ref, source });
  };

  unsubscribePr = async (ref: PrRef) => {
    await this.rpc("unsubscribe_pr", ref);
  };

  showPreview = async (port: number, opts: { title?: string; localhost?: boolean; via?: number }) => this.rpc<{ port: number; url: string; title?: string }>("show_preview", { port, ...opts });

  mcpToken = async (name: string, stale?: string) => this.rpc<{ authorization: string; expiresAt: number | null }>("mcp_token", { name, ...(stale ? { stale } : {}) });

  skill = async (name: string) => skillBundle.parse(await this.rpc<unknown>("skill", { name }));

  getImage = async (id: string) => this.rpc<{ mime: string; data: string } | null>("get_image", { id });

  build = async (args: Record<string, unknown>) => this.rpc<unknown>("build", args);
  local = async (args: Record<string, unknown>) => this.rpc<unknown>("local", args);
  input = async (args: Record<string, unknown>) => this.rpc<unknown>("input", args);
  crew = async (args: Record<string, unknown>) => this.rpc<unknown>("crew", args);
  comment = async (args: Record<string, unknown>) => this.rpc<unknown>("comment", args);
  ship = async (args: Record<string, unknown>) => this.rpc<unknown>("ship", args);
  shareImage = async (data: string, caption?: string) => this.rpc<{ id: string; width?: number; height?: number }>("share_image", { data, caption });

  subscribeSubscriptions(onList: (views: unknown) => void, onError: () => void) {
    const sub = { on: onList, err: onError };
    this.listSubs.add(sub);
    if (this.lastList !== undefined) queueMicrotask(() => this.listSubs.has(sub) && onList(this.lastList));
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
    this.stopAccepting();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error("transport closed"));
    }
    this.waiters.clear();
    this.dropped();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  };
}
