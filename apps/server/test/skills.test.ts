import { gzipSync } from "node:zlib";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { uiApp } from "../src/http/ui";
import { untar } from "../src/lib/skillRepo";
import { parseSkillSource } from "../src/lib/skillSource";
import * as bridge from "../src/services/bridge";
import { skillBundle } from "../src/services/skills";
import { updateSettings } from "../src/services/settings";
import { fakeFetch, harness } from "./harness";

// Skills (docs/skills.md): what people paste, a GitHub tarball read into skills, and what reaches the bridge.

describe("skill sources", () => {
  const cases: [string, Partial<ReturnType<typeof parseSkillSource>>][] = [
    ["npx skills add vercel-labs/agent-skills --skill frontend-design -g -a claude-code -y", { owner: "vercel-labs", repo: "agent-skills", path: "", skills: ["frontend-design"] }],
    ["npx -y skills@1.9.0 add owner/repo -s one two --agent claude-code codex", { owner: "owner", repo: "repo", skills: ["one", "two"] }],
    ["pnpm dlx skills add owner/repo@pdf", { owner: "owner", repo: "repo", skills: ["pdf"] }],
    ["npx skills add https://github.com/anthropics/skills/tree/main/skills/pdf", { owner: "anthropics", repo: "skills", refPath: ["main", "skills", "pdf"] }],
    ["https://github.com/o/r/blob/feat/x/skills/a/SKILL.md", { owner: "o", repo: "r", refPath: ["feat", "x", "skills", "a"] }],
    ["git clone https://github.com/o/r.git", { owner: "o", repo: "r", path: "" }],
    ["o/r/skills/a#v2", { owner: "o", repo: "r", ref: "v2", path: "skills/a" }],
    ["npx add-skill o/r --all", { owner: "o", repo: "r", skills: ["*"] }],
    ["/plugin marketplace add o/r", { owner: "o", repo: "r" }],
  ];
  it.each(cases)("%s", (input, want) => expect(parseSkillSource(input)).toMatchObject(want));

  it("refuses what is not a GitHub repository", () => {
    expect(() => parseSkillSource("npx skills add ./local")).toThrow(/local folder/);
    expect(() => parseSkillSource("https://gitlab.com/g/r")).toThrow(/GitHub/);
    expect(() => parseSkillSource("npx skills remove o/r")).toThrow(/add command/);
  });
});

