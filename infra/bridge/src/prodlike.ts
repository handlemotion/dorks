import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Prod-like testing on the box (dorks-cloud docs/prod-like-testing.md, "Load" and "Gate"): the A/B run behind the `prodlike_run`
// MCP tool and `dorks prodlike run`. It checks out the PR's base and head commits side by side (git worktrees), starts each one's
// service in turn on the same box, against the same database branch (DATABASE_URL from configure), replays the repository's load
// scripts against it, and measures every route itself. Each half reports to Sentry under its own environment (box-<id>-base,
// box-<id>-head). The Worker reads Sentry for both halves, compares, and posts the `Dorks / prod-like` check on the head commit.
//
// The repository says how, in .dorks/prodlike.json (reviewed in the PR like any code):
//
//   { "service": { "command": "node app.mjs serve", "port": 3010, "ready": "/health", "cwd": "." },
//     "setup": "npm ci",                      run once in each checkout (optional)
//     "seed": "node .dorks/seed.mjs",         run once, from head, before the first round (optional): data the branch lacks
//     "migrate": "npm run migrate",           run once, in head, before head's first round (optional)
//     "load": [".dorks/load/*.mjs"],          default: every .mjs in .dorks/load
//     "rounds": 3, "requests": 200, "concurrency": 4 }
//
// A load script exports either a list of requests, weighted ({path, method?, route?, weight?, headers?}), or a function that the runner
// calls again and again with a small HTTP client until the round's request count is reached. Only GET and HEAD are sent unless the
// team allows writes (Worker setting `writes`): the branch's data is scrubbed, but the app's side effects (mail, payments, webhooks) are
// real. `route` names the parameterized route ("/customers/:id") so the box's numbers line up with Sentry's transaction names.
//
// Base rounds all run before head's (head's migrations would break base otherwise); the p95 is compared round by round.

