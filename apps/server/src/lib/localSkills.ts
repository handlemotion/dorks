import { readdirSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { findSkills, MAX_SKILL_BYTES, MAX_SKILL_FILES, type FoundSkill, type TarFile } from "./skillRepo";

// Skills already on this computer (docs/skills.md, "From this computer"): the folders `npx skills add -g` and Claude Code keep in
// the owner's home. The server runs on the owner's Mac, so it reads them straight from disk.

/** Where skills live on this computer, first wins on a name: `npx skills`' global folder, then Claude Code's own. */
export const localSkillRoots = (home = homedir()): string[] => [join(home, ".agents", "skills"), join(home, ".claude", "skills")];

/** `~/…` for a path in the owner's home, for display. */
export const tildePath = (p: string, home = homedir()): string => (p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

const SKIP = new Set(["node_modules", ".git", ".DS_Store"]);

const statOrNull = (p: string): Stats | null => {
  try {
    return statSync(p); // follows symlinks: `npx skills` links ~/.claude/skills/<name> to ~/.agents/skills/<name>
  } catch {
    return null;
  }
};

export interface LocalFolder {
  /** The folder as listed (a symlink stays a symlink, so re-pointing it is followed). */
  dir: string;
  skill: FoundSkill;
  /** More than a skill may hold (files or bytes): listed, but refused on import. */
  over: boolean;
}

/** One skill folder read from disk: its own SKILL.md and everything beside it (symlinks followed, each folder once), or null. */
export function readSkillDir(dir: string): LocalFolder | null {
  const st = statOrNull(dir);
  if (!st?.isDirectory() || !statOrNull(join(dir, "SKILL.md"))?.isFile()) return null;
  const files: TarFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let over = false;
  const walk = (abs: string, rel: string) => {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (over) return;
      if (SKIP.has(name)) continue;
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const s = statOrNull(p);
      if (s?.isDirectory()) walk(p, r);
      else if (s?.isFile()) {
        if (files.length >= MAX_SKILL_FILES || bytes + s.size > MAX_SKILL_BYTES) {
          over = true;
          return;
        }
        try {
          files.push({ path: r, data: readFileSync(p), exec: (s.mode & 0o111) !== 0 });
          bytes += s.size;
        } catch {
          // unreadable: left out
        }
      }
    }
  };
  walk(dir, "");
  const skill = findSkills(files, "", basename(dir)).find((s) => s.path === "");
  return skill ? { dir, skill, over } : null;
}

/** Every skill in `roots`, by name (the first root that has a name wins; a folder linked from both counts once). */
export function listLocalFolders(roots: string[]): LocalFolder[] {
  const out: LocalFolder[] = [];
  const names = new Set<string>();
  const reals = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const dir = join(root, e);
      let real: string;
      try {
        real = realpathSync(dir);
      } catch {
        continue;
      }
      if (reals.has(real)) continue;
      const f = readSkillDir(dir);
      if (!f || names.has(f.skill.name)) continue;
      reals.add(real);
      names.add(f.skill.name);
      out.push(f);
    }
  }
  return out.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
}
