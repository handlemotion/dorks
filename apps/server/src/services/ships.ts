import { Effect } from "effect";
import type { ShipStage, ShipStageState, ShipStatus, ShipView } from "@dorks/shared";
import { touch, type App } from "../app";
import { insert, json, update, type Row } from "../db";
import { append, setTimer } from "../lifecycle/dispatch";
import {
  getCached,
  GhCheckRuns,
  GhCombinedStatus,
  GhCompare,
  GhDeployments,
  GhDeploymentStatuses,
  GhJobs,
  GhWorkflowRuns,
  type GhDeployment,
  type GithubError,
  type GhWorkflowRun,
} from "../lib/github";
import type { Subscription } from "./subscriptions";

// Post-merge shipping (docs/shipping.md). When a session's PR merges, a ship follows its merge commit: the workflow runs it started
// (a job or step named for migrations gets its own stage), other apps' check runs (Cloudflare Pages, Vercel), commit statuses and
// deployments, including a later commit's deployment that contains this one. The poller (services/poller.ts) reads every open ship
// each pass with conditional requests; each change appends a `ship` event with the whole snapshot, which the chat shows as one card.
// Nothing here wakes the agent: the box stays asleep while the server watches.

/** After everything finished, wait this long for follow-ups (a deploy workflow CI starts) before calling it shipped. */
export const SHIP_SETTLE_MS = 60_000;
/** Nothing at all on the merge commit after this long: nothing runs on a merge here. */
export const SHIP_QUIET_MS = 5 * 60_000;
/** The watch ends this long after the merge, whatever is still running (`stalled`). A failed ship is watched until then for re-runs. */
export const SHIP_MAX_MS = 60 * 60_000;
const MAX_RUNS = 15;
const MAX_COMPARES = 3; // per pass: later deployments whose ancestry is not known yet
const MIGRATION = /migrat/i;

interface ShipPoll {
  /** Request path -> ETag and the decoded body it answered, so a 304 still rebuilds the stages. Only paths read on the last pass. */
  etags?: Record<string, string>;
  bodies?: Record<string, unknown>;
  /** Workflow runs whose jobs were read after the run completed: their migration stages are final. */
  jobsRead?: number[];
  /** Commit -> whether it contains the merge commit (a later deployment). */
  contains?: Record<string, boolean>;
  /** When every stage was last seen finished (cleared while one runs). */
  doneAt?: number;
  /** GitHub's merge time: deployments created before it are not this merge's. */
  mergedAt?: number;
}

export interface Ship {
  id: number;
  dorkId: string;
  repo: string;
  number: number;
  url: string;
  title?: string;
  baseRef: string;
  sha: string;
  status: ShipStatus;
  stages: ShipStage[];
  startedAt: number;
  endedAt?: number;
  poll?: ShipPoll;
}

const shipOf = (r: Row): Ship => ({
  id: r.id as number,
  dorkId: r.dork_id as string,
  repo: r.repo as string,
  number: r.number as number,
  url: r.url as string,
  title: (r.title as string | null) ?? undefined,
  baseRef: r.base_ref as string,
  sha: r.sha as string,
  status: r.status as ShipStatus,
  stages: json<ShipStage[]>(r.stages) ?? [],
  startedAt: r.started_at as number,
  endedAt: (r.ended_at as number | null) ?? undefined,
  poll: json(r.poll),
});

export const shipView = (s: Ship): ShipView => ({
  id: s.id,
  repo: s.repo,
  number: s.number,
  url: s.url,
  ...(s.title ? { title: s.title } : {}),
  baseRef: s.baseRef,
  sha: s.sha,
  status: s.status,
  stages: s.stages,
  startedAt: s.startedAt,
  ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
});

export const getShip = (app: App, id: number): Ship | undefined => {
  const r = app.db.get("SELECT * FROM ships WHERE id = ?", id);
  return r ? shipOf(r) : undefined;
};

