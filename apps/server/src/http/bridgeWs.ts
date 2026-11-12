import type { AppError } from "@dorks/shared";
import { Cause, Data, Effect, Exit, Fiber, Latch, Queue, Schema, Scope } from "effect";
import { AppFail, type App, type Change } from "../app";
import { verifyBridgeSecret } from "../lib/bridgeAuth";
import { buildOp } from "../services/buildAgent";
import * as bridge from "../services/bridge";
import { attempt, attemptPromise, BridgeError } from "../services/bridge";

// One authenticated bridge socket (docs/architecture.md, "Bridge protocol"). Transport-neutral: the listener (main.ts) feeds it
// text frames and gives it `send` / `close`, so the protocol is testable without a socket.

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

const isAuth = Schema.is(Schema.Struct({ t: Schema.Literal("auth"), dorkId: Schema.String, secret: Schema.String }));
/** Anything else after auth is ignored. */
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
  ["show_preview", (app, id, a) => attemptPromise(() => bridge.showPreview(app, id, a.port, a.title, a.localhost))],
  ["get_image", (app, id, a) => attempt(() => bridge.getImage(app, id, a.id))],
  ["share_image", (app, id, a) => attempt(() => bridge.shareImage(app, id, a.data, a.caption))],
  ["build", (app, id, a) => attemptPromise(() => buildOp(app, id, a))],
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

  constructor(
    private readonly app: App,
    private readonly io: SocketIO,
  ) {}

  open() {
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

  /** The first frame authenticates; frames that arrive while it is checked are dropped (one attempt at a time). */
  private auth(msg: unknown): Effect.Effect<void> {
    if (this.authenticating) return Effect.void;
    this.authenticating = true;
    return this.authenticate(msg).pipe(Effect.catchTag("Hangup", this.hangUp), Effect.forkIn(this.scope), Effect.asVoid);
  }

  private authenticate(msg: unknown): Effect.Effect<void, Hangup> {
    const { app } = this;
    return Effect.gen({ self: this }, function* () {
      if (!isAuth(msg)) return yield* forbidden();
      const ok = yield* Effect.tryPromise(() => verifyBridgeSecret(app.cfg.bridgeSecretKey, msg.dorkId, msg.secret)).pipe(Effect.orElseSucceed(() => false));
      if (!ok) return yield* forbidden();
      yield* Effect.try({ try: () => bridge.bridgeDork(app, msg.dorkId), catch: () => forbidden() }); // deleted or unknown
      if (this.closed) return yield* forbidden();
      if (this.authTimer) yield* Fiber.interrupt(this.authTimer);
      this.dorkId = msg.dorkId;
      this.send({ t: "auth_ok" });
      const off = app.hub.on((c) => this.onChange(c));
      yield* Scope.addFinalizer(this.scope, Effect.sync(off));
      yield* this.publisher().pipe(Effect.forkIn(this.scope));
    });
  }

  /** Runs one rpc as its own fiber; it starts at once, so rpcs (pushes above all) are applied in arrival order. */
  private request(dorkId: string, msg: unknown, raw: string): Effect.Effect<void> {
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

/** A frame for the debug log: a response by id and outcome only (never a configure result), anything else truncated. */
const debugLine = (o: object) => {
  const f = o as { t?: string; id?: number; ok?: boolean };
  return f.t === "res" ? JSON.stringify({ t: "res", id: f.id, ok: f.ok }) : JSON.stringify(o).slice(0, 160);
};
