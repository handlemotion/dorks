import type { ClientEventBody } from "@dorks/shared";
import { fail, touch, type App } from "../app";
import { commandOf, getDork, openCommands, runtimeOf, type CommandKind, type CommandRow, type DorkRow } from "../data";
import { update, insert } from "../db";
import { reduce, type Effect, type Input, type Result } from "../core/machine";

// The lifecycle driver. Every function here is synchronous and meant to run inside one SQLite transaction (app.db.tx): a state
// change, its event, and its effects (timers, box jobs, outbox rows) commit together or not at all.

export const WATCHDOG_MS = 3 * 60_000; // creating/waking must reach `ready` (or a lost bridge must return) within this
export const FLUSH_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 30_000;
export const BRIDGE_STALE_MS = 90_000;
export const MAX_MESSAGE_CHARS = 50_000;
export const PAUSE_STUCK_MS = 2 * 60_000; // a `pausing` intent older than this is assumed lost (the job died without reporting)
export const PAUSE_RETRY_BASE_MS = 15_000; // failed pause from `error`: retry after 15s, 30s, 60s, ...
export const MAX_PAUSE_RETRIES = 6;

const AWAKE = ["creating", "working", "idle", "waking"];
export const isAwake = (s: string) => AWAKE.includes(s);

// ---------------------------------------------------------------- event log
/**
 * Dense per-dork seq: next = last + 1. A growing assistant message keeps ONE row (its text grows in place), so pages stay small;
 * clients re-fold what they loaded. Returns the tail seq.
 */
export function append(app: App, dorkId: string, ...bodies: ClientEventBody[]): number {
  const { db } = app;
  const tailRow = db.get<{ seq: number; ts: number; body: string }>("SELECT seq, ts, body FROM events WHERE dork_id = ? ORDER BY seq DESC LIMIT 1", dorkId);
  let tail = tailRow ? { seq: tailRow.seq, body: JSON.parse(tailRow.body) as ClientEventBody } : undefined;
  let seq = tail?.seq ?? 0;
  const ts = app.now();
  for (const body of bodies) {
    if (tail && body.type === "assistant_delta" && tail.body.type === "assistant_delta" && tail.body.messageId === body.messageId) {
      tail = { seq: tail.seq, body: { ...tail.body, text: tail.body.text + body.text } };
      db.run("UPDATE events SET body = ?, ts = ? WHERE dork_id = ? AND seq = ?", JSON.stringify(tail.body), ts, dorkId, tail.seq);
      continue;
    }
    db.run("INSERT INTO events (dork_id, seq, ts, body) VALUES (?, ?, ?, ?)", dorkId, ++seq, ts, JSON.stringify(body));
    tail = { seq, body };
  }
  if (bodies.length) touch(app, { t: "events", dorkId, seq });
  return seq;
}

// ---------------------------------------------------------------- timers (durable; app.scheduler fires them)
export function setTimer(app: App, owner: string, name: string, ms: number, payload?: unknown) {
  app.db.run("INSERT OR REPLACE INTO timers (owner, name, due_at, payload) VALUES (?, ?, ?, ?)", owner, name, app.now() + ms, payload === undefined ? null : JSON.stringify(payload));
  app.db.afterCommit(() => app.scheduler?.wake());
}

export function cancelTimer(app: App, owner: string, name: string) {
  app.db.run("DELETE FROM timers WHERE owner = ? AND name = ?", owner, name);
}

export const hasTimer = (app: App, owner: string, name: string) => !!app.db.get("SELECT 1 AS x FROM timers WHERE owner = ? AND name = ?", owner, name);

// ---------------------------------------------------------------- outbox
const unackedMessages = (app: App, dorkId: string): CommandRow[] => openCommands(app.db, dorkId).filter((c) => c.kind === "user_message" || c.kind === "notify");

export function machineCtx(app: App, dork: DorkRow) {
  const open = unackedMessages(app, dork.id);
  return {
    state: dork.state, archived: dork.archived, hasBox: !!dork.boxId, queued: open.length > 0,
    notifyHeld: !open.some((c) => c.kind === "user_message") && open.some((c) => c.kind === "notify" && !c.released),
  };
}

export const queued = (app: App, dorkId: string) => unackedMessages(app, dorkId).length > 0;

/** True while a user message waits for its ack: user messages always go out before notifications. */
export const userMessagePending = (app: App, dorkId: string) => unackedMessages(app, dorkId).some((c) => c.kind === "user_message");

export function enqueue(app: App, dorkId: string, kind: CommandKind, text?: string): string {
  const cid = app.uuid();
  // A user message goes first, and its turn must not be interrupted either: a notify released earlier waits for the next turn boundary again.
  if (kind === "user_message") for (const c of unackedMessages(app, dorkId)) if (c.kind === "notify" && c.released) update(app.db, "commands", { id: c.id }, { released: false });
  insert(app.db, "commands", { dorkId, kind, cid, text, acked: false });
  touch(app, { t: "commands", dorkId });
  return cid;
}

