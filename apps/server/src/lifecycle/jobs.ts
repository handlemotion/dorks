import { Data, Effect } from "effect";
import type { App } from "../app";
import { isBoxNotFound, type BoxProvider } from "../core/box";
import { getDork } from "../data";
import { BoatError } from "../lib/boat";
import { bridgeSecret } from "../lib/bridgeAuth";
import { forgetSandbox, sandboxTunnelEnv } from "../lib/tunnelService";
import { createIssueComment, GithubError, isTransientGithubError } from "../lib/github";
import { pollOnce } from "../services/poller";
import { runBuild, SNAPSHOT_JOB } from "../services/snapshot";
import { getBuild } from "../services/builds";
import { FORGET_JOB, forgetImage, RUN_JOB, runBuildRun } from "../services/buildRuns";
import { githubToken, readSettings } from "../services/settings";
import { getSub } from "../services/subscriptions";
import { SERVER_COMMENT_MARK } from "../services/githubIngest";
import { boxCreated, boxGone, boxPaused, boxResumed, opFailed } from "./lifecycle";
import { patchDork, setTimer } from "./dispatch";

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
  /** The build's machine size, when the dork is on a build. */
  machineType?: string;
}

/** Non-secret facts the box jobs need. */
export function boxInfo(app: App, dorkId: string): BoxInfo | null {
  const dork = getDork(app.db, dorkId);
  if (!dork) return null;
  const s = readSettings(app);
  const codexOnBoat = dork.provider === "codex" && app.cfg.boxProvider === "boat";
  // A dork on a build starts from the build's image (docs/builds.md); before its first image (a setup session), or after the build was
  // deleted, from the base snapshot.
  const build = dork.buildId ? getBuild(app, dork.buildId) : undefined;
  return {
    boxId: dork.boxId ?? null,
    deleting: dork.deleting,
    snapshotId: build?.image ?? s.baseSnapshotId ?? app.cfg.baseSnapshotId ?? "",
    sleepMinutes: s.sleepMinutes,
    machineType: build?.machineType,
    requiresBoatEnvironment: codexOnBoat,
    boatEnvironment: codexOnBoat ? s.boatEnvironment : undefined,
  };
}

/** A step of a job failed: a provider call, or the database around it. `cause` is the original error; only `safe` text reaches users. */
export class JobStepError extends Data.TaggedError("JobStepError")<{ readonly cause: unknown }> {}

/** A Promise-returning call (a provider, a service not yet on Effect) as a job step. */
const promise = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (cause) => new JobStepError({ cause }) });
/** A synchronous step (database reads and writes) that may throw. */
const sync = <A>(f: () => A) => Effect.try({ try: f, catch: (cause) => new JobStepError({ cause }) });
/** A call on the sandbox provider for the current settings. */
const onBox = <A>(app: App, f: (box: BoxProvider) => Promise<A>) => promise(async () => f(await app.getBox()));
const settle = (app: App, fn: () => void) => sync(() => app.db.tx(fn));

/** A box job's failure becomes `op_failed` with generic text; if even that cannot be recorded, the step error escapes. */
const orOpFailed =
  (app: App, dorkId: string, what: string, gen: number) =>
  <E extends JobStepError>(job: Effect.Effect<void, E>): Effect.Effect<void, JobStepError> =>
    job.pipe(Effect.catch((e) => settle(app, () => opFailed(app, dorkId, safe(e.cause, what), gen))));

/** Why a box cannot be created right now, in words the user can act on; undefined when it can. */
const createBlocker = (info: BoxInfo, bridgeUrl: string | undefined) => {
  if (!info.snapshotId) return "No base snapshot configured";
  if (info.requiresBoatEnvironment && !info.boatEnvironment) return "Set your Boat ChatGPT environment in Settings";
  if (!bridgeUrl) return "Set up the public URL that sandboxes use to reach this app first";
  return undefined;
};

