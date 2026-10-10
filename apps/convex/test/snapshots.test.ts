/// <reference types="vite/client" />
// @vitest-environment edge-runtime
// The build state machine, the API and the way dorks pick an image, with the sandbox provider replaced by a scripted fake.
// (The same flow against a real Upstash account is scripts/snapshots-e2e.mjs.)
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { MAX_BUILDS_PER_DAY, MAX_IMAGES_PER_USER, type ScriptPoll } from "../core/snapshot";

const fake = vi.hoisted(() => ({
  polls: [] as unknown[],
  checks: [] as { exitCode: number; output: string }[],
  snapshotStatuses: [] as string[],
  calls: [] as string[],
  files: [] as { path: string; content: string; secret?: boolean }[],
  deletedBoxes: [] as string[],
  deletedSnapshots: [] as string[],
  failDelete: new Set<string>(),
  createFailsFor: new Set<string>(),
  notReady: new Set<string>(),
  throwOnCreate: null as null | Error,
  createFailsWith: null as null | Error,
  created: [] as { snapshot: string; name: string }[],
}));
const last = <T,>(a: T[], dflt: T): T => (a.length > 1 ? a.shift()! : (a[0] ?? dflt));

vi.mock("../convex/lib/box", () => ({
  getBox: () => ({
    async createFromSnapshot(snapshot: string, o: { name: string }) {
      fake.created.push({ snapshot, name: o.name });
      if (fake.createFailsFor.has(snapshot)) throw fake.createFailsWith ?? new (await import("../core/box")).BoxNotFoundError("snapshot gone");
      return { id: `box-${o.name}` };
    },
    async resume() {},
    async pause() {},
    async delete(id: string) {
      fake.calls.push(`deleteBox:${id}`);
      fake.deletedBoxes.push(id);
    },
  }),
  getBuilder: () => ({
    async createBuildBox(base: string, o: { name: string }) {
      fake.calls.push(`create:${base}`);
      if (fake.throwOnCreate) throw fake.throwOnCreate;
      return { id: `bb-${o.name}` };
    },
    async findBuildBox(name: string) {
      return `bb-${name}`;
    },
    async putFiles(_b: string, files: { path: string; content: string; secret?: boolean }[]) {
      fake.calls.push("put");
      fake.files.push(...files);
    },
    async startRunner() {
      fake.calls.push("start");
    },
    async pollRunner() {
      fake.calls.push("poll");
      return last(fake.polls as ScriptPoll[], { state: "done", exitCode: 0, log: "ok" });
    },
    async check(_b: string, command: string) {
      fake.calls.push(command.includes("tools.before") ? "verify" : "cleanup");
      return command.includes("tools.before") ? last(fake.checks, { exitCode: 0, output: "" }) : { exitCode: 0, output: "" };
    },
    async startSnapshot(_b: string, name: string) {
      fake.calls.push("snapshot");
      return { id: `snap-${name}` };
    },
    async snapshotStatus() {
      fake.calls.push("snapshotStatus");
      return last(fake.snapshotStatuses, "ready");
    },
    async snapshotReady(id: string) {
      return !fake.notReady.has(id);
    },
    async deleteSnapshot(id: string) {
      if (fake.failDelete.has(id)) throw new Error("provider down");
      fake.deletedSnapshots.push(id);
    },
  }),
}));

// Auth is the better-auth component (covered by scripts/e2e.mjs); here the identity subject is the user id.
vi.mock("../convex/auth", () => ({
  requireUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) => {
    const id = await ctx.auth.getUserIdentity();
    if (!id) throw new Error("Unauthenticated");
    return id.subject;
  },
}));

const modules = import.meta.glob("../convex/**/*.*s");
const code = (e: unknown) => (e as { data?: { code?: string } }).data?.code;
const rejects = async (p: Promise<unknown>) => p.then(() => undefined, (e) => code(e));

