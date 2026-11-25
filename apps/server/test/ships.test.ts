import { describe, expect, it } from "vite-plus/test";
import type { ShipView } from "@dorks/shared";
import { dorkView } from "../src/data";
import { needsAttentionOf } from "../src/data";
import { pollOnce, POLL_MS } from "../src/services/poller";
import { updateSettings } from "../src/services/settings";
import { SHIP_VERIFY_MS } from "@dorks/shared";
import { SHIP_QUIET_MS, SHIP_SETTLE_MS, shipOp } from "../src/services/ships";
import * as subs from "../src/services/subscriptions";
import { fakeFetch, harness } from "./harness";

// After a merge: the ship tracker follows the merge commit through GitHub (workflow runs, a migration step, other apps' checks,
// deployments, including a later commit's deploy that contains it) and settles on shipped, failed or quiet.

const MERGE = "merge0000000";
type Run = {
  id: number;
  name: string;
  workflow_id?: number;
  head_sha?: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_started_at: string;
  updated_at: string;
};
type Step = { name: string; number: number; status: string; conclusion: string | null };

function github() {
  const state = {
    pr: {
      title: "Add thing",
      state: "open" as "open" | "closed",
      merged: false,
      mergeable: true,
      merged_by: null as null | { login: string; type: string },
      head: { ref: "agent/x", sha: "aaa1111" },
      base: { ref: "main", sha: "base000", repo: { default_branch: "main" } },
      merge_commit_sha: null as string | null,
      merged_at: null as string | null,
    },
    runs: [] as Run[],
    jobs: {} as Record<number, { id: number; name: string; status: string; conclusion: string | null; html_url: string; steps: Step[] }[]>,
    checkRuns: [] as { id: number; name: string; status: string; conclusion: string | null; details_url: string; app: { slug: string } }[],
    deployments: [] as { id: number; sha: string; environment: string; created_at: string }[],
    deploymentStatuses: {} as Record<number, { state: string; environment_url?: string; log_url?: string }[]>,
    /** sha -> compare status against the merge commit */
    compare: {} as Record<string, string>,
  };
  const etag = (v: unknown) => {
    const s = JSON.stringify(v);
    let h = 7;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `"${h}"`;
  };
  const reply = (url: URL, init: RequestInit | undefined, body: unknown) => {
    const tag = etag([url.search, body]);
    if (new Headers(init?.headers).get("if-none-match") === tag) return new Response(null, { status: 304, headers: { etag: tag } });
    return new Response(JSON.stringify(body), { status: 200, headers: { etag: tag, "content-type": "application/json" } });
  };
  const f = fakeFetch((url, init) => {
    const p = url.pathname.replace("/repos/octo/hello", "");
    if (url.pathname === "/user") return Response.json({ login: "agent-bot" });
    if (p === "/pulls/7") return reply(url, init, state.pr);
    if (p === "/pulls/7/reviews" || p === "/issues/7/comments" || p === "/pulls/7/comments") return reply(url, init, []);
    if (/^\/commits\/[^/]+\/check-suites$/.test(p)) return reply(url, init, { check_suites: [] });
    if (p === "/actions/runs") return reply(url, init, { workflow_runs: state.runs.filter((r) => (r.head_sha ?? MERGE) === url.searchParams.get("head_sha")) });
    const wf = /^\/actions\/workflows\/(\d+)\/runs$/.exec(p);
    if (wf) return reply(url, init, { workflow_runs: state.runs.filter((r) => r.workflow_id === Number(wf[1])).toSorted((a, b) => b.id - a.id) });
    const jobs = /^\/actions\/runs\/(\d+)\/jobs$/.exec(p);
    if (jobs) return reply(url, init, { jobs: state.jobs[Number(jobs[1])] ?? [] });
    if (p === `/commits/${MERGE}/check-runs`) return reply(url, init, { check_runs: state.checkRuns });
    if (p === `/commits/${MERGE}/status`) return reply(url, init, { statuses: [] });
    if (p === "/deployments") {
      const sha = url.searchParams.get("sha");
      return reply(url, init, (sha ? state.deployments.filter((d) => d.sha === sha) : state.deployments).toSorted((a, b) => b.id - a.id).slice(0, Number(url.searchParams.get("per_page") ?? 30)));
    }
    const ds = /^\/deployments\/(\d+)\/statuses$/.exec(p);
    if (ds) return reply(url, init, (state.deploymentStatuses[Number(ds[1])] ?? []).toReversed());
    const cmp = new RegExp(`^/compare/${MERGE}\\.\\.\\.(.+)$`).exec(p);
    if (cmp) return reply(url, init, { status: state.compare[cmp[1]] ?? "diverged" });
    return new Response("{}", { status: 404 });
  });
  return { state, fetch: f };
}

