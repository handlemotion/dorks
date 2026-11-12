import { describe, expect, it } from "vite-plus/test";
import { append } from "../src/lifecycle/dispatch";
import { AGENT_COMMENT_GRACE_MS } from "../src/services/githubIngest";
import { pollOnce, POLL_MS } from "../src/services/poller";
import { updateSettings } from "../src/services/settings";
import * as subs from "../src/services/subscriptions";
import { fakeFetch, harness, NOW } from "./harness";

// The PR poller against a miniature GitHub: conditional requests, a baseline that does not replay history, and the events a change produces.

interface Comment { id: number; body: string; html_url: string; user: { login: string; type: string }; created_at: string; path?: string }
const person = (login: string, type = "User") => ({ login, type });

function github() {
  const state = {
    token: "ghp_test",
    pr: { title: "Add thing", state: "open" as "open" | "closed", merged: false, mergeable: true as boolean | null, merged_by: null as null | { login: string; type: string }, head: { ref: "agent/x", sha: "aaa1111" }, base: { ref: "main", sha: "base000" } },
    reviews: [] as { id: number; state: string; body: string; html_url: string; user: { login: string; type: string } }[],
    issueComments: [] as Comment[],
    reviewComments: [] as Comment[],
    suites: {} as Record<string, { id: number; status: string; conclusion: string | null; latest_check_runs_count: number }[]>,
    missing: false,
    rateLimitedUntil: 0,
    unauthorized: false,
  };
  const etag = (v: unknown) => `"${[...JSON.stringify(v)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}"`;
  const conditional = (url: URL, init: RequestInit | undefined, body: unknown) => {
    const tag = etag([url.search, body]);
    const sent = new Headers(init?.headers).get("if-none-match");
    if (sent === tag) return new Response(null, { status: 304, headers: { etag: tag } });
    return new Response(JSON.stringify(body), { status: 200, headers: { etag: tag, "content-type": "application/json" } });
  };
  const f = fakeFetch((url, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    if (state.unauthorized || auth !== `Bearer ${state.token}`) return new Response("{}", { status: 401 });
    if (state.rateLimitedUntil) return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(state.rateLimitedUntil / 1000)) } });
    const p = url.pathname;
    if (p === "/user") return Response.json({ login: "agent-bot" });
    if (!p.startsWith("/repos/octo/hello/")) return new Response("{}", { status: 404 });
    if (state.missing) return new Response("{}", { status: 404 });
    const since = url.searchParams.get("since");
    const after = <T extends { created_at: string }>(list: T[]) => (since ? list.filter((c) => c.created_at > since) : list);
    if (p === "/repos/octo/hello/pulls/7") return conditional(url, init, state.pr);
    if (p === "/repos/octo/hello/pulls/7/reviews") return conditional(url, init, state.reviews);
    if (p === "/repos/octo/hello/issues/7/comments") return conditional(url, init, after(state.issueComments));
    if (p === "/repos/octo/hello/pulls/7/comments") return conditional(url, init, after(state.reviewComments));
    const m = /^\/repos\/octo\/hello\/commits\/([^/]+)\/check-suites$/.exec(p);
    if (m) return conditional(url, init, { check_suites: state.suites[m[1]] ?? [] });
    return new Response("{}", { status: 404 });
  });
  return { state, fetch: f };
}

async function setup() {
  const gh = github();
  const h = harness({ fetch: gh.fetch });
  const id = h.seed("idle");
  await updateSettings(h.app, { githubToken: gh.state.token });
  h.app.db.tx(() => subs.subscribe(h.app, h.dork(id), "octo/hello", 7, "agent"));
  const sub = () => subs.subscriptionsOfDork(h.app, id)[0];
  const inbox = () => h.app.db.all<{ kind: string; summary: string }>("SELECT kind, summary FROM inbox WHERE dork_id = ? ORDER BY id", id);
  const tick = async () => {
    h.clock.t += POLL_MS;
    return pollOnce(h.app);
  };
  const at = (n: number) => new Date(NOW + n).toISOString();
  return { gh, h, id, sub, inbox, tick, at };
}

