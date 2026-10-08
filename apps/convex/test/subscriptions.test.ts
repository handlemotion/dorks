/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { commentPolicy as commentPolicySchema, subscriptionView, type CommentPolicy } from "@dorks/shared";
import { convexTest, type TestConvexForDataModel } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { DataModel, Id } from "../convex/_generated/dataModel";
import { bridgeSecret } from "../convex/lib/bridgeAuth";
import { enqueueNotification } from "../convex/lib/notify";
import { commentAllowed, MAX_SUBSCRIPTIONS_PER_DORK, subscriptionsForHead, subscriptionsForPr, updateSubscription } from "../convex/lib/subscriptions";
import schema from "../convex/schema";
import { DELIVERY_RETENTION_MS, INBOX_RETENTION_MS } from "../convex/subscriptions";

vi.mock("../convex/auth", () => ({
  requireUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) => {
    const id = await ctx.auth.getUserIdentity();
    if (!id) throw new Error("Unauthenticated");
    return id.subject;
  },
}));

const gh = vi.hoisted(() => ({
  tokens: [] as unknown[],
  prs: [] as string[],
  fail: null as null | { status: number } | "network",
  pr: { title: "Add thing", headRef: "agent/x", headSha: "abc123", baseRef: "main", repo: "Octo/Hello", state: "open", mergeable: true } as Record<string, unknown>,
}));
vi.mock("../../api/src/lib/github", async (orig) => {
  const actual = await orig<typeof import("../../api/src/lib/github")>();
  return {
    ...actual,
    createInstallationToken: async (_env: unknown, installationId: unknown, _f: unknown, scope: unknown) => (gh.tokens.push({ installationId, scope }), { token: "ghs_read", expiresAt: "2030-01-01T00:00:00Z" }),
    getPullRequest: async (token: string, repo: string, number: number) => {
      gh.prs.push(`${token} ${repo}#${number}`);
      if (gh.fail === "network") throw new TypeError("fetch failed");
      if (gh.fail) throw new actual.GithubHttpError(gh.fail.status, "pull request lookup");
      return gh.pr;
    },
  };
});

const modules = import.meta.glob("../convex/**/*.*s");
type T = TestConvexForDataModel<DataModel>;
const code = (e: unknown) => (e as { data?: { code?: string } }).data?.code;
const rejects = async (p: Promise<unknown>) => p.then(() => undefined, (e) => code(e));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  Object.assign(gh, { tokens: [], prs: [], fail: null, pr: { title: "Add thing", headRef: "agent/x", headSha: "abc123", baseRef: "main", repo: "Octo/Hello", state: "open", mergeable: true } });
  process.env.BRIDGE_SECRET_KEY = "test-bridge-key";
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_APP_PRIVATE_KEY = "unused";
  delete process.env.BOX_PROVIDER;
});
afterEach(() => vi.useRealTimers());

async function seed(over: { userId?: string; installation?: number | null } = {}) {
  const t = convexTest(schema, modules);
  const userId = over.userId ?? "u1";
  const dorkId = await t.run(async (ctx) => {
    await ctx.db.insert("userSettings", { userId, sleepMinutes: 5, ...(over.installation === null ? {} : { githubInstallationId: over.installation ?? 42 }) });
    const id = await ctx.db.insert("dorks", { userId, title: "t", repo: "octo/hello", branch: "agent/x", state: "idle", archived: false, boxId: "box-1", lastActivityAt: 1 });
    await ctx.db.insert("dorkRuntime", { dorkId: id, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: Date.now(), bridgeLost: false, timers: {} });
    return id;
  });
  return { t, dorkId, c: { dorkId, secret: await bridgeSecret(dorkId) }, user: t.withIdentity({ subject: userId }) };
}
const subsOf = (t: T) => t.run((ctx) => ctx.db.query("prSubscriptions").collect());
const eventsOf = (t: T, id: Id<"dorks">) => t.run((ctx) => ctx.db.query("events").withIndex("by_dork_seq", (q) => q.eq("dorkId", id)).collect().then((r) => r.map((e) => e.body)));
const scheduled = (t: T) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect().then((r) => r.map((j) => j.name)));
const setFirst = (t: T, patch: Record<string, unknown>) => t.run(async (ctx) => ctx.db.patch((await ctx.db.query("prSubscriptions").first())!._id, patch));
const subscribed = (t: T, dorkId: Id<"dorks">, over: Record<string, unknown> = {}) =>
  t.run((ctx) =>
    ctx.db.insert("prSubscriptions", {
      dorkId, userId: "u1", repo: "octo/hello", number: 12, url: "https://github.com/octo/hello/pull/12", source: "agent", status: "active", ci: "unknown", review: "none",
      mergeable: null, ciFixAttempts: 0, state: "open", lastEventAt: 1, ...over,
    }),
  );