export type ServiceSpec = { command: string; port: number; ready?: string; cwd?: string };
export type Plan = { service: ServiceSpec; setup?: string; seed?: string; migrate?: string; load: string[]; rounds: number; requests: number; concurrency: number };
export type Req = { method: string; path: string; route?: string; weight?: number; headers?: Record<string, string>; body?: string };
export type LoadScript = { file: string; requests?: Req[]; fn?: (http: Http) => Promise<void> };
export type RouteStats = { requests: number; failures: number; p95Ms: number | null };
export type Http = {
  get: (path: string, opts?: { route?: string; headers?: Record<string, string> }) => Promise<{ status: number; body: string }>;
  head: (path: string, opts?: { route?: string; headers?: Record<string, string> }) => Promise<{ status: number; body: string }>;
  request: (method: string, path: string, opts?: { route?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string }>;
};

export class PlanError extends Error {}

const READ = new Set(["GET", "HEAD"]);
const PLAN_FILE = ".dorks/prodlike.json";

/** Reads and checks .dorks/prodlike.json in `dir`. */
export function readPlan(dir: string): Plan {
  const path = join(dir, PLAN_FILE);
  if (!existsSync(path))
    throw new PlanError(
      `No ${PLAN_FILE} in this repository. Write one (it is reviewed in the PR like any code), for example:\n` +
        `{ "service": { "command": "npm start", "port": 3000, "ready": "/health" }, "setup": "npm ci", "load": [".dorks/load/browse.mjs"], "rounds": 3 }\n` +
        `and a load script, .dorks/load/browse.mjs: export default [{ path: "/" }, { path: "/api/items", weight: 3 }, { path: "/api/items/1", route: "/api/items/:id" }];`,
    );
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new PlanError(`${PLAN_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  const s = raw.service as Record<string, unknown> | undefined;
  if (!s || typeof s.command !== "string" || !s.command.trim() || !Number.isInteger(s.port) || (s.port as number) < 1 || (s.port as number) > 65535)
    throw new PlanError(`${PLAN_FILE}: service must be {command, port, ready?, cwd?}`);
  const str = (k: string) => {
    const v = raw[k];
    if (v !== undefined && typeof v !== "string") throw new PlanError(`${PLAN_FILE}: ${k} must be a command (a string)`);
    return v as string | undefined;
  };
  const int = (k: string, def: number, min: number, max: number) => {
    const v = raw[k] ?? def;
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new PlanError(`${PLAN_FILE}: ${k} must be a whole number from ${min} to ${max}`);
    return v as number;
  };
  const load = raw.load === undefined ? [".dorks/load/*.mjs"] : raw.load;
  if (!Array.isArray(load) || !load.every((x) => typeof x === "string")) throw new PlanError(`${PLAN_FILE}: load must be a list of files`);
  return {
    service: { command: s.command, port: s.port as number, ready: typeof s.ready === "string" ? s.ready : undefined, cwd: typeof s.cwd === "string" ? s.cwd : undefined },
    setup: str("setup"),
    seed: str("seed"),
    migrate: str("migrate"),
    load,
    rounds: int("rounds", 3, 1, 10),
    requests: int("requests", 200, 10, 5000),
    concurrency: int("concurrency", 4, 1, 32),
  };
}

/** The files a plan's load list names, inside `dir` (a trailing *.mjs is a directory's .mjs files). */
export function loadFiles(dir: string, patterns: string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    const abs = resolve(dir, p.replace(/\/\*\.m?js$/, ""));
    if (relative(dir, abs).startsWith("..") || isAbsolute(relative(dir, abs))) throw new PlanError(`load file ${p} is outside the repository`);
    if (p.endsWith("*.mjs") || p.endsWith("*.js")) {
      if (!existsSync(abs)) continue;
      for (const f of readdirSync(abs).sort()) if (/\.m?js$/.test(f)) out.push(join(abs, f));
    } else if (existsSync(abs)) out.push(abs);
    else throw new PlanError(`load file ${p} does not exist`);
  }
  if (!out.length) throw new PlanError("No load scripts: add one under .dorks/load/ (see the `load` field of .dorks/prodlike.json)");
  return out;
}

/** Imports a load script: a list of requests or a function. Writes are refused here unless the team allows them. */
export async function importLoad(file: string, writes: boolean): Promise<LoadScript> {
  const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as { default?: unknown; requests?: unknown };
  const v = mod.default ?? mod.requests;
  if (typeof v === "function") return { file, fn: v as LoadScript["fn"] };
  if (!Array.isArray(v) || !v.length) throw new PlanError(`${file}: export default a list of requests ({path, method?, route?, weight?}) or a function (http) => …`);
  const requests = v.map((r: Record<string, unknown>, i) => {
    if (!r || typeof r.path !== "string" || !r.path.startsWith("/")) throw new PlanError(`${file}: request ${i + 1} needs a path starting with /`);
    const method = typeof r.method === "string" ? r.method.toUpperCase() : "GET";
    if (!READ.has(method) && !writes) throw new PlanError(`${file}: ${method} ${r.path} is a write, and this team's load is read-only (GET and HEAD). An owner can allow writes in Settings.`);
    return { method, path: r.path, route: typeof r.route === "string" ? r.route : undefined, weight: typeof r.weight === "number" && r.weight > 0 ? r.weight : 1, headers: r.headers as Record<string, string> | undefined, body: typeof r.body === "string" ? r.body : undefined };
  });
  return { file, requests };
}

export const p95 = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]! * 100) / 100;
};

/** The key a request is counted under: its method and route (or path without the query), as Sentry names transactions. */
export const routeKey = (method: string, path: string, route?: string) => `${method} ${route ?? path.split("?")[0]}`;

/**
 * One round against `origin`: `count` requests from the scripts (weighted lists picked in proportion, functions called in turn),
 * `concurrency` at a time. Returns per-route stats; a failure is a 5xx or a network error.
 */