async function setup() {
  const gh = github();
  const h = harness({ fetch: gh.fetch, ghToken: "ghp_test" });
  const id = h.seed("idle");
  await updateSettings(h.app, { githubConnected: true });
  h.app.db.tx(() => subs.subscribe(h.app, h.dork(id), "octo/hello", 7, "agent"));
  await pollOnce(h.app);
  const iso = (dt = 0) => new Date(h.clock.t + dt).toISOString();
  const merge = async () => {
    Object.assign(gh.state.pr, { state: "closed", merged: true, merged_by: { login: "alice", type: "User" }, merge_commit_sha: MERGE, merged_at: iso() });
    return tick();
  };
  const tick = async (ms = POLL_MS) => {
    h.clock.t += ms;
    return pollOnce(h.app);
  };
  /** The card as the transcript shows it: the latest `ship` event. */
  const card = () =>
    h
      .events(id)
      .filter((e) => e.body.type === "ship")
      .map((e) => (e.body as { ship: ShipView }).ship)
      .at(-1);
  const run = (over: Partial<Run> & { id: number; name: string }): Run => ({
    event: "push",
    status: "in_progress",
    conclusion: null,
    html_url: `https://github.com/octo/hello/actions/runs/${over.id}`,
    run_started_at: iso(),
    updated_at: iso(),
    ...over,
  });
  return { gh, h, id, merge, tick, card, run, iso };
}

