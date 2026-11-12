import { errorEvent, fromBridge, type AppError, type AppErrorCode, type ClientEventBody, type CommandFrame, type FromBridge, type SubscriptionView, type ToBridge } from "@dorks/shared";
import { Cause, Data, Effect, Exit } from "effect";
import { AppFail, fail, touch, type App } from "../app";
import { createNormalizer } from "../core/normalize";
import { getDork, openCommands, runtimeOf, type DorkRow, type Preview, type SharedImage } from "../data";
import { update } from "../db";
import { append, bridgeSeen, dispatch, enqueueConfigure, finishPause, patchDork } from "../lifecycle/dispatch";
import { opFailed } from "../lifecycle/lifecycle";
import { rememberModelChoices } from "./models";
import { claudeToken, cliSecrets, githubToken } from "./settings";
import { buildVarValues, getBuild } from "./builds";
import * as subs from "./subscriptions";
import { randomBytes } from "node:crypto";

// What the in-box bridge may do (docs/architecture.md, "Bridge protocol"). These are the bodies of the WebSocket rpc ops and of the
// commands snapshot; http/bridgeWs.ts authenticates the socket (per-dork HMAC) before any of them runs.

// Per-call limits: one push is one transaction, and a hostile or buggy bridge must not be able to fill it.
export const MAX_FRAMES_PER_PUSH = 500;
export const MAX_EVENT_BYTES = 256 * 1024;
const encoder = new TextEncoder();

/** A refused bridge rpc: `error` is the AppError of its `res` frame. */
export class BridgeError extends Data.TaggedError("BridgeError")<{ readonly error: AppError }> {
  static of(code: AppErrorCode, message: string) {
    return new BridgeError({ error: { code, message } as AppError });
  }
}

/** A service's `AppFail` becomes `BridgeError`; anything else stays a defect. */
const classify = (e: unknown): Effect.Effect<never, BridgeError> => (e instanceof AppFail ? Effect.fail(new BridgeError({ error: e.error })) : Effect.die(e));

/** Runs a synchronous service call that refuses with `fail` (the transactional bodies below). */
export const attempt = <A>(f: () => A): Effect.Effect<A, BridgeError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f());
    } catch (e) {
      return classify(e);
    }
  });

/** Like `attempt`, for a call that returns a Promise. */
export const attemptPromise = <A>(f: () => Promise<A>): Effect.Effect<A, BridgeError> => Effect.tryPromise({ try: f, catch: (e) => e }).pipe(Effect.catch(classify));

/** Runs a bridge effect for a synchronous caller (the test harness): a refusal throws its `AppFail`, as `fail` does. */
const runSync = <A>(effect: Effect.Effect<A, BridgeError>): A => {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const e = Cause.squash(exit.cause);
  throw e instanceof BridgeError ? new AppFail(e.error) : e;
};

/** The dork a bridge socket speaks for, or `forbidden` if it is gone. */
export function bridgeDork(app: App, dorkId: string): DorkRow {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return fail("forbidden", "forbidden");
  return dork;
}

export function connect(app: App, dorkId: string): { afterBridgeSeq: number } {
  return app.db.tx(() => {
    const dork = bridgeDork(app, dorkId);
    // A bridge that connects while we believe the box is asleep must not wake anything.
    if (dork.state === "sleeping") fail("sleeping", "sleeping");
    bridgeSeen(app, dork);
    enqueueConfigure(app, dorkId);
    return { afterBridgeSeq: runtimeOf(app.db, dorkId).bridgeSeq };
  });
}

export function heartbeat(app: App, dorkId: string) {
  app.db.tx(() => bridgeSeen(app, bridgeDork(app, dorkId))); // back after a blip while working/idle cancels the watchdog the loss armed
}

export type CommandEntry = { cid: string; frame: CommandFrame };

