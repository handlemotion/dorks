import type { App } from "../app";
import { isBoxNotFound } from "../core/box";
import { getDork } from "../data";
import { BoatError } from "../lib/boat";
import { bridgeSecret } from "../lib/bridgeAuth";
import { createIssueComment, GithubHttpError, isTransientGithubError } from "../lib/github";
import { pollOnce } from "../services/poller";
import { githubToken, readSettings } from "../services/settings";
import { getSub } from "../services/subscriptions";
import { boxCreated, boxGone, boxPaused, boxResumed, opFailed } from "./lifecycle";
import { setTimer } from "./dispatch";
import { patchDork } from "./dispatch";

// Work that must call out to a provider, so it cannot run inside a transaction. Each job is a timer row claimed by the scheduler
// (at-most-once, no automatic retry): every provider call is idempotent, and a failure becomes `op_failed` -> `error`; the user's
// next message retries. Results come back through the transactional functions in lifecycle.ts, which carry the operation
// generation so a stale result is ignored. Only generic text reaches the event log.

const MAX_ORPHAN_ATTEMPTS = 6;
const STALL_RETRY_MS = [60_000, 5 * 60_000];

const safe = (e: unknown, what: string) => {
  console.error(`${what} failed`, e instanceof Error ? e.message.slice(0, 200) : "unknown");
  return e instanceof BoatError && e.message.startsWith("boat: selected environment") ? e.message : `${what} failed`;
};

export interface BoxInfo {
  boxId: string | null;
  deleting: boolean;
  snapshotId: string;
  sleepMinutes: number;
  requiresBoatEnvironment: boolean;
  boatEnvironment?: string;
}

/** Non-secret facts the box jobs need. */
export function boxInfo(app: App, dorkId: string): BoxInfo | null {
  const dork = getDork(app.db, dorkId);
  if (!dork) return null;
  const s = readSettings(app);
  const codexOnBoat = dork.provider === "codex" && app.cfg.boxProvider === "boat";
  return {
    boxId: dork.boxId ?? null, deleting: dork.deleting, snapshotId: s.baseSnapshotId ?? app.cfg.baseSnapshotId ?? "", sleepMinutes: s.sleepMinutes,
    requiresBoatEnvironment: codexOnBoat, boatEnvironment: codexOnBoat ? s.boatEnvironment : undefined,
  };
}

const settle = (app: App, fn: () => void) => app.db.tx(fn);

async function boxCreate(app: App, dorkId: string, gen: number) {
  try {
    const info = boxInfo(app, dorkId);
    if (!info || info.deleting) return; // deleted before we started: do not create a box nobody will clean up
    if (!info.snapshotId) return settle(app, () => opFailed(app, dorkId, "No base snapshot configured", gen));
    if (info.requiresBoatEnvironment && !info.boatEnvironment) return settle(app, () => opFailed(app, dorkId, "Set your Boat ChatGPT environment in Settings", gen));
    const bridgeUrl = app.bridgeUrl();
    if (!bridgeUrl) return settle(app, () => opFailed(app, dorkId, "Set up the public URL that sandboxes use to reach this app first", gen));
    // Only bridge connection details go in the create-time env; user secrets arrive over the bridge's configure call.
    const box = await (await app.getBox()).createFromSnapshot(info.snapshotId, {
      name: dorkId,
      initCommand: "dorks-bridge",
      env: { DORK_ID: dorkId, BRIDGE_URL: bridgeUrl, BRIDGE_SECRET: await bridgeSecret(app.cfg.bridgeSecretKey, dorkId) },
      boatEnvironment: info.boatEnvironment,
      generation: gen,
    });
    const recorded = app.db.tx(() => boxCreated(app, dorkId, box.id, info.sleepMinutes, gen));
    // The dork was deleted while the box was being created, so `destroy` saw no boxId. Delete what we just made.
    if (recorded === "orphaned") await deleteOrphan(app, box.id, 0);
  } catch (e) {
    settle(app, () => opFailed(app, dorkId, safe(e, "create_box"), gen));
  }
}

/** Deletes a box that no dork row points at. Provider deletes are idempotent; failures retry with backoff so it cannot leak silently. */
export async function deleteOrphan(app: App, boxId: string, attempt: number) {
  try {
    await (await app.getBox()).delete(boxId);
  } catch (e) {
    safe(e, "delete_orphan_box");
    if (attempt < MAX_ORPHAN_ATTEMPTS) setTimer(app, "", `orphan:${boxId}`, 15_000 * 2 ** attempt, { boxId, attempt: attempt + 1 });
    else console.error("orphan box could not be deleted; remove it manually", boxId);
  }
}

