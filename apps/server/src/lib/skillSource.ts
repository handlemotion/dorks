// What the owner pastes to install a skill (docs/skills.md), turned into a GitHub repository, a ref and a folder. Skills are
// distributed by command, so the field takes the commands people copy from READMEs and skills.sh as they are:
//
//   npx skills add vercel-labs/agent-skills --skill frontend-design -g -a claude-code -y
//   npx skills add https://github.com/anthropics/skills/tree/main/skills/pdf
//   npx skills add owner/repo@skill            npx add-skill owner/repo           npx openskills install owner/repo
//   git clone https://github.com/owner/repo    /plugin marketplace add owner/repo  owner/repo/sub/path  owner/repo#ref
//
// Pure: resolving `refPath` (a /tree/ URL's ref and path, which GitHub's URLs do not separate) needs the API (services/skills.ts).

export interface ParsedSource {
  owner: string;
  repo: string;
  /** A ref named on its own (`owner/repo#ref`). */
  ref: string | null;
  /** The folder in the repository, `""` for the root. Ignored when `refPath` is set. */
  path: string;
  /** From a github.com /tree/ or /blob/ URL: `<ref>/<path>` as segments, split once the ref is known. */
  refPath: string[] | null;
  /** The skills the command named (`--skill a b`, `@skill`); `["*"]` for all; empty for none. */
  skills: string[];
}

export class SourceError extends Error {}

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
/** Package runners that take a sub-command first: `pnpm dlx`, `yarn dlx`, `bun x`. */
const SUBRUNNERS = new Set(["pnpm", "yarn", "bun"]);
const CLIS = new Set(["skills", "add-skill", "openskills"]);
const VERBS = new Set(["add", "a", "install", "i"]);
/** `npx skills add` flags that take values; every other flag stands alone. */
const VALUE_FLAGS = new Set(["-a", "--agent", "--rename", "--owner"]);
const SKILL_FLAGS = new Set(["-s", "--skill"]);

/** Splits a command line like a shell would for this purpose: whitespace, with single and double quotes kept together. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/** Drops `npx -y`, `pnpm dlx`, `skills@1.2 add` and the like, leaving the source and the flags. */
function stripCommand(tokens: string[]): string[] {
  let t = tokens[0] === "$" ? tokens.slice(1) : tokens;
  if (SUBRUNNERS.has(t[0] ?? "") && (t[1] === "dlx" || t[1] === "x")) t = t.slice(2);
  else if (RUNNERS.has(t[0] ?? "")) t = t.slice(1);
  while (t[0]?.startsWith("-")) t = t.slice(1); // npx -y / --yes
  const cli = (t[0] ?? "").replace(/@[^/]*$/, "");
  return CLIS.has(cli) ? skillsCliArgs(cli, t.slice(1)) : otherCommandArgs(t);
}

/** After `skills`, `openskills` (a verb first) or `add-skill` (the source first). */
function skillsCliArgs(cli: string, t: string[]): string[] {
  if (cli === "add-skill") return t;
  if (!VERBS.has(t[0] ?? "")) throw new SourceError("Only the add command installs a skill, like npx skills add owner/repo.");
  return t.slice(1);
}

/** `git clone <url>`, `/plugin marketplace add <src>`, or the source on its own. */
function otherCommandArgs(t: string[]): string[] {
  if (t[0] === "git" && t[1] === "clone")
    return t
      .slice(2)
      .filter((x) => !x.startsWith("-"))
      .slice(0, 1);
  const plugin = t[0] === "/plugin" || (t[0] === "claude" && t[1] === "plugin") ? t.indexOf("add") : -1;
  if (plugin > 0) return t.slice(plugin + 1);
  return t;
}

