import {
  CLOUD_EXPORT_FORMAT,
  CLOUD_EXPORT_VERSION,
  exportFile,
  exportManifest,
  importCommitted,
  importCreated,
  sealForImport,
  type ExportEvent,
  type ExportFile,
  type ExportManifest,
  type ExportSession,
  type ImportCreated,
  type ImportKey,
} from "@dorks/shared";
import { aad, decrypt } from "@dorks/core/crypto";
import { fail, OWNER, touch, type App } from "../app";
import { getDork, type DorkRow } from "../data";
import { dispatch } from "../lifecycle/dispatch";
import { freeze, unfreeze } from "../lifecycle/freeze";
import { allAutomations, updateAutomation } from "./automations";
import { defaultBuildId, getBuild, varsOf } from "./builds";
import { cloudAccount } from "./cloudAccount";
import { open as openMcp, type McpServerRow } from "./mcpServers";
import { readSettings } from "./settings";
import { serverOrg } from "./team";

// "Move to cloud" (docs/move-to-cloud.md): this Mac's team org leaves it for the cloud runtime. The local owner starts it; the cloud
// checks that their account is an owner or admin of the org. Steps: pause every session (a transcript must not grow while it is
// copied), open an import on the cloud (it hands back the key secrets are sealed to), upload the manifest and every session's
// events in parts, commit (the cloud takes the org over and this Mac leaves it), then turn this Mac's automations off so nothing
// runs twice. The local copy stays as it was, paused. A failed move changes nothing in the cloud org until a later one commits.