/** The snapshot of commands the bridge still owes an ack for, in the shape it executes. Pure read. */
export function commandsFor(app: App, dorkId: string): CommandEntry[] {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting || dork.state === "sleeping") return [];
  // Before `ready` the agent is not up. And once the box call of a pause is in flight (or was cancelled but still lands), a
  // delivered message could be acked and then lost with the box: hold it back, the re-wake after the pause delivers it.
  const rt = runtimeOf(app.db, dorkId);
  const deliverMessages = (dork.state === "working" || dork.state === "idle") && (!rt.pause || rt.pause.phase === "flushing");
  const open = openCommands(app.db, dorkId);
  // User messages always go first: no notify is emitted while one is unacked. A notify that arrived mid-turn stays held
  // (`released` false) until the machine's release_notify, so a turn is never interrupted by an autonomous event.
  const userPending = open.some((c) => c.kind === "user_message");
  const out: CommandEntry[] = [];
  for (const c of open) {
    if (c.kind === "user_message") {
      if (deliverMessages) out.push({ cid: c.cid, frame: { t: "user_message", id: c.cid, text: c.text! } });
    } else if (c.kind === "notify") {
      if (deliverMessages && !userPending && (dork.state === "idle" || c.released))
        out.push({ cid: c.cid, frame: { t: "notify", id: c.cid, text: c.text!, kinds: c.meta!.kinds as never, prs: c.meta!.prs } });
    } else if (c.kind === "configure") out.push({ cid: c.cid, frame: { t: "fetch_configure" } });
    else out.push({ cid: c.cid, frame: { t: c.kind } });
  }
  return out;
}

export const subscriptionsFor = (app: App, dorkId: string): SubscriptionView[] => subs.liveSubscriptionViews(app, dorkId);

/** The JSON size of an event frame's `raw` line (0 for frames that carry none). */
const eventBytes = (frame: unknown) => {
  const payload = (frame as { raw?: unknown } | null)?.raw;
  return payload === undefined ? 0 : encoder.encode(JSON.stringify(payload)).length;
};

/**
 * Decodes the `frames` of a `push`: the per-call limits first (too many frames or an oversized event refuse the whole call), then
 * each frame with the shared `fromBridge` schema. A frame that does not parse is dropped, as an unknown frame from a newer bridge.
 */
export const decodePush = (frames: unknown): Effect.Effect<FromBridge[], BridgeError> => {
  if (!Array.isArray(frames)) return Effect.fail(BridgeError.of("invalid", "frames must be an array"));
  if (frames.length > MAX_FRAMES_PER_PUSH) return Effect.fail(BridgeError.of("too_many_frames", `at most ${MAX_FRAMES_PER_PUSH} frames per push`));
  if (frames.some((f) => eventBytes(f) > MAX_EVENT_BYTES)) return Effect.fail(BridgeError.of("event_too_large", `an event exceeds ${MAX_EVENT_BYTES} bytes`));
  return Effect.succeed(
    frames.flatMap((raw) => {
      const parsed = fromBridge.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    }),
  );
};

export type PushResult = { ok: true } | { ok: false; expectedBseq: number };

/**
 * Bridge -> server frames, batched. Events must arrive numbered exactly `bridgeSeq + 1`, `+ 2`, ... (anything `<= bridgeSeq` is a
 * replay and is skipped). If the call contains a gap, NOTHING in it is applied and the result is `{ ok: false, expectedBseq }`
 * (`bridgeSeq + 1`): the bridge must resend everything from its event `expectedBseq` on. Otherwise the result is `{ ok: true }`.
 * Too many frames or an oversized event reject the whole call (`too_many_frames` / `event_too_large`).
 */
export const pushFrames = (app: App, dorkId: string, frames: unknown): Effect.Effect<PushResult, BridgeError> =>
  decodePush(frames).pipe(Effect.flatMap((decoded) => attempt(() => applyPush(app, dorkId, decoded))));

/** `pushFrames` for synchronous callers: a refusal throws `AppFail`. */
export const push = (app: App, dorkId: string, frames: unknown): PushResult => runSync(pushFrames(app, dorkId, frames));

