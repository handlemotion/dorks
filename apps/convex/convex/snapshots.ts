// Customer sandbox snapshots (docs/snapshots.md).
//
// A customer saves a setup script per repo (or for all repos). Saving builds an image: a throwaway box is restored from the base snapshot,
// the repo is cloned, the script runs, and the result is snapshotted. New dorks of that repo then boot from the image instead of the
// base snapshot (lifecycle.boxInfo -> core/snapshot.ts pickSnapshot), with the base snapshot as the fallback whenever no image is ready.
//
// A build is a chain of scheduled steps (`step` below) so it never holds one action open: each step does one provider call, then
// advances the row compare-and-swap and schedules the next. A build that stops advancing is failed by the `sweepBuilds` cron.
import { GithubHttpError, createInstallationToken } from "../core/github";
import { v } from "convex/values";
import { BUILD_DIR, bashCommand, clampTimeoutMinutes, cleanupScript, DEFAULT_BUILD_TIMEOUT_MIN, MAX_BUILDS_PER_DAY, MAX_IMAGES_PER_USER, outdatedReason, pickSnapshot, redactLog, runnerScript, scriptHash, validateSetupScript, verifyScript } from "../core/snapshot";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { requireUserId } from "./auth";
import { fail } from "./lib/dispatch";
import { getBox, getBuilder } from "./lib/box";
import { normalizeRepo, validRepo } from "./lib/repo";

const POLL_MS = 5_000;
const SNAPSHOT_POLL_MS = 3_000;
const STEP_BUDGET_MS = 10 * 60_000; // box creation, upload, verification and the snapshot each get this long
const SWEEP_GRACE_MS = 5 * 60_000; // a step that is this far past its deadline is not coming back
const MAX_RUNNING_BUILDS_PER_USER = 2;
const KEEP_BUILD_ROWS_MS = 30 * 24 * 3_600_000;
/** A dork may be restoring from the superseded snapshot right now, so it is deleted a while after the new one goes live (default 10 min). */
const supersededGraceMs = () => {
  const s = Number(process.env.SNAPSHOT_SUPERSEDED_GRACE_SECONDS);
  return (Number.isFinite(s) && s >= 0 && process.env.SNAPSHOT_SUPERSEDED_GRACE_SECONDS ? Math.min(s, 24 * 3600) : 600) * 1000;
};
const MAX_CLEANUP_ATTEMPTS = 6;

type Step = Doc<"snapshotBuilds">["step"];
const stepValidator = v.union(v.literal("box"), v.literal("start"), v.literal("wait"), v.literal("verify"), v.literal("snapshot"), v.literal("snapshot_wait"), v.literal("done"));

// ---------------------------------------------------------------- reads

export function imageView(image: Doc<"sandboxImages">, latest: Doc<"snapshotBuilds"> | null, currentBase: string | null | undefined, hash: string) {
  const status = latest?.status === "running" ? "building" : image.snapshotId ? "ready" : latest?.status === "failed" ? "failed" : "not_built";
  return {
    id: image._id,
    repo: image.repoDisplay,
    setupScript: image.setupScript,
    timeoutMinutes: image.timeoutMinutes,
    status: status as "building" | "ready" | "failed" | "not_built",
    /** Set when a ready image no longer matches what would be built now. It keeps being used until rebuilt. */
    outdated: image.snapshotId ? outdatedReason({ builtScriptHash: image.builtScriptHash, builtBaseSnapshotId: image.builtBaseSnapshotId, scriptHash: hash, currentBaseSnapshotId: currentBase }) : null,
    builtAt: image.builtAt ?? null,
    createdAt: image.createdAt,
    updatedAt: image.updatedAt,
    lastBuild: latest ? buildView(latest) : null,
  };
}

export const buildView = (b: Doc<"snapshotBuilds">) => ({
  id: b._id, status: b.status, step: b.step, error: b.error ?? null, log: b.logTail ?? "", startedAt: b.createdAt, finishedAt: b.finishedAt ?? null,
});

