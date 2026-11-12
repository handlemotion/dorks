import { createHash, createHmac } from "node:crypto";
import {
  buildRepo,
  draftVar,
  machineType as machineTypeSchema,
  MAX_BUILD_NAME_CHARS,
  MAX_BUILD_REPOS,
  MAX_SCRIPT_CHARS,
  VAR_NAME,
  type BuildRepo,
  type BuildSpec,
  type BuildVarView,
  type BuildView,
  type DraftVar,
  type DraftView,
  type MachineType,
} from "@dorks/shared";
import { z } from "zod";
import { fail, touch, type App } from "../app";
import { decrypt, encrypt } from "../core/crypto";
import { insert, json, update } from "../db";
import { instanceId } from "../lib/box";
import { append, dispatch, enqueue } from "../lifecycle/dispatch";
import { getDork } from "../data";
import { readSettings, MAX_SECRET_BYTES } from "./settings";
import { runViewOf, type RunRow } from "./buildRuns";

// Builds (docs/builds.md): named machine setups. A build's image is a Boat saved snapshot layered on the base snapshot; the run that
// makes it lives in buildRuns.ts. This file owns the definition, its variables, and agents' drafts.
//
// The spec (size, setup script, repos, names of build-time variables) decides the image; its hash is what the owner approves. An
// owner edit approves itself. An agent never edits the build: it edits a draft, which only an owner turns into the build.

export const MAX_BUILDS = 50;
export const MAX_VARS = 100;

export interface BuildRow {
  id: string;
  name: string;
  machineType: MachineType;
  setupScript: string;
  repos: BuildRepo[];
  rev: number;
  specHash: string;
  approvedHash: string | null;
  image: string | null;
  imageHash: string | null;
  imageBase: string | null;
  imageVars: string | null;
  imageAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface VarRow {
  name: string;
  valueEnc: string | null;
  secret: boolean;
  buildTime: boolean;
}

const buildOf = (r: Record<string, unknown>): BuildRow => ({
  id: r.id as string,
  name: r.name as string,
  machineType: r.machine_type as MachineType,
  setupScript: r.setup_script as string,
  repos: json<BuildRepo[]>(r.repos) ?? [],
  rev: r.rev as number,
  specHash: r.spec_hash as string,
  approvedHash: (r.approved_hash as string | null) ?? null,
  image: (r.image as string | null) ?? null,
  imageHash: (r.image_hash as string | null) ?? null,
  imageBase: (r.image_base as string | null) ?? null,
  imageVars: (r.image_vars as string | null) ?? null,
  imageAt: (r.image_at as number | null) ?? null,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

export const getBuild = (app: App, id: string): BuildRow | undefined => {
  const r = app.db.get("SELECT * FROM builds WHERE id = ?", id);
  return r ? buildOf(r) : undefined;
};

export function ownBuild(app: App, id: string): BuildRow {
  const b = getBuild(app, id);
  if (!b) return fail("not_found", "This build no longer exists.");
  return b;
}

export const varsOf = (app: App, buildId: string): VarRow[] =>
  app.db.all("SELECT * FROM build_vars WHERE build_id = ? ORDER BY name", buildId).map((r) => ({
    name: r.name as string,
    valueEnc: (r.value_enc as string | null) ?? null,
    secret: r.secret === 1,
    buildTime: r.build_time === 1,
  }));

// ---------------------------------------------------------------- spec and hashes
export function specOf(b: Pick<BuildRow, "machineType" | "setupScript" | "repos">, vars: { name: string; buildTime: boolean }[]): BuildSpec {
  return {
    machineType: b.machineType,
    setupScript: b.setupScript,
    repos: b.repos.map((r) => ({ repo: r.repo, ...(r.branch ? { branch: r.branch } : {}), ...(r.setupScript ? { setupScript: r.setupScript } : {}) })),
    buildTimeVars: vars
      .filter((v) => v.buildTime)
      .map((v) => v.name)
      .sort(),
  };
}

/** Canonical: fixed key order, so the same spec always hashes the same. */
export const hashSpec = (s: BuildSpec): string =>
  createHash("sha256")
    .update(JSON.stringify([s.machineType, s.setupScript, s.repos.map((r) => [r.repo.toLowerCase(), r.branch ?? null, r.setupScript ?? null]), s.buildTimeVars]))
    .digest("hex");

/** A keyed hash (never a plain one: values may be low-entropy secrets) of the build-time values, to tell when an image went stale. */
export const varsDigest = (app: App, buildId: string, values: Record<string, string>): string =>
  createHmac("sha256", app.cfg.bridgeSecretKey)
    .update(`build-vars|${buildId}|`)
    .update(JSON.stringify(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))))
    .digest("hex");

/** Which base the images are layered on: the base snapshot's name, and the bridge bundle it was built from when the app built it. */
export function baseKey(app: App): string {
  const s = readSettings(app);
  const base = s.baseSnapshotId ?? app.cfg.baseSnapshotId ?? "";
  const row = app.db.get<{ ready_name: string | null; ready_bundle_id: string | null }>("SELECT ready_name, ready_bundle_id FROM snapshot_build WHERE id = 1");
  return row?.ready_name && row.ready_name === base ? `${base}:${row.ready_bundle_id ?? ""}` : base;
}

/** The saved snapshot a build's image is kept under: per install and per build, lowercase, at most 63 characters. */
export const imageName = (app: App, buildId: string) =>
  `dorks-b-${instanceId(app)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 8)}-${buildId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 8)}`;

// ---------------------------------------------------------------- input validation
const specInput = z.object({
  machineType: machineTypeSchema.optional(),
  setupScript: z.string().max(MAX_SCRIPT_CHARS, "the setup script is longer than 64 KB").optional(),
  repos: z.array(buildRepo).max(MAX_BUILD_REPOS, `at most ${MAX_BUILD_REPOS} repositories`).optional(),
});

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) {
    const issue = r.error.issues[0];
    return fail("invalid", `${issue?.path.length ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? "invalid input"}`);
  }
  return r.data;
}