const setup = async (settings: Record<string, unknown> = {}) => {
  const t = convexTest(schema, modules);
  await t.run((ctx) => ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5, claudeTokenEnc: "enc", ...settings }));
  return { t, u1: t.withIdentity({ subject: "u1" }), u2: t.withIdentity({ subject: "u2" }) };
};
type S = Awaited<ReturnType<typeof setup>>;
const settle = (t: S["t"]) => t.finishAllScheduledFunctions(vi.runAllTimers);
const imageOf = (u: S["u1"], id: Id<"sandboxImages">) => u.query(api.snapshots.list, {}).then((l) => l.find((i) => i.id === id)!);
const buildRow = (t: S["t"], id: Id<"snapshotBuilds">) => t.run((ctx) => ctx.db.get(id));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
  Object.assign(fake, { polls: [], checks: [], snapshotStatuses: [], calls: [], files: [], deletedBoxes: [], deletedSnapshots: [], created: [] });
  fake.failDelete.clear();
  fake.createFailsFor.clear();
  fake.notReady.clear();
  fake.throwOnCreate = null;
  fake.createFailsWith = null;
  process.env.BASE_SNAPSHOT_ID = "base-1";
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3210";
  delete process.env.GITHUB_APP_ID;
  delete process.env.SNAPSHOT_SUPERSEDED_GRACE_SECONDS;
});
afterEach(() => vi.useRealTimers());