/** Ships still watched: not ended, and the session is not being deleted (an archived session's ship is still followed). */
export const openShips = (app: App): Ship[] => app.db.all("SELECT s.* FROM ships s JOIN dorks d ON d.id = s.dork_id WHERE s.ended_at IS NULL AND d.deleting = 0 ORDER BY s.id").map(shipOf);

const touchDork = (app: App, dorkId: string) => {
  touch(app, { t: "dork", dorkId });
  touch(app, { t: "dorks" });
};

/** In the merge's transaction: starts following `sha`. Once per PR per session; a merge seen again changes nothing. */
export function startShip(app: App, sub: Subscription, sha: string, mergedAt?: number) {
  if (app.db.get("SELECT 1 AS x FROM ships WHERE dork_id = ? AND repo = ? AND number = ?", sub.dorkId, sub.repo, sub.number)) return;
  insert(app.db, "ships", {
    dorkId: sub.dorkId,
    repo: sub.repo,
    number: sub.number,
    url: sub.url,
    title: sub.title ?? null,
    baseRef: sub.baseRef ?? "",
    sha,
    status: "watching",
    stages: [],
    poll: mergedAt ? { mergedAt } : null,
    startedAt: app.now(),
  });
  const id = app.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  append(app, sub.dorkId, { type: "ship", ship: shipView(getShip(app, id)!) });
  setTimer(app, "", "poll", 0);
}

// ---------------------------------------------------------------- GitHub's words -> stage states
const ms = (iso: string | null | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? Date.parse(iso) : undefined);
const short = (sha: string) => sha.slice(0, 7);

/** A workflow run, job, step or check run: `status` and `conclusion` as GitHub names them. */
function runState(status: string | null | undefined, conclusion: string | null | undefined): { state: ShipStageState; detail?: string } {
  if (status !== "completed") {
    if (status === "waiting") return { state: "pending", detail: "Waiting for approval" };
    return { state: status === "in_progress" ? "running" : "pending" };
  }
  switch (conclusion) {
    case "success":
    case "neutral":
      return { state: "passed" };
    case "failure":
    case "timed_out":
    case "startup_failure":
      return { state: "failed", ...(conclusion === "timed_out" ? { detail: "Timed out" } : {}) };
    case "action_required":
      return { state: "failed", detail: "Action required" };
    case "cancelled":
      return { state: "skipped", detail: "Cancelled" };
    default:
      return { state: "skipped", detail: "Skipped" };
  }
}

function statusState(state: string): ShipStageState {
  if (state === "success") return "passed";
  if (state === "failure" || state === "error") return "failed";
  return "running";
}

function deploymentState(state: string | undefined): ShipStageState {
  switch (state) {
    case "success":
    case "inactive": // a newer deployment replaced it: it was live
      return "passed";
    case "failure":
    case "error":
      return "failed";
    case "in_progress":
      return "running";
    default:
      return "pending"; // no status yet, queued, pending
  }
}

const times = (start: string | null | undefined, end: string | null | undefined, done: boolean) => ({
  ...(ms(start) !== undefined ? { startedAt: ms(start) } : {}),
  ...(done && ms(end) !== undefined ? { endedAt: ms(end) } : {}),
});

const runStage = (r: GhWorkflowRun): ShipStage => {
  const { state, detail } = runState(r.status, r.conclusion);
  return { id: `run:${r.id}`, kind: "workflow", name: r.name || "Workflow", state, url: r.html_url, ...(detail ? { detail } : {}), ...times(r.run_started_at, r.updated_at, r.status === "completed") };
};

