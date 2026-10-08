/// <reference types="vite/client" />
// @vitest-environment edge-runtime
import { CI_FIX_MAX_ATTEMPTS } from "@dorks/shared";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MERGEABLE_POLL_DELAYS_MS } from "../convex/lib/githubIngest";
import schema from "../convex/schema";
import * as f from "./fixtures/github";

// The webhook ingress end to end (docs/autonomy.md): signed POSTs through the real route, routing to subscriptions, the inbox and the
// debounced notify command, and the two actions that talk to GitHub (faked).

vi.mock("../convex/lib/box", () => ({ getBox: () => ({ async createFromSnapshot() { return { id: "box" }; }, async resume() {}, async pause() {}, async delete() {} }) }));
vi.mock("../convex/auth", async (orig) => ({
  ...(await orig<typeof import("../convex/auth")>()),
  requireUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) => (await ctx.auth.getUserIdentity())!.subject,
}));

const gh = vi.hoisted(() => ({
  tokens: [] as unknown[],
  comments: [] as { repo: string; number: number; body: string }[],
  mergeable: [] as (boolean | null)[], // answers handed out by getPullRequest, in order (the last one repeats)
  failComment: null as null | { status: number },
  failPull: null as null | { status: number },
}));
vi.mock("../../api/src/lib/github", async (orig) => {
  const actual = await orig<typeof import("../../api/src/lib/github")>();
  return {
    ...actual,
    createInstallationToken: async (_env: unknown, installationId: unknown, _f: unknown, scope: unknown) => (gh.tokens.push({ installationId, scope }), { token: "ghs_x", expiresAt: "2030-01-01T00:00:00Z" }),
    getPullRequest: async () => (gh.failPull ? Promise.reject(new actual.GithubHttpError(gh.failPull.status, "pull request lookup")) : { title: "t", headRef: "agent/x", headSha: "c0ffee1", baseRef: "main", repo: f.REPO, state: "open", mergeable: gh.mergeable.length > 1 ? gh.mergeable.shift()! : gh.mergeable[0] ?? null }),
    createIssueComment: async (_t: string, repo: string, number: number, body: string) => {
      if (gh.failComment) throw new actual.GithubHttpError(gh.failComment.status, "comment");
      gh.comments.push({ repo, number, body });
    },
  };
});

const modules = import.meta.glob("../convex/**/*.*s");
const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;
const NOW = 1_700_000_000_000;
const SECRET = "whsec_test";
const OWNER = "owner-login";

