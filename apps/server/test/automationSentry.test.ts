import { describe, expect, it } from "vite-plus/test";
import { createAutomation, getAutomationView, listRuns } from "../src/services/automations";
import { sentryWatchOnce } from "../src/services/automationSentry";
import { updateSettings } from "../src/services/settings";
import { fakeFetch, harness } from "./harness";

// The Sentry watcher against a miniature Sentry: a baseline that replays nothing, new issues, a spike that fires once per storm, and a
// monitor that fails, recovers and fails again.

interface Issue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  permalink: string;
  level: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  issueCategory: string;
  status: string;
}

function sentry() {
  const state = { issues: [] as Issue[] };
  const fetch = fakeFetch((url) => {
    const p = url.pathname;
    if (url.host !== "us.sentry.io" && p === "/api/0/organizations/acme/") return Response.json({ slug: "acme", links: { regionUrl: "https://us.sentry.io" } });
    if (url.host !== "us.sentry.io") return new Response("{}", { status: 404 });
    if (p === "/api/0/projects/acme/web/") return Response.json({ id: "42", slug: "web" });
    if (p === "/api/0/organizations/acme/issues/") {
      const q = url.searchParams.get("query") ?? "";
      const monitors = q.includes("issue.category:[cron,uptime]");
      const list = state.issues.filter((i) => i.status === "unresolved" && (monitors ? ["uptime", "cron"].includes(i.issueCategory) : true));
      const sort = url.searchParams.get("sort");
      return Response.json(sort === "freq" ? list.toSorted((a, b) => Number(b.count) - Number(a.count)) : list.toSorted((a, b) => b.firstSeen.localeCompare(a.firstSeen)));
    }
    const latest = /^\/api\/0\/organizations\/acme\/issues\/(\w+)\/events\/latest\/$/.exec(p);
    if (latest)
      return Response.json({
        dateCreated: "2026-11-25T10:00:00Z",
        entries: [
          {
            type: "exception",
            data: {
              values: [
                {
                  type: "TypeError",
                  value: "x is undefined",
                  stacktrace: {
                    frames: [
                      { function: "main", filename: "src/app.ts", lineNo: 3, inApp: true },
                      { function: "load", filename: "src/load.ts", lineNo: 12, inApp: true },
                    ],
                  },
                },
              ],
            },
          },
          { type: "request", data: { method: "GET", url: "https://app.example.com/api/items" } },
        ],
      });
    return new Response("{}", { status: 404 });
  });
  return { state, fetch };
}

async function setup() {
  const s = sentry();
  const h = harness({ fetch: s.fetch, config: { boxProvider: "sim" } });
  await updateSettings(h.app, { claudeToken: "ct", githubConnected: true, sentryToken: "tok", sentryOrg: "acme" });
  let n = 0;
  const issue = (o: Partial<Issue> = {}) => {
    n++;
    const i: Issue = {
      id: String(n),
      shortId: `WEB-${n}`,
      title: `Error ${n}`,
      culprit: "load",
      permalink: `https://acme.sentry.io/issues/${n}/`,
      level: "error",
      count: "1",
      firstSeen: new Date(h.clock.t).toISOString(),
      lastSeen: new Date(h.clock.t).toISOString(),
      issueCategory: "error",
      status: "unresolved",
      ...o,
    };
    s.state.issues.push(i);
    return i;
  };
  const runs = (id: string) => listRuns(h.app, id).map((r) => `${r.source} ${r.summary}`);
  /** The sessions finished: an issue's run no longer holds off the next one. */
  const sleep = () => h.app.db.run("UPDATE dorks SET state = 'sleeping'");
  return { s, h, issue, runs, sleep };
}

