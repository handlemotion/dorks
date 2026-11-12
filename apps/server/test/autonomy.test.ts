import { CI_FIX_MAX_ATTEMPTS, DEFAULT_COMMENT_POLICY } from "@dorks/shared";
import { describe, expect, it } from "vite-plus/test";
import { update } from "../src/db";
import { append } from "../src/lifecycle/dispatch";
import { commentAllowed, ingestEvent, SERVER_COMMENT_MARK, type IngestEnv, type PrEvent } from "../src/services/githubIngest";
import * as subs from "../src/services/subscriptions";
import { harness, type Harness } from "./harness";

const env: IngestEnv = { ownLogin: "agent-bot", policy: DEFAULT_COMMENT_POLICY };
const human = { login: "alice", bot: false };

function setup(state: Parameters<Harness["seed"]>[0] = "idle") {
  const h = harness();
  const id = h.seed(state);
  const sub = (number = 7, source: subs.Subscription["source"] = "agent") => h.app.db.tx(() => subs.subscribe(h.app, h.dork(id), "Octo/Hello", number, source));
  const get = (number = 7) => subs.subscriptionsOfDork(h.app, id).find((s) => s.number === number)!;
  const ingest = (e: PrEvent, e2: IngestEnv = env, number = 7) => h.app.db.tx(() => ingestEvent(h.app, get(number).id, e, e2));
  const patch = (patchBody: Record<string, unknown>, number = 7) => update(h.app.db, "pr_subscriptions", { id: get(number).id }, patchBody);
  const inbox = () => h.app.db.all<{ kind: string; summary: string; delivered: number }>("SELECT kind, summary, delivered FROM inbox WHERE dork_id = ? ORDER BY id", id);
  return { h, id, sub, get, ingest, patch, inbox };
}

const errorCode = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { error?: { code?: string } }).error?.code ?? "other";
  }
};

describe("subscriptions", () => {
  it("subscribes (repo stored lowercase), starts a poll, and appends a subscription event", () => {
    const s = setup();
    const sub = s.sub(7, "agent");
    expect(sub).toMatchObject({ repo: "octo/hello", number: 7, url: "https://github.com/octo/hello/pull/7", source: "agent", status: "active", ci: "unknown", review: "none", mergeable: null, state: "open" });
    expect(s.h.hasTimer("", "poll")).toBe(true);
    expect(s.h.events(s.id).map((e) => e.body)).toContainEqual({ type: "subscription", repo: "octo/hello", number: 7, status: "active", reason: "subscribed (agent)" });
  });

  it("the shim's auto subscription is the PR-opened moment: event and headline link", () => {
    const s = setup();
    s.sub(7, "auto");
    expect(s.h.events(s.id).map((e) => e.body.type)).toContain("pr_opened");
    expect(s.h.dork(s.id).prUrl).toBe("https://github.com/octo/hello/pull/7");
  });

  it("is idempotent: no second row or event, and a stalled one is not un-stalled by the agent", () => {
    const s = setup();
    s.sub();
    s.patch({ status: "stalled" });
    const before = s.h.events(s.id).length;
    s.sub();
    expect(subs.subscriptionsOfDork(s.h.app, s.id)).toHaveLength(1);
    expect(s.get().status).toBe("stalled");
    expect(s.h.events(s.id)).toHaveLength(before);
  });

  it("rejects bad input and caps subscriptions per dork", () => {
    const s = setup();
    const dork = s.h.dork(s.id);
    const subscribe = (repo: string, n: number) => s.h.app.db.tx(() => subs.subscribe(s.h.app, dork, repo, n, "agent"));
    expect(errorCode(() => subscribe("nope", 1))).toBe("invalid");
    expect(errorCode(() => subscribe("o/..", 1))).toBe("invalid");
    expect(errorCode(() => subscribe("o/r", 0))).toBe("invalid");
    expect(errorCode(() => subscribe("o/r", 1.5))).toBe("invalid");
    for (let i = 1; i <= subs.MAX_SUBSCRIPTIONS_PER_DORK; i++) subscribe("o/r", i);
    expect(errorCode(() => subscribe("o/r", 9999))).toBe("limit");
    subscribe("o/r", 1); // the existing one is still fine
  });

  it("views map 1:1 onto the shared shape and hide ended subscriptions; only the calling dork's are listed", () => {
    const s = setup();
    s.sub(7);
    s.sub(8);
    s.patch({ status: "ended" }, 8);
    const other = s.h.seed("idle");
    s.h.app.db.tx(() => subs.subscribe(s.h.app, s.h.dork(other), "x/y", 1, "agent"));
    expect(subs.liveSubscriptionViews(s.h.app, s.id).map((v) => v.number)).toEqual([7]);
    expect(subs.liveSubscriptionViews(s.h.app, other).map((v) => v.repo)).toEqual(["x/y"]);
  });

  it("unsubscribe ends it, appends an event, drops what was buffered for it; unknown PRs are a no-op", () => {
    const s = setup();
    s.sub();
    s.h.app.db.run("INSERT INTO inbox (dork_id, subscription_id, kind, summary, created_at, delivered) VALUES (?, ?, 'comment', 'x', 1, 0)", s.id, s.get().id);
    s.h.app.db.tx(() => subs.unsubscribe(s.h.app, s.id, "octo/hello", 7));
    expect(s.get().status).toBe("ended");
    expect(s.inbox()[0].delivered).toBe(1);
    expect(s.h.events(s.id).map((e) => e.body)).toContainEqual(expect.objectContaining({ type: "subscription", status: "ended", reason: "unsubscribed" }));
    expect(() => s.h.app.db.tx(() => subs.unsubscribe(s.h.app, s.id, "octo/hello", 99))).not.toThrow();
  });

  it("an agent re-subscribing after ending keeps the CI attempt budget; the user resets it", () => {
    const s = setup();
    s.sub();
    s.patch({ ciFixAttempts: 2 });
    s.h.app.db.tx(() => subs.unsubscribe(s.h.app, s.id, "octo/hello", 7));
    s.sub(7, "agent");
    expect(s.get()).toMatchObject({ status: "active", ciFixAttempts: 2 });
    s.sub(7, "user");
    expect(s.get().ciFixAttempts).toBe(0);
  });

  it("resume un-stalls and resets the budget, with an event", () => {
    const s = setup();
    s.sub();
    s.patch({ status: "stalled", ciFixAttempts: 2 });
    s.h.app.db.tx(() => subs.resume(s.h.app, s.h.dork(s.id), "octo/hello", 7));
    expect(s.get()).toMatchObject({ status: "active", ciFixAttempts: 0 });
    expect(s.h.events(s.id).map((e) => e.body)).toContainEqual(expect.objectContaining({ type: "subscription", status: "active", reason: "resumed" }));
    expect(errorCode(() => s.h.app.db.tx(() => subs.resume(s.h.app, s.h.dork(s.id), "octo/hello", 99)))).toBe("not_found");
  });

  it("the poller only looks at open, live subscriptions of dorks that are neither archived nor being deleted", () => {
    const s = setup();
    s.sub(1);
    s.sub(2);
    s.sub(3);
    s.patch({ state: "merged" }, 2);
    s.patch({ status: "ended" }, 3);
    expect(subs.pollable(s.h.app).map((x) => x.number)).toEqual([1]);
    update(s.h.app.db, "dorks", { id: s.id }, { archived: true });
    expect(subs.pollable(s.h.app)).toEqual([]);
  });
});