describe("bridge.subscribe / unsubscribe / subscriptions", () => {
  it("subscribes (repo stored lowercase), schedules hydration, appends a subscription event", async () => {
    const { t, c, dorkId } = await seed();
    await t.mutation(api.bridge.subscribe, { ...c, repo: "Octo/Hello", number: 12, source: "auto" });
    const [s] = await subsOf(t);
    expect(s).toMatchObject({ dorkId, userId: "u1", repo: "octo/hello", number: 12, url: "https://github.com/octo/hello/pull/12", source: "auto", status: "active", ci: "unknown", review: "none", mergeable: null, ciFixAttempts: 0, state: "open" });
    expect(await scheduled(t)).toEqual(["subscriptions:hydrate"]);
    expect(await eventsOf(t, dorkId)).toEqual([{ type: "subscription", repo: "octo/hello", number: 12, status: "active", reason: "subscribed (auto)" }]);
  });

  it("is idempotent: no second row, hydration or event; a stalled one is not un-stalled by the agent", async () => {
    const { t, c, dorkId } = await seed();
    await t.mutation(api.bridge.subscribe, { ...c, repo: "octo/hello", number: 12, source: "auto" });
    await t.mutation(api.bridge.subscribe, { ...c, repo: "OCTO/hello", number: 12, source: "agent" });
    expect(await subsOf(t)).toHaveLength(1);
    expect((await subsOf(t))[0].source).toBe("auto");
    expect(await scheduled(t)).toHaveLength(1);
    expect(await eventsOf(t, dorkId)).toHaveLength(1);
    await setFirst(t, { status: "stalled", ciFixAttempts: 2 });
    await t.mutation(api.bridge.subscribe, { ...c, repo: "octo/hello", number: 12, source: "agent" });
    expect(await subsOf(t)).toMatchObject([{ status: "stalled", ciFixAttempts: 2 }]);
  });

  it("rejects bad input and wrong secrets; caps subscriptions per dork", async () => {
    const { t, c } = await seed();
    expect(await rejects(t.mutation(api.bridge.subscribe, { ...c, repo: "nope", number: 1, source: "agent" }))).toBe("invalid");
    expect(await rejects(t.mutation(api.bridge.subscribe, { ...c, repo: "../x/y", number: 1, source: "agent" }))).toBe("invalid");
    expect(await rejects(t.mutation(api.bridge.subscribe, { ...c, repo: "o/r", number: 0, source: "agent" }))).toBe("invalid");
    expect(await rejects(t.mutation(api.bridge.subscribe, { ...c, repo: "o/r", number: 1.5, source: "agent" }))).toBe("invalid");
    expect(await rejects(t.mutation(api.bridge.subscribe, { ...c, secret: "0".repeat(64), repo: "o/r", number: 1, source: "agent" }))).toBe("forbidden");
    expect(await rejects(t.mutation(api.bridge.unsubscribe, { ...c, secret: "0".repeat(64), repo: "o/r", number: 1 }))).toBe("forbidden");
    expect(await rejects(t.query(api.bridge.subscriptions, { ...c, secret: "0".repeat(64) }))).toBe("forbidden");
    for (let n = 1; n <= MAX_SUBSCRIPTIONS_PER_DORK; n++) await t.mutation(api.bridge.subscribe, { ...c, repo: "o/r", number: n, source: "agent" });
    expect(await rejects(t.mutation(api.bridge.subscribe, { ...c, repo: "o/r", number: 999, source: "agent" }))).toBe("limit");
    await t.mutation(api.bridge.unsubscribe, { ...c, repo: "o/r", number: 1 });
    await t.mutation(api.bridge.subscribe, { ...c, repo: "o/r", number: 999, source: "agent" }); // ended ones don't count
  });

  it("subscriptions maps 1:1 onto subscriptionView and hides ended ones", async () => {
    const { t, c, dorkId } = await seed();
    await subscribed(t, dorkId, { title: "Add thing", headRef: "agent/x", baseRef: "main", headSha: "abc", ci: "failing", review: "changes_requested", mergeable: false, ciFixAttempts: 1, status: "stalled" });
    await subscribed(t, dorkId, { number: 13, url: "https://github.com/octo/hello/pull/13" });
    await subscribed(t, dorkId, { number: 14, url: "https://github.com/octo/hello/pull/14", status: "ended", state: "merged" });
    const list = await t.query(api.bridge.subscriptions, c);
    expect(list.map((s) => s.number)).toEqual([12, 13]);
    for (const s of list) expect(subscriptionView.parse(s)).toEqual(s);
    expect(list[0]).toEqual({
      repo: "octo/hello", number: 12, url: "https://github.com/octo/hello/pull/12", title: "Add thing", headRef: "agent/x", baseRef: "main", headSha: "abc",
      source: "agent", status: "stalled", ci: "failing", review: "changes_requested", mergeable: false, ciFixAttempts: 1, state: "open",
    });
    expect(Object.keys(list[1]).sort()).not.toContain("_id");
  });

  it("subscriptions only lists the calling dork's", async () => {
    const a = await seed();
    await subscribed(a.t, a.dorkId);
    const otherId = await a.t.run((ctx) => ctx.db.insert("dorks", { userId: "u1", title: "o", repo: "o/r", branch: "b", state: "idle", archived: false, lastActivityAt: 1 }));
    await subscribed(a.t, otherId, { number: 99 });
    expect((await a.t.query(api.bridge.subscriptions, a.c)).map((s) => s.number)).toEqual([12]);
  });

  it("unsubscribe ends it, appends an event, drops what was buffered for it; unknown PRs are a no-op", async () => {
    const { t, c, dorkId } = await seed();
    const id = await subscribed(t, dorkId);
    await t.run((ctx) => enqueueNotification(ctx, dorkId, id, "comment", "x"));
    await t.mutation(api.bridge.unsubscribe, { ...c, repo: "octo/hello", number: 12 });
    await t.mutation(api.bridge.unsubscribe, { ...c, repo: "octo/hello", number: 12 });
    await t.mutation(api.bridge.unsubscribe, { ...c, repo: "octo/hello", number: 77 });
    expect((await subsOf(t))[0].status).toBe("ended");
    expect(await eventsOf(t, dorkId)).toEqual([{ type: "subscription", repo: "octo/hello", number: 12, status: "ended", reason: "unsubscribed" }]);
    expect((await t.run((ctx) => ctx.db.query("inbox").collect())).map((r) => r.delivered)).toEqual([true]);
    expect(await t.query(api.bridge.subscriptions, c)).toEqual([]);
  });

  it("an agent re-subscribing after ending keeps the CI attempt budget; the user resets it", async () => {
    const { t, c, dorkId, user } = await seed();
    await subscribed(t, dorkId, { status: "ended", ciFixAttempts: 2 });
    await t.mutation(api.bridge.subscribe, { ...c, repo: "octo/hello", number: 12, source: "agent" });
    expect(await subsOf(t)).toMatchObject([{ status: "active", ciFixAttempts: 2 }]);
    expect(await scheduled(t)).toEqual(["subscriptions:hydrate"]); // re-checked: the PR may have moved on
    await user.mutation(api.subscriptions.subscribe, { dorkId, repo: "octo/hello", number: 12 });
    expect(await subsOf(t)).toMatchObject([{ status: "active", ciFixAttempts: 0, source: "agent" }]);
  });
});