describe("ships", () => {
  it("follows a merge through CI, a migration step and a batched deploy, then settles on shipped", async () => {
    const s = await setup();
    expect(await s.merge()).toBe(POLL_MS); // the merge leaves a ship to watch
    expect(s.card()).toMatchObject({ status: "watching", sha: MERGE, number: 7, stages: [] });

    s.gh.state.runs.push(s.run({ id: 1, name: "CI" }), s.run({ id: 2, name: "Deploy" }));
    s.gh.state.jobs[2] = [
      { id: 20, name: "deploy", status: "in_progress", conclusion: null, html_url: "j20", steps: [{ name: "Run database migrations", number: 3, status: "in_progress", conclusion: null }] },
    ];
    s.gh.state.checkRuns.push({ id: 5, name: "Cloudflare Pages", status: "in_progress", conclusion: null, details_url: "https://dash.cloudflare.com/x", app: { slug: "cloudflare-pages" } });
    s.gh.state.checkRuns.push({ id: 6, name: "test", status: "in_progress", conclusion: null, details_url: "x", app: { slug: "github-actions" } }); // already a run above
    await s.tick();
    expect(s.card()!.stages.map((x) => [x.kind, x.name, x.state])).toEqual([
      ["workflow", "CI", "running"],
      ["workflow", "Deploy", "running"],
      ["migration", "Run database migrations", "running"],
      ["check", "Cloudflare Pages", "running"],
    ]);

    // Everything passes; production is deployed from a later commit that contains the merge, and a branch preview that does not.
    for (const r of s.gh.state.runs) Object.assign(r, { status: "completed", conclusion: "success" });
    s.gh.state.jobs[2][0] = {
      ...s.gh.state.jobs[2][0],
      status: "completed",
      conclusion: "success",
      steps: [{ name: "Run database migrations", number: 3, status: "completed", conclusion: "success" }],
    };
    Object.assign(s.gh.state.checkRuns[0], { status: "completed", conclusion: "success" });
    s.gh.state.deployments.push({ id: 40, sha: "later111", environment: "production", created_at: s.iso() }, { id: 41, sha: "branch22", environment: "Preview", created_at: s.iso() });
    s.gh.state.compare = { later111: "ahead", branch22: "diverged" };
    s.gh.state.deploymentStatuses[40] = [{ state: "in_progress" }];
    await s.tick();
    expect(s.card()!.stages.at(-1)).toMatchObject({ id: "dep:production", state: "running", detail: "with later11" });
    expect(s.card()!.stages.some((x) => x.name.includes("Preview"))).toBe(false);

    // Twenty newer branch previews push it off the recent page: it is still followed until it finishes.
    for (let i = 0; i < 20; i++) s.gh.state.deployments.push({ id: 100 + i, sha: `pr${i}`, environment: "Preview", created_at: s.iso() });
    await s.tick();
    await s.tick(SHIP_SETTLE_MS);
    expect(s.card()).toMatchObject({ status: "watching" });
    expect(s.card()!.stages.at(-1)).toMatchObject({ id: "dep:production", state: "running" });

    s.gh.state.deploymentStatuses[40].push({ state: "success", environment_url: "https://hello.example" });
    await s.tick();
    expect(s.card()).toMatchObject({ status: "watching" }); // all green: waits for the agent's check and follow-ups before calling it
    expect(s.card()!.stages.find((x) => x.id === "dep:production")).toMatchObject({ state: "passed", environmentUrl: "https://hello.example" });

    const events = s.h.events(s.id).length;
    await s.tick(); // nothing changed: no new event
    expect(s.h.events(s.id).length).toBe(events);
    shipOp(s.h.app, s.id, { action: "verify", ok: true, note: "Checked it live." });
    await s.tick(SHIP_SETTLE_MS);
    expect(s.card()).toMatchObject({ status: "shipped" });
    expect(s.card()!.endedAt).toBeDefined();
    expect(await pollOnce(s.h.app)).toBeNull(); // nothing is left to watch
  });

  it("a failure shows at once and asks for the owner until a re-run passes; a merge that starts nothing ends quiet", async () => {
    const s = await setup();
    await s.merge();
    s.gh.state.runs.push(s.run({ id: 1, name: "Deploy", status: "completed", conclusion: "failure" }));
    await s.tick();
    expect(s.card()).toMatchObject({ status: "failed", stages: [{ name: "Deploy", state: "failed" }] });
    expect(needsAttentionOf(s.h.app.db, s.id)).toBe(true);
    expect(dorkView(s.h.dork(s.id), undefined, needsAttentionOf(s.h.app.db, s.id)).needsAttention).toBe(true);
    await s.tick(SHIP_SETTLE_MS * 2);
    expect(s.card()!.endedAt).toBeUndefined(); // still watched: a re-run on the same commit can turn it around

    Object.assign(s.gh.state.runs[0], { status: "in_progress", conclusion: null });
    await s.tick();
    expect(s.card()).toMatchObject({ status: "watching" });
    Object.assign(s.gh.state.runs[0], { status: "completed", conclusion: "success" });
    await s.tick();
    await s.tick(SHIP_SETTLE_MS);
    expect(s.card()).toMatchObject({ status: "shipped" });
    expect(needsAttentionOf(s.h.app.db, s.id)).toBe(false);

    const q = await setup();
    await q.merge();
    await q.tick(SHIP_QUIET_MS);
    expect(q.card()).toMatchObject({ status: "quiet", stages: [] });
  });

  it("follows a cancelled deploy to the newer run that shipped it; a merge into a stacked parent branch is not a ship", async () => {
    const s = await setup();
    await s.merge();
    s.gh.state.runs.push(s.run({ id: 1, name: "Deploy", workflow_id: 9, status: "completed", conclusion: "cancelled" })); // superseded by a newer push
    s.gh.state.runs.push(s.run({ id: 2, name: "Deploy", workflow_id: 9, head_sha: "newer99", status: "in_progress" }));
    s.gh.state.compare = { newer99: "ahead" };
    await s.tick();
    expect(s.card()!.stages).toMatchObject([{ id: "run:1", name: "Deploy", state: "running", detail: "with newer99" }]);
    Object.assign(s.gh.state.runs[1], { status: "completed", conclusion: "success" });
    await s.tick();
    await s.tick(SHIP_SETTLE_MS);
    expect(s.card()).toMatchObject({ status: "shipped", stages: [{ state: "passed" }] });

    const stacked = await setup();
    stacked.gh.state.pr.base.ref = "agent/parent";
    await stacked.merge();
    expect(stacked.card()).toBeUndefined();
  });

  it("tells the agent once the merge is live and waits for its check; tells it once when the ship fails", async () => {
    const s = await setup();
    const inbox = () => s.h.app.db.all<{ kind: string; summary: string }>("SELECT kind, summary FROM inbox WHERE dork_id = ? ORDER BY id", s.id);
    await s.merge();
    expect(() => shipOp(s.h.app, s.id, { action: "verify", ok: true, note: "Looks right." })).toThrow(/waiting for verification/);
    s.gh.state.deployments.push({ id: 40, sha: MERGE, environment: "production", created_at: s.iso() });
    s.gh.state.deploymentStatuses[40] = [{ state: "success", environment_url: "https://hello.example" }];
    await s.tick();
    expect(inbox().map((r) => r.kind)).toEqual(["closed", "deployed"]);
    expect(inbox()[1].summary).toContain("https://hello.example");
    expect(s.card()!.stages.at(-1)).toMatchObject({ kind: "verify", name: "Verify on production", state: "pending" });
    await s.tick(SHIP_SETTLE_MS * 2);
    expect(s.card()).toMatchObject({ status: "watching" }); // waits for the agent's check

    expect(shipOp(s.h.app, s.id, { action: "verify", ok: true, note: "Opened /settings; the new toggle saves." }).text).toMatch(/verified on production/);
    expect(s.card()!.stages.at(-1)).toMatchObject({ state: "passed", detail: "Opened /settings; the new toggle saves." });
    await s.tick();
    await s.tick(SHIP_SETTLE_MS);
    expect(s.card()).toMatchObject({ status: "shipped" });
    expect(inbox().filter((r) => r.kind === "deployed")).toHaveLength(1);

    // Nobody reports: the ship stops waiting after SHIP_VERIFY_MS.
    const quiet = await setup();
    await quiet.merge();
    quiet.gh.state.deployments.push({ id: 40, sha: MERGE, environment: "production", created_at: quiet.iso() });
    quiet.gh.state.deploymentStatuses[40] = [{ state: "success", environment_url: "https://hello.example" }];
    await quiet.tick();
    await quiet.tick(SHIP_VERIFY_MS);
    await quiet.tick(SHIP_SETTLE_MS);
    expect(quiet.card()).toMatchObject({ status: "shipped" });
    expect(quiet.card()!.stages.at(-1)).toMatchObject({ kind: "verify", state: "skipped", detail: "Not verified in time" });

    // A failure wakes it once, with what failed and where.
    const f = await setup();
    const fInbox = () => f.h.app.db.all<{ kind: string; summary: string }>("SELECT kind, summary FROM inbox WHERE dork_id = ? AND kind = 'ship_failed'", f.id);
    await f.merge();
    f.gh.state.runs.push(f.run({ id: 1, name: "Deploy", status: "completed", conclusion: "failure" }));
    await f.tick();
    await f.tick();
    expect(fInbox()).toHaveLength(1);
    expect(fInbox()[0].summary).toContain("Deploy failed: https://github.com/octo/hello/actions/runs/1");
  });
});
