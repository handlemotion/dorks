import { chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import type { SkillBundle, SkillRef } from "@dorks/shared";
import type { Identity } from "./runas";

// The owner's skills (docs/skills.md): installed once in Customize, kept by the server, written here into the agent's
// ~/.claude/skills so every session has them. Claude Code reloads that folder by itself, so a change needs no restart.
//
// Only folders this bridge wrote are ever replaced or removed (recorded in <state dir>/skills.json): a skill the agent installed
// for this session alone (`npx skills add ... -g`) is left as it is, and wins over a shared skill of the same name.

type Log = (...a: unknown[]) => void;
type Manifest = Record<string, string>; // name -> digest

export interface SkillSyncDeps {
  stateDir: string;
  /** The Claude config dir of the agent (`$CLAUDE_CONFIG_DIR`, else `~/.claude` of the user it runs as). */
  configDir: string;
  runAs: Identity | null;
  fetch: (name: string) => Promise<SkillBundle>;
  log: Log;
}

const manifestPath = (stateDir: string) => join(stateDir, "skills.json");

/** Prototype-free, so a skill named `constructor` or `toString` is never mistaken for one this bridge wrote. */
function readManifest(stateDir: string): Manifest {
  const out: Manifest = Object.create(null);
  try {
    const m = JSON.parse(readFileSync(manifestPath(stateDir), "utf8")) as unknown;
    if (m && typeof m === "object") for (const [k, v] of Object.entries(m)) if (typeof v === "string") out[k] = v;
  } catch {
    /* none yet */
  }
  return out;
}

/** A file path inside the skill folder, or null for one that would escape it. */
function safePath(root: string, rel: string): string | null {
  if (!rel || rel.startsWith("/") || rel.includes("\0") || rel.includes("\\")) return null;
  const p = normalize(join(root, rel));
  return p.startsWith(root + sep) ? p : null;
}

/** Gives the folder and everything in it to the agent's user, so it can read and run what it was given. */
function chownTree(path: string, id: Identity) {
  chownSync(path, id.uid, id.gid);
  if (!lstatSync(path).isDirectory()) return;
  for (const e of readdirSync(path)) chownTree(join(path, e), id);
}

function ensureDir(dir: string, id: Identity | null) {
  if (existsSync(dir)) return;
  ensureDir(dirname(dir), id);
  mkdirSync(dir, { mode: 0o755 });
  if (id) chownSync(dir, id.uid, id.gid);
}

/** Writes one skill to a fresh folder beside the target and swaps it in, so the agent never reads a half-written skill. */
function writeSkill(root: string, b: SkillBundle, id: Identity | null) {
  const tmp = join(root, `.dorks-${b.name}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { mode: 0o755 });
  for (const f of b.files) {
    const p = safePath(tmp, f.path);
    if (!p) continue;
    mkdirSync(dirname(p), { recursive: true, mode: 0o755 });
    writeFileSync(p, Buffer.from(f.data, "base64"), { mode: f.exec ? 0o755 : 0o644 });
  }
  if (id) chownTree(tmp, id);
  const target = join(root, b.name);
  rmSync(target, { recursive: true, force: true });
  renameSync(tmp, target);
}

/**
 * Brings the skills folder in step with the owner's list: writes new and changed skills, removes the ones the owner removed.
 * Never throws: a skill that cannot be fetched or written is logged and tried again on the next configure.
 */
export async function syncSkills(d: SkillSyncDeps, want: readonly SkillRef[]): Promise<void> {
  const had = readManifest(d.stateDir);
  if (!want.length && !Object.keys(had).length) return;
  const root = join(d.configDir, "skills");
  const next: Manifest = Object.create(null);
  try {
    ensureDir(root, d.runAs);
  } catch (e) {
    return d.log("skills: cannot create", root, (e as Error).message);
  }
  const wanted = new Set(want.map((s) => s.name));
  for (const name of Object.keys(had)) if (!wanted.has(name)) rmSync(join(root, name), { recursive: true, force: true });
  for (const s of want) {
    const dir = join(root, s.name);
    if (had[s.name] === s.digest && existsSync(dir)) {
      next[s.name] = s.digest;
      continue;
    }
    if (!had[s.name] && existsSync(dir)) {
      d.log("skills: keeping this session's own", s.name);
      continue;
    }
    try {
      const b = await d.fetch(s.name);
      writeSkill(root, b, d.runAs);
      next[s.name] = b.digest;
    } catch (e) {
      d.log("skills: could not install", s.name, (e as Error)?.message ?? e);
      if (had[s.name] && existsSync(dir)) next[s.name] = had[s.name]; // the old copy stays until the next try
    }
  }
  writeFileSync(manifestPath(d.stateDir), JSON.stringify(next));
}