function cleanName(v: unknown): string {
  const name = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!name) fail("invalid", "Give the build a name.");
  if (name.length > MAX_BUILD_NAME_CHARS) fail("invalid", `Build names are at most ${MAX_BUILD_NAME_CHARS} characters.`);
  return name;
}

function uniqueRepos(repos: BuildRepo[]) {
  const seen = new Set<string>();
  for (const r of repos) {
    const k = r.repo.toLowerCase();
    if (seen.has(k)) fail("invalid", `${r.repo} is listed twice.`);
    seen.add(k);
  }
}

function nameTaken(app: App, name: string, except?: string) {
  const other = app.db.get<{ id: string }>("SELECT id FROM builds WHERE lower(name) = lower(?)", name);
  if (other && other.id !== except) fail("conflict", `A build named "${name}" already exists.`);
}

// ---------------------------------------------------------------- owner: builds
export function createBuild(app: App, input: Record<string, unknown>): string {
  const name = cleanName(input.name);
  const spec = parse(specInput, { machineType: input.machineType, setupScript: input.setupScript, repos: input.repos });
  uniqueRepos(spec.repos ?? []);
  return app.db.tx(() => {
    if ((app.db.get<{ n: number }>("SELECT count(*) AS n FROM builds")?.n ?? 0) >= MAX_BUILDS) fail("limit", `At most ${MAX_BUILDS} builds.`);
    nameTaken(app, name);
    const id = app.uuid();
    const now = app.now();
    const row = { machineType: spec.machineType ?? "default", setupScript: spec.setupScript ?? "", repos: spec.repos ?? [] };
    const hash = hashSpec(specOf(row, []));
    insert(app.db, "builds", { id, name, ...row, rev: 1, specHash: hash, approvedHash: hash, createdAt: now, updatedAt: now });
    touch(app, { t: "builds" });
    return id;
  });
}