/** At most one pending `configure`; the bridge handles it idempotently. */
export function enqueueConfigure(app: App, dorkId: string) {
  if (!openCommands(app.db, dorkId).some((c) => c.kind === "configure")) enqueue(app, dorkId, "configure");
}

/** Control frames (flush, interrupt, configure) are only meaningful to the bridge that was running when they were queued. Messages and notifies are not. */
export function clearControlRows(app: App, dorkId: string) {
  const rows = app.db.all("SELECT * FROM commands WHERE dork_id = ? AND acked = 0 AND kind NOT IN ('user_message', 'notify')", dorkId).map(commandOf);
  for (const c of rows) app.db.run("DELETE FROM commands WHERE id = ?", c.id);
  if (rows.length) touch(app, { t: "commands", dorkId });
}

function deleteFlushRows(app: App, dorkId: string) {
  app.db.run("DELETE FROM commands WHERE dork_id = ? AND acked = 0 AND kind = 'flush'", dorkId);
  touch(app, { t: "commands", dorkId });
}

/** Runtime bookkeeping. A pause change alters what the bridge may be sent (messages are held while a pause is in flight), so it re-publishes the commands snapshot. */
export const patchRuntime = (app: App, dorkId: string, patch: Record<string, unknown>) => {
  update(app.db, "dork_runtime", { dorkId }, patch);
  if ("pause" in patch) touch(app, { t: "commands", dorkId });
};
export const patchDork = (app: App, dorkId: string, patch: Record<string, unknown>) => {
  update(app.db, "dorks", { id: dorkId }, patch);
  touch(app, { t: "dork", dorkId });
  touch(app, { t: "dorks" });
};

// ---------------------------------------------------------------- machine driver
/** Apply an input: persist the new state, then run effects. All of it in the caller's transaction. */
export function dispatch(app: App, dorkId: string, input: Input): Result | null {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return null;
  const before = machineCtx(app, dork);
  const r = reduce(before, input);
  if (r.rejected) return r;
  if (r.state !== before.state || r.archived !== before.archived) patchDork(app, dorkId, { state: r.state, archived: r.archived, lastActivityAt: app.now() });
  if (r.state !== before.state) append(app, dorkId, { type: "status", state: r.state });
  if (input.t === "paused" && r.state === "sleeping") clearControlRows(app, dorkId); // nothing may replay into the next wake
  for (const effect of r.effects) runEffect(app, dorkId, effect);
  return r;
}

function runEffect(app: App, dorkId: string, effect: Effect) {
  switch (effect) {
    case "create_box":
    case "resume_box": {
      // A new box operation supersedes any pause, and control rows left by the previous run must not replay into this one.
      dropPause(app, dorkId);
      cancelTimer(app, dorkId, "pause_retry");
      clearControlRows(app, dorkId);
      const rt = runtimeOf(app.db, dorkId);
      const gen = rt.opGen + 1;
      patchRuntime(app, dorkId, { opGen: gen, pauseRetries: 0, bridgeSeenAt: app.now(), bridgeLost: false }); // grace period for the new bridge to dial in
      setTimer(app, dorkId, "bridge_watch", HEARTBEAT_MS);
      setTimer(app, dorkId, `${effect === "create_box" ? "box:create" : "box:resume"}:${gen}`, 0, { gen }); // one row per operation: a superseded one still runs, and its result is ignored
      return;
    }
    case "pause_box":
      return beginPause(app, dorkId);
    case "cancel_pause":
      return cancelPause(app, dorkId);
    case "deliver_outbox":
      return; // declarative: the commands snapshot re-emits every unacked message while the dork is working/idle
    case "release_notify":
      for (const c of unackedMessages(app, dorkId)) if (c.kind === "notify" && !c.released) update(app.db, "commands", { id: c.id }, { released: true });
      touch(app, { t: "commands", dorkId });
      return;
    case "interrupt_agent":
      enqueue(app, dorkId, "interrupt");
      return;
    case "arm_sleep":
      return setTimer(app, dorkId, "sleep", runtimeOf(app.db, dorkId).sleepMinutes * 60_000);
    case "cancel_sleep":
      return cancelTimer(app, dorkId, "sleep");
    case "arm_watchdog":
      return setTimer(app, dorkId, "watchdog", WATCHDOG_MS);
    case "cancel_watchdog":
      return cancelTimer(app, dorkId, "watchdog");
  }
}

