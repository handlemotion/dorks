import {
  automationInput,
  MAX_AUTOMATIONS,
  type AutomationRunSource,
  type AutomationRunStatus,
  type AutomationRunView,
  type AutomationSpec,
  type AutomationTrigger,
  type AutomationView,
  type GithubTrigger,
  type ScheduleTrigger,
} from "@dorks/shared";
import { AppFail, fail, touch, type App } from "../app";
import { insert, json, update } from "../db";
import { cancelTimer, hasTimer, setTimer } from "../lifecycle/dispatch";
import { nextFire, validTimeZone } from "../lib/schedule";
import { createDork } from "./dorks";
import { getBuild } from "./builds";

// Automations (docs/automations.md): instructions an agent runs on a schedule, when something happens in a repository, or when the
// owner says Run now. A run is an ordinary session started with the instructions and what triggered it; the automation keeps a
// history of its runs. Schedules are one `automation:<id>` job per automation; GitHub events come from the repository watcher
// (automationWatch.ts).

export const SCHEDULE_JOB = "automation:";
export const WATCH_JOB = "automation-watch";
/** A runaway trigger (or a loop through the agent's own pushes) stops here. */
export const MAX_RUNS_PER_HOUR = 20;
/** A pull request's pushes start at most one run per automation in this window; the agent's own pushes would otherwise loop. */
export const PUSH_COOLDOWN_MS = 10 * 60_000;
const KEEP_RUNS = 100;
const HISTORY_PAGE = 50;
const WEEK_MS = 7 * 24 * 3_600_000;
const CAP_WINDOW_MS = 3_600_000;
/**
 * The scheduler looks at least once a minute, so a schedule run starting later than this after its time means Dorks was not running
 * (the Mac was off or asleep, or the app was closed): the run says so instead of looking like it started on time.
 */
export const LATE_MS = 5 * 60_000;
/** A schedule pass that threw: the run it owed is recorded as failed, never dropped. */
const PASS_FAILED = "The run could not start because of an error in Dorks. It runs again at the next time.";

export interface AutomationRow extends AutomationSpec {
  id: string;
  schedFrom: number;
  createdAt: number;
  updatedAt: number;
}