/** A gzipped tar like GitHub's: a pax global header, a top folder, a pax long path, an executable script. */
function tarball(files: Record<string, string | { data: string; exec: true }>): Uint8Array {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string, mode = 0o644) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 99), 0);
    h.write(mode.toString(8).padStart(7, "0"), 100);
    h.write(size.toString(8).padStart(11, "0"), 124);
    h.write(type, 156);
    h.write("ustar\u000000", 257);
    return h;
  };
  const add = (name: string, data: Buffer, type: string, mode?: number) => {
    blocks.push(header(name, data.length, type, mode), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  };
  const paxRec = (k: string, v: string) => {
    const body = Buffer.byteLength(` ${k}=${v}\n`);
    let len = body + 2;
    if (String(len).length + body !== len) len = String(len + 1).length + body;
    return `${len} ${k}=${v}\n`;
  };
  add("pax_global_header", Buffer.from(paxRec("comment", "abc123")), "g");
  for (const [path, f] of Object.entries(files)) {
    const full = `o-r-abc123/${path}`;
    const data = Buffer.from(typeof f === "string" ? f : f.data);
    if (full.length > 99) add("PaxHeader", Buffer.from(paxRec("path", full)), "x");
    add(full, data, "0", typeof f === "string" ? 0o644 : 0o755);
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const md = (name: string, description: string) => `---\nname: ${name}\ndescription: >\n  ${description}\n---\n# ${name}\n`;
const LONG = `skills/pdf/references/${"tiefé/".repeat(20)}notes.md`; // a pax path whose byte length differs from its string length
const REPO = tarball({
  "README.md": "# repo",
  "skills/pdf/SKILL.md": md("pdf", "Read and fill PDFs."),
  "skills/pdf/scripts/fill.py": { data: "print(1)", exec: true },
  [LONG]: "deep",
  "skills/Frontend Design/SKILL.md": md("Frontend Design", "Build pages."),
  "node_modules/x/SKILL.md": md("ignored", "no"),
});

describe("skills from GitHub", () => {
  it("reads GitHub's tarball format", () => {
    const paths = untar(REPO).map((f) => f.path);
    expect(paths).toContain(LONG);
    expect(untar(REPO).find((f) => f.path.endsWith("fill.py"))?.exec).toBe(true);
  });

  it("finds, installs and hands skills to the bridge; an update follows the branch", async () => {
    let head = "a".repeat(40);
    let repo = REPO;
    const h = harness();
    h.app.fetch = fakeFetch((url) => {
      if (url.pathname === "/user") return Response.json({ login: "agent-bot" });
      if (url.pathname === "/repos/o/r/commits/HEAD") return new Response(head);
      if (url.pathname === `/repos/o/r/tarball/${head}`) return new Response(repo);
      return new Response("{}", { status: 404 });
    });
    const api = uiApp(h.app);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await api.request(path, { method, headers: { Authorization: "Bearer owner-token-for-tests", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: (await res.json()) as any };
    };

    const found = await call("POST", "/api/skills/resolve", { source: "npx skills add o/r --skill pdf -g -y" });
    expect(found.json).toMatchObject({ repo: "o/r", sha: head, requested: ["pdf"] });
    expect(found.json.skills.map((s: { name: string }) => s.name)).toEqual(["frontend-design", "pdf"]);
    expect((await call("POST", "/api/skills", { source: "o/r", skills: ["pdf"] })).json).toEqual({ installed: ["pdf"] });
    const [view] = (await call("GET", "/api/skills")).json;
    expect(view).toMatchObject({ name: "pdf", description: "Read and fill PDFs.", source: { repo: "o/r", ref: null, path: "skills/pdf" }, fileCount: 3 });

    // The bridge sees name and digest in configure, and fetches the files with the `skill` rpc.
    const id = h.seed("waking", { provider: "claude", repo: "o/r" });
    await updateSettings(h.app, { claudeToken: "c", githubConnected: true });
    const cfg = await Effect.runPromise(bridge.configure(h.app, id));
    expect(cfg && "skills" in cfg && cfg.skills).toEqual([{ name: "pdf", digest: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    const bundle = skillBundle(h.app, id, "pdf");
    expect(bundle.files.map((f) => f.path).sort()).toEqual([LONG.replace("skills/pdf/", ""), "SKILL.md", "scripts/fill.py"].sort());
    expect(bundle.files.find((f) => f.path === "scripts/fill.py")).toMatchObject({ data: Buffer.from("print(1)").toString("base64"), exec: true });

    expect((await call("POST", "/api/skills/pdf/update")).json).toEqual({ updated: false });
    head = "b".repeat(40);
    repo = tarball({ "skills/pdf/SKILL.md": md("pdf", "Read, fill and merge PDFs.") });
    expect((await call("POST", "/api/skills/pdf/update")).json).toEqual({ updated: true });
    expect((await call("GET", "/api/skills")).json[0]).toMatchObject({ sha: head, description: "Read, fill and merge PDFs.", fileCount: 1 });
    expect(skillBundle(h.app, id, "pdf").digest).not.toBe(bundle.digest);
  });

  it("updates a nested skill in a repo whose root is a skill too", async () => {
    let head = "c".repeat(40);
    const repo = tarball({ "SKILL.md": md("root", "The root."), "skills/inner/SKILL.md": md("inner", "Nested.") });
    const h = harness();
    h.app.fetch = fakeFetch((url) => {
      if (url.pathname === "/repos/o/r/commits/HEAD") return new Response(head);
      if (url.pathname.startsWith("/repos/o/r/tarball/")) return new Response(repo);
      return new Response("{}", { status: 404 });
    });
    const { installSkills, updateSkill } = await import("../src/services/skills");
    expect(await installSkills(h.app, { source: "o/r/skills/inner" })).toEqual({ installed: ["inner"] });
    head = "d".repeat(40);
    expect(await updateSkill(h.app, "inner")).toEqual({ updated: false }); // a new commit, same files: found, not "gone"
  });
});
