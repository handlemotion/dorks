import { z } from "zod";

// Skills (docs/skills.md): Agent Skills (a folder with a SKILL.md, https://agentskills.io) the owner installs once in Customize.
// The server downloads them from GitHub and keeps their files; every agent gets them in ~/.claude/skills of its sandbox, so they are
// shared by all sessions. A session can still install one for itself (`npx skills add ... -g`): the bridge never touches those.

/** The Agent Skills name rule: lowercase letters, digits and single hyphens, 1 to 64 characters. It is also the folder name. */
export const SKILL_NAME = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;

/** A skill as the bridge learns about it in `configure`: the files are fetched with the `skill` rpc when the digest changed. */
export const skillRef = z.object({ name: z.string().regex(SKILL_NAME), digest: z.string().regex(/^[0-9a-f]{64}$/) });
export type SkillRef = z.infer<typeof skillRef>;

/** One file of a skill, relative to its folder (at most 512 characters, which the server checks on install); `data` is base64, `exec` keeps a script's executable bit. */
export const skillFile = z.object({ path: z.string().min(1).max(512), data: z.string(), exec: z.boolean().optional() });
export type SkillFile = z.infer<typeof skillFile>;

/** The answer to the bridge's `skill` rpc. */
export const skillBundle = z.object({ name: z.string().regex(SKILL_NAME), digest: z.string(), files: z.array(skillFile).max(1000) });
export type SkillBundle = z.infer<typeof skillBundle>;

/** Where an installed skill came from: a GitHub repository, the ref asked for (null: the default branch) and the folder in it. */
export interface SkillSource {
  repo: string;
  ref: string | null;
  /** The skill's folder in the repository, `""` for the root. */
  path: string;
}

/** An installed skill as a client sees it. */
export interface SkillView {
  name: string;
  description: string;
  source: SkillSource;
  /** The commit it was downloaded from. */
  sha: string;
  /** github.com link to the folder at that commit. */
  url: string;
  fileCount: number;
  bytes: number;
  installedAt: number;
  updatedAt: number;
}

/** A skill found in a repository by `POST /api/skills/resolve`, before it is installed. */
export interface SkillCandidate {
  name: string;
  description: string;
  path: string;
  fileCount: number;
  bytes: number;
  /** Already installed under this name (installing replaces it). */
  installed: boolean;
}

export interface SkillResolution {
  repo: string;
  ref: string | null;
  sha: string;
  skills: SkillCandidate[];
  /** The skills the pasted command named (`--skill`, `owner/repo@skill`); the UI preselects them. Empty: none named. */
  requested: string[];
}
