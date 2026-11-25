import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Workspace } from "../src/workspace";

// The Files tab reads and writes the box's checkouts as the bridge (root in a real box): the path checks are the only fence.
describe("Workspace", () => {
  const setup = () => {
    const work = mkdtempSync(join(tmpdir(), "ws-"));
    const env = { ...process.env, HOME: work, GIT_CONFIG_NOSYSTEM: "1" };
    const repo = (rel: string, origin?: string) => {
      const dir = join(work, rel);
      mkdirSync(join(dir, "src"), { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
      if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir, env });
      writeFileSync(join(dir, "src/app.ts"), "export const a = 1\n");
      execFileSync("git", ["add", "."], { cwd: dir, env });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: dir, env });
      return dir;
    };
    const primary = repo("acme/web", "https://github.com/acme/web.git");
    repo("other", "git@github.com:someone/other.git");
    writeFileSync(join(work, "secret.txt"), "outside\n");
    const ws = new Workspace({ workDir: work, primary: () => primary, baseEnv: env, runAs: null });
    return { work, primary, ws };
  };

  it("finds every checkout, the session's own first, named after its GitHub remote", async () => {
    const { ws } = setup();
    expect(await ws.roots()).toEqual([
      { id: "acme/web", name: "acme/web", branch: "main", primary: true },
      { id: "other", name: "someone/other", branch: "main", primary: false },
    ]);
  });

  it("lists files with their git status, and reads and saves one only from the version it was edited from", async () => {
    const { primary, ws } = setup();
    writeFileSync(join(primary, "src/app.ts"), "export const a = 2\n");
    writeFileSync(join(primary, "notes.md"), "hi\n");
    const tree = await ws.tree("acme/web");
    expect(tree.paths).toEqual(expect.arrayContaining(["src/app.ts", "notes.md"]));
    expect(tree.status).toEqual(
      expect.arrayContaining([
        { path: "src/app.ts", status: "modified" },
        { path: "notes.md", status: "untracked" },
      ]),
    );

    const file = ws.read("acme/web", "src/app.ts");
    if (file.kind !== "text") throw new Error("expected text");
    expect(file.contents).toBe("export const a = 2\n");
    const saved = ws.write("acme/web", "src/app.ts", "export const a = 3\n", file.sha);
    expect(readFileSync(join(primary, "src/app.ts"), "utf8")).toBe("export const a = 3\n");
    expect(() => ws.write("acme/web", "src/app.ts", "stale", file.sha)).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(ws.write("acme/web", "src/app.ts", "ok\n", saved.sha).sha).not.toBe(saved.sha);
  });

  it("never reads or writes outside a checkout or inside its .git, symlinks included", () => {
    const { work, primary, ws } = setup();
    symlinkSync(join(work, "secret.txt"), join(primary, "link.txt"));
    for (const path of ["../other/src/app.ts", "/etc/passwd", ".git/config", "src/../../secret.txt", "link.txt"]) {
      expect(() => ws.read("acme/web", path), path).toThrow(expect.objectContaining({ code: "invalid" }));
    }
    expect(() => ws.write("acme/web", "link.txt", "x", undefined)).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => ws.read("..", "secret.txt")).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => ws.write("acme/web", "src/new.ts", "x", undefined)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(readFileSync(join(work, "secret.txt"), "utf8")).toBe("outside\n");
  });
});
