import type { PrRef, SubscriptionView } from "@dorks/shared";
import { chmodSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { claudeSettings, HookService, sessionContext, settingsPath, writeClaudeSettings, type HookDeps } from "../src/hooks";
import { prLookup } from "../src/pr-lookup";
import { findRepos } from "../src/work-scan";
import { fakeView, makeRemote, tmp } from "./helpers";

// A clone of a local bare remote under a fresh workdir, laid out as the bridge does: <work>/<owner>/<name>.
function checkout(fullName = "acme/demo", work = tmp("work-")) {
  const remote = makeRemote(fullName);
  const dir = join(work, fullName);
  mkdirSync(dirname(dir), { recursive: true });
  remote.sh(work, "clone", "-q", `${remote.baseUrl}/${fullName}.git`, dir);
  const git = (...args: string[]) =>
    remote
      .sh(dir, ...args)
      .toString()
      .trim();
  const commit = (file: string, msg = `edit ${file}`) => {
    writeFileSync(join(dir, file), `${msg}\n`);
    git("add", ".");
    git("commit", "-q", "-m", msg);
  };
  return { work, dir, git, commit, remote };
}

function fakePrs(initial: SubscriptionView[] | null = []) {
  const calls: string[] = [];
  const state = { list: initial };
  return {
    state,
    calls,
    prs: {
      list: async () => state.list,
      subscribe: async (ref: PrRef, source: string) => void calls.push(`sub ${ref.repo}#${ref.number} ${source}`),
      unsubscribe: async (ref: PrRef) => void calls.push(`unsub ${ref.repo}#${ref.number}`),
    } satisfies HookDeps["prs"],
  };
}

function service(work: string, over: Partial<HookDeps> & { subs?: SubscriptionView[] | null } = {}) {
  const logs: string[] = [];
  const p = fakePrs(over.subs === undefined ? [] : over.subs);
  const stateDir = over.stateDir ?? tmp("state-");
  const svc = new HookService({ workDir: work, stateDir, env: process.env, runAs: null, prs: p.prs, hasPr: async () => null, log: (...a) => void logs.push(a.join(" ")), ...over });
  const call = (method: string, input: unknown) => svc.methods[method]!(input) as Promise<any>;
  return {
    svc,
    logs,
    stateDir,
    prCalls: p.calls,
    subs: p.state,
    stop: (input: object = {}) => call("hook.stop", { hook_event_name: "Stop", session_id: "s1", stop_hook_active: false, ...input }),
    post: (command: string, response: unknown, tool = "Bash") => call("hook.postToolUse", { hook_event_name: "PostToolUse", tool_name: tool, tool_input: { command }, tool_response: response }),
    start: () => call("hook.sessionStart", { hook_event_name: "SessionStart", source: "startup" }),
  };
}

describe("Stop gate", () => {
  it("lets a clean repo stop, without output", async () => {
    const w = checkout();
    expect(await service(w.work).stop()).toBeNull();
  });

  it("ignores a work dir with no repositories, or one that does not exist yet", async () => {
    expect(await service(tmp("empty-")).stop()).toBeNull();
    expect(await service(join(tmp("gone-"), "nope")).stop()).toBeNull();
  });

  it("blocks on commits not pushed to the upstream, and the reason carries the whole checklist", async () => {
    const w = checkout();
    w.git("checkout", "-q", "-b", "dork/x");
    w.commit("a.txt");
    w.git("push", "-q", "-u", "origin", "dork/x");
    w.commit("b.txt");
    w.commit("c.txt");
    const r = await service(w.work).stop();
    expect(r.decision).toBe("block");
    expect(Object.keys(r).sort()).toEqual(["decision", "reason"]);
    expect(r.reason).toContain("acme/demo");
    expect(r.reason).toContain(w.dir);
    expect(r.reason).toContain("branch dork/x: 2 commits not pushed to origin/dork/x");
    expect(r.reason).toMatch(/1\. Validate locally first\. Run the repo's tests, typecheck and lint for what you changed, using the scripts the repo defines/);
    expect(r.reason).toMatch(/2\. Push the branch/);
    expect(r.reason).toMatch(/3\. Open a pull request with `gh pr create`.*subscribes you/);
    expect(r.reason).toMatch(/4\. Or, if you are intentionally not pushing this work, say so in your reply/);
  });

  it("blocks on a branch with commits beyond the default branch and no upstream; a fresh branch without commits is fine", async () => {
    const w = checkout();
    w.git("checkout", "-q", "-b", "dork/empty");
    expect(await service(w.work).stop()).toBeNull();
    w.git("checkout", "-q", "-b", "dork/x");
    w.commit("a.txt");
    const r = await service(w.work).stop();
    expect(r.reason).toContain("branch dork/x: 1 commit not pushed anywhere (no upstream)");
    expect(r.reason).not.toContain("dork/empty");
  });

  it("treats a branch that tracks the default branch as unpublished: pushing it would not be a push of the branch", async () => {
    const w = checkout();
    w.git("checkout", "-q", "-b", "feat", "origin/main");
    w.commit("a.txt");
    expect((await service(w.work).stop()).reason).toContain("branch feat: 1 commit not pushed anywhere");
  });

  it("sees commits made on the default branch itself", async () => {
    const w = checkout();
    w.commit("a.txt");
    expect((await service(w.work).stop()).reason).toContain("branch main: 1 commit not pushed to origin/main");
  });

  it("counts a branch pushed without -u as pushed", async () => {
    const w = checkout();
    w.git("checkout", "-q", "-b", "dork/x");
    w.commit("a.txt");
    w.git("push", "-q", "origin", "dork/x");
    const hasPr = async () => true;
    expect(await service(w.work, { hasPr }).stop()).toBeNull();
    w.commit("b.txt");
    expect((await service(w.work, { hasPr }).stop()).reason).toContain("1 commit not pushed to origin/dork/x");
  });

  it("skips a branch whose remote branch is gone (merged and cleaned up)", async () => {
    const w = checkout();
    w.git("checkout", "-q", "-b", "dork/x");
    w.commit("a.txt");
    w.git("push", "-q", "-u", "origin", "dork/x");
    w.git("checkout", "-q", "main");
    w.remote.sh(w.remote.bare, "branch", "-q", "-D", "dork/x");
    w.git("fetch", "-q", "--prune", "origin");
    expect(await service(w.work, { hasPr: async () => false }).stop()).toBeNull();
  });

  describe("pushed branches without a PR", () => {
    const pushed = () => {
      const w = checkout();
      w.git("checkout", "-q", "-b", "dork/x");
      w.commit("a.txt");
      w.git("push", "-q", "-u", "origin", "dork/x");
      return w;
    };

    it("blocks when the PR lookup says there is none, naming the repo and branch it asked about", async () => {
      const w = pushed();
      const asked: string[] = [];
      const r = await service(w.work, { hasPr: async (repo, branch) => (asked.push(`${repo}:${branch}`), false) }).stop();
      expect(asked).toEqual(["acme/demo:dork/x"]);
      expect(r.reason).toContain("branch dork/x: pushed to origin/dork/x, no pull request");
    });

    it("lets it stop when a PR exists, or when that cannot be told (no gh, offline)", async () => {
      const w = pushed();
      expect(await service(w.work, { hasPr: async () => true }).stop()).toBeNull();
      expect(await service(w.work, { hasPr: async () => null }).stop()).toBeNull();
    });

    it("answers from the cached subscriptions first (repo compared case-insensitively), without asking GitHub", async () => {
      const w = pushed();
      const hasPr = async () => {
        throw new Error("should not be asked");
      };
      const subs = [{ ...fakeView({ repo: "acme/demo", number: 7 }), headRef: "dork/x" }];
      expect(await service(w.work, { hasPr, subs }).stop()).toBeNull();
      // a subscription for another branch does not count
      const other = [{ ...fakeView({ repo: "acme/demo", number: 8 }), headRef: "dork/y" }];
      expect(await service(w.work, { hasPr: async () => false, subs: other }).stop()).toMatchObject({ decision: "block" });
    });
  });

  describe("once per condition", () => {
    const unpushed = () => {
      const w = checkout();
      w.git("checkout", "-q", "-b", "dork/x");
      w.commit("a.txt");
      return w;
    };

    it("raises a condition once; more commits on the same branch are the same condition", async () => {
      const w = unpushed();
      const s = service(w.work);
      expect(await s.stop()).toMatchObject({ decision: "block" });
      expect(await s.stop()).toBeNull();
      w.commit("b.txt");
      expect(await s.stop()).toBeNull();
    });

    it("raises only what is new: a second branch is blocked on its own, the first is not repeated", async () => {
      const w = unpushed();
      const s = service(w.work);
      await s.stop();
      w.git("checkout", "-q", "-b", "dork/y", "main");
      w.commit("y.txt");
      const r = await s.stop();
      expect(r.reason).toContain("branch dork/y");
      expect(r.reason).not.toContain("branch dork/x");
    });

    it("forgets a condition once it clears, so the same work going unpushed later is raised again", async () => {
      const w = unpushed();
      const s = service(w.work);
      await s.stop();
      w.git("push", "-q", "-u", "origin", "dork/x");
      expect(await s.stop({ session_id: "s1" })).toBeNull(); // cleared (and a PR exists below)
      w.commit("b.txt");
      expect((await s.stop()).reason).toContain("1 commit not pushed to origin/dork/x");
    });

    it("remembers across a bridge restart, and starts over in a new session", async () => {
      const w = unpushed();
      const first = service(w.work);
      await first.stop();
      const restarted = service(w.work, { stateDir: first.stateDir });
      expect(await restarted.stop()).toBeNull();
      expect(await restarted.stop({ session_id: "s2" })).toMatchObject({ decision: "block" });
    });

    it("a corrupt memory file is no memory", async () => {
      const w = unpushed();
      const first = service(w.work);
      await first.stop();
      writeFileSync(join(first.stateDir, "stop-gate.json"), "not json");
      expect(await service(w.work, { stateDir: first.stateDir }).stop()).toMatchObject({ decision: "block" });
    });

    it("never blocks while Claude is already continuing because of a block, and that does not use up the condition", async () => {
      const w = unpushed();
      const s = service(w.work);
      expect(await s.stop({ stop_hook_active: true })).toBeNull();
      expect(await s.stop()).toMatchObject({ decision: "block" });
      expect(await s.stop({ stop_hook_active: true })).toBeNull();
    });

    it("skips the turn that answers a `ready` notification, but not other notifications or user messages", async () => {
      const w = unpushed();
      const s = service(w.work);
      s.svc.noteTurn(["ci_passed", "ready"]);
      expect(await s.stop()).toBeNull();
      s.svc.noteTurn(["ci_failed"]);
      expect(await s.stop()).toMatchObject({ decision: "block" });
      w.git("checkout", "-q", "-b", "dork/y", "main");
      w.commit("y.txt");
      s.svc.noteTurn(["ready"]);
      expect(await s.stop()).toBeNull();
      s.svc.noteTurn([]); // a user message
      expect(await s.stop()).toMatchObject({ decision: "block" });
    });
  });

  it("scans every repository under the workdir, deeper than owner/name, and not node_modules, dot dirs or worktree checkouts", async () => {
    const a = checkout("acme/demo");
    const b = checkout("other/lib", a.work);
    for (const [dir, file] of [
      [a.dir, "a.txt"],
      [b.dir, "b.txt"],
    ] as const) {
      writeFileSync(join(dir, file), "x\n");
      a.remote.sh(dir, "add", ".");
      a.remote.sh(dir, "commit", "-q", "-m", "x");
    }
    const hidden = join(a.work, "node_modules/pkg");
    mkdirSync(hidden, { recursive: true });
    a.remote.sh(hidden, "init", "-q");
    a.git("worktree", "add", "-q", "-b", "wt", join(a.work, "wt"));
    expect(findRepos(a.work).sort()).toEqual([a.dir, b.dir].sort());
    const r = await service(a.work).stop();
    expect(r.reason).toContain("acme/demo");
    expect(r.reason).toContain("other/lib");
    expect(r.reason).not.toContain("node_modules");
    expect(findRepos(join(a.work, "x/y/z/w"))).toEqual([]);
  });

  it("fails open: a failing scan or lookup answers nothing and says so in the log", async () => {
    const w = checkout();
    w.git("checkout", "-q", "-b", "dork/x");
    w.commit("a.txt");
    w.git("push", "-q", "-u", "origin", "dork/x");
    const s = service(w.work, {
      hasPr: async () => {
        throw new Error("boom with detail");
      },
    });
    expect(await s.stop()).toBeNull();
    expect(s.logs).toEqual(["hook stop failed: Error"]);
    const broken = service(w.work, { subs: null, prs: { ...fakePrs().prs, list: () => Promise.reject(new Error("x")) } });
    expect(await broken.stop()).toBeNull();
  });
});

describe("PostToolUse", () => {
  const URL1 = "https://github.com/acme/demo/pull/12";
  const bash = (stdout: string, stderr = "") => ({ stdout, stderr, interrupted: false, isImage: false });

  it("subscribes to the PR `gh pr create` printed, as auto, and returns nothing", async () => {
    const s = service(tmp("w-"));
    expect(await s.post("gh pr create --fill --base main", bash(`${URL1}\n`, "Creating pull request for dork/x into main in acme/demo\n"))).toBeNull();
    expect(s.prCalls).toEqual(["sub acme/demo#12 auto"]);
  });

  it("finds the URL whichever way gh was invoked, and in stderr for `gh stack submit`", async () => {
    const s = service(tmp("w-"));
    await s.post("cd /x && gh -R acme/demo pr create --title 'a; b' --body-file -", bash(`${URL1}\n`));
    await s.post("gh stack submit --auto", bash("", "Created https://github.com/acme/demo/pull/21\nCreated https://github.com/acme/demo/pull/22\n"));
    expect(s.prCalls).toEqual(["sub acme/demo#12 auto", "sub acme/demo#21 auto", "sub acme/demo#22 auto"]);
  });

  it("is idempotent: a PR the shim already subscribed (listed in the backend's lowercase) is not subscribed again", async () => {
    const s = service(tmp("w-"), { subs: [fakeView({ repo: "acme/demo", number: 12 })] });
    await s.post("gh pr create", bash("https://github.com/Acme/Demo/pull/12\n"));
    expect(s.prCalls).toEqual([]);
  });

  it("subscribes even when the list has not loaded (the backend is idempotent)", async () => {
    const s = service(tmp("w-"), { subs: null });
    await s.post("gh pr create", bash(`${URL1}\n`));
    expect(s.prCalls).toEqual(["sub acme/demo#12 auto"]);
  });

  it("ignores commands that merely mention a PR URL, other tools, and tools that printed nothing useful", async () => {
    const s = service(tmp("w-"));
    await s.post("gh pr view 12 --json url", bash(`${URL1}\n`));
    await s.post("echo gh pr create", bash(`${URL1}\n`).stdout.replace(URL1, "nothing"));
    await s.post("cat notes.md", bash(`see ${URL1}\n`));
    await s.post("gh pr create", bash("no url printed\n"));
    await s.post("gh pr create", bash(`${URL1}\n`), "Write");
    expect(await s.post("gh pr create", undefined)).toBeNull();
    expect(await s.svc.methods["hook.postToolUse"]!(null)).toBeNull();
    expect(s.prCalls).toEqual([]);
  });

  it("unsubscribes from a PR that `gh pr merge` or `gh pr close` ended", async () => {
    const s = service(tmp("w-"), { subs: [fakeView({ repo: "acme/demo", number: 12 }), fakeView({ repo: "acme/demo", number: 13 }), fakeView({ repo: "acme/demo", number: 14 })] });
    expect(await s.post("gh pr merge 12 --squash --delete-branch", bash("", "✓ Squashed and merged pull request Acme/Demo#12 (Fix login)\n✓ Deleted branch dork/x\n"))).toBeNull();
    await s.post("gh pr close 13 --comment 'superseded'", bash("", "✓ Closed pull request acme/demo#13 (Old)\n"));
    await s.post("gh pr merge 14 --rebase", bash("✓ Rebased and merged pull request acme/demo#14 (X)\n"));
    expect(s.prCalls).toEqual(["unsub Acme/Demo#12", "unsub acme/demo#13", "unsub acme/demo#14"]); // #12 was printed with other casing and still matched the lowercase subscription
  });

  it("does not unsubscribe when the merge is only queued, was not subscribed, or the text is not from a merge or close", async () => {
    const s = service(tmp("w-"), { subs: [fakeView({ repo: "acme/demo", number: 12 })] });
    await s.post("gh pr merge 12 --auto --squash", bash("", "✓ Pull request acme/demo#12 will be automatically merged via squash when all requirements are met\n"));
    await s.post("gh pr merge 99", bash("", "✓ Merged pull request acme/demo#99 (Other)\n"));
    await s.post("git log --oneline", bash("Merged pull request acme/demo#12 (from a log)\n"));
    expect(s.prCalls).toEqual([]);
  });

  it("fails open when the backend refuses", async () => {
    const s = service(tmp("w-"), {
      prs: {
        list: async () => [],
        subscribe: async () => {
          throw new Error("backend down");
        },
        unsubscribe: async () => {},
      },
    });
    expect(await s.post("gh pr create", bash(`${URL1}\n`))).toBeNull();
    expect(s.logs).toEqual(["hook post-tool-use failed: Error"]);
  });
});

describe("SessionStart", () => {
  it("adds the subscribed PRs and the autonomy guide as additionalContext", async () => {
    const subs: SubscriptionView[] = [
      { ...fakeView({ repo: "acme/demo", number: 12 }), title: "Fix login", ci: "failing", review: "changes_requested", mergeable: false, ciFixAttempts: 1 },
      { ...fakeView({ repo: "acme/other", number: 3 }), ci: "passing", review: "approved", mergeable: true, status: "stalled", ciFixAttempts: 2 },
      fakeView({ repo: "acme/demo", number: 4 }),
    ];
    const r = await service(tmp("w-"), { subs }).start();
    expect(Object.keys(r)).toEqual(["hookSpecificOutput"]);
    expect(r.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const ctx: string = r.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('- acme/demo#12 "Fix login": CI failing, review changes_requested, has merge conflicts, CI fix attempts 1/2');
    expect(ctx).toContain("- acme/other#3: CI passing, review approved, mergeable, STALLED after 2/2 CI fix attempts");
    expect(ctx).toContain("- acme/demo#4: CI unknown, review none, mergeability unknown");
    expect(ctx).toContain("<dorks-event>");
    expect(ctx).toMatch(/validate locally before you push/i);
    expect(ctx).toContain("dorks pr sub <pr>");
    expect(ctx).toContain("dorks pr unsub <pr>");
    expect(ctx).toContain("dorks pr list");
    expect(ctx).toMatch(/standby note/);
    expect(ctx).toMatch(/Never merge it yourself/);
  });

  it("says so when there are none, or when the list could not be loaded", async () => {
    expect(sessionContext([])).toContain("not subscribed to any pull requests yet");
    expect(sessionContext(null)).toContain("could not be loaded just now; call the `pr_list` tool");
    expect(sessionContext(null)).toContain("How autonomy works here:");
  });
});

describe("settings for `claude --settings`", () => {
  const self: [string, string] = ["/usr/local/bin/node", "/opt/dorks/cli.mjs"];

  it("is written readable by the Claude user, holds no secrets, and is rewritten in place", () => {
    const state = tmp("state-");
    const file = writeClaudeSettings(state, self);
    expect(file).toBe(settingsPath(state));
    expect(file).toBe(join(state, "claude-settings.json"));
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(claudeSettings(self));
    chmodSync(file, 0o600);
    writeClaudeSettings(state, self);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(readFileSync(file, "utf8")).not.toMatch(/token|secret|sk-ant|ghs_/i);
  });
});

describe("PR lookup through gh", () => {
  // A gh that records how it was called and answers with canned output. It only sees the environment prLookup gives it.
  function fakeGh(stdout: string, exit = 0) {
    const dir = tmp("gh-");
    const report = join(dir, "report");
    writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s|%s\\n' "$GH_TOKEN" "$*" > '${report}'\nprintf '%s' '${stdout}'\nexit ${exit}\n`);
    chmodSync(join(dir, "gh"), 0o755);
    return { gh: join(dir, "gh"), seen: () => readFileSync(report, "utf8").trim() };
  }
  const lookup = (gh: string, token: string | null = "ghs_tok") => prLookup({ PATH: process.env.PATH, DORKS_REAL_GH: gh, BRIDGE_SECRET: "never-forwarded" }, "/nonexistent/cli.mjs", () => token);

  it("is true when gh lists a PR; unknown when gh fails, prints garbage, or there is no token or gh", async () => {
    expect(await lookup(fakeGh('[{"number":5}]').gh)("acme/demo", "b")).toBe(true);
    expect(await lookup(fakeGh("[]", 1).gh)("acme/demo", "b")).toBeNull();
    expect(await lookup(fakeGh("not json").gh)("acme/demo", "b")).toBeNull();
    expect(await lookup(fakeGh("{}").gh)("acme/demo", "b")).toBeNull();
    expect(await lookup(fakeGh("[]").gh, null)("acme/demo", "b")).toBeNull();
    expect(await lookup("/nonexistent/gh")("acme/demo", "b")).toBeNull();
  });
});
