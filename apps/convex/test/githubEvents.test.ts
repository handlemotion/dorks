import { describe, expect, it } from "vitest";
import { appBotLogin, parseGithubEvent, sentByApp, suiteOutcome } from "../convex/lib/githubEvents";
import * as f from "./fixtures/github";

const sender = (s: f.Sender) => ({ login: s.login, bot: s.type === "Bot" });
const base = { installationId: f.INSTALLATION, repo: f.REPO, sender: sender(f.alice) };

describe("parseGithubEvent", () => {
  it("pull_request closed: merged or not", () => {
    expect(parseGithubEvent("pull_request", f.pullRequestEvent("closed", { merged: true, state: "closed" }))).toEqual({ ...base, kind: "pr_closed", number: 12, merged: true });
    expect(parseGithubEvent("pull_request", f.pullRequestEvent("closed", { state: "closed" }))).toEqual({ ...base, kind: "pr_closed", number: 12, merged: false });
  });

  it("pull_request synchronize carries the new head", () => {
    expect(parseGithubEvent("pull_request", f.pullRequestEvent("synchronize", { number: 7, headSha: "beef123", headRef: "agent/y" }, { sender: f.bot })))
      .toEqual({ ...base, sender: sender(f.bot), kind: "pr_synchronize", number: 7, headSha: "beef123", headRef: "agent/y" });
  });

  it("pull_request edited counts only when the base changed", () => {
    expect(parseGithubEvent("pull_request", f.baseChanged("feature/parent", { baseRef: "main" }))).toEqual({ ...base, kind: "pr_base_changed", number: 12, baseRef: "main", from: "feature/parent" });
    expect(parseGithubEvent("pull_request", f.pullRequestEvent("edited", {}, { changes: { title: { from: "old" } } }))).toBeNull();
  });

  it("ignores pull_request actions we do not act on", () => {
    for (const action of ["opened", "labeled"] as const) expect(parseGithubEvent("pull_request", f.pullRequestEvent(action))).toBeNull();
  });

  it("pull_request_review: submitted states only", () => {
    expect(parseGithubEvent("pull_request_review", f.reviewEvent("changes_requested", { body: "Rename it" })))
      .toEqual({ ...base, kind: "review", number: 12, state: "changes_requested", body: "Rename it", url: `https://github.com/${f.REPO}/pull/12#pullrequestreview-80` });
    expect(parseGithubEvent("pull_request_review", f.reviewEvent("approved", { body: null }))).toMatchObject({ state: "approved", body: "" });
    expect(parseGithubEvent("pull_request_review", f.reviewEvent("approved", { action: "dismissed" }))).toBeNull();
    const dismissed = { ...f.reviewEvent("approved"), review: { ...f.reviewEvent("approved").review, state: "dismissed" } };
    expect(parseGithubEvent("pull_request_review", dismissed)).toBeNull();
  });

  it("review comments and PR conversation comments become one comment kind", () => {
    expect(parseGithubEvent("pull_request_review_comment", f.reviewCommentEvent({ body: "Use a Map", path: "src/b.ts" })))
      .toEqual({ ...base, kind: "comment", number: 12, body: "Use a Map", path: "src/b.ts", url: `https://github.com/${f.REPO}/pull/12#discussion_r10` });
    const c = parseGithubEvent("issue_comment", f.issueCommentEvent({ body: "ping" }));
    expect(c).toEqual({ ...base, kind: "comment", number: 12, body: "ping", url: `https://github.com/${f.REPO}/pull/12#issuecomment-20` });
    expect(c).not.toHaveProperty("path");
  });

  it("drops edited/deleted comments and comments on plain issues", () => {
    expect(parseGithubEvent("pull_request_review_comment", f.reviewCommentEvent({ action: "edited" }))).toBeNull();
    expect(parseGithubEvent("issue_comment", f.issueCommentEvent({ action: "deleted" }))).toBeNull();
    expect(parseGithubEvent("issue_comment", f.issueCommentEvent({ onIssue: true }))).toBeNull();
  });

  it("check_suite completed: maps the conclusion, only for those that say something about the code", () => {
    expect(parseGithubEvent("check_suite", f.checkSuiteEvent("failure"))).toEqual({ ...base, kind: "check_suite", suiteId: 118578147, headSha: "c0ffee1", headBranch: "agent/x", outcome: "fail" });
    expect(parseGithubEvent("check_suite", f.checkSuiteEvent("success"))).toMatchObject({ outcome: "pass" });
    for (const c of ["cancelled", "action_required", "stale", null]) expect(parseGithubEvent("check_suite", f.checkSuiteEvent(c))).toBeNull();
    expect(parseGithubEvent("check_suite", f.checkSuiteEvent("success", { action: "requested" }))).toBeNull();
    expect(parseGithubEvent("check_suite", f.checkSuiteEvent("success", { headBranch: null }))).not.toHaveProperty("headBranch");
  });

  it("suiteOutcome", () => {
    expect(["success", "neutral", "skipped"].map(suiteOutcome)).toEqual(["pass", "pass", "pass"]);
    expect(["failure", "timed_out", "startup_failure"].map(suiteOutcome)).toEqual(["fail", "fail", "fail"]);
    expect(suiteOutcome("whatever")).toBeNull();
  });

  it("push: branches only, not deletions or tags", () => {
    expect(parseGithubEvent("push", f.pushEvent("main", { sha: "abc9999" }))).toEqual({ ...base, kind: "push", branch: "main", sha: "abc9999" });
    expect(parseGithubEvent("push", f.pushEvent("feature/a/b"))).toMatchObject({ branch: "feature/a/b" });
    expect(parseGithubEvent("push", f.pushEvent("main", { deleted: true }))).toBeNull();
    expect(parseGithubEvent("push", f.pushEvent("v1", { ref: "refs/tags/v1" }))).toBeNull();
  });

  it("ignores installation events, pings, unknown events and payloads that are not an App delivery", () => {
    expect(parseGithubEvent("installation", f.installationEvent)).toBeNull();
    expect(parseGithubEvent("installation_repositories", f.installationEvent)).toBeNull();
    expect(parseGithubEvent("ping", f.pingEvent)).toBeNull();
    expect(parseGithubEvent("star", f.pushEvent("main"))).toBeNull();
    expect(parseGithubEvent("push", { ...f.pushEvent("main"), installation: undefined })).toBeNull();
    expect(parseGithubEvent("pull_request", f.pullRequestEvent("closed", {}, { installation: null }))).toBeNull();
    expect(parseGithubEvent("pull_request", { action: "closed" })).toBeNull();
    for (const junk of [null, 5, "x", []]) expect(parseGithubEvent("push", junk)).toBeNull();
  });

  it("a delivery without a sender (a check suite from the ghost user) still parses", () => {
    const { sender: _s, ...noSender } = f.checkSuiteEvent("failure");
    expect(parseGithubEvent("check_suite", noSender)).toMatchObject({ sender: { login: "ghost", bot: false } });
  });
});

describe("sentByApp", () => {
  it("matches the App's bot user, case-insensitively, and nothing else", () => {
    expect(appBotLogin("dorks")).toBe("dorks[bot]");
    expect(sentByApp({ login: "Dorks-Test[bot]", bot: true }, "dorks-test")).toBe(true);
    expect(sentByApp({ login: "coderabbitai[bot]", bot: true }, "dorks-test")).toBe(false);
    expect(sentByApp({ login: "dorks-test[bot]", bot: false }, "dorks-test")).toBe(false); // type must be Bot
    expect(sentByApp({ login: "dorks-test", bot: false }, "dorks-test")).toBe(false);
  });
});