/**
 * Bridge liveness. Every bridge call (connect, heartbeat, push) goes through here: clearing `bridgeLost` while the dork is
 * working/idle must also tell the machine, or the watchdog armed by `bridge_lost` stays armed and kills a healthy dork.
 */
export function bridgeSeen(app: App, dork: DorkRow) {
  const rt = runtimeOf(app.db, dork.id);
  patchRuntime(app, dork.id, { bridgeSeenAt: app.now(), bridgeLost: false });
  if (rt.bridgeLost && (dork.state === "working" || dork.state === "idle")) dispatch(app, dork.id, { t: "agent_ready" });
}

// ---------------------------------------------------------------- pausing
// A pause is an intent with a generation (`rt.pause`), separate from the effect that carries it out: the flush and the box call
// both take time, and a message (or a newer box operation) may arrive in between. Every step re-checks the intent.

/**
 * Ask a live bridge to flush, then pause the box on `flushed` (or after a timeout). A silent bridge is paused directly.
 * An intent already in progress is kept, unless `force` (the box is known to be running again, so an older pause cannot be
 * trusted) or its box call has been in flight so long that it must have died.
 */
export function beginPause(app: App, dorkId: string, force = false) {
  const rt = runtimeOf(app.db, dorkId);
  const now = app.now();
  if (rt.pause && rt.pause.phase !== "cancelled") {
    const lost = rt.pause.phase === "pausing" && now - (rt.pause.since ?? 0) > PAUSE_STUCK_MS;
    if (!force && !lost) return; // already flushing / pausing
    cancelTimer(app, dorkId, "flush");
    deleteFlushRows(app, dorkId);
  }
  const live = !rt.bridgeLost && now - rt.bridgeSeenAt < BRIDGE_STALE_MS;
  const gen = rt.opGen + 1;
  if (live) {
    const flushCid = enqueue(app, dorkId, "flush");
    patchRuntime(app, dorkId, { opGen: gen, pause: { gen, phase: "flushing", since: now, flushCid } });
    setTimer(app, dorkId, "flush", FLUSH_TIMEOUT_MS);
  } else {
    patchRuntime(app, dorkId, { opGen: gen, pause: { gen, phase: "pausing", since: now } });
    setTimer(app, dorkId, `box:pause:${gen}`, 0, { gen });
  }
}

/** A pause that failed (or was lost) leaves a box running under `error`: try again later, with backoff, up to a cap. */
export function schedulePauseRetry(app: App, dorkId: string) {
  const rt = runtimeOf(app.db, dorkId);
  const n = rt.pauseRetries;
  if (n >= MAX_PAUSE_RETRIES) return void console.error("box could not be paused after retries; pause it manually", dorkId);
  patchRuntime(app, dorkId, { pauseRetries: n + 1 });
  setTimer(app, dorkId, "pause_retry", PAUSE_RETRY_BASE_MS * 2 ** n);
}

/** Flush done (or timed out): pause the box, but only if the pause is still wanted. */
export function finishPause(app: App, dorkId: string, flushedCid?: string) {
  const rt = runtimeOf(app.db, dorkId);
  if (rt.pause?.phase !== "flushing") return; // cancelled meanwhile, or already launched (duplicate `flushed`)
  // A `flushed` that names another flush is a straggler from a pause that was cancelled; it must not end this one early.
  if (flushedCid !== undefined && rt.pause.flushCid !== undefined && flushedCid !== rt.pause.flushCid) return;
  cancelTimer(app, dorkId, "flush");
  deleteFlushRows(app, dorkId);
  patchRuntime(app, dorkId, { pause: { gen: rt.pause.gen, phase: "pausing", since: app.now() } });
  setTimer(app, dorkId, `box:pause:${rt.pause.gen}`, 0, { gen: rt.pause.gen });
}

/**
 * Someone needs the box awake. Before the box call is launched this fully undoes the pause; once the pause job is in flight it
 * cannot be recalled, so it is marked cancelled and `boxPaused` wakes the dork again when it lands.
 */
export function cancelPause(app: App, dorkId: string) {
  const rt = runtimeOf(app.db, dorkId);
  if (!rt.pause || rt.pause.phase === "cancelled") return;
  if (rt.pause.phase === "pausing") return patchRuntime(app, dorkId, { pause: { gen: rt.pause.gen, phase: "cancelled", since: rt.pause.since } });
  cancelTimer(app, dorkId, "flush");
  deleteFlushRows(app, dorkId);
  patchRuntime(app, dorkId, { pause: undefined });
}

/** A new box operation replaces the intent outright (its generation bump makes any in-flight pause result stale). */
function dropPause(app: App, dorkId: string) {
  const rt = runtimeOf(app.db, dorkId);
  if (!rt.pause) return;
  cancelTimer(app, dorkId, "flush");
  patchRuntime(app, dorkId, { pause: undefined });
}

export { fail };