async function latestBuild(ctx: QueryCtx, imageId: Id<"sandboxImages">) {
  return ctx.db.query("snapshotBuilds").withIndex("by_image_created", (q) => q.eq("imageId", imageId)).order("desc").first();
}

async function imagesOf(ctx: QueryCtx, userId: string) {
  return ctx.db.query("sandboxImages").withIndex("by_user_repo", (q) => q.eq("userId", userId)).take(MAX_IMAGES_PER_USER + 1);
}

/**
 * The base every box of this account starts from when it has no image of its own, and every image is built on: the user's own base in their
 * own Upstash account (`userSettings.workstationSnapshotId`, built by workstation.provision). A snapshot belongs to one Upstash account, so
 * with Upstash the deployment's BASE_SNAPSHOT_ID (a snapshot of someone else's account) is never used; other providers fall back to it.
 */
export async function baseFor(ctx: QueryCtx, userId: string): Promise<string | null> {
  const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  return s?.workstationSnapshotId ?? (process.env.BOX_PROVIDER === "upstash" ? null : (process.env.BASE_SNAPSHOT_ID ?? null));
}

/** The user's saved images, newest edit first, with the state of the last build. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const base = await baseFor(ctx, userId);
    const images = (await imagesOf(ctx, userId)).sort((a, b) => b.updatedAt - a.updatedAt);
    return Promise.all(images.map(async (i) => imageView(i, await latestBuild(ctx, i._id), base, await scriptHash(i.setupScript))));
  },
});

export const builds = query({
  args: { imageId: v.id("sandboxImages") },
  handler: async (ctx, { imageId }) => {
    const userId = await requireUserId(ctx);
    const image = await ctx.db.get(imageId);
    if (!image || image.userId !== userId) return [];
    return (await ctx.db.query("snapshotBuilds").withIndex("by_image_created", (q) => q.eq("imageId", imageId)).order("desc").take(10)).map(buildView);
  },
});

/** Which image a new dork of `repo` would boot from, and why. `source`: repo | account (the user's own base) | base (the deployment's) | none. */
export const effective = query({
  args: { repo: v.string() },
  handler: async (ctx, { repo }) => {
    const userId = await requireUserId(ctx);
    if (!validRepo(repo)) fail("invalid", "repo must be owner/name");
    return { source: (await chooseSnapshot(ctx, userId, repo))?.source ?? ("none" as const) };
  },
});

/**
 * The casing a dork of `repo` must use: the image's. The image cloned the repo into `~/work/<owner>/<name>` as typed when it was saved,
 * and the bridge looks for the dork's `repo` there (file systems are case-sensitive, GitHub is not), so a differently cased dork would clone again.
 */
export async function repoNameFor(ctx: QueryCtx, userId: string, repo: string): Promise<string> {
  const image = await ctx.db.query("sandboxImages").withIndex("by_user_repo", (q) => q.eq("userId", userId).eq("repo", normalizeRepo(repo))).unique();
  return image?.repoDisplay ?? repo;
}

/** The rule behind `effective` and `lifecycle.boxInfo`: see pickSnapshot. */
export async function chooseSnapshot(ctx: QueryCtx, userId: string, repo: string) {
  const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
  const images = await imagesOf(ctx, userId);
  const choice = pickSnapshot({ repo: normalizeRepo(repo), images, accountSnapshotId: s?.workstationSnapshotId, baseSnapshotId: process.env.BOX_PROVIDER === "upstash" ? undefined : process.env.BASE_SNAPSHOT_ID });
  const image = choice?.source === "repo" ? images.find((i) => i.snapshotId === choice.snapshotId) : undefined;
  return choice ? { ...choice, imageId: image?._id } : null;
}

// ---------------------------------------------------------------- writes (the customer's API)

async function ownedImage(ctx: MutationCtx, imageId: Id<"sandboxImages">) {
  const userId = await requireUserId(ctx);
  const image = await ctx.db.get(imageId);
  if (!image || image.userId !== userId) return fail("not_found", "not found");
  return image;
}