async function boxResume(app: App, dorkId: string, gen: number) {
  try {
    const info = boxInfo(app, dorkId);
    if (!info?.boxId) throw new Error("no box");
    try {
      await (await app.getBox()).resume(info.boxId);
    } catch (e) {
      // The provider no longer has this box (deleted out of band, retention expired). Forget the id so the machine's
      // `error` + !hasBox path recreates it from the snapshot on the next message, instead of failing resume forever.
      if (!isBoxNotFound(e)) throw e;
      console.error("resume_box: box no longer exists, clearing boxId");
      return settle(app, () => boxGone(app, dorkId, info.boxId!, "The sandbox no longer exists; it will be recreated on your next message"));
    }
    settle(app, () => boxResumed(app, dorkId));
  } catch (e) {
    settle(app, () => opFailed(app, dorkId, safe(e, "resume_box"), gen));
  }
}

async function boxPause(app: App, dorkId: string, gen: number) {
  try {
    const info = boxInfo(app, dorkId);
    if (info?.boxId) await (await app.getBox()).pause(info.boxId);
    settle(app, () => boxPaused(app, dorkId, gen));
  } catch (e) {
    settle(app, () => opFailed(app, dorkId, safe(e, "pause_box"), gen));
  }
}

async function boxDestroy(app: App, dorkId: string) {
  const info = boxInfo(app, dorkId);
  if (!info) return;
  // Delete the box first; wipe rows only if that worked, so a failed delete can be retried by calling remove again.
  try {
    if (info.boxId) await (await app.getBox()).delete(info.boxId);
  } catch (e) {
    safe(e, "delete_box");
    return settle(app, () => patchDork(app, dorkId, { deleting: false }));
  }
  settle(app, () => {
    app.db.run("DELETE FROM dorks WHERE id = ?", dorkId); // events, commands, runtime, subscriptions and the inbox cascade
    app.db.run("DELETE FROM timers WHERE owner = ?", dorkId);
    patchDork(app, dorkId, {});
  });
}

/** The one comment a stalled PR gets: CI keeps failing, a person has to look. */
async function stallComment(app: App, subscriptionId: number, runUrl: string, attempt: number, name: string, owner: string) {
  const sub = getSub(app, subscriptionId);
  if (!sub || sub.status !== "stalled") return; // a human resumed it, or it ended, before the comment went out
  const token = await githubToken(app);
  if (!token) return;
  try {
    await createIssueComment(app.fetch, token, sub.repo, sub.number, `CI is still failing after the agent's automatic fix attempts, so it has stopped. A human needs to take a look.\n\nFailing run: ${runUrl}`);
  } catch (e) {
    console.error("stall comment failed", subscriptionId, e instanceof GithubHttpError ? e.status : "unexpected");
    if (isTransientGithubError(e) && attempt < STALL_RETRY_MS.length) setTimer(app, owner, name, STALL_RETRY_MS[attempt], { subscriptionId, runUrl, attempt: attempt + 1 });
  }
}

export const INBOX_RETENTION_MS = 24 * 3_600_000; // delivered rows only matter for debugging
export const SWEEP_EVERY_MS = 6 * 3_600_000;

/** Prunes the debounce buffer's delivered rows, then comes back. */
export function sweep(app: App) {
  app.db.tx(() => app.db.run("DELETE FROM inbox WHERE delivered = 1 AND created_at < ?", app.now() - INBOX_RETENTION_MS));
  setTimer(app, "", "sweep", SWEEP_EVERY_MS);
}

/** Timer names that are jobs (async, outside a transaction) rather than state-machine timers. */
export const isJob = (name: string) => name.startsWith("box:") || name.startsWith("orphan:") || name.startsWith("stall:") || name === "poll" || name === "sweep";

export async function runJob(app: App, owner: string, name: string, payload: any): Promise<void> {
  try {
    if (name.startsWith("box:create")) return await boxCreate(app, owner, payload.gen);
    if (name.startsWith("box:resume")) return await boxResume(app, owner, payload.gen);
    if (name.startsWith("box:pause")) return await boxPause(app, owner, payload.gen);
    if (name === "box:destroy") return await boxDestroy(app, owner);
    if (name.startsWith("orphan:")) return await deleteOrphan(app, payload.boxId, payload.attempt);
    if (name.startsWith("stall:")) return await stallComment(app, payload.subscriptionId, payload.runUrl, payload.attempt ?? 0, name, owner);
    if (name === "sweep") return sweep(app);
    if (name === "poll") {
      const next = await pollOnce(app);
      if (next !== null) setTimer(app, "", "poll", next);
    }
  } catch (e) {
    console.error(`job ${name} crashed`, e instanceof Error ? e.message.slice(0, 200) : "unknown");
  }
}