/** Applies one decoded batch in one transaction. */
function applyPush(app: App, dorkId: string, frames: FromBridge[]): PushResult {
  return app.db.tx(() => {
    const dork = bridgeDork(app, dorkId);
    bridgeSeen(app, dork); // liveness counts even when the batch is refused below
    const rt = runtimeOf(app.db, dorkId);

    // Validate the whole batch before applying any of it: events must continue the stored numbering exactly (frames already
    // stored are skipped as replays). A gap refuses the call atomically, so the bridge can resend everything after its last
    // confirmed event without any frame (an `agent_exited`, say) being applied twice.
    if (hasGap(frames, rt.bridgeSeq)) return { ok: false as const, expectedBseq: rt.bridgeSeq + 1 };

    // The normalizer is stateful (in-flight message id) but a transaction is not: seed it from the last batch.
    const normalize = createNormalizer();
    if (rt.streamMsgId) normalize({ type: "stream_event", event: { type: "message_start", message: { id: rt.streamMsgId } } });
    const pending: ClientEventBody[] = [];
    const batch: Batch = {
      app,
      dorkId,
      dork,
      normalize,
      pending,
      touched: false,
      bridgeSeq: rt.bridgeSeq,
      streamMsgId: rt.streamMsgId,
      finalMsgId: rt.finalMsgId,
      interruptRequested: rt.interruptRequested,
      flush: () => {
        if (pending.length) append(app, dorkId, ...pending.splice(0));
      },
    };

    for (const f of frames) (FRAME_HANDLERS[f.t] as (b: Batch, f: FromBridge) => void)(batch, f);
    batch.flush();
    const { bridgeSeq, streamMsgId, finalMsgId, interruptRequested, preview, touched } = batch;
    update(app.db, "dork_runtime", { dorkId }, { bridgeSeq, streamMsgId, finalMsgId, interruptRequested });
    if (preview !== undefined || touched) patchDork(app, dorkId, { ...(preview !== undefined ? { preview } : {}), lastActivityAt: app.now() });
    return { ok: true as const };
  });
}

/** Whether the batch's new events skip a number after `bridgeSeq` (replays, `<= bridgeSeq`, are fine). */
function hasGap(frames: FromBridge[], bridgeSeq: number): boolean {
  let next = bridgeSeq + 1;
  for (const f of frames) {
    if (f.t !== "event" || f.bseq < next) continue;
    if (f.bseq !== next) return true;
    next++;
  }
  return false;
}

/** One `push` call being applied: the runtime cursor it advances and what it has collected so far. */
interface Batch {
  app: App;
  dorkId: string;
  dork: DorkRow;
  normalize: ReturnType<typeof createNormalizer>;
  /** Client events not yet appended; `flush` appends them, so events stay ordered around dispatches. */
  pending: ClientEventBody[];
  flush: () => void;
  bridgeSeq: number;
  streamMsgId: string;
  finalMsgId: string;
  interruptRequested: boolean;
  preview?: string;
  /** A turn completed: the dork's last activity moves. */
  touched: boolean;
}
type FrameOf<T extends FromBridge["t"]> = Extract<FromBridge, { t: T }>;