/**
 * Creates or updates the image for a repo (`owner/name`): that repo's environment. `build` omitted: build when the saved result does not
 * match the script (nothing is built if it is already current); `true`: build now regardless; `false`: only save.
 */
export const put = mutation({
  args: { repo: v.string(), setupScript: v.string(), timeoutMinutes: v.optional(v.number()), build: v.optional(v.boolean()) },
  handler: async (ctx, { repo, setupScript, timeoutMinutes, build }) => {
    const userId = await requireUserId(ctx);
    if (!validRepo(repo)) fail("invalid", "repo must be owner/name");
    const bad = validateSetupScript(setupScript);
    if (bad) fail("invalid", bad);
    const key = normalizeRepo(repo);
    const now = Date.now();
    const timeout = clampTimeoutMinutes(timeoutMinutes);
    const existing = await ctx.db.query("sandboxImages").withIndex("by_user_repo", (q) => q.eq("userId", userId).eq("repo", key)).unique();
    let imageId: Id<"sandboxImages">;
    if (existing) {
      imageId = existing._id;
      await ctx.db.patch(imageId, { repoDisplay: repo, setupScript, timeoutMinutes: timeout, updatedAt: now });
    } else {
      if ((await imagesOf(ctx, userId)).length >= MAX_IMAGES_PER_USER) fail("limit", `at most ${MAX_IMAGES_PER_USER} images; delete one first`);
      imageId = await ctx.db.insert("sandboxImages", { userId, repo: key, repoDisplay: repo, setupScript, timeoutMinutes: timeout, createdAt: now, updatedAt: now });
    }
    const hash = await scriptHash(setupScript);
    const current = !!existing?.snapshotId && existing.builtScriptHash === hash;
    const wanted = build === undefined ? !current : build;
    if (!wanted) return { imageId, buildId: null };
    // Saving the same script again while it is already being built (a double click, a retry) joins that build instead of restarting it.
    const running = build === undefined && existing ? (await latestBuild(ctx, imageId)) : null;
    if (running?.status === "running" && running.scriptHash === hash) return { imageId, buildId: running._id };
    return { imageId, buildId: await startBuild(ctx, (await ctx.db.get(imageId))!) };
  },
});

/** Builds the saved script again (e.g. after the base snapshot changed, or to pick up new dependencies). */
export const rebuild = mutation({
  args: { imageId: v.id("sandboxImages") },
  handler: async (ctx, { imageId }) => ({ buildId: await startBuild(ctx, await ownedImage(ctx, imageId)) }),
});

export const cancel = mutation({
  args: { imageId: v.id("sandboxImages") },
  handler: async (ctx, { imageId }) => {
    await ownedImage(ctx, imageId);
    await cancelRunning(ctx, imageId, "cancelled by you");
  },
});

/** Deletes the image and its snapshot. Dorks already running keep their box; new ones fall back to the next image or the base snapshot. */
export const remove = mutation({
  args: { imageId: v.id("sandboxImages") },
  handler: async (ctx, { imageId }) => {
    const image = await ownedImage(ctx, imageId);
    await cancelRunning(ctx, imageId, "the image was deleted");
    if (image.snapshotId) await ctx.scheduler.runAfter(supersededGraceMs(), internal.snapshots.release, { userId: image.userId, snapshotIds: [image.snapshotId], attempt: 0 });
    await ctx.db.delete(imageId);
  },
});

/**
 * The user's Upstash key changed, so every image of theirs now lives in an account we no longer use: forget them all and stop the builds.
 * The old snapshots stay in the old account (we can no longer reach it). The new account has no base yet either (workstation.provision).
 */
export async function resetForNewAccount(ctx: MutationCtx, userId: string) {
  for (const image of await imagesOf(ctx, userId)) {
    await cancelRunning(ctx, image._id, "the Upstash key changed");
    await ctx.db.patch(image._id, { snapshotId: undefined, builtScriptHash: undefined, builtBaseSnapshotId: undefined, builtAt: undefined });
  }
}

// ---------------------------------------------------------------- build state machine