describe("snapshots.put", () => {
  it("validates the repo and the script", async () => {
    const { u1 } = await setup();
    for (const repo of ["./x", "o/..", "no-slash", "a b/c", ""]) expect(await rejects(u1.mutation(api.snapshots.put, { repo, setupScript: "true" }))).toBe("invalid");
    expect(await rejects(u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: " " }))).toBe("invalid");
    expect(await rejects(u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "x".repeat(16 * 1024 + 1) }))).toBe("invalid");
    expect(await u1.query(api.snapshots.list, {})).toEqual([]);
  });

  it("creates the image once per repo (any casing), keeps GitHub's casing, and builds", async () => {
    const { t, u1 } = await setup();
    const a = await u1.mutation(api.snapshots.put, { repo: "Octo/Repo", setupScript: "npm ci" });
    expect(a.buildId).not.toBeNull();
    const b = await u1.mutation(api.snapshots.put, { repo: "octo/repo", setupScript: "npm ci && npm run build", build: false });
    expect(b.imageId).toBe(a.imageId);
    expect(b.buildId).toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("sandboxImages").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repo: "octo/repo", repoDisplay: "octo/repo", setupScript: "npm ci && npm run build" });
    expect((await imageOf(u1, a.imageId)).repo).toBe("octo/repo");
  });

  it("saving the same script again while it builds joins that build; a forced build replaces it", async () => {
    const { t, u1 } = await setup();
    const a = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "v1" });
    const again = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "v1" });
    expect(again).toEqual(a);
    const forced = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "v1", build: true });
    expect(forced.buildId).not.toBe(a.buildId);
    expect((await buildRow(t, a.buildId!))!.status).toBe("cancelled");
    const edited = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "v2" });
    expect(edited.buildId).not.toBe(forced.buildId); // a different script is a different build
  });

  it("caps images per user and the timeout", async () => {
    const { t, u1 } = await setup();
    for (let i = 0; i < MAX_IMAGES_PER_USER; i++) await u1.mutation(api.snapshots.put, { repo: `o/r${i}`, setupScript: "true", build: false });
    expect(await rejects(u1.mutation(api.snapshots.put, { repo: "o/one-more", setupScript: "true", build: false }))).toBe("limit");
    await u1.mutation(api.snapshots.put, { repo: "o/r0", setupScript: "true", timeoutMinutes: 9999, build: false }); // updating an existing one is fine at the cap
    expect((await t.run((ctx) => ctx.db.query("sandboxImages").first()))!.timeoutMinutes).toBe(30);
  });

  it("refuses to build without a base snapshot", async () => {
    delete process.env.BASE_SNAPSHOT_ID;
    const { u1 } = await setup();
    expect(await rejects(u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true" }))).toBe("not_configured");
    // saving without building is still fine
    expect((await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true", build: false })).buildId).toBeNull();
  });

  it("builds the user's own snapshot override when they have one", async () => {
    const { t, u1 } = await setup({ workstationSnapshotId: "mine-1" });
    const { buildId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true" });
    expect((await buildRow(t, buildId!))!.baseSnapshotId).toBe("mine-1");
  });
});

describe("a build that succeeds", () => {
  it("runs the steps in order and makes the snapshot the image's live one", async () => {
    const { t, u1 } = await setup();
    fake.polls = [{ state: "running", log: "installing" }, { state: "running", log: "still installing" }, { state: "done", exitCode: 0, log: "all done" }];
    fake.snapshotStatuses = ["creating", "ready"];
    const { imageId, buildId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "npm ci" });
    expect((await imageOf(u1, imageId)).status).toBe("building");
    await settle(t);

    const image = await imageOf(u1, imageId);
    expect(image).toMatchObject({ status: "ready", outdated: null, lastBuild: { status: "succeeded", step: "done", log: "all done", error: null } });
    const row = (await t.run((ctx) => ctx.db.get(imageId)))!;
    expect(row.snapshotId).toBe(`snap-dorks-env-${buildId}`);
    expect(row.builtBaseSnapshotId).toBe("base-1");
    expect(fake.calls.filter((c) => !c.startsWith("deleteBox"))).toEqual(["create:base-1", "put", "start", "poll", "poll", "poll", "verify", "cleanup", "snapshot", "snapshotStatus", "snapshotStatus"]);
    expect(fake.deletedBoxes).toEqual([`bb-${buildId}`]); // the build box is deleted once the snapshot exists
    expect(fake.files.map((f) => f.path).sort()).toEqual(["/tmp/dorks-build/run.sh", "/tmp/dorks-build/setup.sh"]); // no token: no GitHub App installed
    expect(fake.files.find((f) => f.path.endsWith("setup.sh"))!.content).toBe("npm ci\n");
    expect(fake.files.find((f) => f.path.endsWith("run.sh"))!.content).toContain("https://github.com/o/r.git");
  });

  it("uses the image for new dorks of the repo and the base for others", async () => {
    const { t, u1 } = await setup({ githubInstallationId: 1 });
    const { buildId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true" });
    await settle(t);
    const dork = (repo: string) => t.run((ctx) => ctx.db.insert("dorks", { userId: "u1", title: "t", repo, branch: "b", state: "creating", archived: false, lastActivityAt: 1 }));
    const info = (id: Id<"dorks">) => t.query(internal.lifecycle.boxInfo, { dorkId: id });
    expect(await info(await dork("O/R"))).toMatchObject({ snapshotId: `snap-dorks-env-${buildId}`, snapshotSource: "repo" });
    expect(await info(await dork("o/other"))).toMatchObject({ snapshotId: "base-1", snapshotSource: "base", imageId: null });
    expect(await u1.query(api.snapshots.effective, { repo: "o/R" })).toEqual({ source: "repo" });
    expect(await u1.query(api.snapshots.effective, { repo: "o/other" })).toEqual({ source: "base" });
  });

  it("an image for all repos applies to every repo without an image of its own", async () => {
    const { t, u1 } = await setup();
    await u1.mutation(api.snapshots.put, { repo: "*", setupScript: "sudo apt-get install -y jq" });
    await u1.mutation(api.snapshots.put, { repo: "o/special", setupScript: "true" });
    await settle(t);
    expect(await u1.query(api.snapshots.effective, { repo: "any/thing" })).toEqual({ source: "default" });
    expect(await u1.query(api.snapshots.effective, { repo: "o/special" })).toEqual({ source: "repo" });
    expect(fake.files.find((f) => f.content.includes("apt-get"))).toBeDefined();
    expect(fake.files.filter((f) => f.path.endsWith("run.sh")).some((f) => !f.content.includes("git clone"))).toBe(true); // the all-repos image clones nothing
  });

  it("a dork keeps the image's repo casing, so it finds the clone that was baked in", async () => {
    const { u1 } = await setup({ githubInstallationId: 1 });
    await u1.mutation(api.snapshots.put, { repo: "Acme/Widget-API", setupScript: "true", build: false });
    const id = await u1.mutation(api.dorks.create, { repo: "acme/widget-api", message: "hi" });
    expect((await u1.query(api.dorks.get, { dorkId: id }))!.repo).toBe("Acme/Widget-API");
    const other = await u1.mutation(api.dorks.create, { repo: "Some/Other", message: "hi" });
    expect((await u1.query(api.dorks.get, { dorkId: other }))!.repo).toBe("Some/Other");
  });

  it("saving the same script when the image is current builds nothing; a different script rebuilds and the old snapshot goes after the grace period", async () => {
    const { t, u1 } = await setup();
    const first = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "v1" });
    await settle(t);
    const again = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "v1" });
    expect(again.buildId).toBeNull();
    const forced = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "v1", build: true });
    expect(forced.buildId).not.toBeNull();
    await settle(t);

    const second = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "v2" });
    expect((await imageOf(u1, first.imageId)).outdated).toBe("script_changed"); // visible while the rebuild runs
    fake.deletedSnapshots.length = 0;
    await settle(t);
    const row = (await t.run((ctx) => ctx.db.get(first.imageId)))!;
    expect(row.snapshotId).toBe(`snap-dorks-env-${second.buildId}`);
    // the grace period is a scheduled delay: runAllTimers fires it
    expect(fake.deletedSnapshots).toContain(`snap-dorks-env-${forced.buildId}`);
    expect(fake.deletedSnapshots).not.toContain(`snap-dorks-env-${second.buildId}`);
    expect(await imageOf(u1, first.imageId)).toMatchObject({ status: "ready", outdated: null });
  });

  it("a changed base snapshot marks the image outdated but keeps serving it", async () => {
    const { t, u1 } = await setup();
    const { imageId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true" });
    await settle(t);
    process.env.BASE_SNAPSHOT_ID = "base-2";
    expect(await imageOf(u1, imageId)).toMatchObject({ status: "ready", outdated: "base_changed" });
    expect(await u1.query(api.snapshots.effective, { repo: "o/r" })).toEqual({ source: "repo" });
    await u1.mutation(api.snapshots.rebuild, { imageId });
    await settle(t);
    expect((await imageOf(u1, imageId)).outdated).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(imageId)))!.builtBaseSnapshotId).toBe("base-2");
  });
});