const FRAME_HANDLERS: { [T in FromBridge["t"]]: (b: Batch, f: FrameOf<T>) => void } = {
  codex_models: ({ app, dorkId, dork }, f) => {
    if (dork.provider === "codex") patchDork(app, dorkId, { codexModelChoices: f.models });
  },
  title: ({ app, dorkId }, f) => {
    // Only replaces the first-message placeholder: a name the user typed (or one already generated) always wins.
    const fresh = getDork(app.db, dorkId)!;
    const title = cleanTitle(f.text);
    if (fresh.titleSource === "message" && title) patchDork(app, dorkId, { title, titleSource: "auto" });
  },
  agent_models: ({ app, dorkId, dork }, f) => {
    if (dork.provider !== "claude") return;
    patchDork(app, dorkId, { modelChoices: f.models, agentEffort: f.effort ?? undefined });
    rememberModelChoices(app, f.models);
  },
  codex_issue: ({ app, dorkId, dork }, f) => {
    if (dork.provider === "codex") append(app, dorkId, errorEvent({ code: "failed", message: f.message }));
  },
  event: applyEvent,
  ready: ({ app, dorkId, dork, flush }) => {
    flush();
    if (dork.provider === "codex") patchDork(app, dorkId, { codexModelChoices: undefined });
    dispatch(app, dorkId, { t: "agent_ready" });
  },
  ack: ({ app, dorkId }, f) => {
    const c = openCommands(app.db, dorkId).find((x) => x.cid === f.id);
    if (!c) return;
    if (c.kind === "user_message" || c.kind === "notify") update(app.db, "commands", { id: c.id }, { acked: true });
    else app.db.run("DELETE FROM commands WHERE id = ?", c.id);
    touch(app, { t: "commands", dorkId });
  },
  agent_exited: ({ app, dorkId, flush }, f) => {
    flush();
    append(app, dorkId, { type: "agent_exited", message: `agent exited (code ${f.code ?? "?"})` });
    console.error("agent exited", dorkId, f.code); // stderr tail is never logged: it can echo env
    dispatch(app, dorkId, { t: "agent_exited" });
  },
  flushed: ({ app, dorkId }, f) => finishPause(app, dorkId, f.cid),
};

/** One raw agent stream line: normalized into client events, the session id, or a turn boundary. */
function applyEvent(b: Batch, f: FrameOf<"event">) {
  if (f.bseq <= b.bridgeSeq) return; // replay overlap after a reconnect
  b.bridgeSeq = f.bseq;
  const r = f.raw as { type?: string; event?: { type?: string; message?: { id?: string } } };
  if (r?.type === "stream_event" && r.event?.type === "message_start") b.streamMsgId = r.event.message?.id ?? "";
  let stopped = false;
  for (const n of b.normalize(f.raw)) {
    if (n.kind === "event") stopped = applyClientEvent(b, n.body, stopped);
    else if (n.kind === "session") {
      patchDork(b.app, b.dorkId, b.dork.provider === "codex" ? { codexThreadId: n.sessionId } : { claudeSessionId: n.sessionId, ...(n.model ? { agentModel: n.model } : {}) });
    } else {
      b.flush();
      dispatch(b.app, b.dorkId, { t: "turn_idle" });
    }
  }
}

/** Queues one client event, stamping a `turn_complete`. Returns whether the line's turn was stopped by the user. */
function applyClientEvent(b: Batch, body: ClientEventBody, stopped: boolean): boolean {
  // The final answer is the turn's last assistant message with no tool call after it. The server names it on the
  // turn's turn_complete, so clients never infer it from where a message sits.
  if (body.type === "assistant_message") b.finalMsgId = body.messageId;
  if (body.type === "tool_use") b.finalMsgId = "";
  if (body.type === "turn_complete") {
    // A turn the user stopped ends as an error result: it is `stopped`, not a failure, and gets no error event.
    stopped = b.interruptRequested && body.outcome === "failed";
    const outcome = stopped ? "stopped" : body.outcome;
    body = { ...body, outcome, ...(outcome === "done" && b.finalMsgId ? { finalMessageId: b.finalMsgId } : {}) };
    b.finalMsgId = "";
    b.interruptRequested = false;
    b.touched = true;
  }
  if (stopped && body.type === "error" && body.error?.code === "turn_failed") return stopped;
  b.pending.push(body);
  if (body.type === "assistant_message") b.preview = body.text.slice(0, 140);
  return stopped;
}

// ---------------------------------------------------------------- PR subscriptions (docs/autonomy.md)
// The gh shim / hooks / `dorks pr` CLI in the box call these through the bridge. PRs the poller sees change reach the agent as `notify` frames.

export function subscribePr(app: App, dorkId: string, repo: string, number: number, source: "auto" | "agent") {
  if (source !== "auto" && source !== "agent") fail("invalid", "bad source");
  app.db.tx(() => void subs.subscribe(app, bridgeDork(app, dorkId), repo, number, source));
}