export async function runLoad(origin: string, scripts: LoadScript[], o: { count: number; concurrency: number; writes: boolean; timeoutMs?: number }): Promise<Record<string, RouteStats>> {
  const times = new Map<string, number[]>();
  const fails = new Map<string, number>();
  let sent = 0;
  const send = async (method: string, path: string, opts: { route?: string; headers?: Record<string, string>; body?: string } = {}) => {
    method = method.toUpperCase();
    if (!READ.has(method) && !o.writes) throw new PlanError(`${method} ${path} is a write, and this team's load is read-only (GET and HEAD)`);
    if (!path.startsWith("/")) throw new PlanError(`path must start with / (${path})`);
    sent++;
    const key = routeKey(method, path, opts.route);
    const t0 = performance.now();
    let status = 0;
    let body = "";
    try {
      const res = await fetch(origin + path, { method, headers: opts.headers, body: opts.body, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
      body = await res.text();
      status = res.status;
    } catch {
      status = 0;
    }
    const ms = performance.now() - t0;
    if (!times.has(key)) times.set(key, []);
    times.get(key)!.push(ms);
    if (status === 0 || status >= 500) fails.set(key, (fails.get(key) ?? 0) + 1);
    return { status, body };
  };
  const http: Http = { get: (p, x) => send("GET", p, x), head: (p, x) => send("HEAD", p, x), request: (m, p, x) => send(m, p, x) };
  // The weighted pool of the list scripts, and the function scripts.
  const pool: Req[] = [];
  for (const s of scripts) for (const r of s.requests ?? []) for (let i = 0; i < Math.round((r.weight ?? 1) * 10); i++) pool.push(r);
  const fns = scripts.filter((s) => s.fn).map((s) => s.fn!);
  let turn = 0;
  const worker = async () => {
    while (sent < o.count) {
      const k = turn++;
      if (fns.length && (!pool.length || k % 2 === 1)) await fns[k % fns.length]!(http);
      else {
        const r = pool[(k * 7919) % pool.length]!;
        await send(r.method, r.path, r);
      }
    }
  };
  await Promise.all(Array.from({ length: o.concurrency }, worker));
  const out: Record<string, RouteStats> = {};
  for (const [k, xs] of times) out[k] = { requests: xs.length, failures: fails.get(k) ?? 0, p95Ms: p95(xs) };
  return out;
}

// ---- processes

function sh(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, log: (s: string) => void): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let tail = "";
    const keep = (d: Buffer) => (tail = (tail + d.toString()).slice(-4000));
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    const timer = setTimeout(() => killGroup(child), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) res();
      else (log(tail), rej(new PlanError(`\`${command}\` in ${cwd} failed (exit ${code}):\n${tail.trim().split("\n").slice(-15).join("\n")}`)));
    });
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  try {
    process.kill(-child.pid!, signal);
  } catch {}
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  killGroup(child);
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  if (child.exitCode === null) killGroup(child, "SIGKILL");
}

