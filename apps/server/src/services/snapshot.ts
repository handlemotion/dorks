import { createHash } from "node:crypto";
import { Cause, Data, Effect } from "effect";
import { fail, touch, type App } from "../app";
import { snapshotOps, type SnapshotOps } from "../core/snapshot";
import { update } from "../db";
import { boatBuildFailureMessage } from "../lib/boatSnapshots";
import { instanceId } from "../lib/box";
import { hasTimer, setTimer } from "../lifecycle/dispatch";
import { boatKey, readSettings } from "./settings";

// "Prepare Boat": builds this install's base snapshot in the user's Boat account, one click, instead of the manual `boat` CLI steps.
//
//   create a build sandbox (no account credentials, lifetime-limited) -> wait ready -> upload the bridge bundle and installer
//   (checked by sha256) -> run the installer -> save a snapshot -> point `baseSnapshotId` at it -> delete the build sandbox.
//
// The snapshot name is per installation (`dorks-base-<8 hex of the instance id>`), so two installs on one Boat account never replace
// each other's image; rebuilding saves the same name again, which Boat replaces atomically (a failed save keeps the last good one).
// The job is one row in `timers`, claimed at-most-once like every job; a crash leaves the row `running`, and `recoverSnapshotBuild`
// re-queues it on the next start with a new attempt number. Every attempt first deletes any build sandbox it finds (the one it
// recorded, and any carrying this install's build label), so a crash never leaves a billing sandbox behind.
//
// The job is an Effect: the build sandbox is a scoped resource (`Effect.acquireRelease`), so it is deleted when the attempt ends,
// however it ends (success, failure, a newer attempt taking over, or the fiber being interrupted).

export const SNAPSHOT_JOB = "snapshot:build";

export const STEPS = [
  { id: "prepare", label: "Cleaning up earlier builds" },
  { id: "create", label: "Creating a build sandbox" },
  { id: "start", label: "Waiting for the sandbox to start" },
  { id: "upload", label: "Uploading the bridge and installer" },
  { id: "install", label: "Installing tools (about a minute)" },
  { id: "save", label: "Saving the snapshot" },
  { id: "finish", label: "Finishing up" },
] as const;
type StepId = (typeof STEPS)[number]["id"];

const INSTALL_TIMEOUT_SECONDS = 600; // Boat's cap for a synchronous command
const SAVE_POLL_MS = 3_000;
const SAVE_POLLS = 400; // about 20 minutes: a save of a running sandbox "can run minutes"
const BRIDGE_PATH = "/home/user/dorks-bridge.mjs";
const INSTALLER_PATH = "/home/user/boat-install.sh";

/** Failures whose message is already written for the person watching. */
class BuildError extends Data.TaggedError("BuildError")<{ readonly message: string }> {}
/** A newer attempt took the build over: this one stops without writing anything. */
class Superseded extends Data.TaggedError("Superseded") {}

interface BuildRow {
  status: "idle" | "running" | "failed";
  step: string | null;
  message: string | null;
  error: string | null;
  attempt: number;
  build_sandbox_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  ready_name: string | null;
  ready_bundle_id: string | null;
  ready_at: number | null;
}

const readBuild = (app: App) => app.db.get<BuildRow>("SELECT * FROM snapshot_build WHERE id = 1")!;

/** Stable per installation; lowercase letters, digits and dashes, as Boat requires. */
export const snapshotName = (app: App) =>
  `dorks-base-${instanceId(app)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 8)}`;
export const buildLabel = (app: App) =>
  createHash("sha256")
    .update(`snapshot-build\n${instanceId(app)}`)
    .digest("hex");

export interface SnapshotView {
  /** none: never built. building: a build is running. failed: the last attempt failed (a previous good snapshot may still be in use). ready: built. */
  state: "none" | "building" | "ready" | "failed";
  /** The saved snapshot this app built, or null. Sandboxes start from `settings.baseSnapshotId`; `managed` says whether that is it. */
  snapshot: string | null;
  managed: boolean;
  /** Built from an older bridge or installer than this app now carries: rebuild to update. */
  stale: boolean;
  step: StepId | null;
  stepIndex: number;
  stepCount: number;
  message: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  builtBundleId: string | null;
  currentBundleId: string | null;
  canBuild: boolean;
  cannotBuildReason: string | null;
}