export function unsubscribePr(app: App, dorkId: string, repo: string, number: number) {
  app.db.tx(() => {
    bridgeDork(app, dorkId);
    subs.unsubscribe(app, dorkId, repo, number);
  });
}

// ---------------------------------------------------------------- previews
// `preview_show` (the bridge's MCP tool): the agent says its dev server is up; the box provider hosts the port and the URL is kept on
// the dork, where the Previews tab lists it.

/** Ports Boat itself uses in every sandbox (https://docs.boat.dev/hosting): SSH, the desktop stream, its agents. */
const RESERVED_PORTS = new Set([22, 6080, 8090, 8911]);
const reserved = (port: number) => RESERVED_PORTS.has(port) || (port >= 47984 && port <= 48010);
const MAX_PREVIEWS = 20;
const MAX_TITLE = 60;

export async function showPreview(app: App, dorkId: string, port: unknown, title: unknown, localhost: unknown): Promise<Preview> {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return fail("invalid", "port must be an integer from 1 to 65535");
  if (reserved(port)) return fail("invalid", `port ${port} is used by the sandbox itself; run the dev server on another port`);
  const name = typeof title === "string" && title.trim() ? title.trim().slice(0, MAX_TITLE) : undefined;
  const dork = bridgeDork(app, dorkId);
  if (!dork.boxId) return fail("sleeping", "the box is not running");
  const box = await app.getBox();
  if (!box.hostPort) return fail("not_configured", "this sandbox provider cannot host ports");
  let url: string;
  try {
    ({ url } = await box.hostPort(dork.boxId, port, { title: name, localhost: localhost === true }));
  } catch (e) {
    console.error("host port failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    return fail("failed", "could not host the port");
  }
  const preview: Preview = { port, url, ...(name ? { title: name } : {}) };
  app.db.tx(() => {
    const now = bridgeDork(app, dorkId);
    if (now.boxId !== dork.boxId) return; // the box was replaced meanwhile: this URL belongs to the old one
    const rest = (now.previews ?? []).filter((p) => p.port !== port);
    patchDork(app, dorkId, { previews: [...rest, preview].slice(-MAX_PREVIEWS) });
  });
  return preview;
}

// ---------------------------------------------------------------- shared images
// `screenshot_share` (the bridge's MCP tool): the agent shows the owner a screenshot of its work. The bytes are stored here and served
// at GET /images/:id; the agent puts `![caption](dorks-image:<id>)` in its message and the web resolves it to that URL.

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 200;
const MAX_CAPTION = 200;

/** The image type from its magic bytes, or null. Only formats every webview renders; never SVG (it can carry script). */
export function imageMime(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return null;
}

/** A PNG's pixel size from its IHDR chunk (the lightbox uses it to size the viewer before the image loads). */
function pngSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 24) return undefined;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

