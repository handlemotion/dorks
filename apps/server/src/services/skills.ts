import { gunzipSync, gzipSync } from "node:zlib";
import type { SkillBundle, SkillRef, SkillResolution, SkillView } from "@dorks/shared";
import { AppFail, fail, type App } from "../app";
import { getDork } from "../data";
import { findSkills, MAX_SKILL_BYTES, MAX_SKILL_FILES, MAX_TARBALL_BYTES, skillDigest, untar, type FoundSkill, type TarFile } from "../lib/skillRepo";
import { parseSkillSource, SourceError, type ParsedSource } from "../lib/skillSource";
import { reconfigureAwake } from "./mcpServers";
import { githubToken } from "./settings";

// Skills from Customize (docs/skills.md). The owner pastes a GitHub repository or an `npx skills add` command once; this server
// downloads the repository's tarball, keeps each chosen skill's folder in SQLite, and every sandbox gets it in ~/.claude/skills
// through the bridge (`configure` lists name and digest, the `skill` rpc returns the files). Nothing is installed per session.

const API = "https://api.github.com";
const HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "dorks" };
const TIMEOUT_MS = 60_000;
const MAX_SKILLS = 200;
const CACHE_MS = 10 * 60_000;

interface Row {
  name: string;
  description: string;
  repo: string;
  ref: string | null;
  path: string;
  sha: string;
  digest: string;
  file_count: number;
  bytes: number;
  files: Uint8Array;
  installed_at: number;
  updated_at: number;
}

const viewOf = (r: Row): SkillView => ({
  name: r.name,
  description: r.description,
  source: { repo: r.repo, ref: r.ref, path: r.path },
  sha: r.sha,
  url: `https://github.com/${r.repo}/tree/${r.sha}${r.path ? `/${r.path}` : ""}`,
  fileCount: r.file_count,
  bytes: r.bytes,
  installedAt: r.installed_at,
  updatedAt: r.updated_at,
});

const LIST = "SELECT name, description, repo, ref, path, sha, digest, file_count, bytes, installed_at, updated_at FROM skills ORDER BY name";
export const listSkills = (app: App): SkillView[] => app.db.all<Row>(LIST).map(viewOf);

/** What `configure` carries: each skill's name and digest. The bridge fetches the files of the ones it does not have. */
export const skillRefs = (app: App): SkillRef[] => app.db.all<{ name: string; digest: string }>("SELECT name, digest FROM skills ORDER BY name");

/** The bridge's `skill` rpc: one skill's files, for a dork that exists. Skills hold no secrets, so no further gating. */
export function skillBundle(app: App, dorkId: string, name: unknown): SkillBundle {
  const dork = getDork(app.db, dorkId);
  if (!dork || dork.deleting) fail("forbidden", "forbidden");
  const r = typeof name === "string" ? app.db.get<Pick<Row, "name" | "digest" | "files">>("SELECT name, digest, files FROM skills WHERE name = ?", name) : undefined;
  if (!r) fail("not_found", "no such skill");
  return { name: r.name, digest: r.digest, files: JSON.parse(gunzipSync(r.files).toString("utf8")) as SkillBundle["files"] };
}

// ---------------------------------------------------------------- GitHub

/** Tarballs read recently, by `owner/repo@sha`: Find then Install reads the repository once. */
const tarballs = new Map<string, { at: number; files: TarFile[] }>();

const authHeaders = (token: string | undefined): Record<string, string> => (token ? { ...HEADERS, Authorization: `Bearer ${token}` } : HEADERS);