export type MovePhase = "idle" | "pausing" | "uploading" | "committing" | "done" | "failed";
export interface MoveStatus {
  phase: MovePhase;
  orgId: string | null;
  importId: string | null;
  sessions: { done: number; total: number };
  events: { done: number; total: number };
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

/** This Mac's id on the relay (services/phoneLink.ts), when it is paired. */
const phoneLinkMacId = (app: App) => app.db.get<{ cloud_mac_id: string | null }>("SELECT cloud_mac_id FROM settings WHERE id = 1")?.cloud_mac_id ?? null;

const IDLE: MoveStatus = { phase: "idle", orgId: null, importId: null, sessions: { done: 0, total: 0 }, events: { done: 0, total: 0 }, error: null, startedAt: null, finishedAt: null };
const statuses = new WeakMap<App, MoveStatus>();
const AWAKE = new Set(["working", "creating", "waking"]);
const RUNNING_PHASES: MovePhase[] = ["pausing", "uploading", "committing"];
const messageOf = (e: unknown) => ((e as { error?: { message?: string } })?.error?.message ?? (e instanceof Error ? e.message : "The move failed")).slice(0, 300);
const PAUSE_WAIT_MS = 180_000;
const MAX_EVENTS_PER_PART = 5000;

/** Tests: forget this process's view, as a restart does (the record in `meta` stays). */
export const resetMoveStatus = (app: App) => void statuses.delete(app);

export const moveStatus = (app: App): MoveStatus => statuses.get(app) ?? lastMove(app) ?? IDLE;

/** The last committed move, kept in `meta` so the app still knows after a restart. */
function lastMove(app: App): MoveStatus | null {
  const r = app.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'cloud_move'");
  return r ? (JSON.parse(r.value) as MoveStatus) : null;
}

/** Progress is polled (`GET /api/cloud/move`); only the end touches settings, so clients do not refetch everything per part. */
function set(app: App, patch: Partial<MoveStatus>) {
  const next = { ...moveStatus(app), ...patch };
  statuses.set(app, next);
  if (!patch.phase) return;
  // Every phase is kept in `meta`: a restart mid-commit must find the import to ask the cloud about (recoverMove).
  app.db.tx(() => {
    app.db.run("INSERT INTO meta (key, value) VALUES ('cloud_move', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
    if (patch.phase === "failed" || patch.phase === "done") touch(app, { t: "settings" });
  });
  if (patch.phase === "failed" || patch.phase === "done") unfreeze(app);
}

const MOVING = "This organization is moving to Dorks Cloud. Try again once it has moved.";

/**
 * After a restart: a move that was uploading is over (failed: start it again); one that was committing may have committed, so the
 * cloud is asked (`GET …/imports/:id`) before anything else. Until it answers, this Mac stays frozen.
 */
export async function recoverMove(app: App) {
  const last = lastMove(app);
  if (!last || !RUNNING_PHASES.includes(last.phase)) return;
  statuses.set(app, last);
  if (last.phase !== "committing" || !last.orgId || !last.importId) return set(app, { phase: "failed", error: "The move was interrupted. Start it again.", finishedAt: app.now() });
  freeze(app, MOVING);
  try {
    await settleCommit(app, last.orgId, last.importId);
  } catch (e) {
    set(app, { phase: "failed", error: messageOf(e), finishedAt: app.now() });
  }
}

// ---------------------------------------------------------------- the export

const sessionIds = (app: App) => app.db.all<{ id: string }>("SELECT id FROM dorks WHERE deleting = 0 ORDER BY created_at").map((r) => r.id);

function sessionOf(app: App, d: DorkRow): ExportSession {
  const ev = app.db.get<{ n: number; last: number | null }>("SELECT count(*) AS n, max(seq) AS last FROM events WHERE dork_id = ?", d.id)!;
  return {
    id: d.id,
    title: d.title,
    titleSource: d.titleSource,
    repo: d.repo,
    branch: d.branch,
    provider: d.provider,
    mode: d.mode,
    state: d.state,
    archived: d.archived,
    // A local session's "box" is a worktree on this Mac, and its agent's session lives there: the cloud starts it afresh.
    boxId: d.location === "local" ? null : (d.boxId ?? null),
    claudeSessionId: d.location === "local" ? null : (d.claudeSessionId ?? null),
    codexThreadId: d.location === "local" ? null : (d.codexThreadId ?? null),
    model: d.model ?? null,
    effort: d.effort ?? null,
    fast: d.fast,
    codeMode: d.codeMode,
    buildId: d.buildId ?? null,
    location: d.location,
    parentId: d.parentId ?? null,
    icon: d.icon ?? null,
    prUrl: d.prUrl ?? null,
    preview: d.preview ?? null,
    createdBy: d.createdBy ?? null,
    createdAt: d.createdAt,
    lastActivityAt: d.lastActivityAt,
    repliedAt: d.repliedAt ?? null,
    events: { count: ev.n, lastSeq: ev.last ?? 0 },
  };
}

/** A session's events from `fromSeq`, at most `maxBytes` of JSON (always at least one event). */
export function eventsFrom(app: App, dorkId: string, fromSeq: number, maxBytes = Infinity): ExportEvent[] {
  const out: ExportEvent[] = [];
  let bytes = 0;
  for (const r of app.db.all<{ seq: number; ts: number; body: string }>("SELECT seq, ts, body FROM events WHERE dork_id = ? AND seq >= ? ORDER BY seq LIMIT ?", dorkId, fromSeq, MAX_EVENTS_PER_PART)) {
    bytes += Buffer.byteLength(r.body) + 48; // UTF-8, as JSON.stringify sends it, plus the {seq, ts, body} envelope
    if (out.length && bytes > maxBytes) break;
    out.push({ seq: r.seq, ts: r.ts, body: JSON.parse(r.body) as ExportEvent["body"] });
  }
  return out;
}

const REENTER_OF = [
  ["claudeTokenEnc", "claudeToken"],
  ["boatKeyEnc", "boatKey"],
  ["sentryTokenEnc", "sentryToken"],
  ["antigravityTokenEnc", "antigravityToken"],
] as const;

/** Everything but the transcripts, with every secret sealed to the import's key (decrypted here, in memory, only to be sealed). */
export async function buildManifest(app: App, ctx: { orgId: string; importId: string; key: ImportKey }): Promise<ExportManifest> {
  const sealer = await sealForImport(ctx.key, ctx);
  const s = readSettings(app);
  const variables = [];
  for (const r of app.db.all<{ name: string; value_enc: string }>("SELECT name, value_enc FROM secrets ORDER BY name"))
    variables.push({ name: r.name, value: await sealer.seal(`variable|${r.name}`, await decrypt(app.ring, r.value_enc, aad.secret(OWNER, r.name))) });
  const mcpServers = [];
  for (const r of app.db.all<McpServerRow>("SELECT * FROM mcp_servers ORDER BY name")) {
    const sealed = await openMcp(app, r);
    const names = JSON.parse(r.secret_names) as { headers: string[]; env: string[] };
    mcpServers.push({
      name: r.name,
      transport: r.transport,
      url: r.url,
      command: r.command,
      args: JSON.parse(r.args) as string[],
      headerNames: names.headers,
      envNames: names.env,
      oauth: !!(r.oauth || sealed.oauth),
      secrets: await sealer.seal(`mcp|${r.name}`, JSON.stringify({ headers: sealed.headers, env: sealed.env, ...(sealed.url ? { url: sealed.url } : {}) })),
      createdAt: r.created_at,
    });
  }
  const skills = app.db.all<Record<string, unknown>>("SELECT * FROM skills ORDER BY name").map((r) => ({
    name: r.name as string,
    description: r.description as string,
    repo: r.repo as string,
    ref: (r.ref as string | null) ?? null,
    path: r.path as string,
    sha: r.sha as string,
    digest: r.digest as string,
    fileCount: r.file_count as number,
    bytes: r.bytes as number,
    files: Buffer.from(r.files as Uint8Array).toString("base64"),
    installedAt: r.installed_at as number,
    updatedAt: r.updated_at as number,
  }));
  const automations = allAutomations(app).map((a) => ({
    id: a.id,
    name: a.name,
    mode: "code" as const,
    enabled: a.enabled,
    triggers: a.triggers,
    instructions: a.instructions,
    model: a.model,
    effort: a.effort,
    buildId: a.buildId,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }));
  const manifest: ExportManifest = {
    format: CLOUD_EXPORT_FORMAT,
    version: CLOUD_EXPORT_VERSION,
    exportedAt: app.now(),
    orgId: ctx.orgId,
    importId: ctx.importId,
    source: { kind: "mac", macId: phoneLinkMacId(app), app: "dorks" },
    sealing: sealer.sealing,
    settings: {
      sleepMinutes: s.sleepMinutes,
      commentPolicy: s.commentPolicy ?? null,
      claudeCodeMode: s.claudeCodeMode,
      boatOrg: s.boatOrg ?? null,
      boatEnvironment: s.boatEnvironment ?? null,
      sentryOrg: s.sentryOrg ?? null,
      sentryUrl: s.sentryUrl ?? null,
      reenter: [...REENTER_OF.filter(([col]) => s[col]).map(([, name]) => name), ...(s.githubConnected ? (["github"] as const) : [])],
    },
    variables,
    mcpServers,
    skills,
    automations,
    sessions: sessionIds(app).map((id) => sessionOf(app, getDork(app.db, id)!)),
    images: imagesOf(app),
    builds: await buildsOf(app, sealer),
    defaultBuildId: defaultBuildId(app),
  };
  return exportManifest.parse(manifest); // what the cloud will check, checked here first
}

/** Builds with their variables (values sealed as `build-var|<build>|<name>`); their images stay in this Mac's Boat account. */
async function buildsOf(app: App, sealer: Awaited<ReturnType<typeof sealForImport>>) {
  const out = [];
  for (const { id } of app.db.all<{ id: string }>("SELECT id FROM builds ORDER BY created_at")) {
    const b = getBuild(app, id)!;
    const vars = [];
    for (const v of varsOf(app, id))
      vars.push({
        name: v.name,
        secret: v.secret,
        buildTime: v.buildTime,
        value: v.valueEnc === null ? null : await sealer.seal(`build-var|${id}|${v.name}`, await decrypt(app.ring, v.valueEnc, `build-var|${id}|${v.name}`)),
      });
    out.push({
      id,
      name: b.name,
      machineType: b.machineType,
      setupScript: b.setupScript,
      repos: b.repos,
      services: b.services,
      approved: b.approvedHash !== null && b.approvedHash === b.specHash,
      hadImage: !!b.image,
      vars,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    });
  }
  return out;
}

/** The chats' images (dorks-image:<id> in the transcripts). Attachments never claimed by a message (no dork) stay behind. */
const imagesOf = (app: App) =>
  app.db
    .all<{ id: string; dork_id: string; mime: string; n: number; created_at: number }>(
      "SELECT i.id, i.dork_id, i.mime, length(i.bytes) AS n, i.created_at FROM images i JOIN dorks d ON d.id = i.dork_id WHERE d.deleting = 0 ORDER BY i.created_at",
    )
    .map((r) => ({ id: r.id, dorkId: r.dork_id, mime: r.mime, bytes: r.n, createdAt: r.created_at }));

const imageData = (app: App, id: string) => {
  const r = app.db.get<{ mime: string; bytes: Uint8Array }>("SELECT mime, bytes FROM images WHERE id = ?", id)!;
  return { mime: r.mime, data: Buffer.from(r.bytes).toString("base64") };
};

/** The whole export as one file (manifest + every session's events), checked against the shared schema. */
export async function buildExportFile(app: App, ctx: { orgId?: string; importId: string; key: ImportKey }): Promise<ExportFile> {
  const orgId = ctx.orgId ?? serverOrg(app) ?? fail("invalid", "This server does not belong to an organization");
  const manifest = await buildManifest(app, { ...ctx, orgId });
  const events: Record<string, ExportEvent[]> = {};
  for (const s of manifest.sessions) {
    const all: ExportEvent[] = [];
    for (let from = 1; all.length < s.events.count;) {
      const part = eventsFrom(app, s.id, from);
      if (!part.length) break;
      all.push(...part);
      from = part.at(-1)!.seq + 1;
    }
    events[s.id] = all;
  }
  return exportFile.parse({ ...manifest, events, imageData: Object.fromEntries(manifest.images.map((i) => [i.id, imageData(app, i.id).data])) });
}

// ---------------------------------------------------------------- the move

/**
 * Starts the move in the background; `moveStatus` follows it. `orgId` is the org this Mac serves (a team org, or the personal workspace
 * on a paid plan: the cloud takes it over), or, from the personal workspace, a paid team the owner manages: everything is copied into
 * it and this Mac stays the personal workspace's, with the moved sessions archived here.
 */
export async function startMove(app: App, orgId: string): Promise<MoveStatus> {
  const org = serverOrg(app);
  if (org && org !== orgId) {
    const { orgs } = await cloudAccount.places(app);
    if (!orgs.find((o) => o.id === org)?.personal) fail("invalid", "This computer serves another organization");
    if (!orgs.some((o) => o.id === orgId)) fail("not_found", "You are not in that organization");
  }
  // Checked after the lookup above, and with nothing awaited from here to `set`: two requests at once (two windows) cannot both start.
  const cur = moveStatus(app);
  if (RUNNING_PHASES.includes(cur.phase)) fail("conflict", "A move to the cloud is already running");
  if (cur.phase === "done" && cur.orgId === orgId) fail("conflict", "This organization already moved to the cloud");
  const awake = app.db.all<{ title: string; state: string }>("SELECT title, state FROM dorks WHERE deleting = 0").filter((d) => AWAKE.has(d.state));
  if (awake.length) fail("conflict", `${awake.length === 1 ? "A session is" : `${awake.length} sessions are`} still working. Let them finish or stop them, then move.`);
  freeze(app, MOVING); // before the pause and the snapshot, held until the move ends
  set(app, { ...IDLE, phase: "pausing", orgId, startedAt: app.now() });
  void runMove(app, orgId).catch((e) => set(app, { phase: "failed", error: messageOf(e), finishedAt: app.now() }));
  return moveStatus(app);
}

async function runMove(app: App, orgId: string) {
  await pauseAll(app);
  const ids = sessionIds(app);
  const sessions = ids.map((id) => sessionOf(app, getDork(app.db, id)!));
  const total = sessions.reduce((n, s) => n + s.events.count, 0);
  const created = importCreated.parse(
    await cloudCall(app, "POST", `/v1/orgs/${encodeURIComponent(orgId)}/imports`, {
      format: CLOUD_EXPORT_FORMAT,
      version: CLOUD_EXPORT_VERSION,
      source: { kind: "mac", macId: phoneLinkMacId(app) },
      counts: { sessions: sessions.length, events: total },
    }),
  );
  const base = `/v1/orgs/${encodeURIComponent(orgId)}/imports/${encodeURIComponent(created.importId)}`;
  set(app, { phase: "uploading", importId: created.importId, sessions: { done: 0, total: sessions.length }, events: { done: 0, total } });
  const manifest = await buildManifest(app, { orgId, importId: created.importId, key: created.key });
  await cloudCall(app, "PUT", `${base}/manifest`, manifest);
  let sent = 0;
  for (const [i, s] of manifest.sessions.entries()) {
    sent += await uploadEvents(app, `${base}/sessions/${encodeURIComponent(s.id)}/events`, s, created, (n) => set(app, { events: { done: sent + n, total } }));
    set(app, { sessions: { done: i + 1, total: sessions.length }, events: { done: sent, total } });
  }
  for (const img of manifest.images) await cloudCall(app, "PUT", `${base}/images/${encodeURIComponent(img.id)}`, imageData(app, img.id));
  set(app, { phase: "committing" });
  await settleCommit(app, orgId, created.importId);
}

/**
 * Commits, or finds out whether an earlier attempt did: a commit whose answer was lost (or a restart mid-commit) is reconciled with
 * `GET …/imports/:id` before anything is retried, since a second import would be refused once the org runs in the cloud.
 */
async function settleCommit(app: App, orgId: string, importId: string) {
  const finish = () => finishMove(app, orgId);
  const base = `/v1/orgs/${encodeURIComponent(orgId)}/imports/${encodeURIComponent(importId)}`;
  for (let attempt = 1; ; attempt++) {
    try {
      importCommitted.parse(await cloudCall(app, "POST", `${base}/commit`, {}));
      return finish();
    } catch (e) {
      const status = (await cloudCall(app, "GET", base).catch(() => null)) as { status?: string } | null;
      if (status?.status === "committed") return finish();
      if (status?.status !== "open" || attempt >= 3) throw e; // the import is gone or the cloud keeps failing: the org stays here
    }
  }
}

/**
 * The cloud runs it now: this Mac's automations go off (so nothing runs twice) and the move is recorded as done. Copied into another
 * org, the sessions stay here archived (only the flag: their sandboxes are the cloud's to resume now), so the personal workspace does
 * not list them twice.
 */
function finishMove(app: App, orgId: string) {
  for (const a of allAutomations(app)) if (a.enabled) updateAutomation(app, a.id, { enabled: false });
  const own = serverOrg(app);
  const copied = !!own && own !== orgId;
  app.db.tx(() => {
    const ids = sessionIds(app);
    // The cloud owns the moved sandboxes and agent sessions now (a Teams org resumes the same box): this Mac lets go of them, so deleting
    // or waking the local copy can never destroy or touch the cloud's box. A local session's worktree stays this Mac's.
    app.db.run("UPDATE dorks SET box_id = NULL, claude_session_id = NULL, codex_thread_id = NULL WHERE deleting = 0 AND location = 'cloud'");
    if (copied) app.db.run("UPDATE dorks SET archived = 1 WHERE deleting = 0 AND archived = 0");
    touch(app, { t: "dorks" });
    for (const id of ids) touch(app, { t: "dork", dorkId: id });
  });
  set(app, { phase: "done", finishedAt: app.now() });
}

/** Every awake-able session goes to sleep (its box pauses), so no transcript grows while it is copied. */
async function pauseAll(app: App) {
  app.db.tx(() => {
    for (const id of sessionIds(app)) if (getDork(app.db, id)?.state === "idle") dispatch(app, id, { t: "sleep_due" });
  });
  const until = app.now() + PAUSE_WAIT_MS;
  for (;;) {
    const awake = app.db.all<{ state: string }>("SELECT state FROM dorks WHERE deleting = 0").filter((d) => d.state !== "sleeping" && d.state !== "error");
    if (!awake.length) return;
    if (app.now() > until) fail("failed", "Some sessions did not pause. Try again in a minute.");
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** One session's events in parts of at most maxPartBytes, resuming where the cloud says it stands (409 {expectedSeq}). */
async function uploadEvents(app: App, path: string, s: ExportSession, created: ImportCreated, progress: (n: number) => void): Promise<number> {
  let from = 1;
  let sent = 0;
  while (from <= s.events.lastSeq) {
    const events = eventsFrom(app, s.id, from, created.maxPartBytes - 64); // the {"events":[…]} wrapper
    if (!events.length) break;
    const r = (await cloudCall(app, "PUT", path, { events }, [409])) as { expectedSeq?: number; message?: string } | null;
    if (typeof r?.expectedSeq !== "number" && r?.message) fail("conflict", r.message.slice(0, 200)); // a 409 that is not about where to resume
    if (typeof r?.expectedSeq === "number" && r.expectedSeq !== events.at(-1)!.seq + 1) {
      from = r.expectedSeq; // the cloud already had some (a retried move), or is missing some: continue where it stands
      continue;
    }
    sent += events.length;
    progress(sent);
    from = events.at(-1)!.seq + 1;
  }
  return s.events.count;
}

/** One call to the import API as the signed-in account; `pass` lists statuses whose JSON body is returned instead of failing. */
async function cloudCall(app: App, method: string, path: string, body?: unknown, pass: number[] = []): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await cloudAccount.request(app, path, method === "GET" ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
    if (res.ok || pass.includes(res.status)) return out;
    if (res.status >= 500 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    const message = typeof out?.message === "string" ? out.message : `Dorks Cloud refused the move (${res.status})`;
    fail(res.status === 403 ? "forbidden" : res.status === 404 ? "not_found" : res.status === 409 ? "conflict" : res.status >= 500 ? "failed" : "invalid", message.slice(0, 200));
  }
}