export function shareImage(app: App, dorkId: string, data: unknown, caption: unknown): { id: string; width?: number; height?: number } {
  if (typeof data !== "string" || !data) return fail("invalid", "data must be a base64 image");
  const bytes = Uint8Array.from(Buffer.from(data, "base64"));
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return fail("invalid", `the image must be 1 byte to ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const mime = imageMime(bytes);
  if (!mime) return fail("invalid", "only PNG, JPEG, WebP or GIF images can be shared");
  const text = typeof caption === "string" ? caption.replace(/\s+/g, " ").trim().slice(0, MAX_CAPTION) : "";
  const id = randomBytes(16).toString("hex");
  const size = mime === "image/png" ? pngSize(bytes) : undefined;
  const image: SharedImage = { id, ...(text ? { caption: text } : {}), ...size, createdAt: Date.now() };
  app.db.tx(() => {
    const dork = bridgeDork(app, dorkId);
    app.db.run("INSERT INTO images (id, dork_id, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)", id, dorkId, mime, bytes, image.createdAt);
    const all = [...(dork.images ?? []), image];
    // Past the cap the oldest go, bytes included, so a looping agent cannot grow the database without bound.
    for (const old of all.slice(0, Math.max(0, all.length - MAX_IMAGES))) app.db.run("DELETE FROM images WHERE id = ?", old.id);
    patchDork(app, dorkId, { images: all.slice(-MAX_IMAGES) });
  });
  return { id, ...size };
}

/** How long an upload may wait for the message that names it: a removed or abandoned attachment is deleted after this. */
export const UNCLAIMED_IMAGE_MS = 24 * 60 * 60 * 1000;

/** An attachment the owner uploaded (POST /api/images), not yet in a message: unclaimed until a message names it. */
export function uploadImage(app: App, bytes: Uint8Array): { id: string } {
  // Uploads are the only way unclaimed images appear, so sweeping here bounds them without a timer.
  app.db.run("DELETE FROM images WHERE dork_id IS NULL AND created_at < ?", app.now() - UNCLAIMED_IMAGE_MS);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return fail("invalid", `the image must be 1 byte to ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const mime = imageMime(bytes);
  if (!mime) return fail("invalid", "only PNG, JPEG, WebP or GIF images can be attached");
  const id = randomBytes(16).toString("hex");
  app.db.run("INSERT INTO images (id, dork_id, mime, bytes, created_at) VALUES (?, NULL, ?, ?, ?)", id, mime, bytes, app.now());
  return { id };
}

const NAMED = /dorks-image:([0-9a-f]{32})/g;
/** The attachments a message names become the dork's (inside the message's transaction). Ids another dork holds are left alone. */
export function claimImages(app: App, dorkId: string, text: string) {
  for (const [, id] of text.matchAll(NAMED)) app.db.run("UPDATE images SET dork_id = ? WHERE id = ? AND dork_id IS NULL", dorkId, id);
}

/** An image of this dork as base64 (the bridge puts attachments in the agent's turn), or null. */
export function getImage(app: App, dorkId: string, id: unknown): { mime: string; data: string } | null {
  bridgeDork(app, dorkId);
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) return null;
  const r = app.db.get("SELECT mime, bytes FROM images WHERE id = ? AND dork_id = ?", id, dorkId);
  return r ? { mime: r.mime as string, data: Buffer.from(r.bytes as Uint8Array).toString("base64") } : null;
}

/** The bytes behind a shared image id, for GET /images/:id. */
export function imageBytes(app: App, id: string): { mime: string; bytes: Uint8Array } | null {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const r = app.db.get("SELECT mime, bytes FROM images WHERE id = ?", id);
  return r ? { mime: r.mime as string, bytes: r.bytes as Uint8Array } : null;
}

// ---------------------------------------------------------------- titles
/** The first user message, which the bridge names the dork after. */
function nameFrom(app: App, dorkId: string): { nameFrom?: string } {
  const r = app.db.get("SELECT json_extract(body, '$.text') AS text FROM events WHERE dork_id = ? AND json_extract(body, '$.type') = 'user_message' ORDER BY seq LIMIT 1", dorkId);
  const text = typeof r?.text === "string" ? r.text.slice(0, 4000) : "";
  return text ? { nameFrom: text } : {};
}

/** The bridge already cleaned the name (infra/bridge/src/title.ts); keep it to one line. */
const cleanTitle = (raw: string) => raw.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- secrets (async: decryption never happens inside a transaction)
/** Secrets are only minted for a dork whose box should be up and which the user has not archived. */
const TOKEN_STATES = ["creating", "waking", "working", "idle"];
export const mayMintSecrets = (dork: Pick<DorkRow, "state" | "archived">) => !dork.archived && TOKEN_STATES.includes(dork.state);

/** A token the dork needs is not set: the user has onboarding to finish. */
class OnboardingIncomplete extends Data.TaggedError("OnboardingIncomplete")<{ readonly message: string }> {}

/** `configure` was refused. If the dork was archived while still booting, finish the boot handshake so the box is paused, not left running. */
function settleRefused(app: App, dorkId: string) {
  app.db.tx(() => {
    const dork = getDork(app.db, dorkId);
    if (dork && !dork.deleting && dork.archived && (dork.state === "creating" || dork.state === "waking")) dispatch(app, dorkId, { t: "agent_ready" });
  });
}