/** Starts the service and waits until its ready path answers below 500 (or its port answers at all). */
async function start(spec: ServiceSpec, dir: string, env: NodeJS.ProcessEnv, log: (s: string) => void): Promise<ChildProcess> {
  const child = spawn("sh", ["-c", spec.command], { cwd: resolve(dir, spec.cwd ?? "."), env: { ...env, PORT: String(spec.port) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let tail = "";
  const keep = (d: Buffer) => (tail = (tail + d.toString()).slice(-4000));
  child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);
  const url = `http://127.0.0.1:${spec.port}${spec.ready ?? "/"}`;
  for (const end = Date.now() + 120_000; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
    if (child.exitCode !== null) throw new PlanError(`the service exited (${child.exitCode}) before it was ready:\n${tail.trim().split("\n").slice(-15).join("\n")}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await res.arrayBuffer();
      if (res.status < 500) return child;
    } catch {}
  }
  log(tail);
  await stop(child);
  throw new PlanError(`the service did not answer ${url} within 120 s`);
}

async function git(dir: string, ...args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const c = spawn("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("exit", (code) => (code === 0 ? res(out.trim()) : rej(new PlanError(`git ${args.join(" ")}: ${err.trim() || `exit ${code}`}`))));
  });
}

/** The PR's base: the merge base of HEAD with the remote's default branch (or `baseRef`). */
export async function baseOf(dir: string, baseRef?: string): Promise<string> {
  if (!baseRef) {
    await git(dir, "fetch", "--quiet", "origin").catch(() => {});
    const head = await git(dir, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD").catch(() => "refs/remotes/origin/main");
    baseRef = head.replace(/^refs\/remotes\//, "");
  }
  return git(dir, "merge-base", "HEAD", baseRef);
}

// ---- the A/B run

export type Call = (op: "prodlike", args: Record<string, unknown>) => Promise<any>;
export type AbOptions = { dir: string; call: Call; baseRef?: string; rounds?: number; requests?: number; log?: (s: string) => void; env?: NodeJS.ProcessEnv; reportWaitMs?: number };
export type AbResult = { runId: string; verdict: string; title: string; summary: string; checkUrl: string | null; checkNote: string | null; dirty: boolean };

/** Spans one request is assumed to make, to size the load inside the box's span budget. */
const SPANS_PER_REQUEST = 10;
/** Idle time after a round before its service stops, so the Sentry SDK flushes (a SIGTERM can drop the last batch). */
const FLUSH_MS = 2_500;

export async function runAb(o: AbOptions): Promise<AbResult> {
  const log = o.log ?? (() => {});
  const env = o.env ?? process.env;
  const dir = await git(o.dir, "rev-parse", "--show-toplevel");
  const plan = readPlan(dir);
  const rounds = o.rounds ?? plan.rounds;
  const headSha = await git(dir, "rev-parse", "HEAD");
  const baseSha = await baseOf(dir, o.baseRef);
  if (baseSha === headSha) throw new PlanError("HEAD is its base: commit your change on a branch first (the run compares the PR's base with its head)");
  const dirty = (await git(dir, "status", "--porcelain", "--untracked-files=no")) !== "";
  const start_ = await o.call("prodlike", { action: "start", baseSha, headSha });
  const writes = start_.writes === true;
  let perRound = o.requests ?? plan.requests;
  if (start_.budget && start_.sampleRate > 0) {
    const fits = Math.floor((start_.budget.remaining * 0.8) / (2 * rounds * SPANS_PER_REQUEST * start_.sampleRate));
    if (fits < perRound) log(`span budget: ${start_.budget.remaining} of ${start_.budget.budget} left this hour, so ${Math.max(fits, 0)} requests a round instead of ${perRound}`);
    perRound = Math.min(perRound, fits);
    if (perRound < 10) throw new PlanError(`This box's span budget is nearly used (${start_.budget.spans} of ${start_.budget.budget} in the last hour); run again later`);
  }
  const root = join(tmpdir(), "dorks-prodlike", start_.runId);
  mkdirSync(root, { recursive: true });
  const trees = { base: join(root, "base"), head: join(root, "head") };
  try {
    await git(dir, "worktree", "add", "--detach", "--quiet", trees.base, baseSha);
    await git(dir, "worktree", "add", "--detach", "--quiet", trees.head, headSha);
    // The scripts come from head (this PR): its load and seed are what reviewers see. Base runs head's load too, so both get the same.
    const headPlan = readPlan(trees.head);
    const scripts = await Promise.all(loadFiles(trees.head, headPlan.load).map((f) => importLoad(f, writes)));
    const basePlan = existsSync(join(trees.base, PLAN_FILE)) ? readPlan(trees.base) : headPlan;
    for (const [which, p] of [["base", basePlan], ["head", headPlan]] as const) if (p.setup) (log(`${which}: ${p.setup}`), await sh(p.setup, trees[which], env, 10 * 60_000, log));
    if (headPlan.seed) (log(`seed: ${headPlan.seed}`), await sh(headPlan.seed, trees.head, env, 10 * 60_000, log));
    const results: Record<"base" | "head", Record<string, RouteStats>[]> = { base: [], head: [] };
    for (const which of ["base", "head"] as const) {
      const p = which === "base" ? basePlan : headPlan;
      if (which === "head" && headPlan.migrate) (log(`head: ${headPlan.migrate}`), await sh(headPlan.migrate, trees.head, env, 10 * 60_000, log));
      const halfEnv: NodeJS.ProcessEnv = { ...env, ...(start_.environments ? { SENTRY_ENVIRONMENT: start_.environments[which], SENTRY_DSN: start_.dsn, SENTRY_TRACES_SAMPLE_RATE: String(start_.sampleRate) } : {}) };
      for (let r = 0; r < rounds; r++) {
        const child = await start(p.service, trees[which], halfEnv, log);
        try {
          const origin = `http://127.0.0.1:${p.service.port}`;
          await runLoad(origin, scripts, { count: Math.min(10, perRound), concurrency: 1, writes }); // warm-up, not counted
          results[which].push(await runLoad(origin, scripts, { count: perRound, concurrency: plan.concurrency, writes }));
          log(`${which} round ${r + 1}/${rounds}: ${perRound} requests`);
          await new Promise((res) => setTimeout(res, FLUSH_MS)); // the SDK sends its last spans before the service stops
        } finally {
          await stop(child);
        }
      }
    }
    const report = (final: boolean) => o.call("prodlike", { action: "report", runId: start_.runId, base: { sha: baseSha, rounds: results.base }, head: { sha: headSha, rounds: results.head }, final });
    let r = await report(false);
    for (const end = Date.now() + (o.reportWaitMs ?? 180_000); r.state === "ingesting" && Date.now() < end; ) {
      log(`waiting for Sentry: ${JSON.stringify(r.seen)} of ${JSON.stringify(r.sent)} requests seen`);
      await new Promise((res) => setTimeout(res, 5_000));
      r = await report(false);
    }
    if (r.state === "ingesting") r = await report(true);
    return { runId: start_.runId, verdict: r.verdict, title: r.title, summary: r.summary, checkUrl: r.checkUrl ?? null, checkNote: r.checkNote ?? null, dirty };
  } finally {
    for (const t of [trees.base, trees.head]) await git(dir, "worktree", "remove", "--force", t).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

export function describeAb(r: AbResult): string {
  return [
    `Prod-like A/B run ${r.runId}: ${r.verdict.toUpperCase()}, ${r.title}`,
    r.checkUrl ? `Posted as the "Dorks / prod-like" check: ${r.checkUrl}` : `No check posted${r.checkNote ? `: ${r.checkNote}` : ""}`,
    r.dirty ? "Note: you have uncommitted changes. The run tested the committed HEAD, not them." : "",
    "",
    r.summary,
  ]
    .filter((l, i) => l !== "" || i === 3)
    .join("\n");
}

/** The telemetry_query result as text. */
export function describeTelemetry(r: any): string {
  if (!r) return "No result.";
  const head = `Sentry, environment ${r.environment}, last ${r.since}:`;
  if (r.kind === "usage") return `${head} ${r.spans} spans of this box's ${r.budget} per hour (${r.remaining} left); sample rate ${r.sampleRate}.`;
  if (r.kind === "errors")
    return r.errors.length ? [head, ...r.errors.map((e: any) => `- ${e.count}× ${e.title}${e.route ? ` (${e.route})` : ""}, issue ${e.issue}, last ${e.lastSeen}`)].join("\n") : `${head} no errors.`;
  if (r.kind === "spans")
    return r.spans.length ? [head, ...r.spans.map((s: any) => `- ${s.op} ${String(s.description ?? "").slice(0, 120)}: ${s.count}×, p95 ${s.p95Ms} ms, avg ${s.avgMs} ms`)].join("\n") : `${head} no spans.`;
  if (r.kind === "p95")
    return r.routes.length
      ? [head, ...r.routes.map((x: any) => `- ${x.route}: ${x.requests} requests, p95 ${x.p95Ms} ms, failure rate ${x.failureRate}, ${x.dbPerRequest ?? "?"} queries per request`)].join("\n")
      : `${head} no requests. Did the service start with SENTRY_DSN and SENTRY_ENVIRONMENT from its environment?`;
  return JSON.stringify(r);
}