describe("a build that fails", () => {
  const failing = async (arrange: () => void) => {
    const { t, u1 } = await setup();
    const ok = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "v1" });
    await settle(t);
    const goodSnapshot = (await t.run((ctx) => ctx.db.get(ok.imageId)))!.snapshotId;
    Object.assign(fake, { calls: [], deletedBoxes: [], deletedSnapshots: [] });
    arrange();
    const bad = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "v2" });
    await settle(t);
    return { t, u1, ok, bad, goodSnapshot, view: await imageOf(u1, ok.imageId) };
  };

  it("script exits non-zero: the error and log are kept, the box is deleted, the previous image keeps serving", async () => {
    const { view, goodSnapshot, t, ok, bad } = await failing(() => (fake.polls = [{ state: "done", exitCode: 2, log: `boom ghs_${"q".repeat(30)}` }]));
    expect(view).toMatchObject({ status: "ready", outdated: "script_changed", lastBuild: { status: "failed", error: "the setup script failed (exit code 2)" } });
    expect(view.lastBuild!.log).toContain("boom");
    expect(view.lastBuild!.log).not.toContain("ghs_qqqq");
    expect((await t.run((ctx) => ctx.db.get(ok.imageId)))!.snapshotId).toBe(goodSnapshot);
    expect(fake.deletedBoxes).toEqual([`bb-${bad.buildId}`]);
    expect(fake.calls).not.toContain("snapshot");
  });

  it("verification fails: the reason is shown and no snapshot is taken", async () => {
    const { view } = await failing(() => (fake.checks = [{ exitCode: 1, output: "tool changed: claude was /usr/bin/claude, now missing" }]));
    expect(view.lastBuild).toMatchObject({ status: "failed", step: "verify" });
    expect(view.lastBuild!.error).toContain("would not work for an agent");
    expect(view.lastBuild!.error).toContain("claude was /usr/bin/claude");
    expect(fake.calls).not.toContain("snapshot");
  });

  it("the build box vanished: reported as such", async () => {
    const { view } = await failing(() => (fake.polls = [{ state: "lost", log: "" }]));
    expect(view.lastBuild!.error).toMatch(/stopped before the script finished/);
  });

  it("the snapshot errors at the provider: the half-made snapshot is deleted", async () => {
    const { view, bad } = await failing(() => (fake.snapshotStatuses = ["creating", "error"]));
    expect(view.lastBuild).toMatchObject({ status: "failed", error: "the provider could not create the snapshot" });
    expect(fake.deletedSnapshots).toEqual([`snap-dorks-env-${bad.buildId}`]);
  });

  it("a failing first build leaves the image not built, and dorks keep booting from the base snapshot", async () => {
    const { t, u1 } = await setup();
    fake.polls = [{ state: "done", exitCode: 1, log: "" }];
    const { imageId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "false" });
    await settle(t);
    expect(await imageOf(u1, imageId)).toMatchObject({ status: "failed", outdated: null });
    expect(await u1.query(api.snapshots.effective, { repo: "o/r" })).toEqual({ source: "base" });
  });

  it("an unexpected error shows a generic message, a provider error shows its status-only message", async () => {
    const { t, u1 } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.throwOnCreate = new Error("connection string postgres://admin:hunter2@db");
    const a = await u1.mutation(api.snapshots.put, { repo: "o/a", setupScript: "true" });
    await settle(t);
    expect((await imageOf(u1, a.imageId)).lastBuild).toMatchObject({ status: "failed", error: "unexpected error during box" });
    fake.throwOnCreate = Object.assign(new Error("upstash create: HTTP 500"), { name: "UpstashBoxError" });
    const b = await u1.mutation(api.snapshots.put, { repo: "o/b", setupScript: "true" });
    await settle(t);
    expect((await imageOf(u1, b.imageId)).lastBuild!.error).toBe("upstash create: HTTP 500");
  });

  it("the sweeper fails a build whose step never came back, and deletes its box", async () => {
    const { t, u1 } = await setup();
    const { imageId, buildId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true" });
    await t.run((ctx) => ctx.db.patch(buildId!, { step: "wait", boxId: "bb-stuck", deadline: Date.now() - 10 * 60_000 })); // the chain is lost: nothing is scheduled any more
    // drop the build's already scheduled first step so only the sweeper acts
    await t.run(async (ctx) => { for (const s of await ctx.db.system.query("_scheduled_functions").collect()) await ctx.scheduler.cancel(s._id); });
    await t.mutation(internal.snapshots.sweepBuilds, {});
    await settle(t);
    expect(await imageOf(u1, imageId)).toMatchObject({ status: "failed", lastBuild: { status: "failed", error: "the build stopped responding and was abandoned" } });
    expect(fake.deletedBoxes).toContain("bb-stuck");
  });

  it("cleanup retries a provider failure, then gives up quietly", async () => {
    const { t } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.failDelete.add("snap-x");
    await t.action(internal.snapshots.release, { snapshotIds: ["snap-x", "snap-y"], attempt: 0 });
    expect(fake.deletedSnapshots).toEqual(["snap-y"]);
    fake.failDelete.clear();
    await settle(t); // the retry is scheduled with backoff
    expect(fake.deletedSnapshots).toEqual(["snap-y", "snap-x"]);
  });
});