async function startBuild(ctx: MutationCtx, image: Doc<"sandboxImages">): Promise<Id<"snapshotBuilds">> {
  const base = await baseFor(ctx, image.userId);
  if (!base) fail("not_configured", process.env.BOX_PROVIDER === "upstash" ? "Build your sandbox image first (add your Upstash API key, then build the image)" : "No base snapshot configured");
  const now = Date.now();
  const recent = await ctx.db.query("snapshotBuilds").withIndex("by_user_created", (q) => q.eq("userId", image.userId).gt("createdAt", now - 24 * 3_600_000)).order("desc").take(MAX_BUILDS_PER_DAY + 1);
  if (recent.length >= MAX_BUILDS_PER_DAY) fail("rate_limited", `at most ${MAX_BUILDS_PER_DAY} image builds per day`);
  await cancelRunning(ctx, image._id, "replaced by a newer build");
  if (recent.filter((b) => b.status === "running" && b.imageId !== image._id).length >= MAX_RUNNING_BUILDS_PER_USER) fail("limit", `at most ${MAX_RUNNING_BUILDS_PER_USER} builds at a time`);
  const hash = await scriptHash(image.setupScript);
  const buildId = await ctx.db.insert("snapshotBuilds", {
    imageId: image._id, userId: image.userId, repo: image.repoDisplay, status: "running", step: "box", setupScript: image.setupScript, scriptHash: hash,
    baseSnapshotId: base, createdAt: now, deadline: now + STEP_BUDGET_MS,
  });
  await ctx.scheduler.runAfter(0, internal.snapshots.step, { buildId, step: "box" });
  return buildId;
}

/** Ends the image's running build (if any) and queues the cleanup of whatever it created. */
async function cancelRunning(ctx: MutationCtx, imageId: Id<"sandboxImages">, reason: string) {
  const running = await ctx.db.query("snapshotBuilds").withIndex("by_image_created", (q) => q.eq("imageId", imageId)).order("desc").take(5);
  for (const b of running.filter((x) => x.status === "running")) await finish(ctx, b, "cancelled", reason);
}

async function finish(ctx: MutationCtx, b: Doc<"snapshotBuilds">, status: "failed" | "cancelled", error: string) {
  await ctx.db.patch(b._id, { status, error, finishedAt: Date.now() });
  // Nothing of a failed build is kept: the box, and the half-made snapshot if it got that far. The image keeps its previous good snapshot.
  await ctx.scheduler.runAfter(0, internal.snapshots.release, { userId: b.userId, buildName: b._id, boxId: b.boxId, snapshotIds: b.snapshotId ? [b.snapshotId] : [], attempt: 0 });
}

export const buildForStep = internalQuery({
  args: { buildId: v.id("snapshotBuilds") },
  handler: async (ctx, { buildId }) => {
    const b = await ctx.db.get(buildId);
    if (!b) return null;
    const s = await ctx.db.query("userSettings").withIndex("by_user", (q) => q.eq("userId", b.userId)).unique();
    const image = await ctx.db.get(b.imageId);
    return { ...b, githubInstallationId: s?.githubInstallationId ?? null, timeoutMinutes: image?.timeoutMinutes ?? null };
  },
});

/** Moves a running build from `from` to `to` (compare-and-swap, so a duplicate run of a step is harmless) and schedules the next step. */
export const advance = internalMutation({
  args: {
    buildId: v.id("snapshotBuilds"), from: stepValidator, to: stepValidator, budgetMs: v.number(), delayMs: v.optional(v.number()),
    boxId: v.optional(v.string()), snapshotId: v.optional(v.string()), snapshotName: v.optional(v.string()), logTail: v.optional(v.string()),
  },
  handler: async (ctx, { buildId, from, to, budgetMs, delayMs, ...patch }) => {
    const b = await ctx.db.get(buildId);
    if (!b || b.status !== "running" || b.step !== from) return false;
    await ctx.db.patch(buildId, { step: to, deadline: Date.now() + budgetMs, ...Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined)), ...(patch.logTail !== undefined ? { logTail: redactLog(patch.logTail) } : {}) });
    await ctx.scheduler.runAfter(delayMs ?? 0, internal.snapshots.step, { buildId, step: to });
    return true;
  },
});