export async function snapshotView(app: App): Promise<SnapshotView> {
  const row = readBuild(app);
  const settings = readSettings(app);
  let currentBundleId: string | null = null;
  let cannotBuildReason: string | null = null;
  try {
    currentBundleId = (await app.snapshotAssets()).bundleId;
  } catch (e) {
    cannotBuildReason = e instanceof Error ? e.message : "The bridge bundle is not available.";
  }
  if (!cannotBuildReason && app.cfg.boxProvider === "boat" && !settings.boatKeyEnc) cannotBuildReason = "Add your Boat API key first.";
  const managed = !!row.ready_name && settings.baseSnapshotId === row.ready_name;
  const step = row.status === "running" ? (STEPS.find((s) => s.id === row.step)?.id ?? null) : null;
  return {
    state: row.status === "running" ? "building" : row.status === "failed" ? "failed" : row.ready_name ? "ready" : "none",
    snapshot: row.ready_name,
    managed,
    stale: managed && !!currentBundleId && row.ready_bundle_id !== currentBundleId,
    step,
    stepIndex: step ? STEPS.findIndex((s) => s.id === step) : -1,
    stepCount: STEPS.length,
    message: row.status === "running" ? row.message : null,
    error: row.status === "failed" ? row.error : null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    builtBundleId: row.ready_bundle_id,
    currentBundleId,
    canBuild: !cannotBuildReason,
    cannotBuildReason,
  };
}

/**
 * Starts a build unless one is running, or the snapshot is already built from the current bridge and in use (and `force` is off).
 * Idempotent: calling it while a build runs just returns the status.
 */
export async function startBuild(app: App, opts: { force?: boolean } = {}): Promise<SnapshotView> {
  if (app.cfg.boxProvider === "boat" && !(await boatKey(app))) fail("not_configured", "Add your Boat API key first.");
  let assets;
  try {
    assets = await app.snapshotAssets();
  } catch (e) {
    fail("failed", e instanceof Error ? e.message : "The bridge bundle is not available.");
  }
  queueBuild(app, { force: opts.force, bundleId: assets.bundleId });
  return snapshotView(app);
}

/** Marks a build running and queues its job, unless one runs or the snapshot in use is current. Synchronous: one transaction. */
function queueBuild(app: App, opts: { force?: boolean; bundleId?: string }) {
  app.db.tx(() => {
    const row = readBuild(app);
    if (row.status === "running") return;
    const inUse = !!row.ready_name && readSettings(app).baseSnapshotId === row.ready_name;
    if (!opts.force && row.status !== "failed" && inUse && row.ready_bundle_id === opts.bundleId) return; // already up to date
    const attempt = row.attempt + 1;
    update(app.db, "snapshot_build", { id: 1 }, { status: "running", step: STEPS[0].id, message: STEPS[0].label, error: null, attempt, startedAt: app.now(), finishedAt: null });
    setTimer(app, "", SNAPSHOT_JOB, 0, { attempt });
    touch(app, { t: "snapshot" });
    console.error(`snapshot build queued (attempt ${attempt})`);
  });
}

/**
 * With a Boat key and no base snapshot (in Settings or `BASE_SNAPSHOT_ID`), queue the build, so onboarding needs no "Prepare Boat"
 * step. Called after a Boat key is saved (`retryFailed`: a new key is the owner's answer to a failed build) and on every start,
 * which never retries a failure by itself (a build can cost money). If the bridge bundle is missing the job fails and
 * `snapshotView` says why.
 */
export function buildIfMissing(app: App, opts: { retryFailed?: boolean } = {}): void {
  const s = readSettings(app);
  if (s.baseSnapshotId ?? app.cfg.baseSnapshotId) return;
  if (!s.boatKeyEnc) return; // also with simulated sandboxes: the build follows the owner's Boat step, never a bare start
  if (readBuild(app).status === "failed" && !opts.retryFailed) return;
  queueBuild(app, {});
}

/**
 * After a restart: a build that was running when the process died is queued again, as a new attempt. A Boat key saved with no
 * snapshot and no build yet (the process stopped between saving the key and queueing the build) starts one now.
 */