/** The source token and the skills the flags named. */
function splitFlags(args: string[]): { source: string; skills: string[] } {
  let source = "";
  const skills: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (SKILL_FLAGS.has(a)) {
      while (args[i + 1] && !args[i + 1]!.startsWith("-")) skills.push(args[++i]!);
    } else if (a.startsWith("--skill=")) skills.push(...a.slice(8).split(","));
    else if (a === "--all") skills.push("*");
    else if (VALUE_FLAGS.has(a)) {
      while (args[i + 1] && !args[i + 1]!.startsWith("-")) i++;
    } else if (!a.startsWith("-") && !source) source = a;
  }
  if (!source) throw new SourceError("Paste a GitHub repository, like owner/repo, or an npx skills add command.");
  return { source, skills };
}

const repoOf = (owner: string, repo: string) => {
  const r = repo.replace(/\.git$/, "");
  if (!SEGMENT.test(owner) || !SEGMENT.test(r)) throw new SourceError(`${owner}/${repo} is not a GitHub repository name.`);
  return { owner, repo: r };
};

/** A github.com URL: the repository, and for /tree/ or /blob/ the ref-and-path segments. */
function fromUrl(raw: string): Omit<ParsedSource, "skills"> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError("That is not a valid URL.");
  }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") throw new SourceError("Skills install from GitHub for now: paste a github.com repository or an npx skills add command.");
  const seg = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (seg.length < 2) throw new SourceError("Paste the repository URL, like https://github.com/owner/repo.");
  const { owner, repo } = repoOf(seg[0]!, seg[1]!);
  if (seg[2] === "tree" || seg[2] === "blob") {
    const rest = seg.slice(3);
    if (/^skill\.md$/i.test(rest.at(-1) ?? "")) rest.pop(); // a link to the SKILL.md itself
    return { owner, repo, ref: null, path: "", refPath: rest.length ? rest : null };
  }
  return { owner, repo, ref: null, path: seg.slice(2).join("/"), refPath: null };
}

/** `owner/repo`, `owner/repo/sub/path`, `owner/repo@skill`, `owner/repo#ref`, `owner/repo#ref@skill`, `github:` and ssh forms. */
function fromShorthand(raw: string, skills: string[]): Omit<ParsedSource, "skills"> {
  let s = raw.replace(/^github:/, "");
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/.exec(s);
  if (ssh) s = ssh[1]!;
  if (/^(\.{0,2}\/|~)/.test(s)) throw new SourceError("A local folder cannot be installed here: skills come from GitHub so every sandbox can get them.");
  if (/^(gitlab:|https?:)/.test(s) || s.includes(":")) throw new SourceError("Skills install from GitHub for now: paste a github.com repository or an npx skills add command.");
  const at = /^([^/@#]+\/[^/@#]+)(.*?)@([^/@]+)$/.exec(s);
  if (at) {
    skills.push(at[3]!);
    s = at[1]! + at[2]!;
  }
  let ref: string | null = null;
  const hash = s.indexOf("#");
  if (hash >= 0) {
    ref = s.slice(hash + 1) || null;
    s = s.slice(0, hash);
  }
  const seg = s.split("/").filter(Boolean);
  if (seg.length < 2) throw new SourceError("Paste a GitHub repository, like owner/repo, or an npx skills add command.");
  const { owner, repo } = repoOf(seg[0]!, seg[1]!);
  return { owner, repo, ref, path: seg.slice(2).join("/"), refPath: null };
}

export function parseSkillSource(input: string): ParsedSource {
  const line =
    input
      .trim()
      .split("\n")
      .find((l) => l.trim() && !l.trim().startsWith("#")) ?? "";
  if (!line) throw new SourceError("Paste a GitHub repository, like owner/repo, or an npx skills add command.");
  if (line.length > 2000) throw new SourceError("That is too long for an install command.");
  const { source, skills } = splitFlags(stripCommand(tokenize(line.trim())));
  const parsed = /^https?:\/\//.test(source) ? fromUrl(source) : fromShorthand(source, skills);
  if (parsed.path.split("/").some((p) => p === ".." || p === ".")) throw new SourceError("That folder path is not allowed.");
  return { ...parsed, skills: [...new Set(skills.map((x) => x.trim()).filter(Boolean))] };
}