describe("hydration", () => {
  const hydrate = async (t: T, repo = "octo/hello", number = 12) => {
    const [s] = (await subsOf(t)).filter((x) => x.repo === repo && x.number === number);
    await t.action(internal.subscriptions.hydrate, { subscriptionId: s._id });
    return (await subsOf(t)).find((x) => x._id === s._id)!;
  };

  it("fills in title, refs, sha, state and mergeable with a read-only installation token", async () => {
    const { t, c } = await seed();
    await t.mutation(api.bridge.subscribe, { ...c, repo: "octo/hello", number: 12, source: "auto" });
    expect(await hydrate(t)).toMatchObject({ title: "Add thing", headRef: "agent/x", headSha: "abc123", baseRef: "main", state: "open", mergeable: true, status: "active" });
    expect(gh.tokens).toEqual([{ installationId: 42, scope: { permissions: { pull_requests: "read" } } }]);
    expect(gh.prs).toEqual(["ghs_read octo/hello#12"]);
  });

  it("a PR that is already merged ends the subscription", async () => {
    const { t, c, dorkId } = await seed();
    await t.mutation(api.bridge.subscribe, { ...c, repo: "octo/hello", number: 12, source: "agent" });
    gh.pr = { ...gh.pr, state: "merged", mergeable: null };
    expect(await hydrate(t)).toMatchObject({ state: "merged", status: "ended" });
    expect(await eventsOf(t, dorkId)).toContainEqual({ type: "subscription", repo: "octo/hello", number: 12, status: "ended", reason: "merged" });
  });

  it.each([401, 403, 404, 422])("GitHub %i (the installation cannot see the PR) ends the subscription", async (status) => {
    const { t, c, dorkId } = await seed();
    await t.mutation(api.bridge.subscribe, { ...c, repo: "someone/else", number: 5, source: "agent" });
    gh.fail = { status };
    expect(await hydrate(t, "someone/else", 5)).toMatchObject({ status: "ended" });
    expect(await eventsOf(t, dorkId)).toContainEqual({ type: "subscription", repo: "someone/else", number: 5, status: "ended", reason: "PR not found or not accessible to your GitHub App installation" });
    expect(await t.query(api.bridge.subscriptions, c)).toEqual([]);
  });

  it("no installation: ended; transient errors retry with backoff and keep the subscription", async () => {
    const none = await seed({ installation: null });
    await none.t.mutation(api.bridge.subscribe, { ...none.c, repo: "octo/hello", number: 12, source: "agent" });
    expect(await hydrate(none.t)).toMatchObject({ status: "ended" });

    const { t, c } = await seed();
    await t.mutation(api.bridge.subscribe, { ...c, repo: "octo/hello", number: 12, source: "agent" });
    gh.fail = { status: 502 };
    expect(await hydrate(t)).toMatchObject({ status: "active" });
    expect((await subsOf(t))[0]).not.toHaveProperty("headRef");
    gh.fail = "network";
    await hydrate(t);
    const retries = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j) => j.name === "subscriptions:hydrate" && j.scheduledTime > Date.now());
    expect(retries.map((j) => Math.round((j.scheduledTime - Date.now()) / 60_000))).toEqual([1, 1]);
  });

  it("an unsubscribed PR is not hydrated or revived; sim mode never calls GitHub", async () => {
    const { t, c } = await seed();
    await t.mutation(api.bridge.subscribe, { ...c, repo: "octo/hello", number: 12, source: "agent" });
    await t.mutation(api.bridge.unsubscribe, { ...c, repo: "octo/hello", number: 12 });
    expect(await hydrate(t)).toMatchObject({ status: "ended" });
    expect(gh.prs).toEqual([]);

    await t.mutation(api.bridge.subscribe, { ...c, repo: "octo/hello", number: 12, source: "agent" });
    process.env.BOX_PROVIDER = "sim";
    expect(await hydrate(t)).toMatchObject({ status: "active" });
    expect(gh.tokens).toEqual([]);
    expect(gh.prs).toEqual([]);
  });
});