/** Still waiting: record the output so far and look again later. */
export const progress = internalMutation({
  args: { buildId: v.id("snapshotBuilds"), step: stepValidator, logTail: v.string(), delayMs: v.number() },
  handler: async (ctx, { buildId, step, logTail, delayMs }) => {
    const b = await ctx.db.get(buildId);
    if (!b || b.status !== "running" || b.step !== step) return;
    await ctx.db.patch(buildId, { logTail: redactLog(logTail) });
    await ctx.scheduler.runAfter(delayMs, internal.snapshots.step, { buildId, step });
  },
});

export const failBuild = internalMutation({
  args: { buildId: v.id("snapshotBuilds"), error: v.string(), logTail: v.optional(v.string()) },
  handler: async (ctx, { buildId, error, logTail }) => {
    const b = await ctx.db.get(buildId);
    if (!b || b.status !== "running") return;
    if (logTail !== undefined) await ctx.db.patch(buildId, { logTail: redactLog(logTail) }); // the provider already redacts; this is the second line
    await finish(ctx, b, "failed", redactLog(error));
  },
});

/** The snapshot is ready: it becomes the image's live snapshot, and the one it replaces is deleted after a grace period. */
export const succeed = internalMutation({
  args: { buildId: v.id("snapshotBuilds") },
  handler: async (ctx, { buildId }) => {
    const b = await ctx.db.get(buildId);
    if (!b || b.status !== "running" || b.step !== "snapshot_wait" || !b.snapshotId) return;
    const now = Date.now();
    const image = await ctx.db.get(b.imageId);
    await ctx.db.patch(buildId, { status: "succeeded", step: "done", finishedAt: now });
    if (!image) {
      // The image was deleted while this ran (remove cancels running builds, so this is a narrow race): nothing points at the snapshot.
      return void (await ctx.scheduler.runAfter(0, internal.snapshots.release, { userId: b.userId, buildName: b._id, boxId: b.boxId, snapshotIds: [b.snapshotId], attempt: 0 }));
    }
    await ctx.db.patch(image._id, { snapshotId: b.snapshotId, builtScriptHash: b.scriptHash, builtBaseSnapshotId: b.baseSnapshotId, builtAt: now });
    await ctx.scheduler.runAfter(0, internal.snapshots.release, { userId: b.userId, buildName: b._id, boxId: b.boxId, snapshotIds: [], attempt: 0 });
    if (image.snapshotId && image.snapshotId !== b.snapshotId) await ctx.scheduler.runAfter(supersededGraceMs(), internal.snapshots.release, { userId: image.userId, snapshotIds: [image.snapshotId], attempt: 0 });
  },
});

/** Cron: a build whose step never came back (the action died, the scheduler dropped it) must not stay "building" forever or hold its box. */
export const sweepBuilds = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const b of await ctx.db.query("snapshotBuilds").withIndex("by_status", (q) => q.eq("status", "running")).take(100)) {
      if (now > b.deadline + SWEEP_GRACE_MS) await finish(ctx, b, "failed", "the build stopped responding and was abandoned");
    }
    for (const b of await ctx.db.query("snapshotBuilds").withIndex("by_status", (q) => q.eq("status", "succeeded").lt("createdAt", now - KEEP_BUILD_ROWS_MS)).take(100)) await ctx.db.delete(b._id);
    for (const b of await ctx.db.query("snapshotBuilds").withIndex("by_status", (q) => q.eq("status", "failed").lt("createdAt", now - KEEP_BUILD_ROWS_MS)).take(100)) await ctx.db.delete(b._id);
  },
});