async function gh(app: App, token: string | undefined, path: string, accept?: string): Promise<Response> {
  try {
    return await app.fetch(`${API}${path}`, { headers: { ...authHeaders(token), ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    fail("failed", "GitHub could not be reached. Check the connection and try again.");
  }
}

function refused(res: Response, repo: string): never {
  if (res.status === 404 || res.status === 422) fail("not_found", `GitHub has no ${repo} that this computer's GitHub login can see.`);
  if (res.status === 403 || res.status === 429) fail("limit", "GitHub's rate limit was hit. Connect GitHub in Settings, or try again in a few minutes.");
  fail("failed", `GitHub answered ${res.status} for ${repo}.`);
}

/** The commit a ref names (null: the default branch), or null when GitHub has no such ref. */
async function commitOf(app: App, token: string | undefined, repo: string, ref: string | null): Promise<string | null> {
  const res = await gh(app, token, `/repos/${repo}/commits/${encodeURIComponent(ref ?? "HEAD")}`, "application/vnd.github.sha");
  if (res.ok) return (await res.text()).trim();
  if (ref && (res.status === 404 || res.status === 422)) {
    // A missing ref in a repository that exists: tell the two apart for a clear message.
    const repoRes = await gh(app, token, `/repos/${repo}`);
    if (repoRes.ok) return null;
    refused(repoRes, repo);
  }
  refused(res, repo);
}

/** A /tree/ URL's segments are `<ref>/<path>` with no way to tell where the ref ends: try the shortest ref first. */
async function splitRefPath(app: App, token: string | undefined, repo: string, segs: string[]): Promise<{ ref: string; path: string; sha: string }> {
  for (let i = 1; i <= Math.min(segs.length, 6); i++) {
    const ref = segs.slice(0, i).join("/");
    const sha = await commitOf(app, token, repo, ref);
    if (sha) return { ref, path: segs.slice(i).join("/"), sha };
  }
  fail("not_found", `${repo} has no branch or tag ${segs[0]}.`);
}

async function readBody(res: Response): Promise<Uint8Array> {
  if (Number(res.headers.get("content-length")) > MAX_TARBALL_BYTES) fail("invalid", "That repository is too large to install skills from (over 64 MB).");
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = res.body!.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    n += r.value.length;
    if (n > MAX_TARBALL_BYTES) {
      void reader.cancel();
      fail("invalid", "That repository is too large to install skills from (over 64 MB).");
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks);
}

async function tarball(app: App, token: string | undefined, repo: string, sha: string): Promise<TarFile[]> {
  const key = `${repo}@${sha}`;
  const hit = tarballs.get(key);
  if (hit && app.now() - hit.at < CACHE_MS) return hit.files;
  const res = await gh(app, token, `/repos/${repo}/tarball/${sha}`);
  if (!res.ok) refused(res, repo);
  let files: TarFile[];
  try {
    files = untar(await readBody(res));
  } catch (e) {
    if (e instanceof AppFail) throw e;
    fail("failed", `The download of ${repo} could not be read.`);
  }
  for (const [k, v] of tarballs) if (app.now() - v.at >= CACHE_MS || tarballs.size >= 4) tarballs.delete(k);
  tarballs.set(key, { at: app.now(), files });
  return files;
}

interface Resolved {
  parsed: ParsedSource;
  repo: string;
  ref: string | null;
  sha: string;
  found: FoundSkill[];
}

async function resolve(app: App, input: unknown): Promise<Resolved> {
  if (typeof input !== "string") fail("invalid", "source must be text");
  let parsed: ParsedSource;
  try {
    parsed = parseSkillSource(input);
  } catch (e) {
    if (e instanceof SourceError) fail("invalid", e.message);
    throw e;
  }
  const token = await githubToken(app);
  const repo = `${parsed.owner}/${parsed.repo}`;
  let { ref, path } = parsed;
  let sha: string;
  if (parsed.refPath) ({ ref, path, sha } = await splitRefPath(app, token, repo, parsed.refPath));
  else sha = (await commitOf(app, token, repo, ref)) ?? fail("not_found", `${repo} has no branch or tag ${ref}.`);
  const found = findSkills(await tarball(app, token, repo, sha), path, parsed.repo);
  if (!found.length) fail("not_found", `No SKILL.md found in ${repo}${path ? `/${path}` : ""}.`);
  return { parsed, repo, ref, sha, found };
}

/** `POST /api/skills/resolve`: the skills a source holds, so the owner can choose before anything is saved. */
export async function resolveSkills(app: App, source: unknown): Promise<SkillResolution> {
  const r = await resolve(app, source);
  const installed = new Set(app.db.all<{ name: string }>("SELECT name FROM skills").map((x) => x.name));
  const names = new Set(r.found.map((s) => s.name));
  const requested = r.parsed.skills.includes("*") ? [...names] : r.parsed.skills.filter((s) => names.has(s));
  return {
    repo: r.repo,
    ref: r.ref,
    sha: r.sha,
    requested: requested.length || r.found.length > 1 ? requested : [r.found[0]!.name],
    skills: r.found.map((s) => ({ name: s.name, description: s.description, path: s.path, fileCount: s.files.length, bytes: s.bytes, installed: installed.has(s.name) })),
  };
}

function checkSize(s: FoundSkill) {
  if (s.files.length > MAX_SKILL_FILES) fail("invalid", `${s.name} has too many files (over ${MAX_SKILL_FILES}).`);
  if (s.bytes > MAX_SKILL_BYTES) fail("invalid", `${s.name} is too large (over 8 MB).`);
}

const packFiles = (s: FoundSkill) => gzipSync(JSON.stringify(s.files.map((f) => ({ path: f.path, data: Buffer.from(f.data).toString("base64"), ...(f.exec ? { exec: true } : {}) }))));

/** Saves skills and has every awake agent sync (no restart: Claude Code reloads ~/.claude/skills). Runs in the caller's transaction. */
function save(app: App, r: Pick<Resolved, "repo" | "ref" | "sha">, skills: FoundSkill[]) {
  for (const s of skills) {
    app.db.run(
      `INSERT INTO skills (name, description, repo, ref, path, sha, digest, file_count, bytes, files, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET description = excluded.description, repo = excluded.repo, ref = excluded.ref, path = excluded.path, sha = excluded.sha,
         digest = excluded.digest, file_count = excluded.file_count, bytes = excluded.bytes, files = excluded.files, updated_at = excluded.updated_at`,
      s.name,
      s.description,
      r.repo,
      r.ref,
      s.path,
      r.sha,
      skillDigest(s.files),
      s.files.length,
      s.bytes,
      packFiles(s),
      app.now(),
      app.now(),
    );
  }
  reconfigureAwake(app);
  app.db.afterCommit(() => app.hub.emit({ t: "settings" }));
}

/** `POST /api/skills`: installs the named skills of a source (all of them when it holds one and none is named). */
export async function installSkills(app: App, input: { source?: unknown; skills?: unknown }): Promise<{ installed: string[] }> {
  const r = await resolve(app, input.source);
  const want = Array.isArray(input.skills) ? input.skills.filter((s): s is string => typeof s === "string") : [];
  const pick = want.length ? r.found.filter((s) => want.includes(s.name)) : r.found.length === 1 ? r.found : [];
  if (!pick.length) fail("invalid", "Choose the skills to install.");
  pick.forEach(checkSize);
  app.db.tx(() => {
    const have = new Set(app.db.all<{ name: string }>("SELECT name FROM skills").map((x) => x.name));
    if ([...have, ...pick.map((s) => s.name)].filter((n, i, all) => all.indexOf(n) === i).length > MAX_SKILLS) fail("invalid", `at most ${MAX_SKILLS} skills`);
    save(app, r, pick);
  });
  return { installed: pick.map((s) => s.name) };
}

/** `POST /api/skills/:name/update`: downloads the skill again from its source (the same ref, so a branch moves forward). */
export async function updateSkill(app: App, name: string): Promise<{ updated: boolean }> {
  const row = app.db.get<Row>("SELECT * FROM skills WHERE name = ?", name);
  if (!row) fail("not_found", "no such skill");
  const ref = row.ref ? `#${row.ref}` : "";
  // Its own folder first (a root SKILL.md would hide a nested skill from a whole-repo search), then the repo, for a moved skill.
  const atPath = row.path ? await resolve(app, `${row.repo}/${row.path}${ref}`).catch((e: unknown) => (e instanceof AppFail && e.error.code === "not_found" ? null : Promise.reject(e))) : null;
  const r = atPath?.found.some((f) => f.path === row.path) ? atPath : await resolve(app, `${row.repo}${ref}`);
  const s = r.found.find((f) => f.path === row.path) ?? r.found.find((f) => f.name === row.name);
  if (!s) fail("not_found", `${row.repo} no longer has this skill.`);
  checkSize(s);
  if (r.sha === row.sha) return { updated: false };
  const changed = skillDigest(s.files) !== row.digest;
  app.db.tx(() => save(app, r, [{ ...s, name: row.name }])); // the new commit is recorded even when this folder did not change
  return { updated: changed };
}

export function deleteSkill(app: App, name: string): void {
  app.db.tx(() => {
    if (!app.db.get("SELECT name FROM skills WHERE name = ?", name)) return;
    app.db.run("DELETE FROM skills WHERE name = ?", name);
    reconfigureAwake(app);
    app.db.afterCommit(() => app.hub.emit({ t: "settings" }));
  });
}