const rowOf = (r: Record<string, unknown>): AutomationRow => ({
  id: r.id as string,
  name: r.name as string,
  enabled: r.enabled === 1,
  triggers: json<AutomationTrigger[]>(r.triggers) ?? [],
  instructions: r.instructions as string,
  model: (r.model as string | null) ?? null,
  effort: (r.effort as string | null) ?? null,
  buildId: (r.build_id as string | null) ?? null,
  schedFrom: r.sched_from as number,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

export const getAutomation = (app: App, id: string): AutomationRow | undefined => {
  const r = app.db.get("SELECT * FROM automations WHERE id = ?", id);
  return r ? rowOf(r) : undefined;
};

function ownAutomation(app: App, id: string): AutomationRow {
  return getAutomation(app, id) ?? fail("not_found", "This automation no longer exists.");
}

export const allAutomations = (app: App): AutomationRow[] => app.db.all("SELECT * FROM automations ORDER BY lower(name)").map(rowOf);

const schedules = (a: Pick<AutomationRow, "triggers">) => a.triggers.filter((t): t is ScheduleTrigger => t.kind === "schedule");
export const githubTriggers = (a: Pick<AutomationRow, "triggers">) => a.triggers.filter((t): t is GithubTrigger => t.kind === "github");

// ---------------------------------------------------------------- input

/** A full definition from a request body, or `invalid` with the first problem in plain words. */
function checkInput(app: App, input: unknown, selfId?: string): AutomationSpec {
  const parsed = automationInput.safeParse(input);
  if (!parsed.success) return fail("invalid", parsed.error.issues[0]?.message ?? "invalid automation");
  const spec = parsed.data;
  for (const t of spec.triggers) {
    if (t.kind === "schedule" && !validTimeZone(t.timezone)) fail("invalid", `Unknown time zone ${t.timezone}.`);
    if (t.kind === "schedule" && !t.branch) delete t.branch;
    if (t.kind === "github") t.authors = [...new Set(t.authors.map((l) => l.trim()).filter(Boolean))];
  }
  if (spec.buildId && !getBuild(app, spec.buildId)) fail("not_found", "This build no longer exists.");
  if (!spec.model) spec.effort = null;
  const clash = app.db.get<{ id: string }>("SELECT id FROM automations WHERE lower(name) = lower(?)", spec.name);
  if (clash && clash.id !== selfId) fail("conflict", `An automation is already called ${spec.name}.`);
  return spec;
}

const columns = (s: AutomationSpec) => ({
  name: s.name,
  enabled: s.enabled,
  triggers: s.triggers,
  instructions: s.instructions,
  model: s.model,
  effort: s.effort,
  buildId: s.buildId,
});

export function createAutomation(app: App, input: unknown): string {
  return app.db.tx(() => {
    const count = app.db.get<{ n: number }>("SELECT count(*) AS n FROM automations")?.n ?? 0;
    if (count >= MAX_AUTOMATIONS) fail("limit", `You have ${count} automations, the most allowed. Delete one first.`);
    const spec = checkInput(app, input);
    const id = app.uuid();
    const now = app.now();
    insert(app.db, "automations", { id, ...columns(spec), schedFrom: now, createdAt: now, updatedAt: now });
    arm(app, getAutomation(app, id)!);
    touch(app, { t: "automations" });
    return id;
  });
}

/** Replaces the definition with `patch` merged over it (a toggle sends only `enabled`). Schedules count again from now. */
export function updateAutomation(app: App, id: string, patch: unknown): void {
  app.db.tx(() => {
    const a = ownAutomation(app, id);
    if (typeof patch !== "object" || patch === null) fail("invalid", "body must be an object");
    const spec = checkInput(app, { ...columns(a), ...patch }, id);
    update(app.db, "automations", { id }, { ...columns(spec), schedFrom: app.now(), updatedAt: app.now() });
    arm(app, getAutomation(app, id)!);
    touch(app, { t: "automations" });
  });
}

export function deleteAutomation(app: App, id: string): void {
  app.db.tx(() => {
    ownAutomation(app, id);
    app.db.run("DELETE FROM automations WHERE id = ?", id); // its runs cascade; the sessions they started stay
    cancelTimer(app, "", `${SCHEDULE_JOB}${id}`);
    touch(app, { t: "automations" });
  });
}

// ---------------------------------------------------------------- schedules

/** When the automation's schedules fire next, after `from`; null when it has none or is paused. */
export function nextRunAt(a: AutomationRow, from = a.schedFrom): number | null {
  if (!a.enabled) return null;
  const times = schedules(a).map((t) => nextFire(t, from));
  return times.length ? Math.min(...times) : null;
}

/** Sets (or clears) the automation's schedule job, and wakes the repository watcher if it has something new to watch. */
function arm(app: App, a: AutomationRow) {
  const name = `${SCHEDULE_JOB}${a.id}`;
  const next = nextRunAt(a);
  if (next === null) cancelTimer(app, "", name);
  else setTimer(app, "", name, Math.max(0, next - app.now()));
  if (a.enabled && githubTriggers(a).length && !hasTimer(app, "", WATCH_JOB)) setTimer(app, "", WATCH_JOB, 1_000);
}

/**
 * The schedule job: every schedule whose time came since the last look starts one run (a time missed while the app was closed runs
 * once, when it is back, and says it started late), then the job is set for the next time.
 */
export function fireSchedules(app: App, id: string) {
  app.db.tx(() => {
    const a = getAutomation(app, id);
    if (!a || !a.enabled) return;
    const now = app.now();
    for (const { t, due } of dueSchedules(a, now)) {
      const late = now - due > LATE_MS ? { due: dueText(due, now, t.timezone), at: clock(now, t.timezone) } : null;
      startRun(app, a, {
        ...scheduleRun(t, due),
        ...(late ? { note: `started at ${late.at}: Dorks was not running at ${late.due}` } : {}),
        context: `It runs ${scheduleText(t).toLowerCase()} (${t.timezone}).${t.branch ? ` Start from the \`${t.branch}\` branch.` : ""}${
          late ? ` It was due at ${late.due} but Dorks was not running then, so it started at ${late.at}.` : ""
        }`,
      });
    }
    update(app.db, "automations", { id }, { schedFrom: now });
    arm(app, getAutomation(app, id)!);
    touch(app, { t: "automations" });
  });
}

/** The schedules whose next time after the last look has come, with that time. */
const dueSchedules = (a: AutomationRow, now: number) =>
  schedules(a)
    .map((t) => ({ t, due: nextFire(t, a.schedFrom) }))
    .filter(({ due }) => due <= now);

/** What a schedule's run is called in the history, and the key that makes it one run per due time. */
const scheduleRun = (t: ScheduleTrigger, due: number) => ({
  source: "schedule" as const,
  repo: t.repo,
  summary: `${scheduleText(t)}${t.branch ? ` on ${t.branch}` : ""}`,
  // The whole trigger, so two schedules due at once (another branch, another repository) are two runs.
  key: `schedule:${t.repo}@${t.branch ?? ""}:${t.every}:${t.day}:${t.time}:${t.timezone}:${due}`,
});

/** `08:25` on the wall clock in `tz`. */
const clock = (ms: number, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
/** `Mon 23 Nov` in `tz`. */
const date = (ms: number, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(ms);
/** When a late run was due: the time, and the day too when it was not today (a time missed yesterday can be later in the day than now). */
const dueText = (due: number, now: number, tz: string) => (date(due, tz) === date(now, tz) ? clock(due, tz) : `${clock(due, tz)} on ${date(due, tz)}`);

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function scheduleText(t: ScheduleTrigger): string {
  if (t.every === "hour") return `Every hour at :${t.time.slice(3)}`;
  if (t.every === "day") return `Every day at ${t.time}`;
  if (t.every === "weekdays") return `Every weekday at ${t.time}`;
  return `Every ${DAYS[t.day]} at ${t.time}`;
}

/**
 * After a pass that failed (it rolled back): each run it owed is recorded as failed, so the history shows the missed time, then the
 * schedule job is set again from now.
 */
export function rearmSchedule(app: App, id: string) {
  app.db.tx(() => {
    const a = getAutomation(app, id);
    if (!a) return;
    const now = app.now();
    if (a.enabled) {
      for (const { t, due } of dueSchedules(a, now)) {
        const run = scheduleRun(t, due);
        if (!app.db.get("SELECT 1 AS x FROM automation_runs WHERE automation_id = ? AND event_key = ?", a.id, run.key)) recordRun(app, a, { ...run, context: "" }, "failed", PASS_FAILED, null);
      }
    }
    update(app.db, "automations", { id }, { schedFrom: now });
    arm(app, getAutomation(app, id)!);
  });
}

/** After a restart: a schedule job lost mid-flight is set again, and the watcher runs if anything needs it. */
export function recoverAutomations(app: App) {
  app.db.tx(() => {
    const active = allAutomations(app).filter((a) => a.enabled);
    for (const a of active) if (!hasTimer(app, "", `${SCHEDULE_JOB}${a.id}`)) arm(app, a);
    // Checked on its own: a watcher job that was running when the process died was already claimed, so its timer is gone.
    if (active.some((a) => githubTriggers(a).length) && !hasTimer(app, "", WATCH_JOB)) setTimer(app, "", WATCH_JOB, 1_000);
  });
}

// ---------------------------------------------------------------- runs

export interface RunRequest {
  source: AutomationRunSource;
  repo: string;
  /** One line for the history. */
  summary: string;
  /** What the agent is told about why it is running, after the instructions. */
  context: string;
  /** Dedupes an event per automation. */
  key?: string;
  /** Added to the history line, not the session's title: why it started late. */
  note?: string;
  url?: string;
  number?: number;
}

const firstSentence = (s: string) => s.replace(/\s+/g, " ").trim();

/** The session's first message: the owner's instructions, then why this run started. */
function messageOf(a: AutomationRow, r: RunRequest) {
  return `${a.instructions.trim()}\n\n---\nThis session was started by the automation "${a.name}" in ${r.repo}. ${r.context}`;
}

function recordRun(app: App, a: AutomationRow, r: RunRequest, status: AutomationRunStatus, error: string | null, dorkId: string | null): string {
  const id = app.uuid();
  insert(app.db, "automation_runs", {
    id,
    automationId: a.id,
    source: r.source,
    eventKey: r.key ?? null,
    summary: (r.note ? `${r.summary}, ${r.note}` : r.summary).slice(0, 300),
    url: r.url ?? null,
    repo: r.repo,
    number: r.number ?? null,
    dorkId,
    status,
    error,
    createdAt: app.now(),
  });
  // The history keeps the newest runs, and always the last hour's: the hourly cap counts them.
  app.db.run(
    "DELETE FROM automation_runs WHERE automation_id = ? AND created_at <= ? AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?)",
    a.id,
    app.now() - CAP_WINDOW_MS,
    a.id,
    KEEP_RUNS,
  );
  touch(app, { t: "automations" });
  return id;
}

/**
 * Starts a session for one run and records it. An event seen before (its key) does nothing; past the hourly cap the run is recorded
 * as skipped; a session that cannot start (no Claude sign-in, a build not built) is recorded as failed with the reason.
 */
export function startRun(app: App, a: AutomationRow, r: RunRequest): string | null {
  return app.db.tx(() => {
    if (r.key && app.db.get("SELECT 1 AS x FROM automation_runs WHERE automation_id = ? AND event_key = ?", a.id, r.key)) return null;
    const lastHour = app.db.get<{ n: number }>("SELECT count(*) AS n FROM automation_runs WHERE automation_id = ? AND status = 'started' AND created_at > ?", a.id, app.now() - CAP_WINDOW_MS)?.n ?? 0;
    if (r.source !== "manual" && lastHour >= MAX_RUNS_PER_HOUR) return recordRun(app, a, r, "skipped", `It already ran ${lastHour} times in the last hour.`, null);
    let dorkId: string;
    try {
      dorkId = createDork(app, {
        repo: r.repo,
        message: messageOf(a, r),
        title: `${a.name}: ${firstSentence(r.summary)}`.slice(0, 120),
        provider: "claude",
        ...(a.model ? { model: a.model, effort: a.effort ?? undefined } : {}),
        ...(a.buildId ? { buildId: a.buildId } : {}),
      });
    } catch (e) {
      if (!(e instanceof AppFail)) throw e;
      if (r.source === "manual") throw e; // the owner is looking: show it where they clicked
      return recordRun(app, a, r, "failed", e.error.message, null);
    }
    return recordRun(app, a, r, "started", null, dorkId);
  });
}

/** Run now: the first trigger's repository, with the owner as the reason. */
export function runNow(app: App, id: string): AutomationRunView {
  const a = ownAutomation(app, id);
  const t = a.triggers[0];
  if (!t) return fail("invalid", "Add a trigger first: it names the repository.");
  const runId = startRun(app, a, {
    source: "manual",
    repo: t.repo,
    summary: "Run by you",
    context: t.kind === "schedule" && t.branch ? `You started this run by hand. Start from the \`${t.branch}\` branch.` : "You started this run by hand, to try it.",
  });
  return runView(app, app.db.get("SELECT * FROM automation_runs WHERE id = ?", runId!)!);
}

// ---------------------------------------------------------------- views

function runView(app: App, r: Record<string, unknown>): AutomationRunView {
  const dorkId = r.dork_id as string | null;
  const d = dorkId ? app.db.get<{ id: string; title: string; state: string; archived: number }>("SELECT id, title, state, archived FROM dorks WHERE id = ? AND deleting = 0", dorkId) : undefined;
  return {
    id: r.id as string,
    automationId: r.automation_id as string,
    source: r.source as AutomationRunSource,
    summary: r.summary as string,
    url: (r.url as string | null) ?? null,
    repo: (r.repo as string | null) ?? null,
    status: r.status as AutomationRunStatus,
    error: (r.error as string | null) ?? null,
    dork: d ? { id: d.id, title: d.title, state: d.state, archived: d.archived === 1 } : null,
    createdAt: r.created_at as number,
  };
}

export function listRuns(app: App, id: string): AutomationRunView[] {
  ownAutomation(app, id);
  return app.db.all("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?", id, HISTORY_PAGE).map((r) => runView(app, r));
}

export function automationView(app: App, a: AutomationRow): AutomationView {
  const last = app.db.get("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1", a.id);
  const repos = [...new Set(githubTriggers(a).map((t) => t.repo.toLowerCase()))];
  const watched = repos.length
    ? app.db.all<{ repo: string; private: number | null; error: string | null }>(`SELECT repo, private, error FROM automation_watch WHERE repo IN (${repos.map(() => "?").join(", ")})`, ...repos)
    : [];
  const { id, schedFrom: _schedFrom, createdAt, updatedAt, ...spec } = a;
  return {
    id,
    ...spec,
    nextRunAt: nextRunAt(a),
    lastRun: last ? runView(app, last) : null,
    recentRuns: app.db.get<{ n: number }>("SELECT count(*) AS n FROM automation_runs WHERE automation_id = ? AND created_at > ?", a.id, app.now() - WEEK_MS)?.n ?? 0,
    problems: watched.filter((w) => w.error).map((w) => ({ repo: w.repo, message: w.error! })),
    publicRepos: watched.filter((w) => w.private === 0).map((w) => w.repo),
    createdAt,
    updatedAt,
  };
}

export const listAutomations = (app: App): AutomationView[] => allAutomations(app).map((a) => automationView(app, a));
export const getAutomationView = (app: App, id: string): AutomationView => automationView(app, ownAutomation(app, id));