/** Jobs named for migrations, else steps that are: what a merge does to the database, as its own stages. */
function migrationStages(runId: number, jobs: typeof GhJobs.Type): ShipStage[] {
  const out: ShipStage[] = [];
  for (const job of jobs.jobs) {
    const steps = MIGRATION.test(job.name) ? [] : (job.steps ?? []).filter((s) => MIGRATION.test(s.name));
    const parts = MIGRATION.test(job.name) ? [{ ...job, id: `mig:${runId}:${job.id}` }] : steps.map((s) => ({ ...s, id: `mig:${runId}:${job.id}:${s.number}` }));
    for (const p of parts) {
      const { state, detail } = runState(p.status, p.conclusion);
      out.push({
        id: p.id,
        kind: "migration",
        name: p.name,
        state,
        ...(job.html_url ? { url: job.html_url } : {}),
        ...(detail ? { detail } : {}),
        ...times(p.started_at, p.completed_at, p.status === "completed"),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- reading
export interface ShipObservation {
  stages: ShipStage[];
  poll: ShipPoll;
}

/** Whether a failure of one read should stop the whole pass (rate limit, bad token) rather than keep what that read showed before. */
const fatal = (e: GithubError) => e.retryAt !== undefined || e.status === 401;

type Body = <S extends Parameters<typeof getCached>[1]>(schema: S, path: string) => Effect.Effect<S["Type"] | undefined, GithubError>;

/** One `observeShip` call: the ship, what the last pass kept, and the reader for this one. */
interface Look {
  ship: Ship;
  old: ShipPoll;
  /** `/repos/:owner/:name` */
  base: string;
  body: Body;
  /** The stages the last pass showed whose id starts with `prefix`: what a failed read keeps. */
  kept: (prefix: string) => ShipStage[];
}

/** Conditional reads that remember their bodies: a 304, or a failed read, answers what the path said last time. */
function reader(app: App, token: string, old: ShipPoll) {
  const gh = { fetch: app.fetch, token, now: () => app.now() };
  const etags: Record<string, string> = {};
  const bodies: Record<string, unknown> = {};
  const body: Body = (schema, path) => {
    type T = (typeof schema)["Type"];
    const had = old.bodies?.[path] as T | undefined;
    const keep = () => {
      if (had !== undefined) {
        bodies[path] = had;
        if (old.etags?.[path]) etags[path] = old.etags[path];
      }
      return had;
    };
    return getCached(gh, schema, path, had !== undefined ? old.etags?.[path] : undefined).pipe(
      Effect.map((r) => {
        if (r.status === 304) return keep();
        bodies[path] = r.json;
        if (r.etag) etags[path] = r.etag;
        return r.json as T;
      }),
      Effect.catchIf(
        (e) => !fatal(e),
        () => Effect.sync(keep),
      ),
    );
  };
  return { body, etags, bodies };
}

/** Reads what the merge commit set off. Fails only on a rate limit or a bad token; any other failed read keeps its last answer. */
export const observeShip = (app: App, token: string, ship: Ship): Effect.Effect<ShipObservation, GithubError> =>
  Effect.gen(function* () {
    const old = ship.poll ?? {};
    const { body, etags, bodies } = reader(app, token, old);
    const look: Look = { ship, old, base: `/repos/${ship.repo}`, body, kept: (prefix) => ship.stages.filter((s) => s.id.startsWith(prefix)) };
    const runs = yield* readRuns(look);
    const checks = yield* readChecks(look);
    const deployments = yield* readDeployments(look);
    const poll: ShipPoll = {
      etags,
      bodies,
      jobsRead: runs.jobsRead,
      contains: deployments.contains,
      ...(old.mergedAt ? { mergedAt: old.mergedAt } : {}),
      ...(old.doneAt ? { doneAt: old.doneAt } : {}),
    };
    return { stages: [...runs.stages, ...checks, ...deployments.stages], poll };
  });

/** Workflow runs on the merge commit (a push to the base, and what that starts), each followed by its migration stages. */
const readRuns = ({ ship, old, base, body, kept }: Look) =>
  Effect.gen(function* () {
    const stages: ShipStage[] = [];
    const jobsRead: number[] = [];
    const runs = yield* body(GhWorkflowRuns, `${base}/actions/runs?head_sha=${ship.sha}&per_page=50`);
    if (!runs) return { stages: [...kept("run:"), ...kept("mig:")], jobsRead: old.jobsRead ?? [] };
    const list = runs.workflow_runs
      .filter((r) => !r.event.startsWith("pull_request")) // a rebase merge keeps the PR's commits: its PR runs are not the merge's
      .toSorted((a, b) => (ms(a.run_started_at) ?? 0) - (ms(b.run_started_at) ?? 0) || a.id - b.id)
      .slice(0, MAX_RUNS);
    for (const r of list) {
      stages.push(runStage(r));
      const done = r.status === "completed";
      // A finished run's jobs were read once after it finished: its migration stages are final.
      const jobs = done && old.jobsRead?.includes(r.id) ? undefined : yield* body(GhJobs, `${base}/actions/runs/${r.id}/jobs?per_page=100`);
      stages.push(...(jobs ? migrationStages(r.id, jobs) : kept(`mig:${r.id}:`)));
      if (done && (jobs || old.jobsRead?.includes(r.id))) jobsRead.push(r.id);
    }
    return { stages, jobsRead };
  });

/** Other apps' checks (Actions' own are the runs), then commit statuses. */
const readChecks = ({ ship, base, body, kept }: Look) =>
  Effect.gen(function* () {
    const checks = yield* body(GhCheckRuns, `${base}/commits/${ship.sha}/check-runs?per_page=100`);
    const status = yield* body(GhCombinedStatus, `${base}/commits/${ship.sha}/status`);
    return [...(checks ? checkStages(checks) : kept("check:")), ...(status ? status.statuses.map(statusStage) : kept("status:"))];
  });

/**
 * Deployments of this commit, or of a later one on the base that contains it (a deploy that batched several merges): per environment,
 * the newest that contains the merge. Ancestry is asked at most `MAX_COMPARES` times a pass and remembered.
 */
const readDeployments = ({ ship, old, base, body, kept }: Look) =>
  Effect.gen(function* () {
    const contains: Record<string, boolean> = { ...old.contains, [ship.sha]: true };
    const exact = yield* body(GhDeployments, `${base}/deployments?sha=${ship.sha}&per_page=20`);
    const recent = yield* body(GhDeployments, `${base}/deployments?per_page=20`);
    if (!exact && !recent) return { stages: kept("dep:"), contains: old.contains ?? {} };
    const since = (old.mergedAt ?? ship.startedAt) - 60_000;
    const later = (recent ?? []).filter((d) => d.sha !== ship.sha && (ms(d.created_at) ?? 0) >= since);
    for (const d of later.filter((x) => contains[x.sha] === undefined).slice(0, MAX_COMPARES)) {
      const c = yield* body(GhCompare, `${base}/compare/${ship.sha}...${d.sha}`);
      if (c) contains[d.sha] = c.status === "ahead" || c.status === "identical";
    }
    const byEnv = new Map<string, GhDeployment>();
    for (const d of [...(exact ?? []), ...later.filter((x) => contains[x.sha])].toSorted((a, b) => b.id - a.id)) if (!byEnv.has(d.environment)) byEnv.set(d.environment, d);
    const stages: ShipStage[] = [];
    for (const d of [...byEnv.values()].toSorted((a, b) => a.id - b.id)) {
      const statuses = yield* body(GhDeploymentStatuses, `${base}/deployments/${d.id}/statuses?per_page=1`);
      stages.push(deploymentStage(d, statuses?.[0], ship.sha));
    }
    // Keep the ancestry answers small: only commits still in view.
    const inView = new Set([...(recent ?? []).map((d) => d.sha), ship.sha]);
    return { stages, contains: Object.fromEntries(Object.entries(contains).filter(([sha]) => inView.has(sha))) };
  });

function checkStages(checks: typeof GhCheckRuns.Type): ShipStage[] {
  const byName = new Map<string, (typeof checks.check_runs)[number]>();
  for (const c of checks.check_runs) if (c.app?.slug !== "github-actions" && (byName.get(c.name)?.id ?? -1) < c.id) byName.set(c.name, c);
  return [...byName.values()].map((c) => {
    const { state, detail } = runState(c.status, c.conclusion);
    const url = c.details_url || c.html_url;
    return { id: `check:${c.name}`, kind: "check", name: c.name, state, ...(url ? { url } : {}), ...(detail ? { detail } : {}), ...times(c.started_at, c.completed_at, c.status === "completed") };
  });
}

function statusStage(s: (typeof GhCombinedStatus.Type)["statuses"][number]): ShipStage {
  const state = statusState(s.state);
  return {
    id: `status:${s.context}`,
    kind: "status",
    name: s.context,
    state,
    ...(s.target_url ? { url: s.target_url } : {}),
    ...(s.description ? { detail: s.description.slice(0, 120) } : {}),
    ...times(s.created_at, s.updated_at, state !== "running"),
  };
}

function deploymentStage(d: GhDeployment, latest: (typeof GhDeploymentStatuses.Type)[number] | undefined, sha: string): ShipStage {
  const state = deploymentState(latest?.state);
  const url = latest?.log_url || latest?.target_url;
  return {
    id: `dep:${d.environment}`,
    kind: "deployment",
    name: `Deploy to ${d.environment}`,
    state,
    ...(url ? { url } : {}),
    ...(latest?.environment_url ? { environmentUrl: latest.environment_url } : {}),
    ...(d.sha !== sha ? { detail: `with ${short(d.sha)}` } : {}),
    ...times(d.created_at, latest?.updated_at ?? latest?.created_at, state === "passed" || state === "failed"),
  };
}

// ---------------------------------------------------------------- deciding
/** Where a ship stands, from its stages and how long it has been watched. Pure. */
export function decide(startedAt: number, stages: ShipStage[], doneAt: number | undefined, now: number): { status: ShipStatus; doneAt?: number; end: boolean } {
  const active = stages.some((s) => s.state === "pending" || s.state === "running");
  const failed = stages.some((s) => s.state === "failed");
  const over = now - startedAt >= SHIP_MAX_MS;
  if (!stages.length) return now - startedAt >= SHIP_QUIET_MS ? { status: "quiet", end: true } : { status: "watching", end: false };
  const done = active ? undefined : (doneAt ?? now);
  if (over) return { status: active ? "stalled" : failed ? "failed" : "shipped", end: true };
  if (failed) return { status: "failed", doneAt: done, end: false }; // re-runs on the same commit can still turn it around
  if (done !== undefined && now - done >= SHIP_SETTLE_MS) return { status: "shipped", doneAt: done, end: true };
  return { status: "watching", doneAt: done, end: false };
}

/** Applies one observation in a transaction: a `ship` event when what the card shows changed, the dork's row when its status did. */
export function applyShip(app: App, id: number, obs: ShipObservation) {
  app.db.tx(() => {
    const ship = getShip(app, id);
    if (!ship || ship.endedAt !== undefined) return;
    const d = decide(ship.startedAt, obs.stages, ship.poll?.doneAt, app.now());
    const next: Ship = { ...ship, stages: obs.stages, status: d.status, endedAt: d.end ? app.now() : undefined };
    const { doneAt: _, ...poll } = obs.poll;
    update(app.db, "ships", { id }, { stages: obs.stages, status: d.status, poll: { ...poll, ...(d.doneAt !== undefined ? { doneAt: d.doneAt } : {}) }, endedAt: next.endedAt ?? null });
    if (JSON.stringify(shipView(ship)) !== JSON.stringify(shipView(next))) append(app, ship.dorkId, { type: "ship", ship: shipView(next) });
    if (ship.status !== d.status || d.end) touchDork(app, ship.dorkId);
  });
}
