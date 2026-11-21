import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { SKILL_NAME } from "@dorks/shared";

// A GitHub tarball read into memory, and the Agent Skills in it (docs/skills.md). Pure, so it is tested without the network.

export interface TarFile {
  /** Relative to the repository root (GitHub's `<owner>-<repo>-<sha>/` top folder removed). */
  path: string;
  data: Uint8Array;
  exec: boolean;
}

export const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
export const MAX_SKILL_FILES = 1000;
export const MAX_SKILL_BYTES = 8 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const cstr = (b: Uint8Array, start: number, len: number) => {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return text(end >= 0 ? s.subarray(0, end) : s);
};
const octal = (b: Uint8Array, start: number, len: number) => parseInt(cstr(b, start, len).trim() || "0", 8);

/** `key=value` records of a pax header (`<len> key=value\n`). */
function pax(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const s = text(b);
  let i = 0;
  while (i < s.length) {
    const sp = s.indexOf(" ", i);
    const len = Number(s.slice(i, sp));
    if (!(len > 0) || sp < 0) break;
    const rec = s.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** The regular files of a gzipped tar (ustar, pax and GNU long names), top folder stripped. Links and devices are skipped. */
export function untar(gz: Uint8Array): TarFile[] {
  const b = gunzipSync(gz, { maxOutputLength: MAX_UNPACKED_BYTES });
  const files: TarFile[] = [];
  let next: { path?: string; size?: number } = {};
  for (let off = 0; off + 512 <= b.length;) {
    const h = b.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const type = String.fromCharCode(h[156]!);
    const size = next.size ?? octal(h, 124, 12);
    const body = b.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") next = { ...next, ...paxEntry(body) };
    else if (type === "L") next = { ...next, path: cstr(body, 0, body.length) };
    else if (type !== "g") {
      const prefix = cstr(h, 345, 155);
      const name = next.path ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
      next = {};
      const path = name.split("/").slice(1).join("/");
      if ((type === "0" || type === "\0" || type === "7") && path) files.push({ path, data: body, exec: (octal(h, 100, 8) & 0o111) !== 0 });
    }
  }
  return files;
}

function paxEntry(body: Uint8Array): { path?: string; size?: number } {
  const p = pax(body);
  return { ...(p.path ? { path: p.path } : {}), ...(p.size ? { size: Number(p.size) } : {}) };
}

/** `name` and `description` from SKILL.md's YAML frontmatter: plain, quoted and block (`|`, `>`) scalars. Nothing else is read. */
export function frontmatter(md: string): { name?: string; description?: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(md);
  if (!m) return {};
  const lines = m[1]!.split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv || (kv[1] !== "name" && kv[1] !== "description")) continue;
    let v = kv[2]!.trim();
    if (/^[|>][+-]?$/.test(v)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) block.push(lines[++i]!.trim());
      v = v.startsWith("|") ? block.join("\n").trim() : block.filter(Boolean).join(" ");
    } else v = unquote(v);
    out[kv[1]] = v;
  }
  return out;
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v.replace(/\s+#.*$/, "");
}

/** A name that meets the Agent Skills rule: as written when it does, else the folder name made to fit. */
export function skillName(declared: string | undefined, folder: string): string {
  if (declared && SKILL_NAME.test(declared)) return declared;
  const slug = (declared || folder)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || "skill";
}

export interface FoundSkill {
  name: string;
  description: string;
  /** The folder in the repository, `""` for the root. */
  path: string;
  /** Relative to the skill folder. */
  files: TarFile[];
  bytes: number;
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const under = (path: string, dir: string) => dir === "" || path === dir || path.startsWith(`${dir}/`);
const skipped = (p: string) => p.split("/").some((s) => SKIP_DIRS.has(s));

/**
 * The skills under `root`: a SKILL.md right there is the one skill (as `npx skills add` does); otherwise every folder below with a
 * SKILL.md. A skill's files are its folder, minus any skill folder nested in it. `fallback` names a skill at the repository root.
 */
export function findSkills(files: TarFile[], root: string, fallback: string): FoundSkill[] {
  const isSkill = (f: TarFile) => /(^|\/)SKILL\.md$/i.test(f.path) && under(f.path, root) && !skipped(f.path);
  const marks = files.filter(isSkill);
  const top = marks.find((f) => dirOf(f.path) === root);
  const dirs = (top ? [top] : marks).map((f) => dirOf(f.path));
  const seen = new Set<string>();
  const out: FoundSkill[] = [];
  for (const dir of dirs.sort()) {
    const nested = dirs.filter((d) => d !== dir && under(d, dir));
    const own = files.filter((f) => under(f.path, dir) && !skipped(f.path) && !nested.some((d) => under(f.path, d)));
    const rel = own.map((f) => ({ ...f, path: dir ? f.path.slice(dir.length + 1) : f.path }));
    const md = rel.find((f) => /^SKILL\.md$/i.test(f.path));
    if (!md) continue;
    const fm = frontmatter(text(md.data));
    const name = skillName(fm.name, dir ? dir.slice(dir.lastIndexOf("/") + 1) : fallback);
    if (seen.has(name)) continue;
    seen.add(name);
    const withMd = rel.map((f) => (f === md && f.path !== "SKILL.md" ? { ...f, path: "SKILL.md" } : f));
    out.push({ name, description: (fm.description ?? "").slice(0, 1024), path: dir, files: withMd, bytes: withMd.reduce((n, f) => n + f.data.length, 0) });
  }
  return out;
}

/** The skill folder's identity: what the bridge compares to decide whether to fetch it again. */
export function skillDigest(files: readonly { path: string; data: Uint8Array; exec: boolean }[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path}\0${f.exec ? 1 : 0}\0${createHash("sha256").update(f.data).digest("hex")}\n`);
  }
  return h.digest("hex");
}