export function recoverSnapshotBuild(app: App) {
  const row = readBuild(app);
  if (row.status === "idle") return buildIfMissing(app);
  if (row.status !== "running" || hasTimer(app, "", SNAPSHOT_JOB)) return;
  const attempt = row.attempt + 1;
  update(app.db, "snapshot_build", { id: 1 }, { attempt });
  setTimer(app, "", SNAPSHOT_JOB, 0, { attempt });
}

// ---------------------------------------------------------------- the job
/** Moves the build to `step`, or fails with `Superseded` when a newer attempt took it over. */
const progress = (app: App, attempt: number, step: StepId) =>
  Effect.suspend(() => {
    const label = STEPS.find((s) => s.id === step)!.label;
    const current = app.db.tx(() => {
      const row = readBuild(app);
      if (row.status !== "running" || row.attempt !== attempt) return false;
      update(app.db, "snapshot_build", { id: 1 }, { step, message: label });
      touch(app, { t: "snapshot" });
      return true;
    });
    return current ? Effect.void : Effect.fail(new Superseded());
  });

const tail = (s: string) => {
  const t = s.trim().split("\n").slice(-4).join(" ").replace(/\s+/g, " ");
  return t ? t.slice(-300) : "";
};

/** A Promise from outside Effect (the app's seams), failing with what it rejects with. */
const fromPromise = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => e });

/** The `snapshot:build` job (Promise edge for lifecycle/jobs.ts). */
export function runBuild(app: App, attempt: number): Promise<void> {
  return Effect.runPromise(buildJob(app, attempt));
}

/** One attempt of the build. Never fails: a failure is recorded on the build row, for the person watching. */
export const buildJob = (app: App, attempt: number): Effect.Effect<void> =>
  Effect.suspend(() => {
    const first = readBuild(app);
    if (first.status !== "running" || first.attempt !== attempt) return Effect.void; // superseded or cancelled
    // The failure is recorded before the scope closes: the person sees it while the sandbox is still being deleted, as before.
    return buildSteps(app, attempt, first).pipe(
      Effect.catchCause((cause) => recordFailure(app, attempt, cause)),
      Effect.scoped,
    );
  });

const buildSteps = Effect.fnUntraced(function* (app: App, attempt: number, first: BuildRow) {
  const label = buildLabel(app);
  const name = snapshotName(app);
  const driver = snapshotOps(yield* fromPromise(() => app.getSnapshotDriver()));
  const assets = yield* fromPromise(() => app.snapshotAssets());

  yield* progress(app, attempt, "prepare");
  yield* removeBuildSandboxes(app, driver, label, first.build_sandbox_id);

  yield* progress(app, attempt, "create");
  const sandboxId = yield* buildSandbox(app, driver, label, attempt);

  yield* progress(app, attempt, "start");
  yield* driver.waitReady(sandboxId);

  yield* progress(app, attempt, "upload");
  yield* driver.writeFile(sandboxId, BRIDGE_PATH, Buffer.from(assets.bridge).toString("base64"), "base64");
  yield* driver.writeFile(sandboxId, INSTALLER_PATH, assets.installer, "utf8");
  const check = yield* driver.run(sandboxId, `echo "${assets.bridgeSha256}  ${BRIDGE_PATH}" | sha256sum -c -`, 60);
  if (check.exitCode !== 0) return yield* new BuildError({ message: "The uploaded bridge did not match its checksum. Retry the build." });

  yield* progress(app, attempt, "install");
  const install = yield* driver.run(sandboxId, `cd /home/user && DORKS_BUNDLE_ID=${assets.bundleId} bash boat-install.sh`, INSTALL_TIMEOUT_SECONDS);
  if (install.timedOut) return yield* new BuildError({ message: "The installer did not finish in 10 minutes." });
  if (install.exitCode !== 0) return yield* new BuildError({ message: `The installer failed (exit ${install.exitCode ?? "unknown"}). ${tail(install.stderr || install.stdout)}`.trim() });

  yield* progress(app, attempt, "save");
  yield* driver.saveSnapshot(sandboxId, name);
  yield* waitSaved(app, driver, name, sandboxId);

  yield* progress(app, attempt, "finish");
  yield* finishBuild(app, attempt, name, assets.bundleId);
  console.error(`snapshot build ready: ${name}`);
});

