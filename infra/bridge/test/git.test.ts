import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { prepareRepo } from "../src/git";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

describe("prepareRepo", () => {
  it("checks out the dork branch once, then leaves the agent's checkout alone on a later configure", async () => {
    const home = tmp("home-");
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
    // A remote acme/demo.git with main and the branch the agent later moves to.
    const base = tmp("remote-");
    const seed = tmp("seed-");
    git(seed, env, "init", "-q", "-b", "main");
    git(seed, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git(seed, env, "branch", "feature");
    git(base, env, "clone", "-q", "--bare", seed, join(base, "acme/demo.git"));

    const ctx = { gitBaseUrl: `file://${base}`, workDir: tmp("work-"), helper: "", log: () => {}, env };
    const repo = { fullName: "acme/demo", branch: "agent/1234" };
    const dir = await prepareRepo(ctx, repo);
    expect(git(dir, env, "branch", "--show-current")).toBe("agent/1234");

    git(dir, env, "checkout", "-q", "feature"); // the agent moves to another branch
    await prepareRepo(ctx, repo); // a new model, a secret, a restarted bridge
    expect(git(dir, env, "branch", "--show-current")).toBe("feature");
  });
});