/** Recomputes the spec after an owner change: bumps the revision when it changed, and approves it (the owner made it). */
function respec(app: App, buildId: string) {
  const b = ownBuild(app, buildId);
  const hash = hashSpec(specOf(b, varsOf(app, buildId)));
  const patch: Record<string, unknown> = { approvedHash: hash, updatedAt: app.now() };
  if (hash !== b.specHash) Object.assign(patch, { specHash: hash, rev: b.rev + 1 });
  update(app.db, "builds", { id: buildId }, patch);
  touch(app, { t: "builds" });
  touch(app, { t: "build", buildId });
}

export function updateBuild(app: App, buildId: string, input: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = cleanName(input.name);
  const spec = parse(specInput, { machineType: input.machineType, setupScript: input.setupScript, repos: input.repos });
  if (spec.repos) uniqueRepos(spec.repos);
  Object.assign(patch, Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== undefined)));
  app.db.tx(() => {
    ownBuild(app, buildId);
    if (typeof patch.name === "string") nameTaken(app, patch.name, buildId);
    update(app.db, "builds", { id: buildId }, patch);
    respec(app, buildId);
  });
}

/** Deletes the build; its saved snapshot is removed in the background. Dorks on it keep their boxes and fall back to the base. */
export function deleteBuild(app: App, buildId: string) {
  app.db.tx(() => {
    const b = ownBuild(app, buildId);
    app.db.run("UPDATE build_runs SET status = 'cancelled', finished_at = ? WHERE build_id = ? AND status IN ('queued', 'running')", app.now(), buildId);
    app.db.run("DELETE FROM builds WHERE id = ?", buildId);
    app.db.run("UPDATE settings SET default_build_id = NULL WHERE id = 1 AND default_build_id = ?", buildId);
    if (b.image) app.db.run("INSERT OR REPLACE INTO timers (owner, name, due_at, payload) VALUES ('', ?, ?, ?)", `build:forget:${b.image}`, app.now(), JSON.stringify({ image: b.image, attempt: 0 }));
    app.db.afterCommit(() => app.scheduler?.wake());
    touch(app, { t: "builds" });
    touch(app, { t: "build", buildId });
    touch(app, { t: "settings" });
    touch(app, { t: "dorks" });
  });
}

export function setDefaultBuild(app: App, buildId: string | null) {
  app.db.tx(() => {
    if (buildId !== null) {
      const b = ownBuild(app, buildId);
      if (!b.image) fail("not_configured", "Build this machine before making it the default.");
    }
    update(app.db, "settings", { id: 1 }, { defaultBuildId: buildId });
    touch(app, { t: "settings" });
    touch(app, { t: "builds" });
  });
}

export const defaultBuildId = (app: App): string | null => app.db.get<{ default_build_id: string | null }>("SELECT default_build_id FROM settings WHERE id = 1")?.default_build_id ?? null;

// ---------------------------------------------------------------- owner: variables
const aadVar = (buildId: string, name: string) => `build-var|${buildId}|${name}`;

export async function setBuildVar(app: App, buildId: string, name: string, input: Record<string, unknown>) {
  if (!VAR_NAME.test(name)) fail("invalid", "Variable names are UPPER_SNAKE_CASE, at most 64 characters.");
  if (input.value !== undefined && typeof input.value !== "string") fail("invalid", "value must be a string");
  if (typeof input.value === "string" && Buffer.byteLength(input.value) > MAX_SECRET_BYTES) fail("invalid", "Values are at most 16 KB.");
  const existing = varsOf(app, buildId).find((v) => v.name === name);
  const secret = typeof input.secret === "boolean" ? input.secret : (existing?.secret ?? false);
  const buildTime = typeof input.buildTime === "boolean" ? input.buildTime : (existing?.buildTime ?? false);
  const valueEnc = typeof input.value === "string" ? (await encrypt(app.ring, input.value, aadVar(buildId, name))).value : (existing?.valueEnc ?? null);
  app.db.tx(() => {
    ownBuild(app, buildId);
    if (!existing && varsOf(app, buildId).length >= MAX_VARS) fail("limit", `At most ${MAX_VARS} variables per build.`);
    app.db.run(
      "INSERT INTO build_vars (build_id, name, value_enc, secret, build_time) VALUES (?, ?, ?, ?, ?) ON CONFLICT (build_id, name) DO UPDATE SET value_enc = excluded.value_enc, secret = excluded.secret, build_time = excluded.build_time",
      buildId,
      name,
      valueEnc,
      secret ? 1 : 0,
      buildTime ? 1 : 0,
    );
    respec(app, buildId);
  });
}