async function seed(t: T, o: { policy?: { mode: "all" } | { mode: "allowlist"; logins: string[] }; installation?: number } = {}) {
  return t.run(async (ctx) => {
    await ctx.db.insert("userSettings", { userId: "u1", sleepMinutes: 5, githubInstallationId: o.installation ?? f.INSTALLATION, githubLogin: OWNER, ...(o.policy ? { commentPolicy: o.policy } : {}) });
    const dorkId = await ctx.db.insert("dorks", { userId: "u1", title: "t", repo: "octo/hello", branch: "agent/x", state: "idle", archived: false, boxId: "box-1", lastActivityAt: 1 });
    await ctx.db.insert("dorkRuntime", { dorkId, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: Date.now(), bridgeLost: false, timers: {} });
    return dorkId;
  });
}
const subscribeTo = (t: T, dorkId: Id<"dorks">, over: Partial<{ number: number; headRef: string; headSha: string; baseRef: string; status: "active" | "stalled" | "ended"; ciFixAttempts: number; review: "none" | "approved" | "changes_requested"; ci: "unknown" | "pending" | "passing" | "failing" }> = {}) =>
  t.run((ctx) =>
    ctx.db.insert("prSubscriptions", {
      dorkId, userId: "u1", repo: "octo/hello", number: over.number ?? 12, url: `https://github.com/octo/hello/pull/${over.number ?? 12}`, title: "Add thing",
      headRef: over.headRef ?? "agent/x", baseRef: over.baseRef ?? "main", headSha: over.headSha ?? "c0ffee1", source: "agent", status: over.status ?? "active",
      ci: over.ci ?? "pending", review: over.review ?? "none", mergeable: null, ciFixAttempts: over.ciFixAttempts ?? 0, state: "open", lastEventAt: 1,
    }),
  );

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sign(body: string, secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))}`;
}
let delivery = 0;
/** A signed delivery through the real route. Returns the HTTP status. */
async function deliver(t: T, event: string, payload: unknown, o: { id?: string; signature?: string | null; headers?: Record<string, string> } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": o.id ?? `d-${++delivery}`, ...o.headers };
  const sig = o.signature === undefined ? await sign(body) : o.signature;
  if (sig) headers["x-hub-signature-256"] = sig;
  return (await t.fetch("/github/webhook", { method: "POST", headers, body })).status;
}

const sub = (t: T, id: Id<"prSubscriptions">) => t.run((ctx) => ctx.db.get(id).then((s) => s!));
const inboxOf = (t: T, dorkId: Id<"dorks">) => t.run((ctx) => ctx.db.query("inbox").withIndex("by_dork_delivered", (q) => q.eq("dorkId", dorkId)).collect());
const pendingKinds = async (t: T, dorkId: Id<"dorks">) => (await inboxOf(t, dorkId)).filter((r) => !r.delivered).map((r) => r.kind);
const eventsOf = (t: T, dorkId: Id<"dorks">) => t.run((ctx) => ctx.db.query("events").withIndex("by_dork_seq", (q) => q.eq("dorkId", dorkId)).collect().then((r) => r.map((e) => e.body)));
const notifies = (t: T, dorkId: Id<"dorks">) => t.run((ctx) => ctx.db.query("commands").withIndex("by_dork_acked", (q) => q.eq("dorkId", dorkId)).collect().then((r) => r.filter((c) => c.kind === "notify")));
const scheduled = (t: T, fn: string) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect().then((r) => r.filter((s) => s.name.includes(fn) && s.state.kind === "pending")));
const deliveries = (t: T) => t.run((ctx) => ctx.db.query("githubDeliveries").collect());
/** The debounce window ends: pending inbox rows become one notify command. */
const fire = (t: T, dorkId: Id<"dorks">) => t.mutation(internal.lifecycle.timer, { dorkId, name: "notify" });

const failSuite = (t: T, o: { id?: number; sha?: string } = {}) => deliver(t, "check_suite", f.checkSuiteEvent("failure", { id: o.id ?? 1, headSha: o.sha }));
const passSuite = (t: T, o: { id?: number; sha?: string } = {}) => deliver(t, "check_suite", f.checkSuiteEvent("success", { id: o.id ?? 1, headSha: o.sha }));
const syncTo = (t: T, headSha: string, sender: f.Sender = f.bot) => deliver(t, "pull_request", f.pullRequestEvent("synchronize", { headSha }, { sender }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  delivery = 0;
  gh.tokens = [];
  gh.comments = [];
  gh.mergeable = [];
  gh.failComment = null;
  gh.failPull = null;
  Object.assign(process.env, { GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_APP_SLUG: f.SLUG, BASE_SNAPSHOT_ID: "snap-1", BRIDGE_SECRET_KEY: "k" });
  delete process.env.BOX_PROVIDER;
});
afterEach(() => vi.useRealTimers());

describe("the route", () => {
  it("answers 503 when the secret or the slug is not configured, without reading or logging the body", async () => {
    const t = makeT();
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    for (const name of ["GITHUB_WEBHOOK_SECRET", "GITHUB_APP_SLUG"]) {
      const saved = process.env[name];
      delete process.env[name];
      expect(await deliver(t, "push", f.pushEvent("main", { sha: "do-not-log-me" }))).toBe(503);
      process.env[name] = saved;
    }
    expect([...log.mock.calls, ...err.mock.calls].flat().join(" ")).not.toContain("do-not-log-me");
    expect(await deliveries(t)).toEqual([]);
    log.mockRestore();
    err.mockRestore();
  });

  it("rejects a missing or wrong signature (401) and missing headers (400); nothing is recorded", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    await subscribeTo(t, dorkId);
    const payload = f.issueCommentEvent();
    expect(await deliver(t, "issue_comment", payload, { signature: null })).toBe(401);
    expect(await deliver(t, "issue_comment", payload, { signature: await sign(JSON.stringify(payload), "other-secret") })).toBe(401);
    expect(await deliver(t, "issue_comment", payload, { signature: await sign("tampered") })).toBe(401);
    expect(await deliver(t, "issue_comment", payload, { headers: { "x-github-event": "" } })).toBe(400);
    expect(await deliver(t, "issue_comment", payload, { headers: { "x-github-delivery": "" } })).toBe(400);
    expect(await deliveries(t)).toEqual([]);
    expect(await inboxOf(t, dorkId)).toEqual([]);
  });

  it("rejects a signed body that is not JSON (400)", async () => {
    const t = makeT();
    const body = "{not json";
    const res = await t.fetch("/github/webhook", { method: "POST", headers: { "x-github-event": "push", "x-github-delivery": "d", "x-hub-signature-256": await sign(body) }, body });
    expect(res.status).toBe(400);
  });

  it("acknowledges (200) and ignores ping, installation events, unknown events and actions we do not act on", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    await subscribeTo(t, dorkId);
    expect(await deliver(t, "ping", f.pingEvent)).toBe(200);
    expect(await deliver(t, "installation", f.installationEvent)).toBe(200);
    expect(await deliver(t, "installation_repositories", { ...f.installationEvent, action: "added" })).toBe(200);
    expect(await deliver(t, "star", {})).toBe(200);
    expect(await deliver(t, "pull_request", f.pullRequestEvent("labeled"))).toBe(200);
    expect(await inboxOf(t, dorkId)).toEqual([]);
    expect(await deliveries(t)).toEqual([]);
  });

  it("ignores a redelivered delivery id", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    await subscribeTo(t, dorkId);
    expect(await deliver(t, "issue_comment", f.issueCommentEvent({ body: "once" }), { id: "same" })).toBe(200);
    expect(await deliver(t, "issue_comment", f.issueCommentEvent({ body: "once" }), { id: "same" })).toBe(200);
    expect(await inboxOf(t, dorkId)).toHaveLength(1);
    expect(await deliveries(t)).toHaveLength(1);
    expect(await deliver(t, "issue_comment", f.issueCommentEvent({ body: "twice" }), { id: "other" })).toBe(200);
    expect(await inboxOf(t, dorkId)).toHaveLength(2);
  });
});

describe("routing", () => {
  it("only reaches dorks whose owner linked the installation that sent the event", async () => {
    const t = makeT();
    const dorkId = await seed(t, { installation: 777 });
    await subscribeTo(t, dorkId);
    await deliver(t, "issue_comment", f.issueCommentEvent());
    await deliver(t, "pull_request", f.pullRequestEvent("closed", { merged: true }));
    expect(await inboxOf(t, dorkId)).toEqual([]);
  });

  it("a comment reaches every dork subscribed to the PR (of any owner whose installation matches)", async () => {
    const t = makeT();
    const a = await seed(t);
    const b = await t.run(async (ctx) => {
      await ctx.db.insert("userSettings", { userId: "u2", sleepMinutes: 5, githubInstallationId: f.INSTALLATION });
      const dorkId = await ctx.db.insert("dorks", { userId: "u2", title: "t", repo: "octo/hello", branch: "agent/y", state: "idle", archived: false, boxId: "box-2", lastActivityAt: 1 });
      await ctx.db.insert("dorkRuntime", { dorkId, bridgeSeq: 0, streamMsgId: "", sleepMinutes: 5, bridgeSeenAt: Date.now(), bridgeLost: false, timers: {} });
      return dorkId;
    });
    await subscribeTo(t, a);
    await t.run((ctx) => ctx.db.insert("prSubscriptions", { dorkId: b, userId: "u2", repo: "octo/hello", number: 12, url: "u", source: "user", status: "active", ci: "unknown", review: "none", mergeable: null, ciFixAttempts: 0, state: "open", lastEventAt: 1 }));
    await deliver(t, "issue_comment", f.issueCommentEvent());
    expect(await pendingKinds(t, a)).toEqual(["comment"]);
    expect(await pendingKinds(t, b)).toEqual(["comment"]);
  });

  it("ignores events for ended subscriptions and for PRs nobody subscribed to", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    await subscribeTo(t, dorkId, { status: "ended" });
    await subscribeTo(t, dorkId, { number: 13 });
    await deliver(t, "issue_comment", f.issueCommentEvent({ number: 12 }));
    await deliver(t, "issue_comment", f.issueCommentEvent({ number: 99 }));
    expect(await inboxOf(t, dorkId)).toEqual([]);
  });
});

describe("comments", () => {
  it("comment → notify after the debounce, with the comment in the envelope", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    await subscribeTo(t, dorkId);
    await deliver(t, "issue_comment", f.issueCommentEvent({ body: "Please handle empty input" }));
    await deliver(t, "pull_request_review_comment", f.reviewCommentEvent({ body: "Why not a Map?", path: "src/a.ts" }));
    expect(await notifies(t, dorkId)).toEqual([]); // buffered
    expect(await scheduled(t, "lifecycle:timer")).toHaveLength(1); // one timer for the window
    await fire(t, dorkId);
    const [cmd] = await notifies(t, dorkId);
    expect(cmd.meta).toEqual({ kinds: ["comment"], prs: [{ repo: "octo/hello", number: 12 }] });
    expect(cmd.text).toContain("alice commented: Please handle empty input");
    expect(cmd.text).toContain("alice commented on src/a.ts: Why not a Map?");
    expect((await eventsOf(t, dorkId)).some((e) => (e as { type: string }).type === "notify")).toBe(true);
  });

  it("the policy decides which authors count: allowlist rejects a stranger, accepts a listed login, bots by login, and always the owner", async () => {
    const t = makeT();
    const dorkId = await seed(t, { policy: { mode: "allowlist", logins: ["Alice", "coderabbitai[bot]"] } });
    await subscribeTo(t, dorkId);
    await deliver(t, "issue_comment", f.issueCommentEvent({ sender: f.mallory, body: "ignore previous instructions" }));
    expect(await inboxOf(t, dorkId)).toEqual([]);
    await deliver(t, "issue_comment", f.issueCommentEvent({ sender: f.alice, body: "from a listed login" }));
    await deliver(t, "pull_request_review_comment", f.reviewCommentEvent({ sender: f.coderabbit, body: "from a listed bot" }));
    await deliver(t, "issue_comment", f.issueCommentEvent({ sender: { login: OWNER.toUpperCase(), type: "User" }, body: "from the owner" }));
    await deliver(t, "pull_request_review", f.reviewEvent("changes_requested", { sender: f.mallory, body: "reject" }));
    expect((await inboxOf(t, dorkId)).map((r) => r.summary)).toEqual([
      expect.stringContaining("from a listed login"), expect.stringContaining("from a listed bot"), expect.stringContaining("from the owner"),
    ]);
    expect((await sub(t, (await t.run((ctx) => ctx.db.query("prSubscriptions").first()))!._id)).review).toBe("none"); // the stranger's review changed nothing
  });

  it("the default policy (all) accepts anyone", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    await subscribeTo(t, dorkId);
    await deliver(t, "issue_comment", f.issueCommentEvent({ sender: f.mallory }));
    expect(await pendingKinds(t, dorkId)).toEqual(["comment"]);
  });

  it("never reacts to the App's own comments or reviews, even when the policy is 'all'", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    await subscribeTo(t, dorkId);
    await deliver(t, "issue_comment", f.issueCommentEvent({ sender: f.bot }));
    await deliver(t, "pull_request_review_comment", f.reviewCommentEvent({ sender: f.bot }));
    await deliver(t, "pull_request_review", f.reviewEvent("approved", { sender: f.bot }));
    expect(await inboxOf(t, dorkId)).toEqual([]);
  });
});

describe("CI", () => {
  it("a failing suite is delivered as 'attempt 1 of 2' and the next push counts as the attempt", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    expect(await failSuite(t)).toBe(200);
    expect(await sub(t, id)).toMatchObject({ ci: "failing", ciFailing: [1], ciNotified: true, ciFixAttempts: 0 });
    await fire(t, dorkId);
    const [first] = await notifies(t, dorkId);
    expect(first.text).toContain("ci_failed (attempt 1 of 2)");
    expect(first.text).toContain(`https://github.com/${f.REPO}/commit/c0ffee1/checks?check_suite_id=1`);

    await syncTo(t, "beef002"); // the agent's own push: no notification, but it is an attempt
    expect(await sub(t, id)).toMatchObject({ headSha: "beef002", ci: "pending", ciFailing: [], ciNotified: false, ciFixAttempts: 1, mergeable: null });
    expect(await pendingKinds(t, dorkId)).toEqual([]);
    await failSuite(t, { id: 2, sha: "beef002" });
    await fire(t, dorkId);
    expect((await notifies(t, dorkId))[1].text).toContain("ci_failed (attempt 2 of 2)");
  });

  it("two failed fix attempts stall the PR: one transcript event, one comment action, no more CI notifications", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    for (const [n, sha] of [[1, "c0ffee1"], [2, "beef002"]] as const) {
      if (n > 1) await syncTo(t, sha);
      await failSuite(t, { id: n, sha });
      await fire(t, dorkId);
    }
    expect(await notifies(t, dorkId)).toHaveLength(CI_FIX_MAX_ATTEMPTS);
    await syncTo(t, "beef003");
    expect((await sub(t, id)).ciFixAttempts).toBe(CI_FIX_MAX_ATTEMPTS);

    await failSuite(t, { id: 3, sha: "beef003" });
    expect(await sub(t, id)).toMatchObject({ status: "stalled", ci: "failing" });
    expect(await pendingKinds(t, dorkId)).toEqual([]);
    expect((await eventsOf(t, dorkId)).filter((e) => (e as { status?: string }).status === "stalled")).toEqual([
      { type: "subscription", repo: "octo/hello", number: 12, status: "stalled", reason: expect.stringContaining("a human is needed") },
    ]);
    const [action] = await scheduled(t, "github:postStallComment");
    expect(action.args[0]).toMatchObject({ subscriptionId: id, runUrl: `https://github.com/${f.REPO}/commit/beef003/checks?check_suite_id=3` });

    // Further failures and pushes while stalled: nothing for the agent, no second comment.
    await failSuite(t, { id: 4, sha: "beef003" });
    await syncTo(t, "beef004");
    await failSuite(t, { id: 5, sha: "beef004" });
    expect(await pendingKinds(t, dorkId)).toEqual([]);
    expect(await scheduled(t, "github:postStallComment")).toHaveLength(1);
    expect(await sub(t, id)).toMatchObject({ status: "stalled", ciFixAttempts: CI_FIX_MAX_ATTEMPTS, ci: "failing" });
  });

  it("the stall action posts ONE comment as the App, naming a human and the failing run; skips if a human resumed meanwhile", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId, { status: "stalled", ciFixAttempts: 2 });
    const runUrl = "https://github.com/octo/hello/commit/beef003/checks?check_suite_id=3";
    await t.action(internal.github.postStallComment, { subscriptionId: id, runUrl });
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toMatchObject({ repo: "octo/hello", number: 12 });
    expect(gh.comments[0].body).toContain("A human needs to take a look");
    expect(gh.comments[0].body).toContain(runUrl);
    expect(gh.tokens).toEqual([{ installationId: f.INSTALLATION, scope: { permissions: { issues: "write" } } }]);

    await t.run((ctx) => ctx.db.patch(id, { status: "active" }));
    await t.action(internal.github.postStallComment, { subscriptionId: id, runUrl });
    expect(gh.comments).toHaveLength(1);
  });

  it("the stall comment is retried after a transient GitHub error, but not after a permanent one", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId, { status: "stalled" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    gh.failComment = { status: 502 };
    await t.action(internal.github.postStallComment, { subscriptionId: id, runUrl: "u" });
    expect(await scheduled(t, "github:postStallComment")).toHaveLength(1);
    gh.failComment = { status: 403 };
    await t.run(async (ctx) => { for (const s of await ctx.db.system.query("_scheduled_functions").collect()) await ctx.scheduler.cancel(s._id); });
    await t.action(internal.github.postStallComment, { subscriptionId: id, runUrl: "u" });
    expect(await scheduled(t, "github:postStallComment")).toHaveLength(0);
    err.mockRestore();
  });

  it("a failure whose notification never left the debounce window is dropped when the head moves, and is not an attempt", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    await failSuite(t);
    expect(await pendingKinds(t, dorkId)).toEqual(["ci_failed"]);
    await syncTo(t, "beef002", f.alice);
    expect(await pendingKinds(t, dorkId)).toEqual([]);
    expect((await sub(t, id)).ciFixAttempts).toBe(0);
  });

  it("a push from a person after a delivered failure counts as an attempt too; a stale suite for an old head is ignored", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    await failSuite(t);
    await fire(t, dorkId);
    await syncTo(t, "beef002", f.alice);
    expect((await sub(t, id)).ciFixAttempts).toBe(1);
    await failSuite(t, { id: 9, sha: "c0ffee1" }); // the old head
    await passSuite(t, { id: 10, sha: "c0ffee1" });
    expect(await sub(t, id)).toMatchObject({ ci: "pending", ciFixAttempts: 1 });
    expect(await pendingKinds(t, dorkId)).toEqual([]);
  });

  it("suites for a fork's branch of the same name are ignored (only the current head SHA counts)", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    await deliver(t, "check_suite", f.checkSuiteEvent("failure", { headSha: "f0rk000", headBranch: "agent/x" }));
    expect(await sub(t, id)).toMatchObject({ ci: "pending" });
    expect(await pendingKinds(t, dorkId)).toEqual([]);
  });

  it("green resets the attempts, un-stalls, and one still-red suite keeps the PR failing", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId, { ciFixAttempts: 1 });
    await failSuite(t, { id: 1 });
    await failSuite(t, { id: 2 });
    await passSuite(t, { id: 1 });
    expect(await sub(t, id)).toMatchObject({ ci: "failing", ciFailing: [2], ciFixAttempts: 1 });
    await passSuite(t, { id: 2 });
    expect(await sub(t, id)).toMatchObject({ ci: "passing", ciFailing: [], ciFixAttempts: 0, ciNotified: false });

    await t.run((ctx) => ctx.db.patch(id, { status: "stalled", ciFixAttempts: 2 }));
    await passSuite(t, { id: 3 });
    expect(await sub(t, id)).toMatchObject({ status: "active", ciFixAttempts: 0 });
    expect((await eventsOf(t, dorkId)).at(-1)).toEqual({ type: "subscription", repo: "octo/hello", number: 12, status: "active", reason: "CI passed" });
  });

  it("cancelled, action_required and stale suites say nothing", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    for (const c of ["cancelled", "action_required", "stale"]) await deliver(t, "check_suite", f.checkSuiteEvent(c));
    expect(await sub(t, id)).toMatchObject({ ci: "pending" });
  });

  it("a human comment un-stalls and resets; a bot's comment does not", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId, { status: "stalled", ciFixAttempts: 2 });
    await deliver(t, "issue_comment", f.issueCommentEvent({ sender: f.coderabbit }));
    expect(await sub(t, id)).toMatchObject({ status: "stalled", ciFixAttempts: 2 });
    await deliver(t, "issue_comment", f.issueCommentEvent({ sender: f.alice }));
    expect(await sub(t, id)).toMatchObject({ status: "active", ciFixAttempts: 0 });
    expect(await eventsOf(t, dorkId)).toContainEqual({ type: "subscription", repo: "octo/hello", number: 12, status: "active", reason: "resumed by a comment" });
  });

  it("a comment the policy rejects does not un-stall", async () => {
    const t = makeT();
    const dorkId = await seed(t, { policy: { mode: "allowlist", logins: [] } });
    const id = await subscribeTo(t, dorkId, { status: "stalled", ciFixAttempts: 2 });
    await deliver(t, "issue_comment", f.issueCommentEvent({ sender: f.mallory }));
    expect(await sub(t, id)).toMatchObject({ status: "stalled", ciFixAttempts: 2 });
  });

  it("a message from the user to the dork un-stalls and resets", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId, { status: "stalled", ciFixAttempts: 2 });
    const other = await subscribeTo(t, dorkId, { number: 13, ciFixAttempts: 1 });
    await t.withIdentity({ subject: "u1" }).mutation(api.dorks.sendMessage, { dorkId, text: "go on" });
    expect(await sub(t, id)).toMatchObject({ status: "active", ciFixAttempts: 0 });
    expect(await sub(t, other)).toMatchObject({ status: "active", ciFixAttempts: 0 });
    expect(await eventsOf(t, dorkId)).toContainEqual({ type: "subscription", repo: "octo/hello", number: 12, status: "active", reason: "resumed by your message" });
  });
});