const boxCreate = (app: App, dorkId: string, gen: number) =>
  Effect.gen(function* () {
    const info = yield* sync(() => boxInfo(app, dorkId));
    if (!info || info.deleting) return; // deleted before we started: do not create a box nobody will clean up
    const bridgeUrl = yield* sync(() => app.bridgeUrl());
    const blocker = createBlocker(info, bridgeUrl);
    if (blocker) return yield* settle(app, () => opFailed(app, dorkId, blocker, gen));
    // Only bridge connection details go in the create-time env; user secrets arrive over the bridge's configure call.
    const tunnelEnv = yield* promise(() => sandboxTunnelEnv(app, dorkId));
    const secret = yield* promise(() => bridgeSecret(app.cfg.bridgeSecretKey, dorkId));
    const box = yield* onBox(app, (p) =>
      p.createFromSnapshot(info.snapshotId, {
        name: dorkId,
        initCommand: "dorks-bridge",
        env: { DORK_ID: dorkId, BRIDGE_URL: bridgeUrl!, BRIDGE_SECRET: secret, ...tunnelEnv },
        boatEnvironment: info.boatEnvironment,
        machineType: info.machineType,
        generation: gen,
      }),
    );
    const recorded = yield* sync(() => app.db.tx(() => boxCreated(app, dorkId, box.id, info.sleepMinutes, gen)));
    // The dork was deleted while the box was being created, so `destroy` saw no boxId. Delete what we just made.
    if (recorded === "orphaned") yield* deleteOrphan(app, box.id, 0);
  }).pipe(orOpFailed(app, dorkId, "create_box", gen));

/** Deletes a box that no dork row points at. Provider deletes are idempotent; failures retry with backoff so it cannot leak silently. */
export const deleteOrphan = (app: App, boxId: string, attempt: number): Effect.Effect<void, JobStepError> =>
  onBox(app, (box) => box.delete(boxId)).pipe(
    Effect.catch((e) =>
      sync(() => {
        safe(e.cause, "delete_orphan_box");
        if (attempt < MAX_ORPHAN_ATTEMPTS) setTimer(app, "", `orphan:${boxId}`, 15_000 * 2 ** attempt, { boxId, attempt: attempt + 1 });
        else console.error("orphan box could not be deleted; remove it manually", boxId);
      }),
    ),
  );

const boxResume = (app: App, dorkId: string, gen: number) =>
  Effect.gen(function* () {
    const info = yield* sync(() => boxInfo(app, dorkId));
    const boxId = info?.boxId;
    if (!boxId) return yield* new JobStepError({ cause: new Error("no box") });
    // The provider no longer has this box (deleted out of band, retention expired). Forget the id so the machine's
    // `error` + !hasBox path recreates it from the snapshot on the next message, instead of failing resume forever.
    const gone = yield* onBox(app, (box) => box.resume(boxId)).pipe(
      Effect.as(false),
      Effect.catchIf(
        (e) => isBoxNotFound(e.cause),
        () => Effect.succeed(true),
      ),
    );
    if (!gone) return yield* settle(app, () => boxResumed(app, dorkId));
    console.error("resume_box: box no longer exists, clearing boxId");
    yield* settle(app, () => boxGone(app, dorkId, boxId, "The sandbox no longer exists; it will be recreated on your next message"));
  }).pipe(orOpFailed(app, dorkId, "resume_box", gen));

const boxPause = (app: App, dorkId: string, gen: number) =>
  Effect.gen(function* () {
    const info = yield* sync(() => boxInfo(app, dorkId));
    const boxId = info?.boxId;
    if (boxId) yield* onBox(app, (box) => box.pause(boxId));
    yield* settle(app, () => boxPaused(app, dorkId, gen));
  }).pipe(orOpFailed(app, dorkId, "pause_box", gen));

const boxDestroy = (app: App, dorkId: string) =>
  Effect.gen(function* () {
    const info = yield* sync(() => boxInfo(app, dorkId));
    if (!info) return;
    // Delete the box first; wipe rows only if that worked, so a failed delete can be retried by calling remove again.
    const boxId = info.boxId;
    const deleted = yield* (boxId ? onBox(app, (box) => box.delete(boxId)) : Effect.void).pipe(
      Effect.as(true),
      Effect.catch((e) => {
        safe(e.cause, "delete_box");
        return settle(app, () => patchDork(app, dorkId, { deleting: false })).pipe(Effect.as(false));
      }),
    );
    if (!deleted) return;
    yield* promise(() => forgetSandbox(app, dorkId));
    yield* settle(app, () => {
      app.db.run("DELETE FROM dorks WHERE id = ?", dorkId); // events, commands, runtime, subscriptions and the inbox cascade
      app.db.run("DELETE FROM timers WHERE owner = ?", dorkId);
      patchDork(app, dorkId, {});
    });
  });