describe("limits", () => {
  it("at most 10 builds per rolling day, then it frees up", async () => {
    const { t, u1 } = await setup();
    for (let i = 0; i < MAX_BUILDS_PER_DAY; i++) {
      await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: `v${i}` });
      await settle(t);
    }
    expect(await rejects(u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "one too many" }))).toBe("rate_limited");
    vi.setSystemTime(new Date("2026-10-11T12:01:00Z"));
    await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "next day" });
  });

  it("at most 2 builds at a time per user; a rebuild of the same image replaces its running build instead", async () => {
    const { t, u1 } = await setup();
    const a = await u1.mutation(api.snapshots.put, { repo: "o/a", setupScript: "true" });
    await u1.mutation(api.snapshots.put, { repo: "o/b", setupScript: "true" });
    expect(await rejects(u1.mutation(api.snapshots.put, { repo: "o/c", setupScript: "true" }))).toBe("limit");
    const again = await u1.mutation(api.snapshots.rebuild, { imageId: a.imageId });
    expect((await buildRow(t, a.buildId!))!.status).toBe("cancelled");
    expect((await buildRow(t, again.buildId))!.status).toBe("running");
  });
});

describe("cancel, remove and ownership", () => {
  it("cancel ends the running build and deletes its box; the step already in flight does nothing", async () => {
    const { t, u1 } = await setup();
    fake.polls = [{ state: "running", log: "" }];
    const { imageId, buildId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "sleep 600" });
    await t.finishInProgressScheduledFunctions();
    await u1.mutation(api.snapshots.cancel, { imageId });
    await settle(t);
    expect(await buildRow(t, buildId!)).toMatchObject({ status: "cancelled", error: "cancelled by you" });
    expect(fake.deletedBoxes).toContain(`bb-${buildId}`);
    expect(fake.calls).not.toContain("snapshot");
  });

  it("remove deletes the image, its builds' box and (after the grace period) its snapshot", async () => {
    const { t, u1 } = await setup();
    const { imageId, buildId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true" });
    await settle(t);
    fake.deletedSnapshots.length = 0;
    await u1.mutation(api.snapshots.remove, { imageId });
    await settle(t);
    expect(await u1.query(api.snapshots.list, {})).toEqual([]);
    expect(fake.deletedSnapshots).toEqual([`snap-dorks-env-${buildId}`]);
    expect(await u1.query(api.snapshots.effective, { repo: "o/r" })).toEqual({ source: "base" });
  });

  it("another user can neither see nor change an image", async () => {
    const { t, u1, u2 } = await setup();
    const { imageId, buildId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "secret-ish script" });
    await settle(t);
    expect(await u2.query(api.snapshots.list, {})).toEqual([]);
    expect(await u2.query(api.snapshots.builds, { imageId })).toEqual([]);
    for (const op of ["rebuild", "cancel", "remove"] as const) expect(await rejects(u2.mutation(api.snapshots[op], { imageId }))).toBe("not_found");
    await expect(t.mutation(api.snapshots.rebuild, { imageId })).rejects.toThrow(); // not signed in
    expect(await u1.query(api.snapshots.list, {})).toHaveLength(1);
    expect((await u1.query(api.snapshots.builds, { imageId })).map((b) => b.id)).toEqual([buildId]);
    // one user's image never applies to another user's dorks
    expect(await u2.query(api.snapshots.effective, { repo: "o/r" })).toEqual({ source: "base" });
  });

  it("the client never sees snapshot ids, box ids or the token", async () => {
    const { t, u1 } = await setup({ githubInstallationId: 5 });
    const { imageId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true" });
    await settle(t);
    const seen = JSON.stringify([await u1.query(api.snapshots.list, {}), await u1.query(api.snapshots.builds, { imageId })]);
    expect(seen).not.toMatch(/snap-dorks-env|bb-|boxId|snapshotId/);
  });
});