describe("ready", () => {
  it("green CI plus an approval delivers ready once per head SHA, in either order", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    await passSuite(t);
    expect(await pendingKinds(t, dorkId)).toEqual([]); // green alone is not ready
    await deliver(t, "pull_request_review", f.reviewEvent("approved", { body: "" }));
    expect(await sub(t, id)).toMatchObject({ review: "approved", readySha: "c0ffee1" });
    expect(await pendingKinds(t, dorkId)).toEqual(["ready"]); // a bare approval says nothing else
    await passSuite(t, { id: 2 });
    await deliver(t, "pull_request_review", f.reviewEvent("approved", { body: "" }));
    expect(await pendingKinds(t, dorkId)).toEqual(["ready"]); // still just one

    await fire(t, dorkId);
    expect((await notifies(t, dorkId))[0].text).toContain("Do not merge");

    await syncTo(t, "beef002"); // a new head must go green again, and the approval stands
    await passSuite(t, { id: 3, sha: "beef002" });
    expect(await pendingKinds(t, dorkId)).toEqual(["ready"]);
    expect((await sub(t, id)).readySha).toBe("beef002");
  });

  it("approval first, then green", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    await subscribeTo(t, dorkId);
    await deliver(t, "pull_request_review", f.reviewEvent("approved", { body: "LGTM" }));
    expect(await pendingKinds(t, dorkId)).toEqual(["review"]);
    await passSuite(t);
    expect(await pendingKinds(t, dorkId)).toEqual(["review", "ready"]);
  });

  it("is not ready while changes are requested, while CI is red, or while stalled", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    await deliver(t, "pull_request_review", f.reviewEvent("changes_requested"));
    await passSuite(t);
    expect(await sub(t, id)).toMatchObject({ review: "changes_requested", ci: "passing" });
    expect(await pendingKinds(t, dorkId)).toEqual(["review"]);

    await t.run((ctx) => ctx.db.patch(id, { review: "approved", ci: "failing", ciFailing: [7] }));
    await passSuite(t, { id: 1 });
    expect(await pendingKinds(t, dorkId)).toEqual(["review"]); // suite 7 is still red
  });

  it("review states: a comment-only review never downgrades; empty comment reviews are not worth a turn; changes requested always is", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId, { review: "approved" });
    await deliver(t, "pull_request_review", f.reviewEvent("commented", { body: "" }));
    expect((await sub(t, id)).review).toBe("approved");
    expect(await inboxOf(t, dorkId)).toEqual([]);
    await deliver(t, "pull_request_review", f.reviewEvent("commented", { body: "A thought" }));
    expect(await pendingKinds(t, dorkId)).toEqual(["review"]);
    await deliver(t, "pull_request_review", f.reviewEvent("changes_requested", { body: null }));
    expect((await sub(t, id)).review).toBe("changes_requested");
    expect(await pendingKinds(t, dorkId)).toEqual(["review", "review"]);
  });
});