export function deleteBuildVar(app: App, buildId: string, name: string) {
  app.db.tx(() => {
    ownBuild(app, buildId);
    app.db.run("DELETE FROM build_vars WHERE build_id = ? AND name = ?", buildId, name);
    respec(app, buildId);
  });
}

/** Decrypted values, outside any transaction. `buildTimeOnly`: what the setup script receives. Unfilled requests are skipped. */
export async function buildVarValues(app: App, buildId: string, buildTimeOnly = false): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const v of varsOf(app, buildId)) {
    if (!v.valueEnc || (buildTimeOnly && !v.buildTime)) continue;
    out[v.name] = await decrypt(app.ring, v.valueEnc, aadVar(buildId, v.name));
  }
  return out;
}

/** The secret values (plus any extra), for redacting logs and scanning images. */
export async function secretValues(app: App, buildId: string): Promise<string[]> {
  const out: string[] = [];
  for (const v of varsOf(app, buildId)) if (v.secret && v.valueEnc) out.push(await decrypt(app.ring, v.valueEnc, aadVar(buildId, v.name)));
  return out;
}

// ---------------------------------------------------------------- views
function varViews(app: App, buildId: string, plain: Record<string, string>): BuildVarView[] {
  return varsOf(app, buildId).map((v) => ({ name: v.name, secret: v.secret, buildTime: v.buildTime, requested: !v.valueEnc, ...(!v.secret && v.name in plain ? { value: plain[v.name] } : {}) }));
}

/** Plain variable values for display; secrets are never decrypted for a view. */
async function plainValues(app: App, buildId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const v of varsOf(app, buildId)) if (!v.secret && v.valueEnc) out[v.name] = await decrypt(app.ring, v.valueEnc, aadVar(buildId, v.name));
  return out;
}

/** Why an image no longer matches its build, in words, or null when it is current. */
export async function staleness(app: App, b: BuildRow): Promise<string | null> {
  if (!b.image) return null;
  if (b.imageHash !== b.specHash) return "The build changed since this image was made.";
  if (b.imageBase !== baseKey(app)) return "The base snapshot was updated since this image was made.";
  if (b.imageVars !== varsDigest(app, b.id, await buildVarValues(app, b.id, true))) return "A variable used while building changed.";
  return null;
}

const runsOf = (app: App, buildId: string, limit: number): RunRow[] => app.db.all<RunRow>("SELECT * FROM build_runs WHERE build_id = ? ORDER BY created_at DESC LIMIT ?", buildId, limit);

