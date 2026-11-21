import { describe, expect, it } from "vite-plus/test";
import { nextFire } from "../src/lib/schedule";
import { createAutomation, fireSchedules, listRuns, MAX_RUNS_PER_HOUR, runNow, updateAutomation } from "../src/services/automations";
import { watchOnce } from "../src/services/automationWatch";
import { updateSettings } from "../src/services/settings";
import { fakeFetch, harness } from "./harness";

// Automations: schedules in the owner's time zone, and the repository watcher against a miniature GitHub (a baseline that replays
// nothing, the events a change produces, and the guards that keep agents from waking themselves).

const utc = (s: string) => Date.parse(`${s}Z`);

describe("schedule", () => {
  it("fires at the wall-clock time in its zone, across a daylight-saving change", () => {
    const t = { every: "day" as const, day: 1, time: "09:00", timezone: "Europe/Berlin" };
    expect(nextFire(t, utc("2026-03-28T07:59:00"))).toBe(utc("2026-03-28T08:00:00")); // CET, UTC+1
    expect(nextFire(t, utc("2026-03-28T08:00:00"))).toBe(utc("2026-03-29T07:00:00")); // CEST from the 29th, UTC+2
  });

  it("hourly keeps its minute across a half-hour clock change", () => {
    const t = { every: "hour" as const, day: 1, time: "00:30", timezone: "Australia/Lord_Howe" };
    let at = utc("2026-10-03T14:00:00");
    const fires = [];
    for (let i = 0; i < 4; i++) fires.push((at = nextFire(t, at)));
    // 01:30 (+10:30), 02:30 just after the 02:00 → 02:30 jump (+11), then 03:30 and 04:30: always :30 local, nothing skipped.
    expect(fires).toEqual([utc("2026-10-03T15:00:00"), utc("2026-10-03T15:30:00"), utc("2026-10-03T16:30:00"), utc("2026-10-03T17:30:00")]);
  });

  it("a time the clocks skip lands after the gap, and a time they repeat is the first one", () => {
    const t = { every: "day" as const, day: 1, time: "02:30", timezone: "America/New_York" };
    expect(nextFire(t, utc("2026-03-08T05:00:00"))).toBe(utc("2026-03-08T07:30:00")); // 03:30 EDT, not 01:30 EST
    expect(nextFire({ ...t, time: "01:30" }, utc("2026-11-01T04:00:00"))).toBe(utc("2026-11-01T05:30:00")); // 01:30 EDT
  });

  it("skips weekends for weekdays, finds the day for weekly, and the minute for hourly", () => {
    const sat = utc("2026-11-21T12:00:00"); // a Saturday
    expect(nextFire({ every: "weekdays", day: 1, time: "15:00", timezone: "UTC" }, sat)).toBe(utc("2026-11-23T15:00:00"));
    expect(nextFire({ every: "week", day: 3, time: "08:30", timezone: "UTC" }, sat)).toBe(utc("2026-11-25T08:30:00"));
    expect(nextFire({ every: "hour", day: 1, time: "00:15", timezone: "Asia/Kolkata" }, utc("2026-11-21T12:00:00"))).toBe(utc("2026-11-21T12:45:00")); // 18:15 IST, UTC+5:30;
  });
});

function github() {
  const state = {
    private: true,
    pulls: [] as {
      number: number;
      title: string;
      html_url: string;
      state: string;
      user: { login: string };
      created_at: string;
      updated_at: string;
      merged_at: string | null;
      head: { ref: string; sha: string };
      base: { ref: string };
    }[],
    comments: [] as { id: number; html_url: string; issue_url: string; user: { login: string }; body: string; created_at: string }[],
  };
  const fetch = fakeFetch((url) => {
    const p = url.pathname;
    if (p === "/user") return Response.json({ login: "me" });
    if (p === "/repos/octo/app") return Response.json({ private: state.private });
    if (p === "/repos/octo/app/pulls") return Response.json([...state.pulls].reverse());
    if (p === "/repos/octo/app/issues/comments") {
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json([...state.comments].reverse().slice((page - 1) * per, page * per));
    }
    return new Response("{}", { status: 404 });
  });
  return { state, fetch };
}