describe("closing", () => {
  it("merged → subscription ended with state merged, a transcript event and a closed notice", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    await deliver(t, "pull_request", f.pullRequestEvent("closed", { merged: true, state: "closed" }, { sender: f.alice }));
    expect(await sub(t, id)).toMatchObject({ status: "ended", state: "merged" });
    expect(await eventsOf(t, dorkId)).toContainEqual({ type: "subscription", repo: "octo/hello", number: 12, status: "ended", reason: "merged" });
    await fire(t, dorkId);
    expect((await notifies(t, dorkId))[0].text).toContain("Merged by alice.");
    await deliver(t, "issue_comment", f.issueCommentEvent()); // and nothing more is routed
    expect(await pendingKinds(t, dorkId)).toEqual([]);
  });

  it("closed without merging is recorded as closed, for every dork subscribed", async () => {
    const t = makeT();
    const a = await seed(t);
    const id = await subscribeTo(t, a);
    await deliver(t, "pull_request", f.pullRequestEvent("closed", { state: "closed" }));
    expect(await sub(t, id)).toMatchObject({ status: "ended", state: "closed" });
    expect(await eventsOf(t, a)).toContainEqual({ type: "subscription", repo: "octo/hello", number: 12, status: "ended", reason: "closed" });
  });

  it("a close by the App itself ends the subscription without waking the dork", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    await deliver(t, "pull_request", f.pullRequestEvent("closed", { merged: true }, { sender: f.bot }));
    expect((await sub(t, id)).status).toBe("ended");
    expect(await inboxOf(t, dorkId)).toEqual([]);
  });
});