describe("comment policy", () => {
  it("all accepts anyone", () => {
    expect(commentAllowed({ mode: "all" }, "alice", "Agent-Bot")).toBe(true);
  });
  it("an allowlist is case-insensitive, lists bots by login, and always lets the token's owner through", () => {
    const policy = { mode: "allowlist" as const, logins: ["Alice", "coderabbitai[bot]"] };
    expect(commentAllowed(policy, "alice", "agent-bot")).toBe(true);
    expect(commentAllowed(policy, "CodeRabbitAI[bot]", "agent-bot")).toBe(true);
    expect(commentAllowed(policy, "mallory", "agent-bot")).toBe(false);
    expect(commentAllowed(policy, "AGENT-bot", "agent-bot")).toBe(true); // whether it was really the agent is byAgent's call
  });
});

describe("what a change on the PR does", () => {
  it("closed/merged ends the subscription and tells the agent unless it did it itself", () => {
    const s = setup();
    s.sub();
    s.ingest({ kind: "pr_closed", merged: true, sender: human });
    expect(s.get()).toMatchObject({ status: "ended", state: "merged" });
    expect(s.inbox().map((r) => r.kind)).toEqual(["closed"]);
    expect(s.h.events(s.id).map((e) => e.body.type)).toContain("pr_merged");

    const t = setup();
    t.sub();
    t.ingest({ kind: "pr_closed", merged: false, sender: { login: "agent-bot", bot: true } });
    expect(t.get()).toMatchObject({ status: "ended", state: "closed" });
    expect(t.inbox()).toEqual([]);
  });

  it("a push moves the head; one that answers a handed-over failure is a fix attempt, one that races the debounce is not", () => {
    const s = setup();
    s.sub();
    s.patch({ headSha: "aaa1111", ci: "failing", ciNotified: true });
    s.ingest({ kind: "pr_synchronize", headSha: "bbb2222", headRef: "agent/x" });
    expect(s.get()).toMatchObject({ headSha: "bbb2222", ci: "pending", ciFixAttempts: 1, ciFailing: [], ciNotified: false, mergeable: null });
    s.ingest({ kind: "pr_synchronize", headSha: "bbb2222", headRef: "agent/x" }); // the same head again: nothing
    expect(s.get().ciFixAttempts).toBe(1);

    // a failure still waiting out the debounce never reached the agent: dropped, and the push is not an attempt
    const t = setup();
    t.sub();
    t.patch({ headSha: "aaa1111", ciNotified: true });
    t.h.app.db.run("INSERT INTO inbox (dork_id, subscription_id, kind, summary, created_at, delivered) VALUES (?, ?, 'ci_failed', 'x', 1, 0)", t.id, t.get().id);
    t.ingest({ kind: "pr_synchronize", headSha: "ccc3333", headRef: "agent/x" });
    expect(t.get().ciFixAttempts).toBe(0);
    expect(t.inbox().filter((r) => r.kind === "ci_failed")).toEqual([]);
  });

  it("a base change retargets and tells the agent", () => {
    const s = setup();
    s.sub();
    s.patch({ baseRef: "feature-a", conflictSha: "old" });
    s.ingest({ kind: "pr_base_changed", baseRef: "main", from: "feature-a", sender: human });
    expect(s.get()).toMatchObject({ baseRef: "main", mergeable: null, conflictSha: undefined });
    expect(s.inbox()[0]).toMatchObject({ kind: "base_changed", summary: "alice changed the base branch from feature-a to main." });
  });

  it("a base change the agent made mid-turn wakes nobody; one with no known author still does", () => {
    const s = setup();
    s.sub();
    s.patch({ baseRef: "feature-a" });
    s.h.app.db.tx(() => append(s.h.app, s.id, { type: "status", state: "working" }));
    s.ingest({ kind: "pr_base_changed", baseRef: "main", from: "feature-a", sender: { login: "agent-bot", bot: false }, at: s.h.clock.t + 1_000 });
    expect(s.inbox()).toEqual([]);
    s.ingest({ kind: "pr_base_changed", baseRef: "dev", from: "main" });
    expect(s.inbox()[0]).toMatchObject({ kind: "base_changed", summary: "Changed the base branch from main to dev." });
  });

  it("reviews: a comment-only review never downgrades an approval; a bare approval is recorded without a notification", () => {
    const s = setup();
    s.sub();
    s.ingest({ kind: "review", state: "approved", body: "", url: "u", sender: human });
    expect(s.get().review).toBe("approved");
    expect(s.inbox()).toEqual([]); // bare: its inline comments arrive as their own events
    s.ingest({ kind: "review", state: "commented", body: "nit", url: "u", sender: human });
    expect(s.get().review).toBe("approved");
    expect(s.inbox().map((r) => r.kind)).toEqual(["review"]);
    s.ingest({ kind: "review", state: "changes_requested", body: "", url: "u", sender: human });
    expect(s.get().review).toBe("changes_requested");
    expect(s.inbox().map((r) => r.kind)).toEqual(["review", "review"]); // a change request always speaks
  });

  it("the agent's own comments and reviews never wake it, and the policy filters the rest", () => {
    const s = setup();
    s.sub();
    s.ingest({ kind: "comment", body: "my own", url: "u", sender: { login: "Agent-Bot", bot: true } });
    s.ingest({ kind: "review", state: "approved", body: "ok", url: "u", sender: { login: "agent-bot", bot: true } });
    expect(s.inbox()).toEqual([]);
    const allow: IngestEnv = { ownLogin: "agent-bot", policy: { mode: "allowlist", logins: ["alice"] } };
    s.ingest({ kind: "comment", body: "from mallory", url: "u", sender: { login: "mallory", bot: false } }, allow);
    expect(s.inbox()).toEqual([]);
    s.ingest({ kind: "comment", body: "from alice", url: "u", path: "a.ts", sender: human }, allow);
    expect(s.inbox()[0].summary).toContain("alice commented on a.ts: from alice");
  });

  it("a person's comment resets the CI budget and resumes a stalled subscription; a bot's does not", () => {
    const s = setup();
    s.sub();
    s.patch({ status: "stalled", ciFixAttempts: 2 });
    s.ingest({ kind: "comment", body: "bot says", url: "u", sender: { login: "ci-bot[bot]", bot: true } });
    expect(s.get()).toMatchObject({ status: "stalled", ciFixAttempts: 2 });
    // the server's own stall notice is posted with the token while the dork is idle: it is nobody's input
    s.ingest({ kind: "comment", body: `A human needs to take a look.\n\n${SERVER_COMMENT_MARK}`, url: "u", sender: { login: "agent-bot", bot: false }, at: s.h.clock.t });
    expect(s.get()).toMatchObject({ status: "stalled", ciFixAttempts: 2 });
    expect(s.inbox().map((r) => r.summary)).toEqual(["ci-bot[bot] commented: bot says (u)"]);
    s.ingest({ kind: "comment", body: "i looked", url: "u", sender: human });
    expect(s.get()).toMatchObject({ status: "active", ciFixAttempts: 0 });
  });

  it("a failing check suite of the current head is handed to the agent; other heads are ignored", () => {
    const s = setup();
    s.sub();
    s.patch({ headSha: "abc1234def" });
    s.ingest({ kind: "check_suite", suiteId: 5, headSha: "zzz9999", outcome: "fail" });
    expect(s.inbox()).toEqual([]);
    s.ingest({ kind: "check_suite", suiteId: 5, headSha: "abc1234def", outcome: "fail" });
    expect(s.get()).toMatchObject({ ci: "failing", ciFailing: [5], ciNotified: true });
    expect(s.inbox()[0]).toMatchObject({ kind: "ci_failed" });
    expect(s.inbox()[0].summary).toContain("abc1234");
  });

  it("after the attempt budget the subscription stalls once: an event, no notification, one comment job", () => {
    const s = setup();
    s.sub();
    s.patch({ headSha: "abc1234def", ciFixAttempts: CI_FIX_MAX_ATTEMPTS });
    s.ingest({ kind: "check_suite", suiteId: 9, headSha: "abc1234def", outcome: "fail" });
    expect(s.get()).toMatchObject({ status: "stalled", ci: "failing" });
    expect(s.inbox()).toEqual([]);
    expect(s.h.app.db.get("SELECT payload FROM timers WHERE owner = ? AND name = ?", s.id, `stall:${s.get().id}`)).toBeTruthy();
    expect(s.h.events(s.id).map((e) => e.body)).toContainEqual(expect.objectContaining({ type: "subscription", status: "stalled" }));
    s.ingest({ kind: "check_suite", suiteId: 10, headSha: "abc1234def", outcome: "fail" }); // nothing more reaches the agent
    expect(s.inbox()).toEqual([]);
  });

  it("one green suite proves nothing; ci_green resets the budget, un-stalls, and delivers ready once if approved", () => {
    const s = setup();
    s.sub();
    s.patch({ headSha: "abc1234def", ci: "failing", ciFailing: [5], status: "stalled", ciFixAttempts: 2, review: "approved" });
    s.ingest({ kind: "check_suite", suiteId: 5, headSha: "abc1234def", outcome: "pass" });
    expect(s.get().ci).toBe("pending"); // the suite that failed passed, but the head is not confirmed green
    s.ingest({ kind: "ci_green", headSha: "abc1234def" });
    expect(s.get()).toMatchObject({ ci: "passing", status: "active", ciFixAttempts: 0, readySha: "abc1234def" });
    expect(s.inbox().map((r) => r.kind)).toEqual(["ready"]);
    s.ingest({ kind: "ci_green", headSha: "abc1234def" }); // idempotent per head
    expect(s.inbox().map((r) => r.kind)).toEqual(["ready"]);
    s.ingest({ kind: "ci_green", headSha: "stale000" }); // a head that moved on is ignored
    expect(s.get().headSha).toBe("abc1234def");
  });

  it("a PR nobody reviewed is never ready", () => {
    const s = setup();
    s.sub();
    s.patch({ headSha: "abc1234def" });
    s.ingest({ kind: "ci_green", headSha: "abc1234def" });
    expect(s.get().ci).toBe("passing");
    expect(s.inbox()).toEqual([]);
  });

  it("a conflict is announced once per base commit; mergeable clears it", () => {
    const s = setup();
    s.sub();
    s.patch({ baseRef: "main" });
    s.ingest({ kind: "mergeable", baseSha: "base111aaa", mergeable: false });
    s.ingest({ kind: "mergeable", baseSha: "base111aaa", mergeable: false });
    expect(s.inbox().filter((r) => r.kind === "conflict")).toHaveLength(1);
    s.ingest({ kind: "mergeable", baseSha: "base222bbb", mergeable: false });
    expect(s.inbox().filter((r) => r.kind === "conflict")).toHaveLength(2);
    s.ingest({ kind: "mergeable", baseSha: "base333ccc", mergeable: true });
    expect(s.get().mergeable).toBe(true);
  });

  it("an ended subscription ignores everything", () => {
    const s = setup();
    s.sub();
    s.patch({ status: "ended" });
    s.ingest({ kind: "comment", body: "late", url: "u", sender: human });
    expect(s.inbox()).toEqual([]);
  });
});

