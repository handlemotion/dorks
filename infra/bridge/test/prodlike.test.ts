import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { describeAb, importLoad, loadFiles, p95, PlanError, readPlan, routeKey, runAb, runLoad } from "../src/prodlike";
import { tmp } from "./helpers";

const plan = (dir: string, p: unknown) => (mkdirSync(join(dir, ".dorks/load"), { recursive: true }), writeFileSync(join(dir, ".dorks/prodlike.json"), JSON.stringify(p)));

describe("prodlike plan and load scripts", () => {
  it("says what to write when .dorks/prodlike.json is missing, and checks its fields", () => {
    const dir = tmp();
    expect(() => readPlan(dir)).toThrow(/No \.dorks\/prodlike\.json.*"service"/s);
    plan(dir, { service: { command: "npm start" } });
    expect(() => readPlan(dir)).toThrow(/service must be/);
    plan(dir, { service: { command: "npm start", port: 3000 }, rounds: 99 });
    expect(() => readPlan(dir)).toThrow(/rounds must be/);
    plan(dir, { service: { command: "npm start", port: 3000, ready: "/health" } });
    expect(readPlan(dir)).toMatchObject({ service: { port: 3000, ready: "/health" }, rounds: 3, requests: 200, concurrency: 4, load: [".dorks/load/*.mjs"] });
  });

  it("finds the load scripts inside the repository only, and refuses writes unless the team allows them", async () => {
    const dir = tmp();
    plan(dir, { service: { command: "x", port: 1 } });
    expect(() => loadFiles(dir, [".dorks/load/*.mjs"])).toThrow(/No load scripts/);
    writeFileSync(join(dir, ".dorks/load/a.mjs"), 'export default [{ path: "/a", weight: 2 }, { path: "/b/1", route: "/b/:id" }];');
    writeFileSync(join(dir, ".dorks/load/w.mjs"), 'export default [{ method: "POST", path: "/notes" }];');
    expect(() => loadFiles(dir, ["../../etc/passwd"])).toThrow(/outside the repository/);
    const files = loadFiles(dir, [".dorks/load/*.mjs"]);
    expect(files.map((f) => f.split("/").pop())).toEqual(["a.mjs", "w.mjs"]);
    expect((await importLoad(files[0]!, false)).requests).toEqual([
      { method: "GET", path: "/a", route: undefined, weight: 2, headers: undefined, body: undefined },
      { method: "GET", path: "/b/1", route: "/b/:id", weight: 1, headers: undefined, body: undefined },
    ]);
    await expect(importLoad(files[1]!, false)).rejects.toThrow(/POST \/notes is a write.*read-only/);
    expect((await importLoad(files[1]!, true)).requests?.[0]?.method).toBe("POST");
  });

  it("runs a round: weighted requests and function scripts, per-route p95, 5xx counted as failures, writes refused", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(req.url === "/boom" ? 500 : 200).end("ok");
    }).listen(0);
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const stats = await runLoad(
        origin,
        [
          {
            file: "a",
            requests: [
              { method: "GET", path: "/a?x=1", weight: 3 },
              { method: "GET", path: "/boom" },
            ],
          },
          { file: "f", fn: async (http) => void (await http.get("/items/7", { route: "/items/:id" })) },
        ],
        { count: 60, concurrency: 3, writes: false },
      );
      expect(Object.keys(stats).sort()).toEqual(["GET /a", "GET /boom", "GET /items/:id"]);
      expect(Object.values(stats).reduce((a, s) => a + s.requests, 0)).toBeGreaterThanOrEqual(60);
      expect(stats["GET /boom"]!.failures).toBe(stats["GET /boom"]!.requests);
      expect(stats["GET /a"]!.failures).toBe(0);
      expect(stats["GET /a"]!.requests).toBeGreaterThan(stats["GET /boom"]!.requests);
      await expect(runLoad(origin, [{ file: "w", fn: async (http) => void (await http.request("DELETE", "/x")) }], { count: 1, concurrency: 1, writes: false })).rejects.toThrow(PlanError);
      expect(seen.some((s) => s.startsWith("DELETE"))).toBe(false);
    } finally {
      server.close();
    }
    expect(p95([5, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])).toBe(19);
    expect(routeKey("GET", "/c/1?q", "/c/:id")).toBe("GET /c/:id");
  });
});

describe("prodlike A/B run", () => {
  it("starts base then head on the same port, reports both halves to the server, waits out Sentry's ingestion, and cleans its worktrees", async () => {
    const dir = tmp();
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" }).toString().trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    const port = 20000 + Math.floor(Math.random() * 20000);
    plan(dir, { service: { command: "node server.mjs", port, ready: "/health" }, rounds: 2, requests: 20, concurrency: 2 });
    writeFileSync(join(dir, ".dorks/load/l.mjs"), 'export default [{ path: "/v" }];');
    const server = (v: string) =>
      `import { createServer } from "node:http"; createServer((q, s) => s.end(q.url === "/v" ? "${v}" + process.env.SENTRY_ENVIRONMENT : "ok")).listen(Number(process.env.PORT));`;
    writeFileSync(join(dir, "server.mjs"), server("base"));
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "feature");
    writeFileSync(join(dir, "server.mjs"), server("head"));
    git("commit", "-qam", "head");
    const head = git("rev-parse", "HEAD");
    const calls: any[] = [];
    let reports = 0;
    const r = await runAb({
      dir,
      baseRef: "main",
      reportWaitMs: 60_000,
      call: async (_op, a) => {
        calls.push(a);
        if (a.action === "start")
          return {
            runId: "run-1",
            environments: { base: "box-x-base", head: "box-x-head" },
            dsn: "https://k@o.ingest.sentry.io/1",
            sampleRate: 1,
            writes: false,
            budget: { spans: 0, budget: 20000, remaining: 20000 },
          };
        if (++reports === 1) return { state: "ingesting", seen: { base: 1, head: 0 }, sent: { base: 40, head: 40 } };
        return {
          runId: "run-1",
          state: "done",
          verdict: "success",
          title: "No regression on 1 route(s), 2 round(s)",
          summary: "| table |",
          checkUrl: "https://github.com/acme/api/runs/1",
          checkNote: null,
        };
      },
    });
    expect(calls[0]).toEqual({ action: "start", baseSha: base, headSha: head });
    const rep = calls.find((c) => c.action === "report");
    expect(rep.base.sha).toBe(base);
    expect(rep.head.rounds).toHaveLength(2);
    expect(rep.base.rounds[0]["GET /v"].requests).toBe(20);
    expect(calls.filter((c) => c.action === "report").map((c) => c.final)).toEqual([false, false]);
    expect(r.verdict).toBe("success");
    expect(describeAb(r)).toContain("https://github.com/acme/api/runs/1");
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
  }, 60_000);
});