describe("self-sent events", () => {
  it("its own pushes still move the head and reset CI, but wake nobody; its base changes only update state", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId, { ci: "passing" });
    await syncTo(t, "beef002", f.bot);
    await deliver(t, "pull_request", f.baseChanged("old-base", { baseRef: "main" }, { sender: f.bot }));
    expect(await sub(t, id)).toMatchObject({ headSha: "beef002", ci: "pending" });
    expect(await inboxOf(t, dorkId)).toEqual([]);
    expect(await sub(t, id)).toMatchObject({ baseRef: "main" });
  });

  it("a different bot (not this App) is treated like any other author", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    await subscribeTo(t, dorkId);
    await deliver(t, "issue_comment", f.issueCommentEvent({ sender: { login: "other-app[bot]", type: "Bot" } }));
    expect(await pendingKinds(t, dorkId)).toEqual(["comment"]);
  });
});

describe("base branch", () => {
  it("a base change is reported once and clears the stale mergeability", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId, { baseRef: "feature/parent" });
    await deliver(t, "pull_request", f.baseChanged("feature/parent", { baseRef: "main" }));
    expect(await sub(t, id)).toMatchObject({ baseRef: "main", mergeable: null });
    expect((await inboxOf(t, dorkId)).map((r) => [r.kind, r.summary])).toEqual([["base_changed", "alice changed the base branch from feature/parent to main."]]);
    await deliver(t, "pull_request", f.baseChanged("feature/parent", { baseRef: "main" })); // hydration already knows
    expect(await inboxOf(t, dorkId)).toHaveLength(1);
  });

  it("a push to a base branch schedules the mergeability re-read for the PRs that target it, nothing for other branches", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const a = await subscribeTo(t, dorkId);
    await subscribeTo(t, dorkId, { number: 13, baseRef: "release" });
    await deliver(t, "push", f.pushEvent("feature-unrelated"));
    expect(await scheduled(t, "github:checkMergeable")).toHaveLength(0);
    await deliver(t, "push", f.pushEvent("main", { sha: "d00d1e2" }));
    const [job] = await scheduled(t, "github:checkMergeable");
    expect(job.args[0]).toEqual({ installationId: f.INSTALLATION, repo: f.REPO, baseSha: "d00d1e2", attempt: 0, prs: [{ subscriptionId: a, number: 12 }] });
    expect(job.scheduledTime - NOW).toBe(MERGEABLE_POLL_DELAYS_MS[0]);
  });

  it("a push to the base by the App itself is not filtered: the other PRs still need checking", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    await subscribeTo(t, dorkId);
    await deliver(t, "push", f.pushEvent("main", { sender: f.bot }));
    expect(await scheduled(t, "github:checkMergeable")).toHaveLength(1);
  });

  it("the check polls with backoff while GitHub has no answer, then notifies a conflict once per base SHA", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    const run = (baseSha: string, attempt = 0) => t.action(internal.github.checkMergeable, { installationId: f.INSTALLATION, repo: f.REPO, baseSha, attempt, prs: [{ subscriptionId: id, number: 12 }] });

    gh.mergeable = [null];
    await run("d00d1e2");
    const [again] = await scheduled(t, "github:checkMergeable");
    expect(again.args[0]).toMatchObject({ attempt: 1, prs: [{ subscriptionId: id, number: 12 }] });
    expect(again.scheduledTime - NOW).toBe(MERGEABLE_POLL_DELAYS_MS[1]);
    expect(await inboxOf(t, dorkId)).toEqual([]);

    gh.mergeable = [false];
    await run("d00d1e2", 1);
    expect(await sub(t, id)).toMatchObject({ mergeable: false, conflictSha: "d00d1e2" });
    expect((await inboxOf(t, dorkId)).map((r) => r.kind)).toEqual(["conflict"]);
    await run("d00d1e2", 2); // the same base commit again
    expect(await inboxOf(t, dorkId)).toHaveLength(1);
    await run("e11e2f3"); // the base moved on and it still conflicts
    expect(await inboxOf(t, dorkId)).toHaveLength(2);

    gh.mergeable = [true];
    await run("f22f3a4");
    expect(await sub(t, id)).toMatchObject({ mergeable: true });
    expect(await inboxOf(t, dorkId)).toHaveLength(2);
  });

  it("gives up polling after the last delay; retries a transient GitHub failure but not a permanent one", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = (attempt: number) => t.action(internal.github.checkMergeable, { installationId: f.INSTALLATION, repo: f.REPO, baseSha: "x", attempt, prs: [{ subscriptionId: id, number: 12 }] });
    gh.mergeable = [null];
    await run(MERGEABLE_POLL_DELAYS_MS.length - 1);
    expect(await scheduled(t, "github:checkMergeable")).toHaveLength(0);
    gh.failPull = { status: 503 };
    await run(0);
    expect(await scheduled(t, "github:checkMergeable")).toHaveLength(1);
    await t.run(async (ctx) => { for (const s of await ctx.db.system.query("_scheduled_functions").collect()) await ctx.scheduler.cancel(s._id); });
    gh.failPull = { status: 404 };
    await run(0);
    expect(await scheduled(t, "github:checkMergeable")).toHaveLength(0);
    err.mockRestore();
  });

  it("an ended or closed subscription gets no conflict notice", async () => {
    const t = makeT();
    const dorkId = await seed(t);
    const id = await subscribeTo(t, dorkId, { status: "ended" });
    await t.mutation(internal.github.setMergeable, { subscriptionId: id, baseSha: "x", mergeable: false });
    expect(await inboxOf(t, dorkId)).toEqual([]);
  });
});