/** The build sandbox, deleted when the attempt's scope closes. Its id is recorded first, so a crash cannot lose track of it. */
const buildSandbox = (app: App, driver: SnapshotOps, label: string, attempt: number) =>
  Effect.acquireRelease(
    driver.createBuildSandbox({ name: "dorks-base-build", label, key: `dorks-build-${label.slice(0, 16)}-${attempt}` }).pipe(
      Effect.map(({ id }) => id),
      Effect.tap((id) => Effect.sync(() => app.db.tx(() => update(app.db, "snapshot_build", { id: 1 }, { buildSandboxId: id })))),
    ),
    // Whatever happened, the build sandbox must not keep billing.
    (id) => removeBuildSandbox(app, driver, id),
  );

const finishBuild = (app: App, attempt: number, name: string, bundleId: string) =>
  Effect.suspend(() => {
    const current = app.db.tx(() => {
      const row = readBuild(app);
      if (row.attempt !== attempt) return false;
      const now = app.now();
      update(app.db, "snapshot_build", { id: 1 }, { status: "idle", step: null, message: null, error: null, finishedAt: now, readyName: name, readyBundleId: bundleId, readyAt: now });
      update(app.db, "settings", { id: 1 }, { baseSnapshotId: name });
      touch(app, { t: "settings" });
      touch(app, { t: "snapshot" });
      return true;
    });
    return current ? Effect.void : Effect.fail(new Superseded());
  });

/** Marks the attempt failed with a message for the person watching, unless it was superseded or interrupted. */
function recordFailure(app: App, attempt: number, cause: Cause.Cause<unknown>): Effect.Effect<void> {
  if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
  const e = Cause.squash(cause);
  if (e instanceof Superseded) return Effect.void;
  return Effect.sync(() => {
    console.error("snapshot build failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    const message = e instanceof BuildError ? e.message : boatBuildFailureMessage(e);
    app.db.tx(() => {
      const row = readBuild(app);
      if (row.attempt !== attempt) return;
      update(app.db, "snapshot_build", { id: 1 }, { status: "failed", step: null, message: null, error: message, finishedAt: app.now() });
      touch(app, { t: "snapshot" });
    });
  });
}

const waitSaved = Effect.fnUntraced(function* (app: App, driver: SnapshotOps, name: string, sandboxId: string) {
  for (let i = 0; i < SAVE_POLLS; i++) {
    const info = yield* driver.getSnapshot(name);
    // Re-saving a name replaces the old artifact only once the new one is ready: trust the status of OUR save, not of the old one.
    if (info?.sourceSandboxId === sandboxId) {
      if (info.status === "ready") return;
      if (info.status === "failed") return yield* new BuildError({ message: `Boat could not save the snapshot: ${(info.error ?? "no reason given").slice(0, 200)}` });
    }
    yield* Effect.promise(() => app.sleep(SAVE_POLL_MS));
  }
  return yield* new BuildError({ message: "Boat took too long to save the snapshot. Check Boat, then retry." });
});

/** Deletes one build sandbox; if Boat will not, retries in the background (the `orphan:` job) so it cannot leak silently. */
const removeBuildSandbox = (app: App, driver: SnapshotOps, id: string) =>
  driver.deleteSandbox(id).pipe(
    Effect.andThen(Effect.sync(() => app.db.tx(() => app.db.run("UPDATE snapshot_build SET build_sandbox_id = NULL WHERE id = 1 AND build_sandbox_id = ?", id)))),
    Effect.catch((e) =>
      Effect.sync(() => {
        console.error("could not delete the build sandbox; retrying", e instanceof Error ? e.message.slice(0, 200) : "unknown");
        setTimer(app, "", `orphan:${id}`, 15_000, { boxId: id, attempt: 1 });
      }),
    ),
  );

const removeBuildSandboxes = Effect.fnUntraced(function* (app: App, driver: SnapshotOps, label: string, recorded: string | null) {
  const ids = new Set<string>(recorded ? [recorded] : []);
  for (const b of yield* driver.listBuildSandboxes(label)) ids.add(b.id);
  for (const id of ids) yield* removeBuildSandbox(app, driver, id);
});
