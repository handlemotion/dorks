// An in-memory stand-in for apps/server's UI listener, implementing the contract in docs/architecture.md: the REST routes, the
// `/api/live` SSE invalidation stream and a scripted fake agent. It lets the web app and the e2e run with no real server, and it
// is what this package's own tests talk to. Node-only, and it imports nothing at runtime so `node src/mock-cli.ts` works as is.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClientEvent, McpServerView, PullRequestView, SkillCandidate, SkillView } from "@dorks/shared";
import type { Dork, Settings, SnapshotStatus } from "./types.ts";
import { mockAutomations } from "./mock-automations.ts";

const SNAPSHOT_STEPS = [
  ["prepare", "Cleaning up earlier builds"],
  ["create", "Creating a build sandbox"],
  ["start", "Waiting for the sandbox to start"],
  ["upload", "Uploading the bridge and installer"],
  ["install", "Installing tools (about a minute)"],
  ["save", "Saving the snapshot"],
  ["finish", "Finishing up"],
] as const;

export interface MockOptions {
  port?: number;
  host?: string;
  /** Owner bearer token. */
  token?: string;
  /** Start with Boat, a snapshot, GitHub and agents already configured (skips onboarding). */
  configured?: boolean;
  /** Milliseconds between the fake agent's steps. */
  tick?: number;
}

type EventBody = Record<string, unknown> & { type: string };

interface MockDork extends Dork {
  events: ClientEvent[];
  deleting?: boolean;
}