/** `configure` could not build the frame: the dork's operation fails with `message` and the bridge gets `null`. */
const configureFailed = (app: App, dorkId: string, message: string, logged: string) =>
  Effect.sync(() => {
    console.error("configure failed", dorkId, logged);
    app.db.tx(() => opFailed(app, dorkId, message));
    return null;
  });

/**
 * Returns the `configure` frame (Claude token + CLI secrets + GitHub token) straight to the authenticated bridge: never stored.
 * `null` when the dork may not mint secrets now, or when they cannot be read (that fails the dork's operation).
 */
export const configure = Effect.fnUntraced(function* (app: App, dorkId: string): Effect.fn.Return<ToBridge | null, BridgeError> {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return yield* BridgeError.of("forbidden", "forbidden");
  if (!mayMintSecrets(dork)) {
    console.error("configure refused", dorkId);
    settleRefused(app, dorkId);
    return null;
  }
  return yield* configureFrame(app, dork).pipe(
    Effect.catchTag("OnboardingIncomplete", (e) => configureFailed(app, dorkId, e.message, e.message)),
    Effect.catchDefect(() => configureFailed(app, dorkId, "could not configure the sandbox", "unexpected")),
  );
});

/** The tokens and variables the agent runs with. Decryption runs here, never inside a transaction; a failure is a defect. */
const agentSecrets = Effect.fnUntraced(function* (app: App, dork: DorkRow): Effect.fn.Return<{ gh: string; env: Record<string, string> }, OnboardingIncomplete> {
  const sim = app.cfg.boxProvider === "sim";
  const claude = dork.provider === "claude" ? yield* Effect.promise(() => claudeToken(app)) : undefined;
  if (dork.provider === "claude" && !claude) return yield* new OnboardingIncomplete({ message: "Claude token not set" });
  const gh = (yield* Effect.promise(() => githubToken(app))) ?? (sim ? "sim-github-token" : undefined);
  if (!gh) return yield* new OnboardingIncomplete({ message: "GitHub token not set" });
  const secrets = yield* Effect.promise(() => cliSecrets(app));
  // Build variables (docs/builds.md) over the shared ones; decrypted only here, for an authenticated bridge allowed to mint secrets.
  const buildId = dork.buildId && getBuild(app, dork.buildId) ? dork.buildId : undefined;
  const buildVars = buildId ? yield* Effect.promise(() => buildVarValues(app, buildId)) : {};
  return { gh, env: { ...secrets, ...buildVars, ...(claude ? { CLAUDE_CODE_OAUTH_TOKEN: claude } : {}) } };
});

/** The agent's model and effort: Codex's chosen pair, or Claude's model and effort when set. */
function modelFields(dork: DorkRow) {
  if (dork.provider === "codex") return { codexModel: dork.codexModel };
  return { ...(dork.model ? { model: dork.model } : {}), ...(dork.effort ? { effort: dork.effort } : {}) };
}

const configureFrame = (app: App, dork: DorkRow): Effect.Effect<ToBridge, OnboardingIncomplete> =>
  agentSecrets(app, dork).pipe(
    Effect.map(({ gh, env }) => ({
      t: "configure" as const,
      provider: dork.provider,
      ...modelFields(dork),
      env,
      ghToken: gh,
      repo: dork.repo ? { fullName: dork.repo, branch: dork.branch } : null,
      resumeSessionId: (dork.provider === "codex" ? dork.codexThreadId : dork.claudeSessionId) ?? null,
      ...(dork.titleSource === "message" ? nameFrom(app, dork.id) : {}),
    })),
  );

/** The stored GitHub token, for the bridge's refresh path. Same gating as `configure`. */
export async function ghToken(app: App, dorkId: string): Promise<{ token: string } | null> {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) fail("forbidden", "forbidden");
  if (!mayMintSecrets(dork)) return null;
  const token = (await githubToken(app)) ?? (app.cfg.boxProvider === "sim" ? "sim-github-token" : undefined);
  return token ? { token } : null;
}