async function setup() {
  const gh = github();
  const h = harness({ fetch: gh.fetch, config: { boxProvider: "sim" } });
  await updateSettings(h.app, { claudeToken: "ct", githubConnected: true });
  const at = (ms: number) => new Date(h.clock.t + ms).toISOString();
  const pr = (number: number, o: Partial<(typeof gh.state.pulls)[number]> = {}) =>
    gh.state.pulls.push({
      number,
      title: `PR ${number}`,
      html_url: `u${number}`,
      state: "open",
      user: { login: "alice" },
      created_at: at(0),
      updated_at: at(0),
      merged_at: null,
      head: { ref: `f${number}`, sha: "a1" },
      base: { ref: "main" },
      ...o,
    });
  const dorks = () => h.app.db.all<{ title: string; repo: string }>("SELECT title, repo FROM dorks ORDER BY created_at, rowid");
  return { gh, h, at, pr, dorks };
}

const reviewer = {
  name: "review",
  instructions: "Review the PR.",
  triggers: [
    { kind: "github", event: "pr_opened", repo: "octo/app" },
    { kind: "github", event: "pr_pushed", repo: "octo/app" },
    { kind: "github", event: "pr_merged", repo: "octo/app" },
  ],
};

describe("automations", () => {
  it("a schedule starts one session when its time comes, even after missing several, then waits for the next", async () => {
    const s = await setup();
    s.h.clock.t = utc("2026-11-23T08:00:00");
    const id = createAutomation(s.h.app, {
      name: "nightly",
      instructions: "Update deps.",
      triggers: [{ kind: "schedule", every: "day", time: "09:00", timezone: "UTC", repo: "octo/app", branch: "dev" }],
    });
    fireSchedules(s.h.app, id);
    expect(s.dorks()).toEqual([]);
    s.h.clock.t = utc("2026-11-26T10:00:00"); // three days late
    fireSchedules(s.h.app, id);
    expect(s.dorks()).toEqual([{ title: "nightly: Every day at 09:00 on dev", repo: "octo/app" }]);
    const due = s.h.app.db.get<{ due_at: number }>("SELECT due_at FROM timers WHERE name = ?", `automation:${id}`);
    expect(due?.due_at).toBe(utc("2026-11-27T09:00:00"));
  });

  it("the watcher's first read is a baseline; later opens, pushes and merges start runs once", async () => {
    const s = await setup();
    s.pr(1);
    createAutomation(s.h.app, reviewer);
    await watchOnce(s.h.app);
    expect(s.dorks()).toEqual([]);

    s.h.clock.t += 60_000;
    s.pr(2);
    s.gh.state.pulls[0].head.sha = "b2"; // PR 1 got a push
    s.gh.state.pulls[0].updated_at = s.at(0);
    await watchOnce(s.h.app);
    await watchOnce(s.h.app); // nothing new: nothing twice
    expect(s.dorks().map((d) => d.title)).toEqual(["review: #1 PR 1 by @alice", "review: #2 PR 2 by @alice"]);

    s.h.clock.t += 60_000;
    s.gh.state.pulls[1].head.sha = "c3"; // a push right after its run: most likely the agent's own
    s.gh.state.pulls[1].updated_at = s.at(0);
    s.gh.state.pulls[0].merged_at = s.at(0);
    s.gh.state.pulls[0].updated_at = s.at(0);
    s.gh.state.pulls[0].state = "closed";
    await watchOnce(s.h.app);
    expect(s.dorks()).toHaveLength(3);
    expect(listRuns(s.h.app, s.h.app.db.get<{ id: string }>("SELECT id FROM automations")!.id).map((r) => r.source)).toEqual(["pr_merged", "pr_opened", "pr_pushed"]);
  });

  it("on a public repository only listed people start runs, and the login's own comments never do", async () => {
    const s = await setup();
    s.gh.state.private = false;
    const id = createAutomation(s.h.app, { name: "answer", instructions: "Answer.", triggers: [{ kind: "github", event: "comment", repo: "octo/app" }] });
    await watchOnce(s.h.app);
    const comment = (n: number, login: string) => s.gh.state.comments.push({ id: n, html_url: `c${n}`, issue_url: "x/issues/4", user: { login }, body: "hi", created_at: s.at(n) });
    comment(1, "stranger");
    await watchOnce(s.h.app);
    expect(s.dorks()).toEqual([]);
    expect(s.h.app.db.get("SELECT private FROM automation_watch")).toEqual({ private: 0 });

    updateAutomation(s.h.app, id, { triggers: [{ kind: "github", event: "comment", repo: "octo/app", authors: ["friend", "me"] }] });
    comment(2, "me");
    comment(3, "friend");
    await watchOnce(s.h.app);
    expect(s.dorks().map((d) => d.title)).toEqual(["answer: Comment on #4 by @friend"]);
  });

  it("a burst bigger than a page between passes is read whole", async () => {
    const s = await setup();
    const id = createAutomation(s.h.app, { name: "answer", instructions: "Answer.", triggers: [{ kind: "github", event: "comment", repo: "octo/app", authors: ["friend"] }] });
    await watchOnce(s.h.app);
    for (let n = 1; n <= 70; n++) s.gh.state.comments.push({ id: n, html_url: `c${n}`, issue_url: "x/issues/4", user: { login: "friend" }, body: "hi", created_at: s.at(n * 1000) });
    await watchOnce(s.h.app);
    const runs = s.h.app.db.all<{ status: string }>("SELECT status FROM automation_runs WHERE automation_id = ?", id);
    expect(runs).toHaveLength(70); // 20 started, then the hourly cap: every one is accounted for
    expect(runs.filter((r) => r.status === "started")).toHaveLength(MAX_RUNS_PER_HOUR);
  });

  it("two schedules due at once are two runs", async () => {
    const s = await setup();
    s.h.clock.t = utc("2026-11-23T08:00:00");
    const daily = (branch: string) => ({ kind: "schedule", every: "day", time: "09:00", timezone: "UTC", repo: "octo/app", branch });
    const id = createAutomation(s.h.app, { name: "both", instructions: "Go.", triggers: [daily("main"), daily("release")] });
    s.h.clock.t = utc("2026-11-23T09:00:00");
    fireSchedules(s.h.app, id);
    expect(s.dorks().map((d) => d.title)).toEqual(["both: Every day at 09:00 on main", "both: Every day at 09:00 on release"]);
  });

  it("stops at the hourly cap and records why; Run now shows a refusal instead", async () => {
    const s = await setup();
    const id = createAutomation(s.h.app, { name: "loop", instructions: "Go.", triggers: [{ kind: "schedule", every: "hour", time: "00:00", timezone: "UTC", repo: "octo/app" }] });
    s.h.clock.t = utc("2026-11-23T08:00:00");
    for (let i = 0; i < MAX_RUNS_PER_HOUR; i++)
      s.h.app.db.run("INSERT INTO automation_runs (id, automation_id, source, summary, status, created_at) VALUES (?, ?, 'pr_pushed', 's', 'started', ?)", `r${i}`, id, s.h.clock.t - 60_000);
    s.h.app.db.run("UPDATE automations SET sched_from = ? WHERE id = ?", s.h.clock.t - 60_000, id); // 08:00 has just come
    fireSchedules(s.h.app, id);
    expect(listRuns(s.h.app, id)[0]).toMatchObject({ status: "skipped", error: `It already ran ${MAX_RUNS_PER_HOUR} times in the last hour.` });
    await updateSettings(s.h.app, { claudeToken: "" });
    expect(() => runNow(s.h.app, id)).toThrow(/Claude/);
  });
});