export interface MockServer {
  url: string;
  token: string;
  close(): Promise<void>;
  /** Test hooks. */
  dorks: Map<string, MockDork>;
  settings: Settings;
  secrets: Map<string, string>;
  append(dorkId: string, body: EventBody): ClientEvent;
  /** Rewrites an event's fields in place (same seq), like a growing assistant message. */
  rewrite(dorkId: string, seq: number, patch: Record<string, unknown>): void;
  broadcast(message: Record<string, unknown>): void;
  /** The scripted "Prepare Boat" build. */
  snapshot: {
    status(): SnapshotStatus;
    /** The next build fails at its install step with this message (the previous snapshot stays in use). */
    failNextBuild(message: string): void;
    /** Pretend this app now carries a newer bridge: a built snapshot becomes stale. */
    newBridge(): void;
  };
  /** Number of open /api/live streams. */
  liveClients(): number;
  /** Drops every open /api/live stream (clients should reconnect and refetch). */
  dropLive(): void;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const STATUS: Record<string, number> = { invalid: 400, forbidden: 401, not_found: 404, conflict: 409, archived: 409, deleting: 409, limit: 429, not_configured: 412, onboarding_incomplete: 412 };
const fail = (res: ServerResponse, code: string, message: string) => json(res, STATUS[code] ?? 500, { error: { code, message } });

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** One request, after auth and body parsing. */
interface Ctx {
  url: URL;
  method: string;
  body: Record<string, unknown>;
  res: ServerResponse;
}

const view = (d: MockDork): Dork => {
  const { events: _events, deleting: _deleting, ...row } = d;
  return row;
};

const MOCK_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** What a Claude agent reports from the CLI's `initialize` answer. */
const MOCK_MODELS = [
  { model: "default", name: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", resolved: "claude-opus-5-5", efforts: [...MOCK_EFFORTS], fast: true },
  { model: "opus", name: "Opus 5.5", description: "Best for everyday, complex tasks", resolved: "claude-opus-5-5", efforts: [...MOCK_EFFORTS], fast: true },
  { model: "fable", name: "Fable 5.2", description: "Most capable for your hardest tasks", resolved: "claude-fable-5-2", efforts: [...MOCK_EFFORTS], fast: true },
  { model: "sonnet", name: "Sonnet 5.5", description: "Efficient for routine tasks", resolved: "claude-sonnet-5-5", efforts: [...MOCK_EFFORTS] },
  { model: "haiku", name: "Haiku 5.5", description: "Fastest for quick answers", resolved: "claude-haiku-5-5", efforts: [...MOCK_EFFORTS] },
  { model: "claude-opus-4-8", name: "Opus 4.8", description: "Best for everyday, complex tasks", resolved: "claude-opus-4-8", efforts: [...MOCK_EFFORTS], fast: true },
  { model: "claude-sonnet-4-6", name: "Sonnet 4.6", description: "Efficient for routine tasks", resolved: "claude-sonnet-4-6", efforts: [...MOCK_EFFORTS] },
];

export async function startMockServer(opts: MockOptions = {}): Promise<MockServer> {
  const token = opts.token ?? "mock-owner-token";
  const tick = opts.tick ?? 150;
  const dorks = new Map<string, MockDork>();
  /** Each session's pull requests, oldest first; the last is its headline (`prUrl`). */
  const prs = new Map<string, PullRequestView[]>();
  /** The session's PR by `url` (a query param or body field), else its latest. */
  const prOf = (dorkId: string, url: unknown) => {
    const list = prs.get(dorkId) ?? [];
    return typeof url === "string" && url ? list.find((p) => p.url === url) : list.at(-1);
  };
  const secrets = new Map<string, string>();
  const mcpServers = new Map<string, McpServerView>();
  const skills = new Map<string, SkillView>();
  /** A loose stand-in for services/skills.ts: `owner/repo` from the pasted text, and a few made-up skills in it. */
  const mockResolve = (source: string) => {
    const m = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/@#\s]|$)/.exec(source.replace(/https?:\/\/github\.com\//, ""));
    if (!m) return null;
    const repo = `${m[1]}/${m[2]}`;
    const names = m[2] === "skills" || m[2]!.endsWith("-skills") ? ["frontend-design", "pdf", "webapp-testing", "skill-creator"] : [m[2]!.toLowerCase().replace(/[^a-z0-9]+/g, "-")];
    const found: SkillCandidate[] = names.map((name) => ({
      name,
      description: `Mock skill ${name} from ${repo}.`,
      path: names.length > 1 ? `skills/${name}` : "",
      fileCount: 3,
      bytes: 4096,
      installed: skills.has(name),
    }));
    const requested = names.filter((n) => source.includes(n) && n !== m[2]);
    return { repo, ref: null, sha: "0123456789abcdef0123456789abcdef01234567", skills: found, requested: requested.length || names.length > 1 ? requested : names };
  };
  // Composio: a sign-in "finishes" when its link is requested, so the UI's wait ends on the next read.
  const composioApps = new Set<string>();
  let localAccessEnabled = true;
  const live = new Set<ServerResponse>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const settings: Settings = {
    claudeToken: !!opts.configured,
    boatKey: !!opts.configured,
    github: opts.configured ? { configured: true, login: "octocat" } : { configured: false },
    boatOrg: null,
    boatEnvironment: opts.configured ? "dorks-codex" : null,
    baseSnapshotId: opts.configured ? "dorks-base-20260101" : null,
    sleepMinutes: 10,
    commentPolicy: { mode: "all" },
    publicUrlConfigured: true,
    claudeModels: MOCK_MODELS,
  };

  const broadcast = (m: Record<string, unknown>) => {
    for (const r of live) r.write(`data: ${JSON.stringify(m)}\n\n`);
  };

  // The scripted "Prepare Boat" build: the same states, steps and messages as apps/server (docs/architecture.md, "Base snapshot").
  let bundle = 1;
  let failBuild: string | null = null;
  const snap: SnapshotStatus = {
    state: opts.configured ? "ready" : "none",
    snapshot: opts.configured ? "dorks-base-20260101" : null,
    managed: !!opts.configured,
    stale: false,
    step: null,
    stepIndex: -1,
    stepCount: SNAPSHOT_STEPS.length,
    message: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    builtBundleId: opts.configured ? "mock-bundle-1" : null,
    currentBundleId: "mock-bundle-1",
    canBuild: true,
    cannotBuildReason: null,
  };
  const snapView = (): SnapshotStatus => {
    snap.canBuild = settings.boatKey;
    snap.cannotBuildReason = settings.boatKey ? null : "Add your Boat API key first.";
    snap.managed = !!snap.snapshot && settings.baseSnapshotId === snap.snapshot;
    snap.stale = snap.managed && snap.builtBundleId !== snap.currentBundleId;
    return { ...snap };
  };
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const append = (dorkId: string, body: EventBody): ClientEvent => {
    const d = dorks.get(dorkId);
    if (!d) throw new Error(`no dork ${dorkId}`);
    const e = { ...body, seq: d.events.length + 1, dorkId, ts: Date.now() } as unknown as ClientEvent;
    d.events.push(e);
    d.lastActivityAt = e.ts;
    if (e.type === "status") {
      d.state = (body as unknown as { state: Dork["state"] }).state;
      broadcast({ t: "dork", dorkId });
      broadcast({ t: "dorks" });
    }
    broadcast({ t: "events", dorkId, seq: e.seq });
    return e;
  };
  const rewrite = (dorkId: string, seq: number, patch: Record<string, unknown>) => {
    const d = dorks.get(dorkId);
    const e = d?.events[seq - 1];
    if (!d || !e) return;
    Object.assign(e, patch);
    broadcast({ t: "events", dorkId, seq });
  };

  /** The fake agent: a turn of tool calls and a streamed answer, ending idle. */
  const runTurn = (dorkId: string, prompt: string) => {
    const d = dorks.get(dorkId);
    if (!d) return;
    const alive = () => dorks.get(dorkId)?.state === "working";
    const tool = `tool-${randomUUID().slice(0, 8)}`;
    const msg = `msg-${randomUUID().slice(0, 8)}`;
    const answer = `Done: ${prompt.slice(0, 60)}. I read the code, made the change and the tests pass.`;
    const progress = `progress-${randomUUID().slice(0, 8)}`;
    later(tick, () => {
      if (!alive()) return;
      append(dorkId, { type: "assistant_message", messageId: progress, text: "Running the tests first." });
      append(dorkId, { type: "tool_use", toolId: tool, name: "Bash", summary: "pnpm test", input: { command: "pnpm test" } });
    });
    later(tick * 2, () => {
      if (!alive()) return;
      append(dorkId, { type: "tool_result", toolId: tool, ok: true, preview: "Test Files  3 passed (3)" });
      const edit = `${tool}-edit`;
      const file = "src/index.ts";
      append(dorkId, {
        type: "tool_use",
        toolId: edit,
        name: "Edit",
        summary: file,
        input: { file_path: file, old_string: "export const ready = false\n", new_string: "export const ready = true\n" },
      });
      append(dorkId, { type: "tool_result", toolId: edit, ok: true, preview: `The file ${file} has been updated.` });
    });
    let streamSeq = 0;
    later(tick * 3, () => {
      if (!alive()) return;
      streamSeq = append(dorkId, { type: "assistant_delta", messageId: msg, text: answer.slice(0, 20) }).seq;
    });
    later(tick * 4, () => alive() && streamSeq && rewrite(dorkId, streamSeq, { text: answer.slice(0, 45) })); // grows in place, same seq
    later(tick * 5, () => {
      if (!alive()) return;
      append(dorkId, { type: "assistant_message", messageId: msg, text: answer });
      if (/\bpr\b/i.test(prompt)) {
        // Every "pr" turn opens another one; "stack" stacks it on the previous PR's branch, as with GitHub stacked PRs.
        const list = prs.get(dorkId) ?? [];
        const number = 7 + list.length;
        const pr = mockPullRequest(d.repo, number, list.length ? prompt.slice(0, 60) : d.title);
        const parent = list.at(-1);
        if (parent && /\bstack/i.test(prompt)) pr.baseRef = parent.headRef;
        prs.set(dorkId, [...list, pr]);
        append(dorkId, { type: "pr_opened", url: pr.url, number });
        d.prUrl = pr.url;
        d.prState = "open";
        broadcast({ t: "dork", dorkId });
        broadcast({ t: "dorks" });
        broadcast({ t: "subscriptions", dorkId });
      }
      append(dorkId, { type: "turn_complete", durationMs: tick * 5, outcome: "done", finalMessageId: msg });
      append(dorkId, { type: "status", state: "idle" });
      crewTurnEnded(d, answer);
    });
  };

  /**
   * Crews (docs/crew.md), scripted: a coordinator's first turn delegates to two workers; a worker's turn end reaches its coordinator
   * as a crew report, the way the server folds them.
   */
  const crewTurnEnded = (d: MockDork, answer: string) => {
    if (d.kind === "coordinator" && ![...dorks.values()].some((w) => w.parentId === d.id)) {
      const repo = "acme/demo";
      for (const task of ["Add the invoices table and its migration, then open a pr", "Wire the billing API to the invoices table, then open a pr"]) {
        const id = addDork({ repo, message: task, provider: "claude" }, d);
        later(tick, () => startTurn(id, task, { id: d.id, title: d.title }));
      }
      return;
    }
    const parent = d.parentId ? dorks.get(d.parentId) : undefined;
    if (!parent || parent.archived) return;
    append(parent.id, {
      type: "crew",
      direction: "in",
      peer: { id: d.id, title: d.title },
      kind: "report",
      text: `Its turn ended: done.${d.prUrl ? ` PR: ${d.prUrl}` : ""}\nFinal answer:\n${answer}`,
    });
    touched(parent);
  };

  const startTurn = (dorkId: string, text: string, from?: { id: string; title: string }) => {
    append(dorkId, { type: "user_message", text, ...(from ? { from } : {}) });
    append(dorkId, { type: "status", state: "working" });
    runTurn(dorkId, text);
  };

  /** Starts the scripted build (the caller has checked that one may start). */
  const startBuild = () => {
    const fresh = SNAPSHOT_STEPS.length;
    Object.assign(snap, { state: "building", error: null, startedAt: Date.now(), finishedAt: null });
    const stepTo = (i: number) => {
      Object.assign(snap, { step: SNAPSHOT_STEPS[i]![0], stepIndex: i, message: SNAPSHOT_STEPS[i]![1] });
      broadcast({ t: "snapshot" });
    };
    stepTo(0);
    for (let i = 1; i < fresh; i++) {
      later(tick * i, () => {
        if (snap.state !== "building") return;
        if (failBuild && i === 4) {
          Object.assign(snap, { state: "failed", step: null, stepIndex: -1, message: null, error: failBuild, finishedAt: Date.now() });
          failBuild = null;
          return broadcast({ t: "snapshot" });
        }
        stepTo(i);
      });
    }
    later(tick * fresh, () => {
      if (snap.state !== "building") return;
      const name = "dorks-base-mock0001";
      Object.assign(snap, { state: "ready", snapshot: name, step: null, stepIndex: -1, message: null, error: null, finishedAt: Date.now(), builtBundleId: `mock-bundle-${bundle}` });
      settings.baseSnapshotId = name;
      broadcast({ t: "settings" });
      broadcast({ t: "snapshot" });
    });
  };

  const openLive = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ t: "hello", now: Date.now() })}\n\n`);
    live.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(ping);
      live.delete(res);
    });
  };

  /** Why a new session cannot start yet, or null when it can. */
  const cannotCreate = (provider: Dork["provider"]): string | null => {
    if (!settings.boatKey || !settings.baseSnapshotId || !settings.github.configured) return "Finish setup (Boat, base snapshot, GitHub) before creating a session.";
    if (provider === "claude" && !settings.claudeToken) return "Add a Claude token first.";
    if (provider === "codex" && !settings.boatEnvironment) return "Save a Boat environment for Codex first.";
    return null;
  };

  const createDork = ({ body, res }: Ctx) => {
    const coordinator = body.kind === "coordinator";
    const repo = str(body.repo)?.trim() ?? "";
    const message = str(body.message)?.trim();
    if (!(coordinator && !repo) && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(res, "invalid", "repo must look like owner/name");
    if (!message) return fail(res, "invalid", "message is required");
    const provider = body.provider === "codex" ? "codex" : "claude";
    const blocked = cannotCreate(provider);
    if (blocked) return fail(res, "onboarding_incomplete", blocked);
    const id = addDork({ ...body, repo, message, provider });
    later(tick, () => startTurn(id, message));
    return json(res, 200, { id });
  };

  const automations = mockAutomations({
    broadcast: (m) => broadcast(m),
    startSession: (repo, message, title) => {
      const blocked = cannotCreate("claude");
      if (blocked) return { error: blocked };
      const id = addDork({ repo, message, title, provider: "claude" });
      later(tick, () => startTurn(id, message));
      return { id, title };
    },
  });

  /** A new session row (a worker when `parent` is set) and its first status. The caller starts its turn. */
  const addDork = (body: Record<string, unknown> & { repo: string; message: string; provider: Dork["provider"] }, parent?: MockDork): string => {
    const { repo, message, provider } = body;
    const id = randomUUID();
    const now = Date.now();
    dorks.set(id, {
      id,
      title: str(body.title) || message.slice(0, 48),
      kind: body.kind === "coordinator" ? "coordinator" : "agent",
      parentId: parent?.id ?? null,
      ...(str(body.icon) ? { icon: str(body.icon) } : {}),
      repo,
      branch: `dorks/${id.slice(0, 8)}`,
      provider,
      state: "creating",
      archived: false,
      lastActivityAt: now,
      createdAt: now,
      events: [],
      ...(provider === "claude"
        ? {
            model: str(body.model),
            effort: str(body.effort),
            fast: body.fast === true,
            agentModel: MOCK_MODELS.find((c) => c.model === (str(body.model) ?? "default"))?.resolved,
            modelChoices: MOCK_MODELS,
          }
        : {}),
    });
    append(id, { type: "status", state: "creating" });
    broadcast({ t: "dorks" });
    return id;
  };

  /** A change to one session that the list and its page both show. */
  const touched = (d: MockDork) => {
    broadcast({ t: "dork", dorkId: d.id });
    broadcast({ t: "dorks" });
  };

  const listEvents = ({ url, res }: Ctx, d: MockDork) => {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const after = url.searchParams.get("after");
    if (after !== null) {
      const rest = d.events.filter((e) => e.seq > Number(after));
      return json(res, 200, { events: rest.slice(0, limit), hasMore: rest.length > limit });
    }
    const beforeParam = url.searchParams.get("before");
    const older = beforeParam === null ? d.events : d.events.filter((e) => e.seq < Number(beforeParam));
    const page = older.slice(-limit).reverse(); // newest first
    return json(res, 200, { events: page, hasMore: older.length > limit });
  };

  const setModel = ({ body, res }: Ctx, d: MockDork) => {
    const model = str(body.model) || undefined;
    const effort = str(body.effort) || undefined;
    const fast = body.fast === true;
    const choice = MOCK_MODELS.find((c) => c.model === (model ?? "default"));
    if ((model || effort || fast) && (!choice || (effort && !choice.efforts.includes(effort as never)) || (fast && !choice.fast))) return fail(res, "invalid", "not offered by the agent");
    Object.assign(d, { model, effort, fast, agentModel: choice?.resolved ?? "claude-opus-5-5", agentEffort: effort });
    broadcast({ t: "dork", dorkId: d.id });
    return json(res, 200, {});
  };

  /** `/api/dorks/:id[/sub]`, keyed by `METHOD sub` (`*` for any method). */
  const dorkRoutes = new Map<string, (c: Ctx, d: MockDork) => void>([
    ["GET ", ({ res }, d) => json(res, 200, view(d))],
    [
      "PATCH ",
      ({ body, res }, d) => {
        const title = str(body.title)?.trim();
        if (!title) return fail(res, "invalid", "title is required");
        d.title = title;
        touched(d);
        return json(res, 200, {});
      },
    ],
    [
      "DELETE ",
      ({ res }, d) => {
        d.deleting = true;
        broadcast({ t: "dorks" });
        return json(res, 200, {});
      },
    ],
    [
      "POST messages",
      ({ body, res }, d) => {
        const text = str(body.text)?.trim();
        if (!text) return fail(res, "invalid", "text is required");
        if (d.archived) return fail(res, "archived", "This session is archived.");
        startTurn(d.id, text);
        return json(res, 200, {});
      },
    ],
    [
      "POST interrupt",
      ({ res }, d) => {
        if (d.state === "working") {
          append(d.id, { type: "turn_complete", durationMs: 0, outcome: "stopped" });
          append(d.id, { type: "status", state: "idle" });
        }
        return json(res, 200, {});
      },
    ],
    [
      "POST desktop",
      ({ body, res }, d) => {
        if (d.archived) return fail(res, "archived", "This session is archived.");
        const dark = body.theme === "dark";
        const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:${dark ? "#1d1f24" : "#3a6ea5"};color:#fff;font:15px system-ui">Mock desktop</body>`;
        return json(res, 200, { url: `data:text/html;charset=utf-8,${encodeURIComponent(page)}` });
      },
    ],
    [
      "POST archive",
      ({ body, res }, d) => {
        d.archived = body.archived === true;
        touched(d);
        return json(res, 200, {});
      },
    ],
    ["POST model", setModel],
    [
      "POST codex-model",
      ({ body, res }, d) => {
        d.codexModel = { model: str(body.model) ?? "", effort: str(body.effort) ?? "" };
        broadcast({ t: "dork", dorkId: d.id });
        return json(res, 200, {});
      },
    ],
    ["GET events", listEvents],
    [
      "GET pr",
      ({ url, res }, d) => {
        const pr = prOf(d.id, url.searchParams.get("url"));
        return pr ? json(res, 200, pr) : fail(res, "not_found", "This session has no pull request yet.");
      },
    ],
    [
      "POST pr/merge",
      ({ body, res }, d) => {
        const pr = prOf(d.id, body.url);
        if (!pr) return fail(res, "not_found", "This session has no pull request yet.");
        if (pr.state !== "open") return fail(res, "conflict", "Pull Request is not mergeable");
        if (pr.mergeableState === "dirty") return fail(res, "conflict", "Pull Request is not mergeable");
        Object.assign(pr, { state: "merged", mergedAt: Date.now(), mergedBy: pr.author, mergeableState: "unknown" });
        append(d.id, { type: "pr_merged", url: pr.url, number: pr.number });
        broadcast({ t: "subscriptions", dorkId: d.id });
        if (pr.url === d.prUrl) d.prState = "merged";
        // GitHub retargets PRs stacked on the merged branch to its base.
        for (const child of prs.get(d.id) ?? []) if (child.state === "open" && child.baseRef === pr.headRef) child.baseRef = pr.baseRef;
        broadcast({ t: "dork", dorkId: d.id });
        broadcast({ t: "dorks" });
        return json(res, 200, { merged: true, sha: "f".repeat(40), method: body.method });
      },
    ],
    [
      "POST pr/update-branch",
      ({ body, res }, d) => {
        const pr = prOf(d.id, body.url);
        if (!pr) return fail(res, "not_found", "This session has no pull request yet.");
        if (pr.mergeableState === "behind") pr.mergeableState = "clean";
        broadcast({ t: "subscriptions", dorkId: d.id });
        return json(res, 200, {});
      },
    ],
    [
      "* subscriptions",
      ({ method, res }, d) =>
        json(
          res,
          200,
          method === "GET"
            ? (prs.get(d.id) ?? []).map((p) => ({
                repo: p.repo,
                number: p.number,
                url: p.url,
                title: p.title,
                headRef: p.headRef,
                baseRef: p.baseRef,
                headSha: p.headSha,
                source: "auto",
                status: p.state === "open" ? "active" : "ended",
                ci: "passing",
                review: "approved",
                mergeable: true,
                ciFixAttempts: 0,
                state: p.state,
              }))
            : {},
        ),
    ],
    ["* subscriptions/resume", ({ res }) => json(res, 200, {})],
  ]);

  const routeDork = (c: Ctx, m: RegExpExecArray) => {
    const d = dorks.get(decodeURIComponent(m[1]!));
    if (!d || d.deleting) return fail(c.res, "not_found", "No such session.");
    const sub = m[2] ?? "";
    const handle = dorkRoutes.get(`${c.method} ${sub}`) ?? dorkRoutes.get(`* ${sub}`);
    if (!handle) return fail(c.res, "not_found", "Unknown route.");
    return handle(c, d);
  };

  /** Applies a settings PUT; returns an error message when the body is rejected. */
  const saveSettings = (body: Record<string, unknown>): string | null => {
    // Like apps/server, which checks a Boat key with Boat before saving it.
    if (typeof body.boatKey === "string" && body.boatKey.startsWith("bad")) return "Boat rejected that key. Check it and its access (create, use, save and delete sandboxes).";
    const set = (k: "boatKey" | "claudeToken") => {
      if (typeof body[k] === "string") settings[k] = body[k] !== "";
    };
    set("boatKey");
    set("claudeToken");
    if (typeof body.githubConnected === "boolean") settings.github = body.githubConnected ? { configured: true, login: "octocat" } : { configured: false, login: null };
    for (const k of ["boatOrg", "boatEnvironment", "baseSnapshotId"] as const) if (typeof body[k] === "string") settings[k] = body[k] || null;
    if (typeof body.sleepMinutes === "number") {
      if (!Number.isFinite(body.sleepMinutes) || body.sleepMinutes <= 0 || body.sleepMinutes > 1440) return "minutes must be between 0 and 1440";
      settings.sleepMinutes = body.sleepMinutes;
    }
    if (body.commentPolicy) settings.commentPolicy = body.commentPolicy as Settings["commentPolicy"];
    return null;
  };

  /** Fixed paths, keyed by `METHOD path`. */
  const routes = new Map<string, (c: Ctx) => void>([
    [
      "GET /api/dorks",
      ({ url, res }) => {
        const archived = url.searchParams.get("archived") === "true";
        const rows = [...dorks.values()].filter((d) => !d.deleting && d.archived === archived).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        return json(res, 200, rows.slice(0, 200).map(view));
      },
    ],
    ["POST /api/dorks", createDork],
    ["GET /api/settings", ({ res }) => json(res, 200, settings)],
    [
      "PUT /api/settings",
      ({ body, res }) => {
        const error = saveSettings(body);
        if (error) return fail(res, "invalid", error);
        broadcast({ t: "settings" });
        // Like apps/server: a new Boat key starts the base-snapshot build when there is no snapshot yet.
        if (typeof body.boatKey === "string" && body.boatKey && !settings.baseSnapshotId && snap.state !== "building") startBuild();
        return json(res, 200, {});
      },
    ],
    [
      "POST /api/boat/check",
      ({ body, res }) => {
        const key = typeof body.boatKey === "string" ? body.boatKey.trim() : "";
        if (!key && !settings.boatKey) return fail(res, "not_configured", "Add your Boat API key first.");
        if (key.startsWith("bad")) return json(res, 200, { status: "invalid", message: "Boat rejected that key. Check it and its access (create, use, save and delete sandboxes)." });
        return json(res, 200, { status: "ok", message: "Boat accepted the key." });
      },
    ],
    [
      "GET /api/github/repos",
      ({ res }) =>
        json(
          res,
          200,
          settings.github.configured
            ? {
                login: "octocat",
                orgs: ["acme", "handlemotion"],
                repos: ["acme/demo", "handlemotion/dorks", "handlemotion/transitive", "octocat/hello-world", "acme/api", "handlemotion/site", "octocat/dotfiles", "acme/design-system"],
                auth: { state: "ok", source: "gh", missingScopes: [] },
              }
            : { login: null, orgs: [], repos: [], auth: { state: "not_connected", source: null, missingScopes: [] } },
        ),
    ],
    [
      "GET /api/usage",
      ({ res }) => {
        const now = Date.now();
        return json(res, 200, {
          ...(settings.claudeToken ? { claude: { session: { used: 0.07, resetsAt: now + 3 * 3600_000 }, weekly: { used: 0.26, resetsAt: now + 4 * 86400_000 } } } : {}),
          ...(settings.boatKey ? { cloud: { usedHours: 38.4, includedHours: 555.56, periodEnd: now + 29 * 86400_000 } } : {}),
        });
      },
    ],
    ["GET /api/snapshot", ({ res }) => json(res, 200, snapView())],
    [
      "POST /api/snapshot/build",
      ({ body, res }) => {
        if (body.force !== undefined && typeof body.force !== "boolean") return fail(res, "invalid", "force must be a boolean");
        if (!settings.boatKey) return fail(res, "not_configured", "Add your Boat API key first.");
        const current = snapView();
        if (snap.state === "building" || (!body.force && snap.state !== "failed" && snap.snapshot && current.managed && !current.stale)) return json(res, 202, current);
        startBuild();
        return json(res, 202, snapView());
      },
    ],
    ["GET /api/secrets", ({ res }) => json(res, 200, [...secrets.keys()].sort())],
    [
      "GET /api/skills",
      ({ res }) =>
        json(
          res,
          200,
          [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
        ),
    ],
    [
      "POST /api/skills/resolve",
      ({ body, res }) => {
        const r = typeof body.source === "string" ? mockResolve(body.source) : null;
        return r ? json(res, 200, r) : fail(res, "invalid", "Paste a GitHub repository, like owner/repo, or an npx skills add command.");
      },
    ],
    [
      "POST /api/skills",
      ({ body, res }) => {
        const r = typeof body.source === "string" ? mockResolve(body.source) : null;
        if (!r) return fail(res, "invalid", "Paste a GitHub repository, like owner/repo, or an npx skills add command.");
        const want = Array.isArray(body.skills) ? (body.skills as string[]) : [];
        const pick = r.skills.filter((s) => want.includes(s.name) || (!want.length && r.skills.length === 1));
        if (!pick.length) return fail(res, "invalid", "Choose the skills to install.");
        for (const s of pick)
          skills.set(s.name, {
            name: s.name,
            description: s.description,
            source: { repo: r.repo, ref: null, path: s.path },
            sha: r.sha,
            url: `https://github.com/${r.repo}/tree/${r.sha}/${s.path}`,
            fileCount: s.fileCount,
            bytes: s.bytes,
            installedAt: skills.get(s.name)?.installedAt ?? Date.now(),
            updatedAt: Date.now(),
          });
        broadcast({ t: "settings" });
        return json(res, 200, { installed: pick.map((s) => s.name) });
      },
    ],
    // Local access (docs/local-access.md): the switch only; the mock's agents never ask to use the computer.
    ["GET /api/local-access", ({ res }) => json(res, 200, { enabled: localAccessEnabled, grants: [] })],
    [
      "PUT /api/local-access",
      ({ body, res }) => {
        if (typeof body.enabled !== "boolean") return fail(res, "invalid", "enabled must be a boolean");
        localAccessEnabled = body.enabled;
        broadcast({ t: "settings" });
        return json(res, 200, {});
      },
    ],
    [
      "GET /api/mcp-servers",
      ({ res }) =>
        json(
          res,
          200,
          [...mcpServers.values()].sort((a, b) => a.name.localeCompare(b.name)),
        ),
    ],
    ["GET /api/composio", ({ res }) => json(res, 200, { connected: mcpServers.has("composio"), toolkits: [...composioApps].sort() })],
    [
      "PUT /api/composio",
      ({ body, res }) => {
        if (!str(body.apiKey)) return fail(res, "invalid", "enter a Composio API key");
        const createdAt = Date.now();
        mcpServers.set("composio", {
          name: "composio",
          transport: "http",
          url: "https://app.composio.dev/tool_router/v3/trs_mock/mcp",
          command: null,
          args: [],
          headerNames: ["x-api-key"],
          envNames: [],
          oauth: null,
          createdAt,
        });
        broadcast({ t: "settings" });
        return json(res, 200, {});
      },
    ],
    [
      "DELETE /api/composio",
      ({ res }) => {
        mcpServers.delete("composio");
        composioApps.clear();
        broadcast({ t: "settings" });
        return json(res, 200, {});
      },
    ],
    // Builds are not mocked: the list is empty, so the UI shows its empty state (use `pnpm dev` for the real flow).
    ["GET /api/builds", ({ res }) => json(res, 200, [])],
  ]);

  const routeSecret = ({ method, body, res }: Ctx, name: string) => {
    if (method === "PUT") {
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) return fail(res, "invalid", "Names are CAPS_WITH_UNDERSCORES.");
      secrets.set(name, str(body.value) ?? "");
      broadcast({ t: "settings" });
      return json(res, 200, {});
    }
    if (method === "DELETE") {
      secrets.delete(name);
      broadcast({ t: "settings" });
      return json(res, 200, {});
    }
    return fail(res, "not_found", "Unknown route.");
  };

  /** A remote server saved without headers stands in for one that asks for an OAuth sign-in. */
  const mockOAuth = (name: string, http: boolean, headers: string[]) => (http && !headers.length ? (mcpServers.get(name)?.oauth ?? "signed_out") : null);

  // A loose stand-in for services/mcpServers.ts: no values are kept, only the names the views show.
  const routeMcp = ({ method, body, res }: Ctx, name: string) => {
    if (method === "PUT") {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || name === "dorks" || name === "computer") return fail(res, "invalid", "Pick another name.");
      const http = body.transport === "http";
      if (http ? !str(body.url) : !str(body.command)) return fail(res, "invalid", http ? "URL is required" : "command is required");
      const keys = (v: unknown) => (v && typeof v === "object" ? Object.keys(v).sort() : []);
      mcpServers.set(name, {
        name,
        transport: http ? "http" : "stdio",
        url: http ? (str(body.url) ?? null) : null,
        command: http ? null : (str(body.command) ?? null),
        args: !http && Array.isArray(body.args) ? body.args.map(String) : [],
        headerNames: http ? keys(body.headers) : [],
        envNames: http ? [] : keys(body.env),
        oauth: mockOAuth(name, http, keys(body.headers)),
        createdAt: mcpServers.get(name)?.createdAt ?? Date.now(),
      });
      broadcast({ t: "settings" });
      return json(res, 200, { oauth: mcpServers.get(name)!.oauth });
    }
    if (method === "DELETE") {
      mcpServers.delete(name);
      broadcast({ t: "settings" });
      return json(res, 200, {});
    }
    return fail(res, "not_found", "Unknown route.");
  };

  // Sign-in "finishes" as soon as its page is requested, like Composio's above.
  /** Customize's per-name routes: MCP servers, their OAuth, and skills. */
  const routeCustomize = (c: Ctx, path: string) => {
    const mo = /^\/api\/mcp-servers\/([^/]+)\/oauth$/.exec(path);
    if (mo) return routeMcpOAuth(c, decodeURIComponent(mo[1]!));
    const sk = /^\/api\/skills\/([^/]+)(\/update)?$/.exec(path);
    if (sk) return routeSkill(c, decodeURIComponent(sk[1]!), !!sk[2]);
    const mm = /^\/api\/mcp-servers\/([^/]+)$/.exec(path);
    if (mm) return routeMcp(c, decodeURIComponent(mm[1]!));
    return fail(c.res, "not_found", "Unknown route.");
  };

  const routeSkill = ({ method, res }: Ctx, name: string, update: boolean) => {
    if (!skills.has(name)) return fail(res, "not_found", "no such skill");
    if (update && method === "POST") return json(res, 200, { updated: false });
    if (update || method !== "DELETE") return fail(res, "not_found", "Unknown route.");
    skills.delete(name);
    broadcast({ t: "settings" });
    return json(res, 200, {});
  };

  const routeMcpOAuth = ({ method, res }: Ctx, name: string) => {
    const s = mcpServers.get(name);
    if (!s?.oauth) return fail(res, "invalid", `${name} does not ask for a sign-in.`);
    mcpServers.set(name, { ...s, oauth: method === "POST" ? "signed_in" : "signed_out" });
    broadcast({ t: "settings" });
    return json(res, 200, method === "POST" ? { url: `https://auth.example.com/authorize?mock=${name}` } : {});
  };

  const routeComposio = ({ method, res }: Ctx, toolkit: string, link: boolean) => {
    if (!mcpServers.has("composio")) return fail(res, "not_configured", "Add your Composio API key first.");
    if (method === "POST" && link) {
      composioApps.add(toolkit);
      return json(res, 200, { url: `https://app.composio.dev/link/mock_${toolkit}` });
    }
    if (method === "DELETE" && !link) {
      composioApps.delete(toolkit);
      return json(res, 200, {});
    }
    return fail(res, "not_found", "Unknown route.");
  };

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname;
    const method = req.method ?? "GET";
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type, accept");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (method === "OPTIONS") return void res.writeHead(204).end();
    if (path === "/api/health") return json(res, 200, { ok: true });
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? url.searchParams.get("access_token");
    if (bearer !== token) return fail(res, "forbidden", "The owner token was rejected.");
    if (path === "/api/live" && method === "GET") return openLive(req, res);

    const body = method === "GET" || method === "DELETE" ? {} : await readBody(req).catch(() => null);
    if (body === null) return fail(res, "invalid", "Invalid JSON.");
    const c: Ctx = { url, method, body, res };

    const handle = routes.get(`${method} ${path}`);
    if (handle) return handle(c);
    const automation = automations(method, path, body);
    if (automation) return "error" in automation ? fail(res, automation.error, automation.message) : json(res, automation.status, automation.body);
    const m = /^\/api\/dorks\/([^/]+)(?:\/(messages|interrupt|desktop|archive|model|codex-model|events|pr(?:\/merge|\/update-branch)?|subscriptions(?:\/resume)?))?$/.exec(path);
    if (m) return routeDork(c, m);
    const sm = /^\/api\/secrets\/([^/]+)$/.exec(path);
    if (sm) return routeSecret(c, decodeURIComponent(sm[1]!));
    const cm = /^\/api\/composio\/toolkits\/([a-z0-9_]+)(\/link)?$/.exec(path);
    if (cm) return routeComposio(c, cm[1]!, !!cm[2]);
    return routeCustomize(c, path);
  };

  const server: Server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) fail(res, "failed", "Something went wrong");
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    token,
    dorks,
    settings,
    secrets,
    append,
    rewrite,
    broadcast,
    snapshot: {
      status: snapView,
      failNextBuild(message) {
        failBuild = message;
      },
      newBridge() {
        snap.currentBundleId = `mock-bundle-${++bundle}`;
        broadcast({ t: "snapshot" });
      },
    },
    liveClients: () => live.size,
    dropLive() {
      for (const r of live) r.end();
      live.clear();
    },
    async close() {
      for (const t of timers) clearTimeout(t);
      for (const r of live) r.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A pull request as GitHub would show it for the mock's scripted "open a PR" turn: a body with sections, a diff, comments, checks. */
function mockPullRequest(repo: string, number: number, title: string): PullRequestView {
  const now = Date.now();
  const author = { login: "handlemotion" };
  return {
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title,
    body: "## Problem\n\nThe app reported `ready = false` even after setup finished, so the first run always waited for a timeout.\n\n## Approach\n\nFlip the flag once setup completes and cover it with a test.\n\n## Testing\n\n- `pnpm test` passes\n- Checked by hand in the desktop app",
    state: "open",
    draft: false,
    author,
    headRef: number === 7 ? "dorks/ready-flag" : `dorks/change-${number}`,
    baseRef: "main",
    headSha: "a".repeat(40),
    createdAt: now - 12 * 60_000,
    mergeable: true,
    mergeableState: "clean",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    checks: { total: 3, passed: 3, failed: 0, pending: 0, failing: [], runs: ["check", "test", "e2e"].map((name) => ({ name, outcome: "pass" as const })) },
    mergeMethods: ["squash", "merge", "rebase"],
    files: [
      {
        path: "src/index.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,3 @@\n import { setup } from './setup'\n-export const ready = false\n+export const ready = true\n export default setup\n",
      },
    ],
    comments: [
      {
        id: "c1",
        kind: "comment",
        author: { login: "octocat" },
        body: "Nice catch. Does this also fix the retry loop on wake?",
        url: `https://github.com/${repo}/pull/${number}#issuecomment-1`,
        createdAt: now - 8 * 60_000,
      },
      { id: "r1", kind: "review", author: { login: "octocat" }, body: "", reviewState: "APPROVED", url: `https://github.com/${repo}/pull/${number}#pullrequestreview-1`, createdAt: now - 5 * 60_000 },
    ],
  };
}