describe("poller", () => {
  it("does nothing without subscriptions, and waits without a token", async () => {
    const h = harness();
    expect(await pollOnce(h.app)).toBeNull();
    const id = h.seed("idle");
    h.app.db.tx(() => subs.subscribe(h.app, h.dork(id), "octo/hello", 7, "agent"));
    expect(await pollOnce(h.app)).toBe(POLL_MS * 2);
  });

  it("the first look fills the subscription in, learns whose token it is, and replays nothing", async () => {
    const s = await setup();
    s.gh.state.reviews.push({ id: 1, state: "APPROVED", body: "lgtm", html_url: "r1", user: person("bob") });
    s.gh.state.issueComments.push({ id: 10, body: "old", html_url: "c10", user: person("bob"), created_at: s.at(-1000) });
    s.gh.state.reviewComments.push({ id: 20, body: "older", html_url: "c20", user: person("bob"), created_at: s.at(-1000), path: "a.ts" });
    expect(await pollOnce(s.h.app)).toBe(POLL_MS);
    expect(s.sub()).toMatchObject({ title: "Add thing", headRef: "agent/x", headSha: "aaa1111", baseRef: "main", state: "open", mergeable: true, review: "approved" });
    expect(s.sub().poll).toMatchObject({ baselined: true, lastReviewId: 1, lastCommentId: 10, lastReviewCommentId: 20, baseSha: "base000" });
    expect(s.inbox()).toEqual([]);
    expect(s.h.app.db.get("SELECT github_login FROM settings WHERE id = 1")?.github_login).toBe("agent-bot");
  });

  it("every later request is conditional, and a 304 changes nothing", async () => {
    const s = await setup();
    await pollOnce(s.h.app);
    await s.tick(); // the comment lists move to a `since` URL once baselined: their first read there is not yet conditional
    s.gh.fetch.calls.length = 0;
    await s.tick();
    const reads = s.gh.fetch.calls.filter((c) => c.url.startsWith("/repos/"));
    expect(reads.length).toBeGreaterThanOrEqual(5); // pr, reviews, two comment lists, check suites
    expect(reads.every((c) => c.headers.get("if-none-match"))).toBe(true);
    expect(s.inbox()).toEqual([]);
  });

  it("a new comment from someone else reaches the agent; the agent's own does not", async () => {
    const s = await setup();
    await pollOnce(s.h.app);
    // The agent runs a turn from +5.5 s to +6.5 s. The token's login is both the agent's and its owner's: what it wrote during the
    // turn (or within the grace after) is the agent's; what it wrote while the dork was idle is the owner's.
    const status = (t: number, state: "working" | "idle") => {
      s.h.clock.t = NOW + t;
      s.h.app.db.tx(() => append(s.h.app, s.id, { type: "status", state }));
    };
    status(5_500, "working");
    status(6_500, "idle");
    s.h.clock.t = NOW;
    s.gh.state.issueComments.push({ id: 11, body: "please rename", html_url: "c11", user: person("alice"), created_at: s.at(5_000) });
    s.gh.state.issueComments.push({ id: 12, body: "done!", html_url: "c12", user: person("agent-bot"), created_at: s.at(6_000) });
    s.gh.state.issueComments.push({ id: 13, body: "replied", html_url: "c13", user: person("agent-bot"), created_at: s.at(6_500 + AGENT_COMMENT_GRACE_MS) });
    s.gh.state.reviewComments.push({ id: 21, body: "nit", html_url: "c21", user: person("alice"), created_at: s.at(7_000), path: "src/a.ts" });
    s.gh.state.reviewComments.push({ id: 22, body: "also this", html_url: "c22", user: person("agent-bot"), created_at: s.at(60_000), path: "src/b.ts" });
    await s.tick();
    expect(s.inbox().map((r) => r.summary.split(":")[0])).toEqual(["alice commented", "alice commented on src/a.ts", "agent-bot commented on src/b.ts"]);
    expect(s.inbox()[0].summary).toContain("please rename");
    await s.tick(); // not delivered twice
    expect(s.inbox()).toHaveLength(3);
  });

  it("a new review updates the state and speaks when it has something to say", async () => {
    const s = await setup();
    await pollOnce(s.h.app);
    s.gh.state.reviews.push({ id: 2, state: "CHANGES_REQUESTED", body: "fix the tests", html_url: "r2", user: person("alice") });
    await s.tick();
    expect(s.sub().review).toBe("changes_requested");
    expect(s.inbox()[0]).toMatchObject({ kind: "review" });
    expect(s.inbox()[0].summary).toContain("requested changes: fix the tests");
  });

  it("a new head is a push; CI failing on it is handed over once, passing completes it", async () => {
    const s = await setup();
    await pollOnce(s.h.app);
    s.gh.state.pr.head.sha = "bbb2222";
    s.gh.state.suites["bbb2222"] = [{ id: 31, status: "completed", conclusion: "failure", latest_check_runs_count: 2 }, { id: 32, status: "in_progress", conclusion: null, latest_check_runs_count: 1 }];
    await s.tick();
    expect(s.sub()).toMatchObject({ headSha: "bbb2222", ci: "failing", ciFailing: [31], ciNotified: true });
    expect(s.inbox().map((r) => r.kind)).toEqual(["ci_failed"]);
    await s.tick(); // the same failure is not reported again
    expect(s.inbox()).toHaveLength(1);

    // the agent pushes a fix: a new head; its suites pass
    s.gh.state.pr.head.sha = "ccc3333";
    s.gh.state.suites["ccc3333"] = [{ id: 41, status: "completed", conclusion: "success", latest_check_runs_count: 3 }];
    await s.tick();
    expect(s.sub()).toMatchObject({ headSha: "ccc3333", ci: "passing", ciFixAttempts: 0 });
  });

  it("an approved PR whose CI is green is ready, exactly once", async () => {
    const s = await setup();
    await pollOnce(s.h.app);
    s.gh.state.suites["aaa1111"] = [{ id: 51, status: "completed", conclusion: "success", latest_check_runs_count: 1 }];
    s.gh.state.reviews.push({ id: 3, state: "APPROVED", body: "", html_url: "r3", user: person("alice") });
    await s.tick();
    await s.tick();
    expect(s.inbox().filter((r) => r.kind === "ready")).toHaveLength(1);
    expect(s.sub().readySha).toBe("aaa1111");
  });

  it("a base that moves under the PR and breaks it is a conflict, once", async () => {
    const s = await setup();
    await pollOnce(s.h.app);
    s.gh.state.pr.base.sha = "base111";
    s.gh.state.pr.mergeable = false;
    await s.tick();
    await s.tick();
    expect(s.sub().mergeable).toBe(false);
    expect(s.inbox().filter((r) => r.kind === "conflict")).toHaveLength(1);
  });

  it("mergeability GitHub has not computed yet is asked for again, not cached", async () => {
    const s = await setup();
    s.gh.state.pr.mergeable = null;
    await pollOnce(s.h.app);
    expect(s.sub().mergeable).toBeNull();
    s.gh.fetch.calls.length = 0;
    s.gh.state.pr.mergeable = true;
    await s.tick();
    const pr = s.gh.fetch.calls.find((c) => c.url === "/repos/octo/hello/pulls/7")!;
    expect(pr.headers.get("if-none-match")).toBeNull();
    expect(s.sub().mergeable).toBe(true);
  });

  it("a merged PR ends the subscription and the transcript says so", async () => {
    const s = await setup();
    await pollOnce(s.h.app);
    s.gh.state.pr.state = "closed";
    s.gh.state.pr.merged = true;
    s.gh.state.pr.merged_by = person("alice");
    await s.tick();
    expect(s.sub()).toMatchObject({ status: "ended", state: "merged" });
    expect(s.h.events(s.id).map((e) => e.body.type)).toContain("pr_merged");
    expect(s.inbox().map((r) => r.kind)).toEqual(["closed"]);
    expect(await pollOnce(s.h.app)).toBeNull(); // nothing left to watch
  });

  it("a PR that is already merged when first seen just ends", async () => {
    const s = await setup();
    s.gh.state.pr.state = "closed";
    s.gh.state.pr.merged = true;
    await pollOnce(s.h.app);
    expect(s.sub()).toMatchObject({ status: "ended", state: "merged" });
    expect(s.inbox()).toEqual([]);
  });

  it("a PR the token cannot see ends the subscription", async () => {
    const s = await setup();
    s.gh.state.missing = true;
    await pollOnce(s.h.app);
    expect(s.sub().status).toBe("ended");
    expect(s.h.events(s.id).map((e) => e.body)).toContainEqual(expect.objectContaining({ type: "subscription", status: "ended", reason: "PR not found or not accessible to your GitHub token" }));
  });

  it("a rate limit pauses polling until it lifts, without touching the subscription", async () => {
    const s = await setup();
    await pollOnce(s.h.app);
    s.gh.state.rateLimitedUntil = NOW + 10 * 60_000;
    const next = await s.tick();
    expect(next).toBeGreaterThan(8 * 60_000);
    expect(s.sub().status).toBe("active");
  });

  it("a rejected token backs off for minutes instead of hammering", async () => {
    const s = await setup();
    s.gh.state.unauthorized = true;
    expect(await pollOnce(s.h.app)).toBe(5 * 60_000);
    expect(s.sub().status).toBe("active");
  });

  it("the poll job re-arms itself while anything is being watched, and only then", async () => {
    const s = await setup();
    expect(s.h.hasTimer("", "poll")).toBe(true); // subscribe started it
    await s.h.settle();
    expect(s.h.hasTimer("", "poll")).toBe(true);
    s.h.app.db.tx(() => subs.unsubscribe(s.h.app, s.id, "octo/hello", 7));
    await s.h.advance(POLL_MS + 1);
    expect(s.h.hasTimer("", "poll")).toBe(false);
  });
});