/** A snapshot an image points at is gone at the provider (deleted by hand, expired): forget it so new boxes fall back instead of failing. */
export const dropSnapshot = internalMutation({
  args: { imageId: v.id("sandboxImages"), snapshotId: v.string() },
  handler: async (ctx, { imageId, snapshotId }) => {
    const image = await ctx.db.get(imageId);
    if (image?.snapshotId === snapshotId) await ctx.db.patch(imageId, { snapshotId: undefined, builtScriptHash: undefined, builtBaseSnapshotId: undefined, builtAt: undefined });
  },
});

// ---------------------------------------------------------------- the steps (actions)

class BuildError extends Error {} // its message is written for the customer

/** What may be shown to the customer: our own messages and provider/GitHub errors (status codes only, never a response body). */
function describe(e: unknown, step: Step): string {
  const safe = e instanceof BuildError || e instanceof GithubHttpError || (e instanceof Error && ["UpstashBoxError", "BoxNotFoundError"].includes(e.name));
  console.error(`snapshot build ${step} failed`, e instanceof Error ? e.message.slice(0, 200) : "unknown");
  return safe ? (e as Error).message : `unexpected error during ${step}`;
}

export const step = internalAction({
  args: { buildId: v.id("snapshotBuilds"), step: stepValidator },
  handler: async (ctx, { buildId, step }) => {
    const b = await ctx.runQuery(internal.snapshots.buildForStep, { buildId });
    if (!b || b.status !== "running" || b.step !== step) return; // finished, cancelled, or a duplicate delivery
    try {
      await run(ctx, b, step);
    } catch (e) {
      await ctx.runMutation(internal.snapshots.failBuild, { buildId, error: describe(e, step) });
    }
  },
});

type BuildRow = Doc<"snapshotBuilds"> & { githubInstallationId: number | null; timeoutMinutes: number | null };

async function run(ctx: ActionCtx, b: BuildRow, step: Step) {
  const builder = await getBuilder(ctx, b.userId);
  const adv = (to: Step, budgetMs: number, extra: { boxId?: string; snapshotId?: string; snapshotName?: string; logTail?: string; delayMs?: number } = {}) =>
    ctx.runMutation(internal.snapshots.advance, { buildId: b._id, from: step, to, budgetMs, ...extra });
  const boxId = b.boxId;
  const need = () => boxId ?? (() => { throw new BuildError("the build box is missing"); })();

  switch (step) {
    case "box": {
      const box = await builder.createBuildBox(b.baseSnapshotId, { name: b._id });
      await adv("start", STEP_BUDGET_MS, { boxId: box.id });
      return;
    }
    case "start": {
      const timeoutMs = (b.timeoutMinutes ?? DEFAULT_BUILD_TIMEOUT_MIN) * 60_000;
      const token = await cloneToken(b);
      await builder.putFiles(need(), [
        { path: `${BUILD_DIR}/setup.sh`, content: b.setupScript.endsWith("\n") ? b.setupScript : `${b.setupScript}\n` },
        { path: `${BUILD_DIR}/run.sh`, content: runnerScript(b.repo) },
        ...(token ? [{ path: `${BUILD_DIR}/gh-token`, content: token, secret: true }] : []),
      ]);
      await builder.startRunner(need());
      await adv("wait", timeoutMs); // the script's own time limit starts now
      return;
    }
    case "wait": {
      const p = await builder.pollRunner(need());
      if (p.state === "running") {
        if (Date.now() > b.deadline) return void (await ctx.runMutation(internal.snapshots.failBuild, { buildId: b._id, error: `the setup script did not finish within its time limit`, logTail: p.log }));
        return void (await ctx.runMutation(internal.snapshots.progress, { buildId: b._id, step, logTail: p.log, delayMs: POLL_MS }));
      }
      if (p.state === "lost") return void (await ctx.runMutation(internal.snapshots.failBuild, { buildId: b._id, error: "the build box stopped before the script finished", logTail: p.log }));
      if (p.exitCode !== 0) return void (await ctx.runMutation(internal.snapshots.failBuild, { buildId: b._id, error: `the setup script failed (exit code ${p.exitCode})`, logTail: p.log }));
      await adv("verify", STEP_BUDGET_MS, { logTail: p.log });
      return;
    }
    case "verify": {
      const v1 = await builder.check(need(), bashCommand(verifyScript));
      if (v1.exitCode !== 0) throw new BuildError(`the image would not work for an agent: ${v1.output.trim().slice(0, 500) || `check exited with ${v1.exitCode}`}`);
      const v2 = await builder.check(need(), bashCommand(cleanupScript));
      if (v2.exitCode !== 0) throw new BuildError("could not clean the build box before the snapshot");
      await adv("snapshot", STEP_BUDGET_MS);
      return;
    }
    case "snapshot": {
      const name = `dorks-env-${b._id}`;
      const snap = await builder.startSnapshot(need(), name);
      await adv("snapshot_wait", STEP_BUDGET_MS, { snapshotId: snap.id, snapshotName: name, delayMs: SNAPSHOT_POLL_MS });
      return;
    }
    case "snapshot_wait": {
      const status = await builder.snapshotStatus(need(), b.snapshotId ?? "");
      if (status === "ready") return void (await ctx.runMutation(internal.snapshots.succeed, { buildId: b._id }));
      if (status === "error" || status === "missing") throw new BuildError("the provider could not create the snapshot");
      if (Date.now() > b.deadline) throw new BuildError("the snapshot was not ready in time");
      await ctx.runMutation(internal.snapshots.progress, { buildId: b._id, step, logTail: b.logTail ?? "", delayMs: SNAPSHOT_POLL_MS });
      return;
    }
    case "done":
      return;
  }
}

