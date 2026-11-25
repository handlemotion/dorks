import { checkProof, isNonce, newNonce, proof, type AppError } from "@dorks/shared";
import { Cause, Data, Effect, Exit, Fiber, Latch, Queue, Schema, Scope } from "effect";
import { AppFail, type App, type Change } from "../app";
import { bridgeSecret } from "../lib/bridgeAuth";
import { buildOp } from "../services/buildAgent";
import { localOp } from "../services/local";
import { inputOp } from "../services/inputs";
import { crewOp } from "../services/crew";
import { commentOp } from "../services/comments";
import { mcpAccessToken } from "../services/mcpOAuth";
import { skillBundle } from "../services/skills";
import { registerBridgeCaller } from "../services/workspace";
import * as bridge from "../services/bridge";
import { attempt, attemptPromise, BridgeError } from "../services/bridge";

// One authenticated bridge socket (docs/architecture.md, "Bridge protocol"). The server opened it to one dork's bridge
// (http/bridgeLinks.ts). Transport-neutral: the dialer feeds it text frames and gives it `send` / `close`, so the protocol is
// testable without a socket.

export const AUTH_TIMEOUT_MS = 5_000;
export const CLOSE_FORBIDDEN = 4403;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEBUG = !!process.env.DORKS_DEBUG_BRIDGE; // logs frame names and sizes, never configure results

export interface SocketIO {
  send(text: string): void;
  close(code: number, reason?: string): void;
}

/** The socket must close with this code and reason (both are part of the protocol). */
class Hangup extends Data.TaggedError("Hangup")<{ readonly code: number; readonly reason: string }> {}
const forbidden = (reason = "forbidden") => new Hangup({ code: CLOSE_FORBIDDEN, reason });

/** One text frame as JSON: too large or not JSON ends the socket. */
const parseFrame = (raw: string): Effect.Effect<unknown, Hangup> =>
  raw.length > MAX_FRAME_BYTES
    ? Effect.fail(new Hangup({ code: 1009, reason: "frame too large" }))
    : Effect.try({ try: (): unknown => JSON.parse(raw), catch: () => new Hangup({ code: 1003, reason: "bad json" }) });

const isAuth = Schema.is(Schema.Struct({ t: Schema.Literal("auth"), dorkId: Schema.String, nonce: Schema.String, proof: Schema.String }));
/** Anything else after auth is ignored. */
/** The bridge's answer to a `call` (a request from this side: the Files tab). */
const isRet = Schema.is(Schema.Struct({ t: Schema.Literal("ret"), id: Schema.Number, ok: Schema.Boolean, result: Schema.optional(Schema.Unknown), error: Schema.optional(Schema.Unknown) }));
/** The codes a bridge may answer a call with; anything else is `failed`. */
const CALL_CODES = new Set(["invalid", "not_found", "conflict", "failed"]);
const isRpc = Schema.is(Schema.Struct({ t: Schema.Literal("rpc"), id: Schema.Number, op: Schema.String, args: Schema.optional(Schema.Unknown) }));

type Args = Record<string, unknown>;
type Op = (app: App, dorkId: string, args: Args) => Effect.Effect<unknown, BridgeError>;