describe("user-facing subscriptions", () => {
  it("list / subscribe / unsubscribe for the owner only", async () => {
    const { t, dorkId, user } = await seed();
    await user.mutation(api.subscriptions.subscribe, { dorkId, repo: "octo/other", number: 3 });
    expect(await user.query(api.subscriptions.list, { dorkId })).toMatchObject([{ repo: "octo/other", number: 3, source: "user", status: "active" }]);
    const stranger = t.withIdentity({ subject: "u2" });
    expect(await stranger.query(api.subscriptions.list, { dorkId })).toEqual([]);
    expect(await rejects(stranger.mutation(api.subscriptions.subscribe, { dorkId, repo: "o/r", number: 1 }))).toBe("not_found");
    expect(await rejects(stranger.mutation(api.subscriptions.unsubscribe, { dorkId, repo: "octo/other", number: 3 }))).toBe("not_found");
    expect(await rejects(stranger.mutation(api.subscriptions.resume, { dorkId, repo: "octo/other", number: 3 }))).toBe("not_found");
    await user.mutation(api.subscriptions.unsubscribe, { dorkId, repo: "octo/other", number: 3 });
    expect(await user.query(api.subscriptions.list, { dorkId })).toEqual([]);
  });

  it("several dorks may subscribe to one PR", async () => {
    const a = await seed();
    const second = await a.t.run((ctx) => ctx.db.insert("dorks", { userId: "u1", title: "2", repo: "o/r", branch: "b", state: "idle", archived: false, lastActivityAt: 1 }));
    await a.user.mutation(api.subscriptions.subscribe, { dorkId: a.dorkId, repo: "octo/hello", number: 12 });
    await a.user.mutation(api.subscriptions.subscribe, { dorkId: second, repo: "octo/hello", number: 12 });
    expect(await a.t.run((ctx) => subscriptionsForPr(ctx, "Octo/Hello", 12))).toHaveLength(2);
  });

  it("resume un-stalls and resets ciFixAttempts, with an event; resubscribing does the same", async () => {
    const { t, dorkId, user } = await seed();
    await subscribed(t, dorkId, { status: "stalled", ciFixAttempts: 2, ci: "failing" });
    await user.mutation(api.subscriptions.resume, { dorkId, repo: "octo/hello", number: 12 });
    expect(await subsOf(t)).toMatchObject([{ status: "active", ciFixAttempts: 0, ci: "failing" }]);
    expect(await eventsOf(t, dorkId)).toEqual([{ type: "subscription", repo: "octo/hello", number: 12, status: "active", reason: "resumed" }]);

    await setFirst(t, { status: "stalled", ciFixAttempts: 2 });
    await user.mutation(api.subscriptions.subscribe, { dorkId, repo: "octo/hello", number: 12 });
    expect(await subsOf(t)).toMatchObject([{ status: "active", ciFixAttempts: 0 }]);
    expect(await rejects(user.mutation(api.subscriptions.resume, { dorkId, repo: "octo/hello", number: 404 }))).toBe("not_found");
  });
});