export async function buildView(app: App, b: BuildRow): Promise<BuildView> {
  const plain = await plainValues(app, b.id);
  const runs = runsOf(app, b.id, 1).map(runViewOf);
  const active = app.db.get<RunRow>("SELECT * FROM build_runs WHERE build_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1", b.id);
  const stale = await staleness(app, b);
  return {
    id: b.id,
    name: b.name,
    machineType: b.machineType,
    setupScript: b.setupScript,
    repos: b.repos,
    vars: varViews(app, b.id, plain),
    rev: b.rev,
    specHash: b.specHash,
    approved: b.approvedHash === b.specHash,
    image: b.image && b.imageAt ? { name: b.image, at: b.imageAt, stale: !!stale, staleReason: stale } : null,
    lastRun: runs[0] ?? null,
    activeRun: active ? runViewOf(active) : null,
    drafts: draftsOf(app, b.id).filter((d) => d.status === "submitted" || d.status === "editing"),
    dorkCount: app.db.get<{ n: number }>("SELECT count(*) AS n FROM dorks WHERE build_id = ? AND deleting = 0 AND archived = 0", b.id)?.n ?? 0,
    isDefault: defaultBuildId(app) === b.id,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

export async function listBuilds(app: App): Promise<BuildView[]> {
  const rows = app.db.all("SELECT * FROM builds ORDER BY lower(name)").map(buildOf);
  const out: BuildView[] = [];
  for (const b of rows) out.push(await buildView(app, b));
  return out;
}

export const listRuns = (app: App, buildId: string) => {
  ownBuild(app, buildId);
  return runsOf(app, buildId, 20).map(runViewOf);
};

// ---------------------------------------------------------------- drafts (an agent's proposed change to its dork's build)
interface DraftRow {
  id: string;
  build_id: string;
  dork_id: string;
  base_rev: number;
  spec: string;
  vars: string; // DraftVar[]
  note: string | null;
  status: DraftView["status"];
  updated_at: number;
}

function draftViewOf(app: App, d: DraftRow): DraftView {
  const spec = JSON.parse(d.spec) as BuildSpec;
  const build = getBuild(app, d.build_id);
  return {
    id: d.id,
    buildId: d.build_id,
    dorkId: d.dork_id,
    dorkTitle: getDork(app.db, d.dork_id)?.title ?? "",
    status: d.status,
    spec,
    specHash: hashSpec(spec),
    vars: JSON.parse(d.vars) as DraftVar[],
    note: d.note,
    stale: !!build && build.rev !== d.base_rev,
    updatedAt: d.updated_at,
  };
}

const draftsOf = (app: App, buildId: string): DraftView[] => app.db.all<DraftRow>("SELECT * FROM build_drafts WHERE build_id = ? ORDER BY updated_at DESC", buildId).map((d) => draftViewOf(app, d));

const draftOfDork = (app: App, buildId: string, dorkId: string) => app.db.get<DraftRow>("SELECT * FROM build_drafts WHERE build_id = ? AND dork_id = ?", buildId, dorkId);

/** The dork's own build: the only one its agent can ever reach. */
export function dorkBuild(app: App, dorkId: string): BuildRow | null {
  const r = app.db.get<{ build_id: string | null }>("SELECT build_id FROM dorks WHERE id = ?", dorkId);
  return r?.build_id ? (getBuild(app, r.build_id) ?? null) : null;
}

export function draftView(app: App, buildId: string, dorkId: string): DraftView | null {
  const d = draftOfDork(app, buildId, dorkId);
  return d ? draftViewOf(app, d) : null;
}

/** Applies a variable change list on top of the build's variables: what the draft's spec would see. */
function mergeVars(current: { name: string; buildTime: boolean }[], changes: DraftVar[]) {
  const byName = new Map(current.map((v) => [v.name, { name: v.name, buildTime: v.buildTime }]));
  for (const c of changes) {
    if (c.remove) byName.delete(c.name);
    else byName.set(c.name, { name: c.name, buildTime: c.buildTime });
  }
  return [...byName.values()];
}

const draftInput = z.object({
  machineType: machineTypeSchema.optional(),
  setupScript: z.string().max(MAX_SCRIPT_CHARS, "the setup script is longer than 64 KB").optional(),
  repos: z.array(buildRepo).max(MAX_BUILD_REPOS).optional(),
  vars: z.array(draftVar).max(MAX_VARS).optional(),
});

/** Writes (creates or edits) the dork's draft. Fields left out keep the draft's (or, for a new draft, the build's) value. */
export function writeDraft(app: App, dorkId: string, input: unknown): DraftView {
  const patch = parse(draftInput, input ?? {});
  if (patch.repos) uniqueRepos(patch.repos);
  for (const v of patch.vars ?? []) if (v.secret && v.value !== undefined) fail("invalid", `${v.name} is a secret: never put its value in a draft. Leave it out; the owner types it in.`);
  return app.db.tx(() => {
    const b = dorkBuild(app, dorkId);
    if (!b) return fail("not_configured", "This session runs on the base machine, not on a build. Ask the owner to create a build and start a setup session on it.");
    const existing = draftOfDork(app, b.id, dorkId);
    // A submitted draft is frozen until the owner decides: what they review is what they approve.
    if (existing?.status === "submitted") fail("conflict", "Your draft is waiting for the owner's decision; it cannot change until they approve or reject it.");
    const live = existing && existing.status === "editing" ? existing : undefined;
    const prev: BuildSpec = live ? JSON.parse(live.spec) : specOf(b, varsOf(app, b.id));
    const prevVars: DraftVar[] = live ? JSON.parse(live.vars) : [];
    const vars = patch.vars ? mergeChanges(prevVars, patch.vars) : prevVars;
    const merged = mergeVars(varsOf(app, b.id), vars);
    const spec = specOf({ machineType: patch.machineType ?? prev.machineType, setupScript: patch.setupScript ?? prev.setupScript, repos: patch.repos ?? prev.repos }, merged);
    const now = app.now();
    if (existing) {
      update(app.db, "build_drafts", { id: existing.id }, { spec, vars, status: "editing", updatedAt: now, ...(live ? {} : { baseRev: b.rev, note: null }) });
    } else {
      insert(app.db, "build_drafts", { id: app.uuid(), buildId: b.id, dorkId, baseRev: b.rev, spec, vars, status: "editing", updatedAt: now });
    }
    touch(app, { t: "build", buildId: b.id });
    return draftViewOf(app, draftOfDork(app, b.id, dorkId)!);
  });
}

/** Later changes to the same variable replace earlier ones. */
function mergeChanges(prev: DraftVar[], next: DraftVar[]): DraftVar[] {
  const m = new Map(prev.map((v) => [v.name, v]));
  for (const v of next) m.set(v.name, v);
  return [...m.values()];
}

/** The agent asks the owner to approve its draft: a card in the chat and on the build page. */
export function submitDraft(app: App, dorkId: string, note: unknown): DraftView {
  if (note !== undefined && (typeof note !== "string" || note.length > 2000)) fail("invalid", "note must be at most 2000 characters");
  return app.db.tx(() => {
    const b = dorkBuild(app, dorkId);
    if (!b) return fail("not_configured", "This session runs on the base machine, not on a build.");
    const d = draftOfDork(app, b.id, dorkId);
    if (!d || d.status !== "editing") return fail("invalid", "There is no draft to submit. Write one with machine_draft first.");
    const text = typeof note === "string" ? note.trim() : "";
    update(app.db, "build_drafts", { id: d.id }, { status: "submitted", note: text || null, updatedAt: app.now() });
    append(app, dorkId, { type: "build_draft", draftId: d.id, buildId: b.id, buildName: b.name, ...(text ? { note: text } : {}) });
    touch(app, { t: "build", buildId: b.id });
    touch(app, { t: "builds" });
    return draftViewOf(app, draftOfDork(app, b.id, dorkId)!);
  });
}

function ownDraft(app: App, buildId: string, draftId: string): DraftRow {
  const d = app.db.get<DraftRow>("SELECT * FROM build_drafts WHERE id = ? AND build_id = ?", draftId, buildId);
  if (!d) return fail("not_found", "This draft no longer exists.");
  if (d.status !== "submitted" && d.status !== "editing") fail("conflict", "This draft was already decided.");
  return d;
}

/** Tells the agent: a card in its transcript, and the same words as its next turn. */
function decide(app: App, d: DraftRow, buildName: string, approved: boolean, reason: string) {
  update(app.db, "build_drafts", { id: d.id }, { status: approved ? "approved" : "rejected", updatedAt: app.now() });
  const dork = getDork(app.db, d.dork_id);
  if (!dork || dork.deleting) return;
  append(app, d.dork_id, { type: "build_decision", draftId: d.id, buildId: d.build_id, buildName, approved, ...(reason ? { reason } : {}) });
  const text = approved
    ? `<dorks-event>The owner approved your machine draft for the build "${buildName}"; it is now the build${reason ? ` (${reason})` : ""}. An image build may be running: check it with machine_logs and fix it if it fails.</dorks-event>`
    : `<dorks-event>The owner rejected your machine draft for the build "${buildName}"${reason ? `: ${reason}` : "."} Do not resubmit it unchanged.</dorks-event>`;
  enqueue(app, d.dork_id, "user_message", text);
  dispatch(app, d.dork_id, { t: "user_message" });
}

/**
 * The owner approves a draft: its spec and variable changes become the build's (approved, since the owner chose it). New secret or
 * empty variables appear for the owner to fill in. Returns whether an image run can start now (no build-time value is missing).
 */
export async function approveDraft(app: App, buildId: string, draftId: string, reviewed: unknown): Promise<{ missing: string[] }> {
  const d0 = ownDraft(app, buildId, draftId);
  if (d0.status !== "submitted") fail("conflict", "The agent has not submitted this draft yet.");
  // The owner approves the version they saw (DraftView.updatedAt), never whatever the row holds by the time the request lands.
  if (reviewed !== d0.updated_at) fail("conflict", "This draft changed since you opened it. Review it again.");
  const changes = JSON.parse(d0.vars) as DraftVar[];
  const enc = new Map<string, string>();
  for (const v of changes) if (!v.remove && !v.secret && v.value !== undefined) enc.set(v.name, (await encrypt(app.ring, v.value, aadVar(buildId, v.name))).value);
  return app.db.tx(() => {
    const d = ownDraft(app, buildId, draftId);
    // What the owner approved is what they saw: a draft the agent touched since (even during this call) is not applied.
    if (d.status !== "submitted" || d.updated_at !== d0.updated_at || d.spec !== d0.spec || d.vars !== d0.vars)
      fail("conflict", "The agent changed this draft while you were approving it. Review it again.");
    const b = ownBuild(app, buildId);
    const spec = JSON.parse(d.spec) as BuildSpec;
    update(app.db, "builds", { id: buildId }, { machineType: spec.machineType, setupScript: spec.setupScript, repos: spec.repos });
    for (const v of JSON.parse(d.vars) as DraftVar[]) {
      if (v.remove) {
        app.db.run("DELETE FROM build_vars WHERE build_id = ? AND name = ?", buildId, v.name);
        continue;
      }
      const existing = varsOf(app, buildId).find((x) => x.name === v.name);
      const valueEnc = enc.get(v.name) ?? (existing && existing.secret === v.secret ? existing.valueEnc : null);
      app.db.run(
        "INSERT INTO build_vars (build_id, name, value_enc, secret, build_time) VALUES (?, ?, ?, ?, ?) ON CONFLICT (build_id, name) DO UPDATE SET value_enc = excluded.value_enc, secret = excluded.secret, build_time = excluded.build_time",
        buildId,
        v.name,
        valueEnc,
        v.secret ? 1 : 0,
        v.buildTime ? 1 : 0,
      );
    }
    respec(app, buildId);
    decide(app, d, b.name, true, "");
    for (const other of app.db.all<DraftRow>("SELECT * FROM build_drafts WHERE build_id = ? AND id != ? AND status = 'submitted'", buildId, draftId))
      touch(app, { t: "build", buildId: other.build_id });
    const missing = varsOf(app, buildId)
      .filter((v) => v.buildTime && !v.valueEnc)
      .map((v) => v.name);
    return { missing };
  });
}

export function rejectDraft(app: App, buildId: string, draftId: string, reason: unknown) {
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 1000)) fail("invalid", "reason must be at most 1000 characters");
  app.db.tx(() => {
    const d = ownDraft(app, buildId, draftId);
    const b = ownBuild(app, buildId);
    decide(app, d, b.name, false, typeof reason === "string" ? reason.trim() : "");
    touch(app, { t: "build", buildId });
    touch(app, { t: "builds" });
  });
}
