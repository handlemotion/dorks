import { Effect } from "effect";
import { SHIP_VERIFY_MS, type NotifyKind, type ShipStage, type ShipStageState, type ShipStatus, type ShipView } from "@dorks/shared";
import { fail, touch, type App } from "../app";
import { getDork } from "../data";
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
import { enqueueNotification } from "./notify";
import type { Subscription } from "./subscriptions";

// Post-merge shipping (docs/shipping.md). When a session's PR merges, a ship follows its merge commit: the workflow runs it started
// (a job or step named for migrations gets its own stage), other apps' check runs (Cloudflare Pages, Vercel), commit statuses and
// deployments, including a later commit's deployment that contains this one. The poller (services/poller.ts) reads every open ship
// each pass with conditional requests; each change appends a `ship` event with the whole snapshot, which the chat shows as one card.
// The box stays asleep while the server watches; the agent is woken twice at most (`involveAgent`): when the ship reaches a live
// deployment, to verify the change there and report with `ship_verify`, and when it fails, to open a fix-forward or revert PR.

/** After everything finished, wait this long for follow-ups (a deploy workflow CI starts) before calling it shipped. */
export const SHIP_SETTLE_MS = 60_000;
/** Nothing at all on the merge commit after this long: nothing runs on a merge here. */
export const SHIP_QUIET_MS = 5 * 60_000;
/** The watch ends this long after the merge, whatever is still running (`stalled`). A failed ship is watched until then for re-runs. */
export const SHIP_MAX_MS = 60 * 60_000;
const MAX_RUNS = 15;
const MAX_COMPARES = 3; // per pass: later commits (a deployment's, a replacing run's) whose ancestry is not known yet
const MAX_CONTAINS = 50; // ancestry answers remembered per ship
/** Young ships are read every poll pass; after this long, at most every `SHIP_SLOW_MS`, so long deploys cost fewer requests. */
export const SHIP_FAST_MS = 10 * 60_000;
export const SHIP_SLOW_MS = 30_000;
const MIGRATION = /migrat/i;

interface ShipPoll {
  /** Request path -> ETag and the decoded body it answered, so a 304 still rebuilds the stages. Only paths read on the last pass. */
  etags?: Record<string, string>;
  bodies?: Record<string, unknown>;
  /** Workflow runs whose jobs were read after the run completed: their migration stages are final. */
  jobsRead?: number[];
  /** Commit -> whether it contains the merge commit (a later deployment). */
  contains?: Record<string, boolean>;
  /** Environment -> the deployment followed there, kept until a newer one that contains the merge replaces it (it may leave the recent page). */
  deployments?: Record<string, GhDeployment>;
  /** When every stage was last seen finished (cleared while one runs). */
  doneAt?: number;
  /** GitHub's merge time: deployments created before it are not this merge's. */
  mergedAt?: number;
  /** When the ship was last read (`shipDue`). */
  readAt?: number;
}

export interface Ship {
  id: number;
  dorkId: string;
  /** The PR's (ended) subscription: its notifications go through it (null once purged). */
  subscriptionId?: number;
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
  agent?: ShipAgent;
}

/** The agent's part in a ship (docs/shipping.md, "The agent"). */
export interface ShipAgent {
  /** When the agent was told the ship reached a live deployment (once per ship). */
  deployedAt?: number;
  /** When the agent was told the ship failed (once per ship). */
  failedAt?: number;
  /** Its check of the live deployment: pending from the `deployed` notification until it reports or `SHIP_VERIFY_MS` passes. */
  verify?: { state: "pending" | "passed" | "failed" | "skipped"; env: string; url: string; note?: string; at?: number };
}