describe("deleting a dork", () => {
  it("ends its subscriptions at once; purge removes them and their buffered events", async () => {
    const { t, dorkId, user } = await seed();
    const id = await subscribed(t, dorkId);
    await t.run((ctx) => enqueueNotification(ctx, dorkId, id, "comment", "x"));
    await user.mutation(api.dorks.remove, { dorkId });
    expect(await subsOf(t)).toMatchObject([{ status: "ended" }]);
    expect(await t.run((ctx) => subscriptionsForPr(ctx, "octo/hello", 12))).toEqual([]);
    await t.mutation(internal.dorks.purge, { dorkId });
    expect(await subsOf(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("inbox").collect())).toEqual([]);
  });
});

describe("lookups for the webhook ingress", () => {
  it("find by (repo, number) and (repo, headRef), case-insensitively, skipping ended; updateSubscription stamps lastEventAt", async () => {
    const { t, dorkId } = await seed();
    const id = await subscribed(t, dorkId, { headRef: "agent/x" });
    await subscribed(t, dorkId, { number: 13, headRef: "agent/x", status: "ended" });
    await subscribed(t, dorkId, { number: 14, headRef: "agent/y" });
    expect((await t.run((ctx) => subscriptionsForPr(ctx, "OCTO/hello", 12))).map((s) => s.number)).toEqual([12]);
    expect((await t.run((ctx) => subscriptionsForHead(ctx, "octo/Hello", "agent/x"))).map((s) => s.number)).toEqual([12]);
    expect(await t.run((ctx) => subscriptionsForHead(ctx, "octo/hello", "agent/z"))).toEqual([]);
    await t.run((ctx) => updateSubscription(ctx, id, { ci: "failing", review: "approved", mergeable: false, headSha: "def", headRef: "agent/z", state: "open" }));
    expect((await subsOf(t)).find((s) => s._id === id)).toMatchObject({ ci: "failing", review: "approved", mergeable: false, headSha: "def", headRef: "agent/z", lastEventAt: Date.now() });
    expect((await t.run((ctx) => subscriptionsForHead(ctx, "octo/hello", "agent/z"))).map((s) => s.number)).toEqual([12]);
  });
});

