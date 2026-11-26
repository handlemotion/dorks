import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { clonePath, ensureWorktree, listWorktrees, removeWorktree, worktreePath, type Checkout } from "../src/lib/localGit";

// Local dorks' checkouts (docs/local-dorks.md) against a real git "GitHub": a bare repository on disk, reached by file:// URL.

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, ...ID } })
    .toString()
    .trim();

let root = "";
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  root = mkdtempSync(join(tmpdir(), "dorks-localgit-"));
  const remote = join(root, "remote", "acme", "demo.git");
  run(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  const seed = join(root, "seed");
  run(root, "init", "--quiet", "--initial-branch=main", seed);
  writeFileSync(join(seed, "README.md"), "# demo\n");
  run(seed, "add", ".");
  run(seed, "commit", "--quiet", "-m", "init");
  run(seed, "push", "--quiet", remote, "main");
  const auth = { baseUrl: `file://${join(root, "remote")}` };
  const box = (n: string, branch: string): Checkout => ({ reposDir: join(root, "repos"), workDir: join(root, "boxes", n, "work"), repo: "acme/demo", branch });
  return { remote, seed, auth, box };
}

describe("local worktrees", () => {
  it("gives each dork its own worktree and branch off one clone, removes it on archive and adds it back from the branch", async () => {
    const { auth, box } = setup();
    const a = box("a", "agent/aaaa");
    const b = box("b", "agent/bbbb");
    const [wa, wb] = await Promise.all([ensureWorktree(a, auth), ensureWorktree(b, auth)]); // concurrent starts share the clone safely
    expect(wa).toBe(worktreePath(a.workDir, "acme/demo"));
    expect(run(wa, "branch", "--show-current")).toBe("agent/aaaa");
    expect(run(wb, "branch", "--show-current")).toBe("agent/bbbb");
    expect(existsSync(join(wa, "README.md"))).toBe(true);
    expect((await listWorktrees(a.reposDir, "acme/demo")).sort()).toEqual([wa, wb].sort());

    writeFileSync(join(wa, "work.txt"), "done\n");
    run(wa, "add", ".");
    run(wa, "commit", "--quiet", "-m", "work");
    const head = run(wa, "rev-parse", "HEAD");

    await removeWorktree(a); // archive
    expect(existsSync(wa)).toBe(false);
    expect(await listWorktrees(a.reposDir, "acme/demo")).toEqual([wb]);
    expect(run(clonePath(a.reposDir, "acme/demo"), "rev-parse", "agent/aaaa")).toBe(head); // the commit is kept on the branch

    expect(await ensureWorktree(a, auth)).toBe(wa); // unarchive + wake
    expect(run(wa, "rev-parse", "HEAD")).toBe(head);
    expect(run(wa, "branch", "--show-current")).toBe("agent/aaaa");
  });

  it("recreates a worktree from the pushed branch, fast-forwarding a stale local one, and drops the local branch on delete", async () => {
    const { remote, auth, box } = setup();
    const a = box("a", "agent/cccc");
    const wa = await ensureWorktree(a, auth);
    writeFileSync(join(wa, "one.txt"), "1\n");
    run(wa, "add", ".");
    run(wa, "commit", "--quiet", "-m", "one");
    run(wa, "push", "--quiet", remote, "agent/cccc");
    await removeWorktree(a);

    // The branch moved on GitHub meanwhile (pushed from elsewhere).
    const other = join(root, "other");
    run(root, "clone", "--quiet", "--branch", "agent/cccc", remote, other);
    writeFileSync(join(other, "two.txt"), "2\n");
    run(other, "add", ".");
    run(other, "commit", "--quiet", "-m", "two");
    run(other, "push", "--quiet", "origin", "agent/cccc");

    await ensureWorktree(a, auth);
    expect(existsSync(join(wa, "two.txt"))).toBe(true);
    expect(run(wa, "rev-parse", "HEAD")).toBe(run(other, "rev-parse", "HEAD"));

    // A branch that only exists on GitHub (a fresh clone of the data directory) is checked out from there.
    const fresh = { ...box("b", "agent/cccc"), reposDir: join(root, "repos2") };
    await removeWorktree(a, true);
    expect(run(clonePath(a.reposDir, "acme/demo"), "branch", "--list", "agent/cccc")).toBe("");
    const wf = await ensureWorktree(fresh, auth);
    expect(existsSync(join(wf, "two.txt"))).toBe(true);
  });
});