describe("sentry automations", () => {
  it("the first read is a baseline; a new issue then starts one run with its latest event", async () => {
    const t = await setup();
    t.issue();
    const id = createAutomation(t.h.app, { name: "fix", instructions: "Fix it.", triggers: [{ kind: "sentry", event: "sentry_issue", project: "web", repo: "octo/app" }] });
    expect(getAutomationView(t.h.app, id).problems).toEqual([]);
    await sentryWatchOnce(t.h.app);
    expect(t.runs(id)).toEqual([]);

    t.h.clock.t += 60_000;
    const i = t.issue({ title: "TypeError: x is undefined" });
    t.issue({ issueCategory: "uptime" }); // a monitor's issue is not a new error
    await sentryWatchOnce(t.h.app);
    await sentryWatchOnce(t.h.app);
    expect(t.runs(id)).toEqual(["sentry_issue WEB-2 TypeError: x is undefined"]);
    const dork = t.h.app.db.get<{ id: string; repo: string }>("SELECT id, repo FROM dorks")!;
    expect(dork.repo).toBe("octo/app");
    const first = JSON.stringify(t.h.app.db.all("SELECT * FROM events WHERE dork_id = ?", dork.id));
    expect(first).toContain(i.permalink);
    expect(first).toContain("at load (src/load.ts:12)");
  });

  it("a spike fires once per storm, and again only after it has been quiet for an hour", async () => {
    const t = await setup();
    const i = t.issue({ count: "10" });
    const id = createAutomation(t.h.app, { name: "storm", instructions: "Look.", triggers: [{ kind: "sentry", event: "sentry_spike", project: "web", threshold: 100, repo: "octo/app" }] });
    await sentryWatchOnce(t.h.app);
    t.h.clock.t += 60_000;
    i.count = "150";
    await sentryWatchOnce(t.h.app);
    t.h.clock.t += 60_000;
    i.count = "400";
    await sentryWatchOnce(t.h.app);
    expect(t.runs(id)).toEqual(["sentry_spike WEB-1 Error 1 (150 events in an hour)"]);

    i.count = "10"; // quiet, but not for long enough
    t.h.clock.t += 30 * 60_000;
    await sentryWatchOnce(t.h.app);
    i.count = "200";
    t.h.clock.t += 60_000;
    await sentryWatchOnce(t.h.app);
    expect(t.runs(id)).toHaveLength(1);

    i.count = "10";
    t.h.clock.t += 61 * 60_000;
    await sentryWatchOnce(t.h.app);
    t.h.clock.t += 2 * 60 * 60_000; // past the per-issue cooldown too
    t.sleep();
    i.count = "300";
    await sentryWatchOnce(t.h.app);
    expect(t.runs(id)).toHaveLength(2);
  });

  it("a monitor that fails starts a run; recovering and failing again starts another", async () => {
    const t = await setup();
    const id = createAutomation(t.h.app, { name: "down", instructions: "Fix.", triggers: [{ kind: "sentry", event: "sentry_monitor", project: "web", repo: "octo/app" }] });
    await sentryWatchOnce(t.h.app);
    const m = t.issue({ issueCategory: "uptime", title: "Downtime detected for https://app.example.com" });
    await sentryWatchOnce(t.h.app);
    expect(t.runs(id)).toEqual(["sentry_monitor WEB-1 Downtime detected for https://app.example.com"]);

    m.status = "resolved";
    t.h.clock.t += 2 * 60 * 60_000;
    t.sleep();
    await sentryWatchOnce(t.h.app);
    m.status = "unresolved";
    m.lastSeen = new Date(t.h.clock.t).toISOString();
    await sentryWatchOnce(t.h.app);
    expect(t.runs(id)).toHaveLength(2);
  });

  it("says so when Sentry is not connected or the project cannot be read", async () => {
    const t = await setup();
    const id = createAutomation(t.h.app, { name: "x", instructions: "x", triggers: [{ kind: "sentry", event: "sentry_issue", project: "nope", repo: "octo/app" }] });
    await sentryWatchOnce(t.h.app);
    expect(getAutomationView(t.h.app, id).problems).toEqual([{ repo: "nope on Sentry", message: "Sentry has no project nope that your token can see." }]);
    await updateSettings(t.h.app, { sentryToken: "" });
    expect(getAutomationView(t.h.app, id).problems[0]?.repo).toBe("Sentry");
  });
});
