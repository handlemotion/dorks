import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { SkillBundle } from "@dorks/shared";
import { syncSkills } from "../src/skills";
import { tmp } from "./helpers";

// The owner's skills in ~/.claude/skills (docs/skills.md): written, replaced and removed by digest, never touching a skill the
// session installed itself, and never writing outside a skill's folder.

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("skill sync", () => {
  it("keeps the skills folder in step with the owner's list", async () => {
    const stateDir = tmp();
    const configDir = join(tmp(), ".claude");
    const store: Record<string, SkillBundle> = {
      pdf: {
        name: "pdf",
        digest: "1".repeat(64),
        files: [
          { path: "SKILL.md", data: b64("v1") },
          { path: "scripts/run.sh", data: b64("echo"), exec: true },
          { path: "../../escape", data: b64("x") },
        ],
      },
      mine: { name: "mine", digest: "2".repeat(64), files: [{ path: "SKILL.md", data: b64("shared") }] },
    };
    const fetched: string[] = [];
    const d = { stateDir, configDir, runAs: null, log: () => {}, fetch: async (n: string) => (fetched.push(n), store[n]!) };
    // A skill this session installed on its own (npx skills add -g) before the owner shared one of the same name.
    mkdirSync(join(configDir, "skills", "mine"), { recursive: true });
    writeFileSync(join(configDir, "skills", "mine", "SKILL.md"), "session");

    await syncSkills(d, [
      { name: "pdf", digest: store.pdf!.digest },
      { name: "mine", digest: store.mine!.digest },
    ]);
    const skills = join(configDir, "skills");
    expect(readFileSync(join(skills, "pdf", "SKILL.md"), "utf8")).toBe("v1");
    expect(statSync(join(skills, "pdf", "scripts", "run.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(configDir, "escape")) || existsSync(join(skills, "escape"))).toBe(false);
    expect(readFileSync(join(skills, "mine", "SKILL.md"), "utf8")).toBe("session");
    expect(fetched).toEqual(["pdf"]);

    // Same digest: nothing fetched. New digest: replaced. Gone from the list: removed (ours only).
    await syncSkills(d, [{ name: "pdf", digest: store.pdf!.digest }]);
    expect(fetched).toEqual(["pdf"]);
    store.pdf = { name: "pdf", digest: "3".repeat(64), files: [{ path: "SKILL.md", data: b64("v2") }] };
    await syncSkills(d, [{ name: "pdf", digest: store.pdf.digest }]);
    expect(readFileSync(join(skills, "pdf", "SKILL.md"), "utf8")).toBe("v2");
    expect(existsSync(join(skills, "pdf", "scripts"))).toBe(false);
    await syncSkills(d, []);
    expect(existsSync(join(skills, "pdf"))).toBe(false);
    expect(existsSync(join(skills, "mine", "SKILL.md"))).toBe(true);
  });

  it("never takes over a session's skill whose name is an object property", async () => {
    const configDir = join(tmp(), ".claude");
    mkdirSync(join(configDir, "skills", "constructor"), { recursive: true });
    writeFileSync(join(configDir, "skills", "constructor", "SKILL.md"), "session");
    const fetch = async (n: string): Promise<SkillBundle> => ({ name: n, digest: "4".repeat(64), files: [{ path: "SKILL.md", data: b64("shared") }] });
    await syncSkills({ stateDir: tmp(), configDir, runAs: null, log: () => {}, fetch }, [{ name: "constructor", digest: "4".repeat(64) }]);
    expect(readFileSync(join(configDir, "skills", "constructor", "SKILL.md"), "utf8")).toBe("session");
  });
});