/**
 * Read-only token for the clone, limited to the one repo. Without the GitHub App installed there is no token and the clone is anonymous
 * (public repos only). The customer's script runs after the token file is deleted, and the snapshot is scanned for tokens before it is taken.
 */
async function cloneToken(b: BuildRow): Promise<string | null> {
  if (!b.githubInstallationId || process.env.BOX_PROVIDER === "sim") return null;
  const name = b.repo.split("/")[1];
  try {
    const env = { GITHUB_APP_ID: process.env.GITHUB_APP_ID!, GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY! };
    return (await createInstallationToken(env, b.githubInstallationId, fetch, { repositories: [name], permissions: { contents: "read" } })).token;
  } catch (e) {
    // No token of ours (App not installed on this repo, App not configured, GitHub down): the repo may still be public, so try anonymously.
    // A private repo then fails the clone, and the build log says to check the App installation.
    console.error("snapshot build: no installation token for the repo; cloning anonymously", e instanceof GithubHttpError ? e.status : "error");
    return null;
  }
}

// ---------------------------------------------------------------- cleanup

/** Deletes a build's box and snapshots. Provider deletes are idempotent; failures retry with backoff so nothing leaks silently. */
export const release = internalAction({
  args: { userId: v.string(), buildName: v.optional(v.string()), boxId: v.optional(v.string()), snapshotIds: v.array(v.string()), attempt: v.number() },
  handler: async (ctx, { userId, buildName, boxId, snapshotIds, attempt }) => {
    const left: string[] = [];
    let boxLeft: string | undefined;
    const builder = await getBuilder(ctx, userId); // the user's own account: whatever sits in another one is not ours to touch
    try {
      const id = boxId ?? (buildName ? await builder.findBuildBox(buildName) : null);
      if (id) {
        boxLeft = id;
        await (await getBox(ctx, userId)).delete(id);
        boxLeft = undefined;
      }
    } catch (e) {
      console.error("snapshot build: deleting the build box failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    }
    for (const s of snapshotIds) {
      try {
        await builder.deleteSnapshot(s);
      } catch (e) {
        console.error("snapshot build: deleting a snapshot failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
        left.push(s);
      }
    }
    if (!boxLeft && left.length === 0) return;
    if (attempt < MAX_CLEANUP_ATTEMPTS) await ctx.scheduler.runAfter(15_000 * 2 ** attempt, internal.snapshots.release, { userId, boxId: boxLeft, snapshotIds: left, attempt: attempt + 1 });
    else console.error("snapshot build cleanup gave up; remove by hand", boxLeft, left);
  },
});