const STALL_TEXT = (runUrl: string) =>
  `CI is still failing after the agent's automatic fix attempts, so it has stopped. A human needs to take a look.\n\nFailing run: ${runUrl}\n\n${SERVER_COMMENT_MARK}`;

/** The one comment a stalled PR gets: CI keeps failing, a person has to look. */
const stallComment = (app: App, subscriptionId: number, runUrl: string, attempt: number, name: string, owner: string) =>
  Effect.gen(function* () {
    const sub = yield* sync(() => getSub(app, subscriptionId));
    if (!sub || sub.status !== "stalled") return; // a human resumed it, or it ended, before the comment went out
    const token = yield* promise(() => githubToken(app));
    if (!token) return;
    yield* promise(() => createIssueComment(app.fetch, token, sub.repo, sub.number, STALL_TEXT(runUrl))).pipe(
      Effect.catch(({ cause }) =>
        sync(() => {
          console.error("stall comment failed", subscriptionId, cause instanceof GithubError ? (cause.status ?? cause.reason) : "unexpected");
          if (isTransientGithubError(cause) && attempt < STALL_RETRY_MS.length) setTimer(app, owner, name, STALL_RETRY_MS[attempt], { subscriptionId, runUrl, attempt: attempt + 1 });
        }),
      ),
    );
  });

/** One pass of the PR poller; it says when to come back, or that nothing is left to watch. */
const poll = (app: App) => promise(() => pollOnce(app)).pipe(Effect.flatMap((next) => (next === null ? Effect.void : sync(() => setTimer(app, "", "poll", next)))));

export const INBOX_RETENTION_MS = 24 * 3_600_000; // delivered rows only matter for debugging
export const SWEEP_EVERY_MS = 6 * 3_600_000;

/** Prunes the debounce buffer's delivered rows, then comes back. */
export function sweep(app: App) {
  app.db.tx(() => app.db.run("DELETE FROM inbox WHERE delivered = 1 AND created_at < ?", app.now() - INBOX_RETENTION_MS));
  setTimer(app, "", "sweep", SWEEP_EVERY_MS);
}

/** Timer names that are jobs (async, outside a transaction) rather than state-machine timers. */
export const isJob = (name: string) =>
  name.startsWith("box:") ||
  name.startsWith("orphan:") ||
  name.startsWith("stall:") ||
  name === "poll" ||
  name === "sweep" ||
  name === SNAPSHOT_JOB ||
  name.startsWith(RUN_JOB) ||
  name.startsWith(FORGET_JOB);

/**
 * The job a claimed timer names, as an Effect. Each job reports its own outcome (`op_failed` and the like); a `JobStepError` that
 * escapes is a step that failed where nothing could be recorded, and the scheduler logs it.
 */
export const runJob = (app: App, owner: string, name: string, payload: any): Effect.Effect<void, JobStepError> => sync(() => pick(app, owner, name, payload)).pipe(Effect.flatten); // a malformed payload is a step error, not a throw out of the scheduler

function pick(app: App, owner: string, name: string, payload: any): Effect.Effect<void, JobStepError> {
  if (name.startsWith("box:create")) return boxCreate(app, owner, payload.gen);
  if (name.startsWith("box:resume")) return boxResume(app, owner, payload.gen);
  if (name.startsWith("box:pause")) return boxPause(app, owner, payload.gen);
  if (name === "box:destroy") return boxDestroy(app, owner);
  if (name.startsWith("orphan:")) return deleteOrphan(app, payload.boxId, payload.attempt);
  if (name.startsWith("stall:")) return stallComment(app, payload.subscriptionId, payload.runUrl, payload.attempt ?? 0, name, owner);
  if (name === SNAPSHOT_JOB) return promise(() => runBuild(app, payload.attempt));
  if (name.startsWith(RUN_JOB)) return promise(() => runBuildRun(app, name.slice(RUN_JOB.length), payload.attempt));
  if (name.startsWith(FORGET_JOB)) return promise(() => forgetImage(app, payload.image, payload.attempt ?? 0));
  if (name === "sweep") return sync(() => sweep(app));
  if (name === "poll") return poll(app);
  return Effect.void;
}