const shipOf = (r: Row): Ship => ({
  id: r.id as number,
  dorkId: r.dork_id as string,
  subscriptionId: (r.subscription_id as number | null) ?? undefined,
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
  agent: json(r.agent),
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

/** Whether a pass should read this ship now: every pass while young, then every `SHIP_SLOW_MS`. */
export const shipDue = (ship: Ship, now: number) => now - ship.startedAt < SHIP_FAST_MS || now - (ship.poll?.readAt ?? 0) >= SHIP_SLOW_MS;

const touchDork = (app: App, dorkId: string) => {
  touch(app, { t: "dork", dorkId });
  touch(app, { t: "dorks" });
};

/** In the merge's transaction: starts following `sha`. Once per PR per session; a merge seen again changes nothing. */
export function startShip(app: App, sub: Subscription, sha: string, mergedAt?: number) {
  if (app.db.get("SELECT 1 AS x FROM ships WHERE dork_id = ? AND repo = ? AND number = ?", sub.dorkId, sub.repo, sub.number)) return;
  insert(app.db, "ships", {
    dorkId: sub.dorkId,
    subscriptionId: sub.id,
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

/** `id`: the run on the merge commit, kept when a later run that replaced it is shown instead (`via` says which commit it ran). */
const runStage = (r: GhWorkflowRun, id = r.id, via?: string): ShipStage => {
  const { state, detail: d } = runState(r.status, r.conclusion);
  const detail = via ? `with ${short(via)}` : d;
  return { id: `run:${id}`, kind: "workflow", name: r.name || "Workflow", state, url: r.html_url, ...(detail ? { detail } : {}), ...times(r.run_started_at, r.updated_at, r.status === "completed") };
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
  /** Whether `sha` contains the merge commit: remembered, else asked (at most `MAX_COMPARES` times a pass); undefined when unknown. */
  contains: (sha: string) => Effect.Effect<boolean | undefined, GithubError>;
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

/** Ancestry answers for one pass, starting from what earlier passes learned. */
function ancestry(ship: Ship, old: ShipPoll, body: Body) {
  const known: Record<string, boolean> = { ...old.contains, [ship.sha]: true };
  let asked = 0;
  const contains = (sha: string): Effect.Effect<boolean | undefined, GithubError> =>
    Effect.gen(function* () {
      if (known[sha] !== undefined || asked >= MAX_COMPARES) return known[sha];
      asked++;
      const c = yield* body(GhCompare, `/repos/${ship.repo}/compare/${ship.sha}...${sha}`);
      if (c) known[sha] = c.status === "ahead" || c.status === "identical";
      return known[sha];
    });
  const remembered = () => Object.fromEntries(Object.entries(known).slice(-MAX_CONTAINS));
  return { contains, remembered };
}

/** Reads what the merge commit set off. Fails only on a rate limit or a bad token; any other failed read keeps its last answer. */
export const observeShip = (app: App, token: string, ship: Ship): Effect.Effect<ShipObservation, GithubError> =>
  Effect.gen(function* () {
    const old = ship.poll ?? {};
    const { body, etags, bodies } = reader(app, token, old);
    const { contains, remembered } = ancestry(ship, old, body);
    const look: Look = { ship, old, base: `/repos/${ship.repo}`, body, contains, kept: (prefix) => ship.stages.filter((s) => s.id.startsWith(prefix)) };
    const runs = yield* readRuns(look);
    const checks = yield* readChecks(look);
    const deployments = yield* readDeployments(look);
    const poll: ShipPoll = {
      etags,
      bodies,
      jobsRead: runs.jobsRead,
      contains: remembered(),
      deployments: deployments.followed,
      ...(old.mergedAt ? { mergedAt: old.mergedAt } : {}),
      ...(old.doneAt ? { doneAt: old.doneAt } : {}),
    };
    return { stages: [...runs.stages, ...checks, ...deployments.stages], poll };
  });

/**
 * A cancelled run on the merge commit was usually replaced by a newer push (`concurrency: cancel-in-progress` on a deploy): the first
 * later run of the same workflow on the base whose commit contains the merge is the one that shipped it.
 */
const successor = ({ ship, base, body, contains }: Look, run: GhWorkflowRun) =>
  Effect.gen(function* () {
    if (run.workflow_id === undefined) return undefined;
    const later = yield* body(GhWorkflowRuns, `${base}/actions/workflows/${run.workflow_id}/runs?branch=${encodeURIComponent(ship.baseRef)}&per_page=10`);
    const candidates = (later?.workflow_runs ?? []).filter((x) => x.id > run.id && x.head_sha && x.head_sha !== ship.sha && x.conclusion !== "cancelled").toSorted((a, b) => a.id - b.id);
    for (const x of candidates) if (yield* contains(x.head_sha!)) return x;
    return undefined;
  });

/** Workflow runs on the merge commit (a push to the base, and what that starts), each followed by its migration stages. */
const readRuns = (look: Look) =>
  Effect.gen(function* () {
    const { ship, old, base, body, kept } = look;
    const stages: ShipStage[] = [];
    const jobsRead: number[] = [];
    const runs = yield* body(GhWorkflowRuns, `${base}/actions/runs?head_sha=${ship.sha}&per_page=50`);
    if (!runs) return { stages: [...kept("run:"), ...kept("mig:")], jobsRead: old.jobsRead ?? [] };
    const list = runs.workflow_runs
      .filter((r) => !r.event.startsWith("pull_request")) // a rebase merge keeps the PR's commits: its PR runs are not the merge's
      .toSorted((a, b) => (ms(a.run_started_at) ?? 0) - (ms(b.run_started_at) ?? 0) || a.id - b.id)
      .slice(0, MAX_RUNS);
    for (const own of list) {
      const r = own.status === "completed" && own.conclusion === "cancelled" ? ((yield* successor(look, own)) ?? own) : own;
      stages.push(runStage(r, own.id, r === own ? undefined : r.head_sha));
      const done = r.status === "completed";
      // A finished run's jobs were read once after it finished: its migration stages are final.
      const jobs = done && old.jobsRead?.includes(r.id) ? undefined : yield* body(GhJobs, `${base}/actions/runs/${r.id}/jobs?per_page=100`);
      stages.push(...(jobs ? migrationStages(r.id, jobs) : kept(`mig:${r.id}:`)));
      // Final only once every job is seen completed: a failed read answers the last body, which may predate the run's end.
      if (done && (old.jobsRead?.includes(r.id) || jobs?.jobs.every((j) => j.status === "completed"))) jobsRead.push(r.id);
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
 * the newest that contains the merge. The one followed is remembered, so it is still followed after it leaves the recent page.
 */
const readDeployments = ({ ship, old, base, body, kept, contains }: Look) =>
  Effect.gen(function* () {
    const exact = yield* body(GhDeployments, `${base}/deployments?sha=${ship.sha}&per_page=20`);
    const recent = yield* body(GhDeployments, `${base}/deployments?per_page=20`);
    if (!exact && !recent) return { stages: kept("dep:"), followed: old.deployments ?? {} };
    const since = (old.mergedAt ?? ship.startedAt) - 60_000;
    const later: GhDeployment[] = [];
    for (const d of recent ?? []) if (d.sha !== ship.sha && (ms(d.created_at) ?? 0) >= since && (yield* contains(d.sha))) later.push(d);
    const byEnv = new Map<string, GhDeployment>();
    const candidates = [...Object.values(old.deployments ?? {}), ...(exact ?? []), ...later];
    for (const d of candidates.toSorted((a, b) => b.id - a.id)) if (!byEnv.has(d.environment)) byEnv.set(d.environment, d);
    const stages: ShipStage[] = [];
    for (const d of [...byEnv.values()].toSorted((a, b) => a.id - b.id)) {
      const statuses = yield* body(GhDeploymentStatuses, `${base}/deployments/${d.id}/statuses?per_page=1`);
      stages.push(deploymentStage(d, statuses?.[0], ship.sha));
    }
    return { stages, followed: Object.fromEntries(byEnv) };
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

// ---------------------------------------------------------------- the agent
const verifyStage = (v: NonNullable<ShipAgent["verify"]>, since: number): ShipStage => ({
  id: "verify",
  kind: "verify",
  name: `Verify on ${v.env}`,
  state: v.state,
  url: v.url,
  ...(v.note ? { detail: v.note } : v.state === "pending" ? { detail: "The agent is checking the change" } : {}),
  startedAt: since,
  ...(v.at !== undefined ? { endedAt: v.at } : {}),
});

/** Whether the agent can be woken for this ship: the session is live, and the ship still has its subscription (notifications go through it). */
function wakeable(app: App, ship: Ship) {
  const d = getDork(app.db, ship.dorkId);
  return !!d && !d.archived && !d.deleting && ship.subscriptionId !== undefined;
}

const failureLine = (s: ShipStage) => `${s.name} failed${s.detail ? ` (${s.detail})` : ""}${s.url ? `: ${s.url}` : ""}`;

/**
 * The agent's part, from what the tracker just saw: told once that the ship is live (it verifies the change there; the ship waits for
 * its `verify` stage) and once that it failed (it opens a fix-forward or revert PR). Returns the stages with the verify stage.
 */
function involveAgent(app: App, ship: Ship, github: ShipStage[]): { agent: ShipAgent; stages: ShipStage[] } {
  const now = app.now();
  const agent: ShipAgent = { ...ship.agent };
  const notify = (kind: NotifyKind, summary: string) => enqueueNotification(app, ship.dorkId, ship.subscriptionId!, kind, summary);
  const failures = github.filter((s) => s.state === "failed");
  const live = github.find((s) => s.kind === "deployment" && s.state === "passed" && s.environmentUrl);
  if (agent.deployedAt === undefined && live && !failures.length && wakeable(app, ship)) {
    const env = live.name.replace(/^Deploy to /, "");
    agent.deployedAt = now;
    agent.verify = { state: "pending", env, url: live.environmentUrl! };
    notify("deployed", `Merge commit ${short(ship.sha)} is live on ${env}: ${live.environmentUrl}`);
  }
  if (agent.verify?.state === "pending" && now - (agent.deployedAt ?? now) >= SHIP_VERIFY_MS) agent.verify = { ...agent.verify, state: "skipped", note: "Not verified in time", at: now };
  if (agent.failedAt === undefined && failures.length && wakeable(app, ship)) {
    agent.failedAt = now;
    notify("ship_failed", `${failures.map(failureLine).join("; ")}. Merge commit ${ship.sha} on ${ship.baseRef}.`);
  }
  return { agent, stages: agent.verify ? [...github, verifyStage(agent.verify, agent.deployedAt ?? now)] : github };
}

/** Saves a ship's new state: a `ship` event when what the card shows changed, the dork's row when its status did. In a transaction. */
function saveShip(app: App, ship: Ship, next: Ship, poll: ShipPoll) {
  update(app.db, "ships", { id: ship.id }, { stages: next.stages, status: next.status, agent: next.agent ?? null, poll, endedAt: next.endedAt ?? null });
  if (JSON.stringify(shipView(ship)) !== JSON.stringify(shipView(next))) append(app, ship.dorkId, { type: "ship", ship: shipView(next) });
  if (ship.status !== next.status || next.endedAt !== undefined) touchDork(app, ship.dorkId);
}

/** Applies one observation in a transaction. */
export function applyShip(app: App, id: number, obs: ShipObservation) {
  app.db.tx(() => {
    const ship = getShip(app, id);
    if (!ship || ship.endedAt !== undefined) return;
    const { agent, stages } = involveAgent(app, ship, obs.stages);
    const d = decide(ship.startedAt, stages, ship.poll?.doneAt, app.now());
    const { doneAt: _, ...poll } = obs.poll;
    const next: Ship = { ...ship, stages, agent, status: d.status, endedAt: d.end ? app.now() : undefined };
    saveShip(app, ship, next, { ...poll, readAt: app.now(), ...(d.doneAt !== undefined ? { doneAt: d.doneAt } : {}) });
  });
}

/**
 * The `ship` bridge op: the agent's `ship_verify` tool. Records its check of the live deployment on the session's ship that waits for
 * one; a failed check fails the ship.
 */
export function shipOp(app: App, dorkId: string, args: Record<string, unknown>): { text: string } {
  if (args.action !== "verify") return fail("invalid", "unknown ship action");
  if (typeof args.ok !== "boolean" || typeof args.note !== "string" || !args.note.trim()) return fail("invalid", "`ok` and a non-empty `note` are required");
  const { ok, note } = args as { ok: boolean; note: string };
  return app.db.tx(() => {
    const ship = app.db
      .all("SELECT * FROM ships WHERE dork_id = ? ORDER BY id DESC", dorkId)
      .map(shipOf)
      .find((s) => s.agent?.verify?.state === "pending");
    if (!ship?.agent?.verify) return fail("not_found", "No merged PR of this session is waiting for verification: ship_verify answers a `deployed` notification.");
    const now = app.now();
    const verify = { ...ship.agent.verify, state: ok ? ("passed" as const) : ("failed" as const), note: note.trim().slice(0, 300), at: now };
    const agent = { ...ship.agent, verify };
    const stages = [...ship.stages.filter((s) => s.kind !== "verify"), verifyStage(verify, agent.deployedAt ?? now)];
    const d = decide(ship.startedAt, stages, ship.poll?.doneAt, now);
    const next: Ship = { ...ship, stages, agent, status: d.status, endedAt: d.end ? now : undefined };
    saveShip(app, ship, next, { ...ship.poll, ...(d.doneAt !== undefined ? { doneAt: d.doneAt } : {}) });
    return {
      text: ok
        ? `Recorded: #${ship.number} verified on ${verify.env}. The ship card shows your note.`
        : `Recorded: #${ship.number} failed verification on ${verify.env}. Open a fix-forward PR, or a revert PR when the fix is not obvious. Do not deploy, roll back or merge yourself.`,
    };
  });
}