const OPS = new Map<string, Op>([
  ["connect", (app, id) => attempt(() => bridge.connect(app, id))],
  ["heartbeat", (app, id) => attempt(() => bridge.heartbeat(app, id))],
  ["push", (app, id, a) => bridge.pushFrames(app, id, a.frames)],
  ["configure", (app, id) => bridge.configure(app, id)],
  ["gh_token", (app, id) => attemptPromise(() => bridge.ghToken(app, id))],
  ["subscribe_pr", (app, id, a) => attempt(() => bridge.subscribePr(app, id, a.repo as string, a.number as number, a.source as "auto" | "agent"))],
  ["unsubscribe_pr", (app, id, a) => attempt(() => bridge.unsubscribePr(app, id, a.repo as string, a.number as number))],
  ["show_preview", (app, id, a) => attemptPromise(() => bridge.showPreview(app, id, a.port, a.title, a.localhost, a.via))],
  ["get_image", (app, id, a) => attempt(() => bridge.getImage(app, id, a.id))],
  ["share_image", (app, id, a) => attempt(() => bridge.shareImage(app, id, a.data, a.caption))],
  ["build", (app, id, a) => attemptPromise(() => buildOp(app, id, a))],
  ["local", (app, id, a) => attemptPromise(() => localOp(app, id, a))],
  ["input", (app, id, a) => attemptPromise(() => inputOp(app, id, a))],
  ["crew", (app, id, a) => attemptPromise(() => crewOp(app, id, a))],
  ["comment", (app, id, a) => attempt(() => commentOp(app, id, a))],
  ["mcp_token", (app, _id, a) => attemptPromise(() => mcpAccessToken(app, a.name, a.stale))],
  ["skill", (app, id, a) => attempt(() => skillBundle(app, id, a.name))],
]);

