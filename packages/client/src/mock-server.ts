// An in-memory stand-in for apps/server's UI listener, implementing the contract in docs/architecture.md: the REST routes, the
// `/api/live` SSE invalidation stream and a scripted fake agent. It lets the web app and the e2e run with no real server, and it
// is what this package's own tests talk to. Node-only, and it imports nothing at runtime so `node src/mock-cli.ts` works as is.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClientEvent, CommentAnchor, CommentView, McpServerView, PullRequestView, ShipStage, ShipView, SkillCandidate, SkillView } from "@dorks/shared";
import type { Dork, Settings, SnapshotStatus } from "./types.ts";
import { mockAutomations } from "./mock-automations.ts";

/** A new session's mode (docs/modes.md) from its body: `mode`, or the older `kind: "coordinator"` for a nerd; code by default. */
const modeOf = (body: Record<string, unknown>): "chat" | "code" | "nerd" | undefined =>
  body.mode === undefined || body.mode === null ? (body.kind === "coordinator" ? "nerd" : "code") : body.mode === "chat" || body.mode === "code" || body.mode === "nerd" ? body.mode : undefined;

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

/** What the composer's `/` menu offers: the CLI's `initialize` commands, skills marked by where they come from. */
const MOCK_COMMANDS = [
  { name: "code-review", description: "Review the changes since a fixed point along two axes: Standards and Spec. (user)" },
  { name: "frontend-design", description: "Create distinctive, production-grade frontend interfaces with high design quality. (user)" },
  { name: "pdf", description: "Read, fill and merge PDF files. (user)" },
  { name: "tdd", description: "Test-driven development: red, green, refactor. (user)" },
  { name: "release-notes", description: "Draft release notes from the pull requests merged since a tag. (project)", argumentHint: "[since tag]" },
  { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>" },
  { name: "context", description: "Show current context usage" },
  { name: "init", description: "Initialize a new CLAUDE.md file with codebase documentation" },
  { name: "security-review", description: "Complete a security review of the pending changes on the current branch" },
];
/** What the composer's `@` menu searches: the repository's files as the bridge would list them. */
const MOCK_FILES = [
  "AGENTS.md",
  "README.md",
  "package.json",
  "apps/web/src/main.tsx",
  "apps/web/src/components/ChatComposer.tsx",
  "apps/web/src/components/SessionChat.tsx",
  "apps/web/src/components/EmptyState.tsx",
  "apps/web/src/lib/draft.ts",
  "apps/server/src/main.ts",
  "apps/server/src/services/files.ts",
  "packages/shared/src/mentions.ts",
  "packages/ui/src/components/ui/command.tsx",
  "docs/architecture.md",
  "docs/development.md",
];
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
  const now = Date.now();
  const mcpServers = new Map<string, McpServerView>([
    [
      "sentry",
      {
        name: "sentry",
        transport: "http",
        url: "https://mcp.sentry.dev/mcp",
        command: null,
        args: [],
        headerNames: ["Authorization"],
        envNames: [],
        oauth: null,
        createdAt: now - 86_400_000 * 6,
      },
    ],
    [
      "linear",
      {
        name: "linear",
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        command: null,
        args: [],
        headerNames: ["Authorization"],
        envNames: [],
        oauth: null,
        createdAt: now - 86_400_000 * 5,
      },
    ],
    [
      "cloudflare",
      {
        name: "cloudflare",
        transport: "http",
        url: "https://mcp.cloudflare.com/mcp",
        command: null,
        args: [],
        headerNames: ["Authorization"],
        envNames: [],
        oauth: null,
        createdAt: now - 86_400_000 * 4,
      },
    ],
    [
      "context7",
      {
        name: "context7",
        transport: "http",
        url: "https://mcp.context7.com/mcp",
        command: null,
        args: [],
        headerNames: ["CONTEXT7_API_KEY"],
        envNames: [],
        oauth: null,
        createdAt: now - 86_400_000 * 3,
      },
    ],
    [
      "composio",
      {
        name: "composio",
        transport: "http",
        url: "https://app.composio.dev/tool_router/v3/trs_mock/mcp",
        command: null,
        args: [],
        headerNames: ["x-api-key"],
        envNames: [],
        oauth: null,
        createdAt: now - 86_400_000 * 3,
      },
    ],
    [
      "postgres",
      {
        name: "postgres",
        transport: "stdio",
        url: null,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres"],
        headerNames: [],
        envNames: ["DATABASE_URL"],
        oauth: null,
        createdAt: now - 86_400_000 * 2,
      },
    ],
  ]);
  const skills = new Map<string, SkillView>([
    [
      "frontend-design",
      {
        name: "frontend-design",
        description: "Create distinctive, production-grade web interfaces with high design quality",
        source: { repo: "anthropics/skills", ref: null, path: "skills/frontend-design" },
        sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e",
        url: "https://github.com/anthropics/skills/tree/a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e/skills/frontend-design",
        fileCount: 4,
        bytes: 12_480,
        installedAt: now - 86_400_000 * 5,
        updatedAt: now - 86_400_000 * 2,
      },
    ],
    [
      "pdf",
      {
        name: "pdf",
        description: "Extract text, fill forms, merge and generate structured PDF documents",
        source: { repo: "anthropics/skills", ref: null, path: "skills/pdf" },
        sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e",
        url: "https://github.com/anthropics/skills/tree/a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e/skills/pdf",
        fileCount: 3,
        bytes: 8_192,
        installedAt: now - 86_400_000 * 4,
        updatedAt: now - 86_400_000 * 1,
      },
    ],
    [
      "webapp-testing",
      {
        name: "webapp-testing",
        description: "Verify running web applications with Playwright scripts and visual checks",
        source: { repo: "anthropics/skills", ref: null, path: "skills/webapp-testing" },
        sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e",
        url: "https://github.com/anthropics/skills/tree/a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e/skills/webapp-testing",
        fileCount: 5,
        bytes: 15_360,
        installedAt: now - 86_400_000 * 3,
        updatedAt: now - 3_600_000 * 6,
      },
    ],
    [
      "vercel-react-best-practices",
      {
        name: "vercel-react-best-practices",
        description: "React and Next.js performance, data fetching and rendering patterns",
        source: { repo: "vercel-labs/agent-skills", ref: null, path: "skills/vercel-react-best-practices" },
        sha: "9f8e7d6c5b4a3928171605f4e3d2c1b0a9f8e7d6",
        url: "https://github.com/vercel-labs/agent-skills/tree/9f8e7d6c5b4a3928171605f4e3d2c1b0a9f8e7d6/skills/vercel-react-best-practices",
        fileCount: 6,
        bytes: 18_432,
        installedAt: now - 86_400_000 * 2,
        updatedAt: now - 3_600_000 * 2,
      },
    ],
  ]);
  /** A loose stand-in for services/skills.ts: `owner/repo` from the pasted text, and a few made-up skills in it. */
  const mockResolve = (source: string) => {
    const m = /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/@#\s]|$)/.exec(source.replace(/https?:\/\/github\.com\//, ""));
    if (!m) return null;
    const repo = `${m[1]}/${m[2]}`;
    const byRepo: Record<string, string[]> = {
      "anthropics/skills": ["frontend-design", "canvas-design", "pdf", "docx", "xlsx", "pptx", "webapp-testing", "mcp-builder", "skill-creator"],
      "vercel-labs/agent-skills": ["vercel-react-best-practices", "web-design-guidelines"],
      "supabase/agent-skills": ["supabase-postgres-best-practices"],
    };
    const names = byRepo[repo] ?? (m[2] === "skills" || m[2]!.endsWith("-skills") ? ["frontend-design", "pdf", "webapp-testing", "skill-creator"] : [m[2]!.toLowerCase().replace(/[^a-z0-9]+/g, "-")]);
    const found: SkillCandidate[] = names.map((name) => ({
      name,
      description: `Skill ${name} from ${repo}.`,
      path: names.length > 1 ? `skills/${name}` : "",
      fileCount: 3,
      bytes: 4096,
      installed: skills.has(name),
    }));
    const requested = names.filter((n) => source.includes(n) && n !== m[2]);
    return { repo, ref: null, sha: "0123456789abcdef0123456789abcdef01234567", skills: found, requested: requested.length || names.length > 1 ? requested : names };
  };
  // Composio: a sign-in "finishes" when its link is requested, so the UI's wait ends on the next read.
  const composioApps = new Set<string>(["figma", "slack", "gmail"]);
  let localAccessEnabled = true;
  /** Local access (docs/local-access.md): the sessions the owner allowed, and requests waiting for an answer (requestId -> its answer). */
  const localAllowed = new Map<string, number>();
  const inputWaiting = new Map<string, { dorkId: string; names: string[]; answer: (names: string[] | null) => void }>();
  const localWaiting = new Map<string, { dorkId: string; answer: (allowed: "session" | "always" | null) => void }>();
  const live = new Set<ServerResponse>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const settings: Settings = {
    claudeToken: !!opts.configured,
    antigravityToken: false,
    antigravityReady: false,
    // What `agy models` lists for a Google AI plan (apps/server's refreshAntigravityModels), shown once signed in.
    antigravityModels: [],
    antigravitySignIn: { state: "signed_out" },
    boatKey: !!opts.configured,
    github: opts.configured ? { configured: true, login: "octocat" } : { configured: false },
    boatSignIn: opts.configured ? null : { state: "signed_out" },
    boatOrg: null,
    boatEnvironment: opts.configured ? "dorks-codex" : null,
    baseSnapshotId: opts.configured ? "dorks-base-20260101" : null,
    sleepMinutes: 10,
    commentPolicy: { mode: "all" },
    claudeCodeMode: true,
    localAlwaysAllow: false,
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

  /**
   * After a merge, a pretend ship (docs/shipping.md): CI and a deploy workflow with a migration step on the merge commit, a Cloudflare
   * Pages check, then a production deployment, each step a few seconds apart, ending shipped.
   */
  const simulateShip = (dorkId: string, pr: { url: string; number: number; title?: string; baseRef?: string; repo?: string }) => {
    const repo = pr.repo ?? pr.url.replace("https://github.com/", "").split("/pull/")[0];
    const start = Date.now();
    const sha = "9f3c2a17e0b5d4c8a6f1e2d3c4b5a6978899aabb";
    const ship: ShipView = { id: start, repo, number: pr.number, url: pr.url, title: pr.title, baseRef: pr.baseRef ?? "main", sha, status: "watching", stages: [], startedAt: start };
    const run = (n: number) => `https://github.com/${repo}/actions/runs/${n}`;
    const stage = (s: ShipStage) => s;
    // A PR whose title says "fail" fails its deploy, to see the failed card.
    const fails = /fail/i.test(pr.title ?? "");
    const steps: ((t: number) => void)[] = [
      (t) => {
        ship.stages = [
          stage({ id: "run:1", kind: "workflow", name: "CI", state: "running", url: run(1), startedAt: t }),
          stage({ id: "check:Cloudflare Pages", kind: "check", name: "Cloudflare Pages", state: "running", url: "https://dash.cloudflare.com", startedAt: t }),
        ];
      },
      (t) => {
        Object.assign(ship.stages[0], { state: "passed", endedAt: t });
        ship.stages.splice(
          1,
          0,
          stage({ id: "run:2", kind: "workflow", name: "Deploy", state: "running", url: run(2), startedAt: t }),
          stage({ id: "mig:2:1:3", kind: "migration", name: "Run database migrations", state: "running", url: run(2), startedAt: t }),
        );
      },
      (t) => {
        Object.assign(ship.stages[2], { state: "passed", endedAt: t });
        Object.assign(ship.stages[3], { state: "passed", endedAt: t });
        ship.stages.push(stage({ id: "dep:production", kind: "deployment", name: "Deploy to production", state: "running", url: run(2), startedAt: t }));
      },
      (t) => {
        Object.assign(ship.stages[1], { state: "passed", endedAt: t });
        Object.assign(ship.stages[4], fails ? { state: "failed", endedAt: t } : { state: "passed", endedAt: t, environmentUrl: "https://demo.pages.dev" });
        if (fails) ship.status = "failed";
        // The agent is told the merge is live and checks it there (docs/shipping.md, "The agent").
        else
          ship.stages.push({ id: "verify", kind: "verify", name: "Verify on production", state: "pending", url: "https://demo.pages.dev", detail: "The agent is checking the change", startedAt: t });
      },
      (t) => {
        if (fails) return;
        Object.assign(ship.stages[5], { state: "passed", endedAt: t, detail: "Opened /settings on the live site; the new toggle saves and survives a reload." });
        Object.assign(ship, { status: "shipped", endedAt: t });
      },
    ];
    append(dorkId, { type: "ship", ship: structuredClone(ship) });
    steps.forEach((step, i) =>
      later(2500 * (i + 1), () => {
        if (!dorks.has(dorkId)) return;
        step(Date.now());
        append(dorkId, { type: "ship", ship: structuredClone(ship) });
      }),
    );
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

  /**
   * The fake agent's `local_run` (docs/local-access.md): asks the owner unless this session (or every session) is allowed, then
   * "runs" and reports a canned output. `then` continues the turn once it settled.
   */
  const askLocal = (dorkId: string, command: string, reason: string, output: string, then: () => void) => {
    const requestId = `local-${randomUUID().slice(0, 8)}`;
    append(dorkId, { type: "local_request", requestId, kind: "run", command, cwd: "~/app", reason });
    const run = (via: "session" | "always" | "standing") => {
      append(dorkId, { type: "local_decision", requestId, decision: "allowed", via });
      later(tick, () => {
        append(dorkId, { type: "local_result", requestId, ok: true, exitCode: 0, preview: output });
        then();
      });
    };
    if (!localAccessEnabled) return then();
    if (settings.localAlwaysAllow || localAllowed.has(dorkId)) return run("standing");
    localWaiting.set(requestId, {
      dorkId,
      answer: (allowed) => {
        localWaiting.delete(requestId);
        if (allowed) return run(allowed);
        append(dorkId, { type: "local_decision", requestId, decision: "denied" });
        then();
      },
    });
  };

  /** The fake agent's `input_request` (docs/secure-inputs.md): a login form; `then` continues the turn once the owner answered. */
  const askInput = (dorkId: string, then: () => void) => {
    const requestId = `input-${randomUUID().slice(0, 8)}`;
    append(dorkId, {
      type: "input_request",
      requestId,
      title: "Page login",
      description: "Sign in to the account that manages this page. Posts go out as the page.",
      fields: [
        { name: "page_login", label: "Email or phone", kind: "email" },
        { name: "page_password", label: "Password", kind: "secret" },
      ],
    });
    inputWaiting.set(requestId, {
      dorkId,
      names: ["page_login", "page_password"],
      answer: (names) => {
        inputWaiting.delete(requestId);
        append(dorkId, names ? { type: "input_response", requestId, status: "provided", names } : { type: "input_response", requestId, status: "dismissed" });
        then();
      },
    });
  };

  /**
   * The fake agent: a turn of tool calls and a streamed answer, ending idle. A prompt that mentions "computer" first asks to use it;
   * one that mentions "login" first asks for one (a secure input).
   */
  const runTurn = (dorkId: string, prompt: string, localDone = false): void => {
    const d = dorks.get(dorkId);
    if (!d) return;
    if (!localDone && /\blogin\b/i.test(prompt)) {
      later(tick, () => askInput(dorkId, () => runTurn(dorkId, prompt, true)));
      return;
    }
    if (!localDone && /\bcomputer\b/i.test(prompt)) {
      const reason = "To see which simulators are booted on your Mac before I run the UI tests there.";
      later(tick, () =>
        askLocal(dorkId, "xcrun simctl list devices booted", reason, "== Devices ==\n-- iOS 19.0 --\n    iPhone 17 Pro (5C1F…) (Booted)", () =>
          askLocal(dorkId, "git -C ~/app status --short", "To check your local checkout has no changes I would miss.", " M src/App.tsx\n?? notes.md", () => runTurn(dorkId, prompt, true)),
        ),
      );
      return;
    }
    const alive = () => dorks.get(dorkId)?.state === "working";
    const tool = `tool-${randomUUID().slice(0, 8)}`;
    const msg = `msg-${randomUUID().slice(0, 8)}`;
    const answer = `Done: ${prompt.slice(0, 60)}. I read the code, made the change and the tests pass: [the change](https://github.com/octocat/hello-world/pull/1).`;
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
      crewTurnEnded(d, answer);
      // Like apps/server: the oldest queued message starts the next turn, with no idle in between.
      const next = d.queue?.shift();
      if (next) {
        broadcast({ t: "dork", dorkId });
        append(dorkId, { type: "user_message", text: next.text });
        runTurn(dorkId, next.text);
      } else append(dorkId, { type: "status", state: "idle" });
    });
  };

  /**
   * Crews (docs/crew.md), scripted: a coordinator's first turn delegates to two workers; a worker's turn end reaches its coordinator
   * as a crew report, the way the server folds them.
   */
  const crewTurnEnded = (d: MockDork, answer: string) => {
    if (d.mode === "nerd" && ![...dorks.values()].some((w) => w.parentId === d.id)) {
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

  const MOCK_AGY_MODELS = [
    ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
    ["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"],
    ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
    ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
    ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
  ].map(([model, name]) => ({ model: model!, name: name!, efforts: [] }));

  /** Why a new session cannot start yet, or null when it can. */
  const cannotCreate = (provider: Dork["provider"]): string | null => {
    if (!settings.boatKey || !settings.baseSnapshotId || !settings.github.configured) return "Finish setup (Boat, base snapshot, GitHub) before creating a session.";
    if (provider === "claude" && !settings.claudeToken) return "Add a Claude token first.";
    if (provider === "antigravity" && !settings.antigravityReady) return "Connect Antigravity first: sign in with Google in Settings.";
    if (provider === "codex" && !settings.boatEnvironment) return "Save a Boat environment for Codex first.";
    return null;
  };

  const createDork = ({ body, res }: Ctx) => {
    const mode = modeOf(body);
    if (!mode) return fail(res, "invalid", "mode must be chat, code or nerd");
    const repo = str(body.repo)?.trim() ?? "";
    const message = str(body.message)?.trim();
    if (!(mode !== "code" && !repo) && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(res, "invalid", "repo must look like owner/name");
    if (!message) return fail(res, "invalid", "message is required");
    const provider = body.provider === "codex" || body.provider === "opencode" || body.provider === "antigravity" ? body.provider : "claude";
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
      mode: modeOf(body) ?? "code",
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
            commands: MOCK_COMMANDS,
          }
        : provider === "antigravity"
          ? { model: str(body.model), modelChoices: MOCK_AGY_MODELS }
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
      "POST queue",
      ({ body, res }, d) => {
        const text = str(body.text)?.trim();
        if (!text) return fail(res, "invalid", "text is required");
        if (d.archived) return fail(res, "archived", "This session is archived.");
        if (!["creating", "waking", "working"].includes(d.state)) {
          startTurn(d.id, text);
          return json(res, 200, { queued: false });
        }
        d.queue = [...(d.queue ?? []), { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, createdAt: Date.now() }];
        broadcast({ t: "dork", dorkId: d.id });
        return json(res, 200, { queued: true });
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
    [
      "POST mode",
      ({ body, res }, d) => {
        const mode = body.mode === "chat" || body.mode === "code" || body.mode === "nerd" ? body.mode : undefined;
        if (!mode) return fail(res, "invalid", "mode must be chat, code or nerd");
        if (d.archived) return fail(res, "archived", "This session is archived.");
        if (d.parentId && mode !== d.mode) return fail(res, "invalid", "A worker keeps the mode its coordinator gave it.");
        if (d.mode === "nerd" && mode !== "nerd" && [...dorks.values()].some((w) => w.parentId === d.id && !w.archived))
          return fail(res, "conflict", "This nerd still runs sessions. Archive them before switching.");
        d.mode = mode;
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
      "GET files",
      ({ url, res }) => {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const files = MOCK_FILES.filter((p) => p.toLowerCase().includes(q)).sort((a, b) => a.length - b.length);
        json(res, 200, { files, listed: true, truncated: false });
      },
    ],
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
        simulateShip(d.id, pr);
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
    const local = /^local\/([^/]+)$/.exec(sub);
    if (local && c.method === "POST") return decideLocal(c, d, decodeURIComponent(local[1]!));
    const input = /^inputs\/([^/]+)$/.exec(sub);
    if (input && c.method === "POST") return answerInput(c, d, decodeURIComponent(input[1]!));
    const queued = /^queue\/([^/]+)(\/send)?$/.exec(sub);
    if (queued) return takeQueued(c, d, decodeURIComponent(queued[1]!), !!queued[2]);
    const cm = /^comments(?:\/([^/]+)(\/replies)?)?$/.exec(sub);
    if (cm) return routeComments(c, d, cm[1] ? decodeURIComponent(cm[1]) : undefined, !!cm[2]);
    const handle = dorkRoutes.get(`${c.method} ${sub}`) ?? dorkRoutes.get(`* ${sub}`);
    if (!handle) return fail(c.res, "not_found", "Unknown route.");
    return handle(c, d);
  };

  // Preview comments (routeComments below).
  const comments = new Map<string, CommentView[]>();
  const commentText = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const newComment = (fields: Pick<CommentView, "parentId" | "author" | "body" | "anchor" | "port">): CommentView => ({
    id: randomUUID(),
    ...fields,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: Date.now(),
    editedAt: null,
  });
  /** The mock agent's answer in a thread, a moment after the owner wrote in it, with the transcript card the real fold appends. */
  const agentAnswers = (d: MockDork, list: CommentView[], threadId: string, text: string) =>
    setTimeout(() => {
      if (!list.some((c) => c.id === threadId)) return;
      append(d.id, { type: "notify", kinds: [], prs: [], text, source: "preview" });
      list.push(newComment({ parentId: threadId, author: "agent", body: "On it. I'll update it and let you know here.", anchor: null, port: null }));
      broadcast({ t: "comments", dorkId: d.id });
    }, 1500);

  /** `GET|POST /api/dorks/:id/comments`: the threads, or a new one. */
  const routeThreads = ({ method, body, res }: Ctx, d: MockDork, list: CommentView[]) => {
    if (method === "GET") return json(res, 200, list);
    if (method !== "POST") return fail(res, "not_found", "Unknown route.");
    const text = commentText(body.body);
    if (!text) return fail(res, "invalid", "the comment is empty");
    // A light check (this file imports nothing at runtime); the real server parses it with `commentAnchor`.
    const a = body.anchor as CommentAnchor | undefined;
    if (!a || !["element", "text", "area"].includes(a.kind) || typeof a.selector !== "string" || typeof a.path !== "string") return fail(res, "invalid", "the comment needs an anchor on the page");
    const c = newComment({ parentId: null, author: "owner", body: text, anchor: a, port: typeof body.port === "number" ? body.port : null });
    list.push(c);
    broadcast({ t: "comments", dorkId: d.id });
    agentAnswers(d, list, c.id, text);
    return json(res, 200, { id: c.id });
  };

  /** `POST …/comments/:cid/replies`, `PATCH|DELETE …/comments/:cid`. */
  const routeComment = ({ method, body, res }: Ctx, d: MockDork, list: CommentView[], c: CommentView, replies: boolean) => {
    if (replies && method === "POST") {
      const text = commentText(body.body);
      if (!text) return fail(res, "invalid", "the comment is empty");
      const r = newComment({ parentId: c.id, author: "owner", body: text, anchor: null, port: null });
      list.push(r);
      Object.assign(c, { resolvedAt: null, resolvedBy: null });
      agentAnswers(d, list, c.id, text);
      broadcast({ t: "comments", dorkId: d.id });
      return json(res, 200, { id: r.id });
    }
    if (!replies && method === "PATCH") {
      if (commentText(body.body)) Object.assign(c, { body: commentText(body.body), editedAt: Date.now() });
      if (typeof body.resolved === "boolean") Object.assign(c, body.resolved ? { resolvedAt: Date.now(), resolvedBy: "owner" } : { resolvedAt: null, resolvedBy: null });
    } else if (!replies && method === "DELETE")
      comments.set(
        d.id,
        list.filter((x) => x.id !== c.id && x.parentId !== c.id),
      );
    else return fail(res, "not_found", "Unknown route.");
    broadcast({ t: "comments", dorkId: d.id });
    return json(res, 200, {});
  };

  /**
   * Preview comments (services/comments.ts on the real server). The mock agent answers each new comment of the owner's in its
   * thread a moment later, so the bubbles and threads can be tried without a sandbox.
   */
  const routeComments = (c: Ctx, d: MockDork, commentId: string | undefined, replies: boolean) => {
    const list = comments.get(d.id) ?? [];
    comments.set(d.id, list);
    if (!commentId) return routeThreads(c, d, list);
    const found = list.find((x) => x.id === commentId);
    return found ? routeComment(c, d, list, found, replies) : fail(c.res, "not_found", "no such comment");
  };

  /** `DELETE /api/dorks/:id/queue/:qid` removes a queued message; `POST …/send` sends it now. */
  const takeQueued = ({ method, res }: Ctx, d: MockDork, qid: string, send: boolean) => {
    if (method !== (send ? "POST" : "DELETE")) return fail(res, "not_found", "Unknown route.");
    const item = d.queue?.find((q) => q.id === qid);
    if (!item) return fail(res, "not_found", "That message is no longer queued.");
    d.queue = d.queue!.filter((q) => q !== item);
    broadcast({ t: "dork", dorkId: d.id });
    if (send) {
      if (d.state === "working") append(d.id, { type: "user_message", text: item.text });
      else startTurn(d.id, item.text);
    }
    return json(res, 200, {});
  };

  /** `POST /api/dorks/:id/inputs/:requestId`: the owner's values (kept nowhere: the mock only notes which fields were filled) or a dismissal. */
  const answerInput = ({ body, res }: Ctx, d: MockDork, requestId: string) => {
    const waiting = inputWaiting.get(requestId);
    if (!waiting || waiting.dorkId !== d.id) return fail(res, "conflict", "This request was already answered.");
    if (body.dismiss === true) waiting.answer(null);
    else {
      const values = (body.values ?? {}) as Record<string, unknown>;
      const names = waiting.names.filter((n) => typeof values[n] === "string" && values[n] !== "");
      if (names.length < waiting.names.length) return fail(res, "invalid", "Fill in every field.");
      waiting.answer(names);
    }
    return json(res, 200, {});
  };

  /** `POST /api/dorks/:id/local/:requestId`: the owner's answer to a session's first request to use the computer. */
  const decideLocal = ({ body, res }: Ctx, d: MockDork, requestId: string) => {
    const waiting = localWaiting.get(requestId);
    if (!waiting || waiting.dorkId !== d.id) return fail(res, "conflict", "This request was already answered.");
    const decision = body.decision;
    if (decision !== "session" && decision !== "always" && decision !== "deny") return fail(res, "invalid", "decision must be deny, session or always");
    if (decision === "session") localAllowed.set(d.id, Date.now());
    if (decision === "always") settings.localAlwaysAllow = true;
    waiting.answer(decision === "deny" ? null : decision);
    broadcast({ t: "settings" });
    return json(res, 200, {});
  };

  /** Applies a settings PUT; returns an error message when the body is rejected. */
  const saveSettings = (body: Record<string, unknown>): string | null => {
    // Like apps/server, which checks a Boat key with Boat before saving it.
    if (typeof body.boatKey === "string" && body.boatKey.startsWith("bad")) return "Boat rejected that key. Check it and its access (create, use, save and delete sandboxes).";
    if (typeof body.antigravityToken === "string") {
      settings.antigravityToken = settings.antigravityReady = body.antigravityToken !== "";
      settings.antigravitySignIn = settings.antigravityToken ? null : { state: "signed_out" };
    }
    const set = (k: "boatKey" | "claudeToken") => {
      if (typeof body[k] === "string") settings[k] = body[k] !== "";
    };
    set("boatKey");
    set("claudeToken");
    if (typeof body.boatKey === "string") settings.boatSignIn = body.boatKey ? null : { state: "signed_out" };
    if (typeof body.githubConnected === "boolean") settings.github = body.githubConnected ? { configured: true, login: "octocat" } : { configured: false, login: null };
    for (const k of ["boatOrg", "boatEnvironment", "baseSnapshotId"] as const) if (typeof body[k] === "string") settings[k] = body[k] || null;
    if (typeof body.sleepMinutes === "number") {
      if (!Number.isFinite(body.sleepMinutes) || body.sleepMinutes <= 0 || body.sleepMinutes > 1440) return "minutes must be between 0 and 1440";
      settings.sleepMinutes = body.sleepMinutes;
    }
    if (body.commentPolicy) settings.commentPolicy = body.commentPolicy as Settings["commentPolicy"];
    if (typeof body.claudeCodeMode === "boolean") settings.claudeCodeMode = body.claudeCodeMode;
    if (typeof body.localAlwaysAllow === "boolean") settings.localAlwaysAllow = body.localAlwaysAllow;
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
      // Like apps/server's Antigravity sign-in: Google's page "approves" a few seconds after its link is handed out.
      "POST /api/antigravity/sign-in",
      ({ res }) => {
        if (settings.antigravityToken) return json(res, 200, { antigravitySignIn: null });
        settings.antigravitySignIn = { state: "signing_in", url: "https://accounts.google.com/o/oauth2/auth?mock=1" };
        broadcast({ t: "settings" });
        const t = setTimeout(() => {
          timers.delete(t);
          Object.assign(settings, { antigravityToken: true, antigravityReady: true, antigravitySignIn: null, antigravityModels: MOCK_AGY_MODELS });
          broadcast({ t: "settings" });
        }, 3000);
        timers.add(t);
        return json(res, 200, { antigravitySignIn: settings.antigravitySignIn });
      },
    ],
    [
      // Like apps/server's Boat CLI sign-in: the browser sign-in "finishes" a few seconds after its link is handed out.
      "POST /api/boat/sign-in",
      ({ res }) => {
        if (settings.boatKey) return json(res, 200, { boatSignIn: null });
        settings.boatSignIn = { state: "signing_in", url: "https://boat.dev/sign-in?mock=1", userCode: "MOCK-CODE", expiresAt: new Date(Date.now() + 600_000).toISOString() };
        broadcast({ t: "settings" });
        const t = setTimeout(() => {
          timers.delete(t);
          Object.assign(settings, { boatKey: true, boatSignIn: null });
          broadcast({ t: "settings" });
          if (!settings.baseSnapshotId && snap.state !== "building") startBuild();
        }, 3000);
        timers.add(t);
        return json(res, 200, { boatSignIn: settings.boatSignIn });
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
          ...(settings.antigravityToken ? { google: { session: { used: 0.02, resetsAt: now + 4 * 3600_000 }, weekly: { used: 0.01, resetsAt: now + 7 * 86400_000 } } } : {}),
          ...(settings.boatKey
            ? {
                cloud: {
                  usedHours: 38.4,
                  includedHours: 555.56,
                  periodEnd: now + 29 * 86400_000,
                  sandboxes: { used: 3, limit: 100 },
                  startsHour: { used: 4, limit: 60 },
                  startsDay: { used: 21, limit: 200 },
                  walletDollars: 14.79,
                },
              }
            : {}),
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
    // Local access (docs/local-access.md): the switch and the sessions allowed; the fake agent asks when a prompt mentions "computer".
    [
      "GET /api/local-access",
      ({ res }) =>
        json(res, 200, {
          enabled: localAccessEnabled,
          sessions: [...localAllowed].filter(([id]) => dorks.has(id)).map(([dorkId, allowedAt]) => ({ dorkId, dorkTitle: dorks.get(dorkId)!.title, allowedAt })),
        }),
    ],
    [
      "DELETE /api/local-access/sessions",
      ({ url, res }) => {
        const dork = url.searchParams.get("dork");
        if (dork) localAllowed.delete(dork);
        else localAllowed.clear();
        broadcast({ t: "settings" });
        return json(res, 200, {});
      },
    ],
    [
      "PUT /api/local-access",
      ({ body, res }) => {
        if (typeof body.enabled !== "boolean") return fail(res, "invalid", "enabled must be a boolean");
        localAccessEnabled = body.enabled;
        if (!body.enabled) {
          localAllowed.clear();
          settings.localAlwaysAllow = false;
          for (const w of localWaiting.values()) w.answer(null);
        }
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

  // Shared images (the composer's attachments, a captured area of a preview): kept in memory, served without the token like the
  // real server's `GET /images/:id` (the id is the capability).
  const images = new Map<string, { type: string; bytes: Buffer }>();
  const serveImage = (res: ServerResponse, path: string) => {
    const img = images.get(decodeURIComponent(path.slice("/images/".length)));
    if (!img) return fail(res, "not_found", "No such image.");
    return void res.writeHead(200, { "content-type": img.type }).end(img.bytes);
  };
  const uploadImage = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const id = randomUUID().replace(/-/g, ""); // 32 hex characters, like the real server's image ids
    images.set(id, { type: req.headers["content-type"] ?? "image/png", bytes: Buffer.concat(chunks) });
    return json(res, 200, { id });
  };
  /** The health check and `GET /images/:id` (no token), `POST /api/images` (with it); undefined for any other route. */
  const routeImages = (req: IncomingMessage, res: ServerResponse, route: string, authorized: boolean) => {
    if (route.endsWith(" /api/health")) return json(res, 200, { ok: true }) ?? true;
    if (route.startsWith("GET /images/")) return serveImage(res, route.slice("GET ".length)) ?? true;
    if (route === "POST /api/images" && authorized) return uploadImage(req, res);
    return undefined;
  };
  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname;
    const method = req.method ?? "GET";
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type, accept");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (method === "OPTIONS") return void res.writeHead(204).end();
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? url.searchParams.get("access_token");
    const image = routeImages(req, res, `${method} ${path}`, bearer === token);
    if (image) return image;
    if (bearer !== token) return fail(res, "forbidden", "The owner token was rejected.");
    if (path === "/api/live" && method === "GET") return openLive(req, res);

    const body = method === "GET" || method === "DELETE" ? {} : await readBody(req).catch(() => null);
    if (body === null) return fail(res, "invalid", "Invalid JSON.");
    const c: Ctx = { url, method, body, res };

    const handle = routes.get(`${method} ${path}`);
    if (handle) return handle(c);
    const automation = automations(method, path, body);
    if (automation) return "error" in automation ? fail(res, automation.error, automation.message) : json(res, automation.status, automation.body);
    const m =
      /^\/api\/dorks\/([^/]+)(?:\/(local\/[^/]+|inputs\/[^/]+|messages|queue(?:\/[^/]+(?:\/send)?)?|interrupt|desktop|archive|mode|model|codex-model|events|files|pr(?:\/merge|\/update-branch)?|subscriptions(?:\/resume)?|comments(?:\/[^/]+(?:\/replies)?)?))?$/.exec(
        path,
      );
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