describe("duplicate and stale steps", () => {
  it("a step delivered twice, or for a finished build, does nothing", async () => {
    const { t, u1 } = await setup();
    const { buildId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true" });
    await t.action(internal.snapshots.step, { buildId: buildId!, step: "box" });
    await t.action(internal.snapshots.step, { buildId: buildId!, step: "box" }); // the row already moved on
    expect(fake.calls.filter((c) => c.startsWith("create:"))).toHaveLength(1);
    await settle(t);
    const calls = fake.calls.length;
    await t.action(internal.snapshots.step, { buildId: buildId!, step: "wait" }); // finished
    expect(fake.calls).toHaveLength(calls);
  });
});

describe("a deleted image snapshot", () => {
  it("dropSnapshot forgets only the matching snapshot", async () => {
    const { t, u1 } = await setup();
    const { imageId, buildId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true" });
    await settle(t);
    await t.mutation(internal.snapshots.dropSnapshot, { imageId, snapshotId: "something-else" });
    expect((await imageOf(u1, imageId)).status).toBe("ready");
    await t.mutation(internal.snapshots.dropSnapshot, { imageId, snapshotId: `snap-dorks-env-${buildId}` });
    expect(await imageOf(u1, imageId)).toMatchObject({ status: "not_built", builtAt: null });
  });

  it("creating a box falls back to the next snapshot when the image's is gone at the provider", async () => {
    const { t, u1 } = await setup({ githubInstallationId: 1 });
    const { imageId, buildId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true" });
    await settle(t);
    const image = `snap-dorks-env-${buildId}`;
    fake.createFailsFor.add(image);
    fake.notReady.add(image);
    const dorkId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "o/r", branch: "b", state: "creating", archived: false, lastActivityAt: 1 });
      await ctx.db.insert("dorkRuntime", { dorkId: id, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: 0, bridgeLost: false, timers: {} });
      return id;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await t.action(internal.boxes.create, { dorkId, gen: 0 });
    expect(fake.created.map((c) => c.snapshot)).toEqual([image, "base-1"]);
    expect((await t.run((ctx) => ctx.db.get(dorkId)))!.boxId).toBe(`box-${dorkId}`);
    expect(await imageOf(u1, imageId)).toMatchObject({ status: "not_built" });
  });

  it("Upstash answers 400 for a deleted snapshot: confirmed against the snapshot list before falling back", async () => {
    const { t, u1 } = await setup({ githubInstallationId: 1 });
    const { imageId, buildId } = await u1.mutation(api.snapshots.put, { repo: "o/r", setupScript: "true" });
    await settle(t);
    const image = `snap-dorks-env-${buildId}`;
    const newDork = () => t.run(async (ctx) => {
      const id = await ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "o/r", branch: "b", state: "creating", archived: false, lastActivityAt: 1 });
      await ctx.db.insert("dorkRuntime", { dorkId: id, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: 0, bridgeLost: false, timers: {} });
      return id;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.createFailsFor.add(image);
    fake.createFailsWith = Object.assign(new Error("upstash create: HTTP 400"), { name: "UpstashBoxError", status: 400 });

    // 400, but the snapshot is there and ready: something else is wrong, so the create fails and the image is left alone
    const failing = await newDork();
    await t.action(internal.boxes.create, { dorkId: failing, gen: 0 });
    expect((await t.run((ctx) => ctx.db.get(failing)))!.boxId).toBeUndefined();
    expect((await imageOf(u1, imageId)).status).toBe("ready");

    // 400 and the snapshot is gone: forget it and start from the base snapshot
    fake.notReady.add(image);
    const falling = await newDork();
    await t.action(internal.boxes.create, { dorkId: falling, gen: 0 });
    expect((await t.run((ctx) => ctx.db.get(falling)))!.boxId).toBe(`box-${falling}`);
    expect((await imageOf(u1, imageId)).status).toBe("not_built");
  });
});
