import { createHash } from "node:crypto";

// Skills the `dorks` MCP server serves (the MCP Skills extension, `io.modelcontextprotocol/skills`, SEP-2640): each file of a skill is a
// resource under `skill://<name>/<path>`, listed with its SHA-256 digest and size by `skills/list` and read with `resources/read`. A host
// that speaks MCP 2026-07-28 (Claude Code does) offers each skill by its name and description and loads its body only when used, so a
// session that never needs one pays for one line. Hosts verify the bytes against the digest, so the text here is served exactly as written.

export interface SkillFile {
  uri: string;
  text: string;
  mimeType: string;
  digest: string;
  size: number;
}

export interface Skill {
  /** The URI of its SKILL.md. */
  uri: string;
  frontmatter: { name: string; description: string };
  files: SkillFile[];
}

const MACHINE_SETUP_DESCRIPTION =
  "Fix or improve the machine (build) this session runs on, for every future session. Use when you hit a setup problem in this box " +
  "(a missing tool, CLI or runtime, a broken or outdated install step, a dependency each session reinstalls, a missing environment variable, " +
  "a dev server or service that should be prebuilt) or when the user asks to install or set up something for future sessions.";

const MACHINE_SETUP = `# Machine setup

This box starts from a build: a saved image with tools installed, repositories cloned, variables set and services prebuilt, shared by
every session that starts on it. When you notice something wrong or missing in it while you work, propose a fix so the next session
does not hit it too. The owner approves every change; nothing changes until they do.

## When to propose a change

- You had to install a tool, CLI, runtime or system package to do your task, and other sessions in this repository would need it too.
- The build's setup script, or a repository's setup, is broken or out of date: it fails, a lockfile or toolchain version moved, a
  step the repository's docs (README, CONTRIBUTING, AGENTS.md) list is missing.
- A dev server or backing service you needed to test is not in the build's services, or its command, directory or port is wrong.
- The project needs an environment variable the build lacks (a secret only by its name; the owner types the value in).

Do not propose one-off experiments, anything specific to your branch or task, personal preferences, or a bigger machine unless the
work clearly cannot run on this one. When in doubt, mention it in your final answer instead.

## How

1. Keep the user's task first. The proposal is a side task: do it when you have the fix in hand, not instead of the work you were asked
   for.
2. \`machine_get\`: the build as it is (setup script, repositories, services, variables) and your draft if you have one.
3. Make it work in this box first, and note the exact commands that did.
4. \`machine_draft\`: \`setupScript\`, \`repos\` and \`services\` each replace the whole field, so start from what \`machine_get\` shows and
   only add or fix. Scripts run once at build time with \`bash -e\`, as \`user\` with passwordless sudo: keep them idempotent and
   non-interactive (\`sudo apt-get install -y ...\`). Variables merge by name.
5. \`machine_run\` (a trial), then \`machine_logs\` with \`wait: 120\` until it ends. On a failure, fix the draft and run again. Trials are
   limited per day, so get the commands right in this box first.
6. \`machine_submit\` with a \`note\` of one or two sentences: what was wrong and what the change does. The owner sees a card in this chat
   and decides; their answer arrives as a later turn. Do not poll for it, and carry on with your task.
7. Say in your final answer, in one line, that you proposed a change to the machine and why.

On the base machine (\`machine_get\` says so), \`machine_draft\` with a \`name\` proposes a new build for this repository. Do that only when
the repository needs real setup (a toolchain, installs, services) that every session would otherwise repeat.

## Rules

- Never put a secret value in a draft, a script or a note, and never print one. Name the variable and say why; the owner fills it in.
- One draft per session. A submitted draft is frozen until the owner decides.
- \`machine_run\` with \`kind: "image"\` only rebuilds a spec the owner already approved (for example after the base image was updated); to
  change the build, submit a draft.
`;

const sha256 = (s: string) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

function skill(name: string, description: string, body: string): Skill {
  // JSON strings are valid YAML double-quoted scalars, so the frontmatter parses back to exactly these values.
  const text = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
  const uri = `skill://${name}/SKILL.md`;
  return {
    uri,
    frontmatter: { name, description },
    files: [{ uri, text, mimeType: "text/markdown", digest: sha256(text), size: Buffer.byteLength(text, "utf8") }],
  };
}

export const SKILLS: Skill[] = [skill("machine-setup", MACHINE_SETUP_DESCRIPTION, MACHINE_SETUP)];

/** A skill's `skills/list` / `skills/get` entry: its frontmatter and the manifest of its files. */
export const skillEntry = (s: Skill) => ({
  uri: s.uri,
  frontmatter: s.frontmatter,
  resources: s.files.map((f) => ({ uri: f.uri, digest: f.digest, size: f.size })),
});

export const skillFileByUri = (uri: string): SkillFile | undefined => SKILLS.flatMap((s) => s.files).find((f) => f.uri === uri);