const failed = (e: unknown): AppError => {
  if (e instanceof AppFail) return e.error;
  console.error("bridge rpc failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
  return { code: "failed", message: "Something went wrong" };
};

/** The `res` frame for one rpc. A refusal is its typed AppError; a defect is logged and answered with a generic `failed`. */
const answer = (id: number, rpc: Effect.Effect<unknown, BridgeError>) =>
  rpc.pipe(
    Effect.map((result) => ({ t: "res", id, ok: true, result: result === undefined ? {} : result })), // null is a real answer (configure refused)
    Effect.catchTag("BridgeError", ({ error }) => Effect.succeed({ t: "res", id, ok: false, error })),
    Effect.catchDefect((e) => Effect.sync(() => ({ t: "res", id, ok: false, error: failed(e) }))),
  );

const errorText = (cause: Cause.Cause<unknown>) => {
  const e = Cause.squash(cause);
  return e instanceof Error ? e.message.slice(0, 200) : "unknown";
};

/**
 * The session is a scope of fibers, closed when the socket closes: the auth timer, a reader that takes inbound frames off a queue
 * in order, a writer that drains the outbox to the socket, and (once authenticated) a publisher that re-sends the commands and
 * subscriptions snapshots when the hub reports a change for this dork. Each rpc runs as its own fiber, started in arrival order;
 * one still running when the socket closes finishes, and its answer is dropped.
 */
export class BridgeSession {
  private readonly scope = Scope.makeUnsafe();
  private readonly inbox = Effect.runSync(Queue.unbounded<string>());
  private readonly outbox = Effect.runSync(Queue.unbounded<object>());
  /** Opened by a hub change for this dork; the publisher closes it before each snapshot, so a burst becomes one. Starts open: the first snapshot follows `auth_ok`. */
  private readonly changed = Latch.makeUnsafe(true);
  private authTimer?: Fiber.Fiber<void>;
  private dorkId?: string;
  private lastCommands = "";
  private lastSubs = "";
  private closed = false;
  private authenticating = false;
  /** Calls sent to the bridge and not answered yet, by id. */
  private readonly calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextCall = 1;
  /** This side's handshake nonce, sent in `hello`. */
  private readonly nonce = newNonce();

  constructor(
    private readonly app: App,
    private readonly io: SocketIO,
    /** The dork whose bridge this socket was opened to: the bridge must prove it is that one. */
    private readonly expected: string,
    private readonly onAuthenticated: () => void = () => {},
  ) {}

  /** Call once the socket is open: sends `hello` and starts the session. */
  open() {
    this.send({ t: "hello", nonce: this.nonce });
    const fork = Effect.forkIn(this.scope);
    this.authTimer = Effect.runSync(Effect.sleep(AUTH_TIMEOUT_MS).pipe(Effect.andThen(this.hangUp(forbidden("auth timeout"))), fork));
    Effect.runSync(Effect.forever(Queue.take(this.outbox).pipe(Effect.flatMap((o) => this.write(o)))).pipe(fork));
    Effect.runSync(Effect.forever(Queue.take(this.inbox).pipe(Effect.flatMap((raw) => this.receive(raw)))).pipe(fork));
  }

  onMessage(raw: string) {
    if (!this.closed) Queue.offerUnsafe(this.inbox, raw);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, c] of this.calls) {
      clearTimeout(c.timer);
      c.reject(new AppFail({ code: "sleeping", message: "The sandbox disconnected. Try again in a moment." }));
      this.calls.delete(id);
    }
    Effect.runFork(Scope.close(this.scope, Exit.void));
  }

  private hangUp = ({ code, reason }: Hangup) => Effect.sync(() => this.io.close(code, reason));

  private send(o: object) {
    if (!this.closed) Queue.offerUnsafe(this.outbox, o);
  }

  private write(o: object): Effect.Effect<void> {
    return Effect.sync(() => {
      if (this.closed) return;
      if (DEBUG) console.error("[bridge ws] ->", this.dorkId?.slice(-6), debugLine(o));
      this.io.send(JSON.stringify(o));
    }).pipe(Effect.catchDefect((e) => Effect.sync(() => console.error("bridge send failed", e instanceof Error ? e.message.slice(0, 200) : "unknown"))));
  }

  private receive(raw: string): Effect.Effect<void> {
    return parseFrame(raw).pipe(
      Effect.flatMap((msg) => (this.dorkId ? this.request(this.dorkId, msg, raw) : this.auth(msg))),
      Effect.catchTag("Hangup", this.hangUp),
    );
  }

  /** The first frame answers `hello`; frames that arrive while it is checked are dropped (one attempt at a time). */
  private auth(msg: unknown): Effect.Effect<void> {
    if (this.authenticating) return Effect.void;
    this.authenticating = true;
    return this.authenticate(msg).pipe(Effect.catchTag("Hangup", this.hangUp), Effect.forkIn(this.scope), Effect.asVoid);
  }

  private authenticate(msg: unknown): Effect.Effect<void, Hangup> {
    const { app } = this;
    return Effect.gen({ self: this }, function* () {
      if (!isAuth(msg) || msg.dorkId !== this.expected || !isNonce(msg.nonce)) return yield* forbidden();
      const secret = yield* Effect.tryPromise(() => bridgeSecret(app.cfg.bridgeSecretKey, msg.dorkId)).pipe(Effect.orElseSucceed(() => ""));
      const ok = !!secret && (yield* Effect.promise(() => checkProof(secret, "bridge", this.nonce, msg.nonce, msg.proof)));
      if (!ok) return yield* forbidden();
      yield* Effect.try({ try: () => bridge.bridgeDork(app, msg.dorkId), catch: () => forbidden() }); // deleted or unknown
      if (this.closed) return yield* forbidden();
      if (this.authTimer) yield* Fiber.interrupt(this.authTimer);
      this.dorkId = msg.dorkId;
      this.send({ t: "auth_ok", proof: yield* Effect.promise(() => proof(secret, "server", msg.nonce, this.nonce)) });
      this.onAuthenticated();
      const off = app.hub.on((c) => this.onChange(c));
      yield* Scope.addFinalizer(this.scope, Effect.sync(off));
      const withdraw = registerBridgeCaller(app, msg.dorkId, (op, args, timeoutMs) => this.call(op, args, timeoutMs));
      yield* Scope.addFinalizer(this.scope, Effect.sync(withdraw));
      yield* this.publisher().pipe(Effect.forkIn(this.scope));
    });
  }

  /**
   * A request to the bridge (`{t: "call", id, op, args}`), answered by its `ret` frame. Rejects with an `AppFail`: the bridge's own
   * error, `timeout` (a bridge older than calls never answers), or `sleeping` when the socket closes first.
   */
  call(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed || !this.dorkId) return Promise.reject(new AppFail({ code: "sleeping", message: "The sandbox is not connected yet." }));
    const id = this.nextCall++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new AppFail({ code: "timeout", message: "The sandbox did not answer in time." }));
      }, timeoutMs);
      this.calls.set(id, { resolve, reject, timer });
      this.send({ t: "call", id, op, args });
    });
  }

  private settle(msg: { id: number; ok: boolean; result?: unknown; error?: unknown }) {
    const c = this.calls.get(msg.id);
    if (!c) return;
    this.calls.delete(msg.id);
    clearTimeout(c.timer);
    if (msg.ok) return c.resolve(msg.result);
    const e = (msg.error ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" && CALL_CODES.has(e.code) ? e.code : "failed";
    const message = typeof e.message === "string" && e.message ? e.message.slice(0, 300) : "The sandbox could not do that.";
    c.reject(new AppFail({ code, message } as AppError));
  }

  /** Runs one rpc as its own fiber; it starts at once, so rpcs (pushes above all) are applied in arrival order. */
  private request(dorkId: string, msg: unknown, raw: string): Effect.Effect<void> {
    if (isRet(msg)) return Effect.sync(() => this.settle(msg));
    if (!isRpc(msg)) return Effect.void;
    if (DEBUG) console.error("[bridge ws] <-", dorkId.slice(-6), msg.op, raw.slice(0, 120));
    const op = OPS.get(msg.op);
    const rpc = op ? Effect.suspend(() => op(this.app, dorkId, (msg.args ?? {}) as Args)) : Effect.fail(BridgeError.of("invalid", `unknown op: ${msg.op}`));
    return answer(msg.id, rpc).pipe(
      Effect.map((res) => this.send(res)),
      Effect.forkDetach({ startImmediately: true }),
      Effect.asVoid,
    );
  }

  private onChange(c: Change) {
    if (!this.dorkId || !("dorkId" in c) || c.dorkId !== this.dorkId) return;
    if (c.t === "events") return;
    Latch.openUnsafe(this.changed);
  }

  /** Sends the snapshots once right after `auth_ok`, then again after every change for this dork. */
  private publisher(): Effect.Effect<never> {
    const pass = Effect.gen({ self: this }, function* () {
      yield* this.changed.await;
      yield* Effect.yieldNow; // opening the latch resumes this fiber at once: let the rest of the burst (and its commit) land first
      yield* Latch.close(this.changed);
      yield* Effect.sync(() => this.publish()).pipe(Effect.catchCause((cause) => Effect.sync(() => console.error("bridge publish failed", errorText(cause)))));
    });
    return Effect.forever(pass);
  }

  /** Sends the commands and subscriptions snapshots if they differ from what the bridge last saw. */
  private publish() {
    if (!this.dorkId || this.closed) return;
    const commands = JSON.stringify(bridge.commandsFor(this.app, this.dorkId));
    if (commands !== this.lastCommands) {
      this.lastCommands = commands;
      this.send({ t: "commands", cmds: JSON.parse(commands) });
    }
    const subs = JSON.stringify(bridge.subscriptionsFor(this.app, this.dorkId));
    if (subs !== this.lastSubs) {
      this.lastSubs = subs;
      this.send({ t: "subscriptions", views: JSON.parse(subs) });
    }
  }
}

/**
 * A frame for the debug log: a response by id and outcome only (never a configure result), a call by id and op only (never a
 * file's contents, which may hold credentials), anything else truncated.
 */
const debugLine = (o: object) => {
  const f = o as { t?: string; id?: number; ok?: boolean; op?: string };
  if (f.t === "res") return JSON.stringify({ t: "res", id: f.id, ok: f.ok });
  if (f.t === "call") return JSON.stringify({ t: "call", id: f.id, op: f.op });
  return JSON.stringify(o).slice(0, 160);
};
