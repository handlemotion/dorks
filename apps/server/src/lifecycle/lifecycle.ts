import { errorEvent } from "@dorks/shared";
import type { App } from "../app";
import { getDork, runtimeOf } from "../data";
import { foldInbox } from "../services/notify";
import {
  append, beginPause, BRIDGE_STALE_MS, cancelTimer, dispatch, enqueueConfigure, finishPause, HEARTBEAT_MS, isAwake, patchDork, patchRuntime, queued, schedulePauseRetry, setTimer,
} from "./dispatch";


/** A user-visible timer fired (the scheduler already claimed its row). Runs in one transaction. */
export function fireTimer(app: App, dorkId: string, name: string) {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return;
  const rt = runtimeOf(app.db, dorkId);
  switch (name) {
    case "sleep":
      dispatch(app, dorkId, { t: "sleep_due" });
      break;
    case "watchdog":
      if (isAwake(dork.state)) append(app, dorkId, errorEvent({ code: "timeout", message: "timed out waiting for the sandbox" }));
      dispatch(app, dorkId, { t: "watchdog" });
      break;
    case "notify":
      foldInbox(app, dorkId); // the debounce window closed: everything buffered becomes one notification
      break;
    case "flush":
      finishPause(app, dorkId); // flush timeout (a no-op if the pause was cancelled meanwhile)
      break;
    case "pause_retry":
      // A pause failed while in `error`; the box may still be running. (A message since then started a new op, which cancels this.)
      if (dork.state === "error" && dork.boxId) beginPause(app, dorkId);
      break;
    case "bridge_watch":
      if (!isAwake(dork.state)) break;
      if (!rt.bridgeLost && app.now() - rt.bridgeSeenAt > BRIDGE_STALE_MS) {
        patchRuntime(app, dorkId, { bridgeLost: true });
        dispatch(app, dorkId, { t: "bridge_lost" });
      }
      setTimer(app, dorkId, "bridge_watch", HEARTBEAT_MS);
      break;
  }
}

/**
 * An effect (box call, secret resolution) failed. The message must already be safe to show.
 * `gen` ties the failure to the box operation that produced it: a failure from a superseded operation is ignored.
 */
export function opFailed(app: App, dorkId: string, message: string, gen?: number) {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return; // deleted while the effect ran: nothing left to fail
  if (gen !== undefined) {
    const rt = runtimeOf(app.db, dorkId);
    if (gen !== rt.opGen) return void console.error("ignoring failure of a superseded box operation", dorkId); // consumed or replaced
    // The failed op is now settled: the next one gets a fresh generation, and a failed pause is no longer pending.
    const cancelled = rt.pause?.gen === gen && rt.pause.phase === "cancelled";
    patchRuntime(app, dorkId, { opGen: gen + 1, ...(rt.pause?.gen === gen ? { pause: undefined } : {}) });
    if (cancelled) return; // a message already took the pause back: the box is still up, so the dork stays as it is
  }
  append(app, dorkId, errorEvent({ code: "failed", message }));
  dispatch(app, dorkId, { t: "op_failed" });
  // In `error` with a box and no pause under way (the pause that error triggers has itself failed): keep trying, capped.
  const after = getDork(app.db, dorkId);
  if (after?.state === "error" && after.boxId && !runtimeOf(app.db, dorkId).pause) schedulePauseRetry(app, dorkId);
}

/**
 * The provider says `boxId` no longer exists. Forget it (and the session that lived on its disk, which a recreated box does
 * not have) and fail the op, atomically, so the machine's `error` + !hasBox path recreates the box on the next message.
 * No-op if the dork now points at a different box: a stale resume must not clobber a newer one.
 */
export function boxGone(app: App, dorkId: string, boxId: string, message: string) {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting || dork.boxId !== boxId) return;
  patchDork(app, dorkId, { boxId: undefined, claudeSessionId: undefined, codexThreadId: undefined, previews: undefined }); // hosted URLs died with the box
  append(app, dorkId, errorEvent({ code: "failed", message }));
  dispatch(app, dorkId, { t: "op_failed" });
}

/**
 * Records the freshly created box. Returns "orphaned" if the dork was deleted (or already purged) while `createFromSnapshot`
 * was in flight, or if a newer create attempt already recorded a different box: nothing tracks this one, so the caller must delete it.
 */
export function boxCreated(app: App, dorkId: string, boxId: string, sleepMinutes: number, gen: number): "ok" | "orphaned" {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return "orphaned";
  if (dork.boxId && dork.boxId !== boxId) return "orphaned";
  const rt = runtimeOf(app.db, dorkId);
  if (gen !== rt.opGen) console.error("recording the box of a superseded create", dorkId);
  patchRuntime(app, dorkId, { sleepMinutes });
  patchDork(app, dorkId, { boxId });
  // The create outlived its dork's patience (watchdog -> error while there was no box to pause): the box now runs under `error`.
  if (dork.state === "error") beginPause(app, dorkId, true);
  return "ok";
}

/**
 * Box resumed. If the bridge never lost its connection (agent crashed, box stayed up) no new connect will trigger `configure`.
 * If the dork gave up on this resume meanwhile the box is running unwanted, and any pause issued before this point may have
 * finished before the resume did: pause again, ordered after it.
 */
export function boxResumed(app: App, dorkId: string) {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return;
  if (dork.state === "error" || dork.state === "sleeping") return beginPause(app, dorkId, true);
  enqueueConfigure(app, dorkId); // idempotent on the bridge side
}

/**
 * The box is paused. Ignored if a newer box operation superseded this pause. If a message took the pause back while the box
 * call was in flight (`cancelled`) or queued work remains, the box is down under a dork that wants to run, so it wakes again.
 */
export function boxPaused(app: App, dorkId: string, gen: number) {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) return;
  const rt = runtimeOf(app.db, dorkId);
  if (gen !== rt.opGen) return void console.error("ignoring pause of a superseded box operation", dorkId);
  const cancelled = rt.pause?.phase === "cancelled";
  patchRuntime(app, dorkId, { opGen: gen + 1, pause: undefined, pauseRetries: 0 });
  cancelTimer(app, dorkId, "pause_retry");
  dispatch(app, dorkId, { t: "paused" });
  // Never from `error`: its pause is the failure's cleanup, and re-waking a dork whose wake just failed would loop forever.
  const after = getDork(app.db, dorkId);
  if (dork.state !== "error" && after && !after.archived && after.state === "sleeping" && (cancelled || queued(app, dorkId))) dispatch(app, dorkId, { t: "user_message" });
}
