import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { FileWatcher, type FileListing } from "../src/files";

describe("FileWatcher", () => {
  it("lists tracked and untracked files but not ignored ones, and sends only when the listing changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "files-"));
    const env = { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["init", "-q"], { cwd: dir, env });
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    writeFileSync(join(dir, "src/app.ts"), "");
    writeFileSync(join(dir, "node_modules/dep.js"), "");
    execFileSync("git", ["add", ".gitignore", "src/app.ts"], { cwd: dir, env });
    writeFileSync(join(dir, "notes.md"), ""); // untracked, not ignored

    const sent: FileListing[] = [];
    const w = new FileWatcher({ dir, baseEnv: env, runAs: null, send: (l) => sent.push(l) });
    await w.scan();
    expect(sent).toEqual([{ paths: expect.arrayContaining([".gitignore", "src/app.ts", "notes.md"]), truncated: false }]);
    expect(sent[0]!.paths).not.toContain("node_modules/dep.js");

    await w.scan(); // nothing changed
    expect(sent).toHaveLength(1);

    writeFileSync(join(dir, "src/new.ts"), "");
    await w.scan();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.paths).toContain("src/new.ts");
  });
});