describe("comment policy", () => {
  const app = "dorks[bot]";
  it("commentAllowed: all accepts anyone but the App itself", () => {
    expect(commentAllowed({ mode: "all" }, "alice", app)).toBe(true);
    expect(commentAllowed({ mode: "all" }, "coderabbitai[bot]", app)).toBe(true);
    expect(commentAllowed({ mode: "all" }, "Dorks[bot]", app)).toBe(false);
  });
  it("commentAllowed: allowlist is case-insensitive, bots by login, and never lets the App through", () => {
    const policy: CommentPolicy = { mode: "allowlist", logins: ["Alice", "coderabbitai[bot]", "dorks[bot]"] };
    expect(commentAllowed(policy, "alice", app)).toBe(true);
    expect(commentAllowed(policy, "CodeRabbitAI[bot]", app)).toBe(true);
    expect(commentAllowed(policy, "mallory", app)).toBe(false);
    expect(commentAllowed(policy, "dorks[bot]", app)).toBe(false);
    expect(commentAllowed({ mode: "allowlist", logins: [] }, "alice", app)).toBe(false);
  });

  it("setCommentPolicy validates with the shared schema and stores it; onboarding exposes it (default all)", async () => {
    const { t, user } = await seed();
    expect((await user.query(api.settings.onboarding, {})).commentPolicy).toEqual({ mode: "all" });
    const policy = { mode: "allowlist", logins: ["alice", "coderabbitai[bot]"] };
    await user.mutation(api.settings.setCommentPolicy, { policy });
    expect((await t.run((ctx) => ctx.db.query("userSettings").collect()))[0].commentPolicy).toEqual(policy);
    expect(commentPolicySchema.parse((await user.query(api.settings.onboarding, {})).commentPolicy)).toEqual(policy);
    await user.mutation(api.settings.setCommentPolicy, { policy: { mode: "all" } });
    expect((await user.query(api.settings.onboarding, {})).commentPolicy).toEqual({ mode: "all" });
    for (const bad of [{ mode: "nobody" }, { mode: "allowlist" }, { mode: "allowlist", logins: [1] }, { mode: "allowlist", logins: [""] }, { mode: "allowlist", logins: ["x".repeat(101)] }, { mode: "allowlist", logins: Array(201).fill("a") }, "all", null])
      expect(await rejects(user.mutation(api.settings.setCommentPolicy, { policy: bad }))).toBe("invalid");
  });

  it("the install link records the GitHub login (sim mode records none)", async () => {
    const { t, user } = await seed();
    await t.mutation(internal.settings.storeGithubInstallation, { userId: "u1", installationId: 7, githubLogin: "alice" });
    expect((await t.run((ctx) => ctx.db.query("userSettings").collect()))[0]).toMatchObject({ githubInstallationId: 7, githubLogin: "alice" });
    process.env.BOX_PROVIDER = "sim";
    await user.action(api.settings.linkGithubInstallation, { installationId: 8, code: "sim" });
    expect((await t.run((ctx) => ctx.db.query("userSettings").collect()))[0]).toMatchObject({ githubInstallationId: 8 });
  });
});

describe("retention sweep", () => {
  it("prunes old delivery ids and delivered inbox rows only", async () => {
    const { t, dorkId } = await seed();
    const sub = await subscribed(t, dorkId);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("githubDeliveries", { deliveryId: "old", receivedAt: now - DELIVERY_RETENTION_MS - 1 });
      await ctx.db.insert("githubDeliveries", { deliveryId: "new", receivedAt: now });
      const row = { dorkId, subscriptionId: sub, kind: "comment" as const, summary: "x" };
      await ctx.db.insert("inbox", { ...row, createdAt: now - INBOX_RETENTION_MS - 1, delivered: true });
      await ctx.db.insert("inbox", { ...row, createdAt: now - INBOX_RETENTION_MS - 1, delivered: false }); // still waiting: kept
      await ctx.db.insert("inbox", { ...row, createdAt: now, delivered: true });
    });
    await t.mutation(internal.subscriptions.sweep, {});
    expect((await t.run((ctx) => ctx.db.query("githubDeliveries").collect())).map((d) => d.deliveryId)).toEqual(["new"]);
    expect((await t.run((ctx) => ctx.db.query("inbox").collect())).map((r) => [r.delivered, r.createdAt === now])).toEqual([[false, false], [true, true]]);
  });
});

