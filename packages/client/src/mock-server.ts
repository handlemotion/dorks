// An in-memory stand-in for apps/server's UI listener, implementing the contract in docs/architecture.md: the REST routes, the
// `/api/live` SSE invalidation stream and a scripted fake agent. It lets the web app and the e2e run with no real server, and it
// is what this package's own tests talk to. Node-only, and it imports nothing at runtime so `node src/mock-cli.ts` works as is.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ClientEvent } from "@dorks/shared";
import type { Dork, Settings, SnapshotStatus } from "./types.ts";

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

const view = (d: MockDork): Dork => {
  const { events: _events, deleting: _deleting, ...row } = d;
  return row;
};

const MOCK_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** What a Claude agent reports from the CLI's `initialize` answer. */
const MOCK_MODELS = [
  { model: "default", name: "Default (recommended)", description: "Mock Opus 1", resolved: "mock-opus-1", efforts: [...MOCK_EFFORTS] },
  { model: "opus", name: "Mock Opus 1", description: "The thorough one", resolved: "mock-opus-1", efforts: [...MOCK_EFFORTS] },
  { model: "haiku", name: "Mock Haiku 1", description: "The quick one", resolved: "mock-haiku-1", efforts: [...MOCK_EFFORTS] },
];

export async function startMockServer(opts: MockOptions = {}): Promise<MockServer> {
  const token = opts.token ?? "mock-owner-token";
  const tick = opts.tick ?? 150;
  const dorks = new Map<string, MockDork>();
  const secrets = new Map<string, string>();
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
      append(dorkId, { type: "tool_use", toolId: tool, name: "Bash", summary: "pnpm test" });
    });
    later(tick * 2, () => {
      if (!alive()) return;
      append(dorkId, { type: "tool_result", toolId: tool, ok: true, preview: "Test Files  3 passed (3)" });
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
      if (/\bpr\b/i.test(prompt)) append(dorkId, { type: "pr_opened", url: `https://github.com/${d.repo}/pull/7`, number: 7 });
      append(dorkId, { type: "turn_complete", durationMs: tick * 5, outcome: "done", finalMessageId: msg });
      append(dorkId, { type: "status", state: "idle" });
    });
  };

  const startTurn = (dorkId: string, text: string) => {
    append(dorkId, { type: "user_message", text });
    append(dorkId, { type: "status", state: "working" });
    runTurn(dorkId, text);
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

    if (path === "/api/live" && method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ t: "hello", now: Date.now() })}\n\n`);
      live.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(ping);
        live.delete(res);
      });
      return;
    }

    const body = method === "GET" || method === "DELETE" ? {} : await readBody(req).catch(() => null);
    if (body === null) return fail(res, "invalid", "Invalid JSON.");
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);

    if (path === "/api/dorks") {
      if (method === "GET") {
        const archived = url.searchParams.get("archived") === "true";
        const rows = [...dorks.values()].filter((d) => !d.deleting && d.archived === archived).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        return json(res, 200, rows.slice(0, 200).map(view));
      }
      if (method === "POST") {
        const repo = str(body.repo)?.trim();
        const message = str(body.message)?.trim();
        if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(res, "invalid", "repo must look like owner/name");
        if (!message) return fail(res, "invalid", "message is required");
        const provider = body.provider === "codex" ? "codex" : "claude";
        if (!settings.boatKey || !settings.baseSnapshotId || !settings.github.configured) return fail(res, "onboarding_incomplete", "Finish setup (Boat, base snapshot, GitHub) before creating a session.");
        if (provider === "claude" && !settings.claudeToken) return fail(res, "onboarding_incomplete", "Add a Claude token first.");
        if (provider === "codex" && !settings.boatEnvironment) return fail(res, "onboarding_incomplete", "Save a Boat environment for Codex first.");
        const id = randomUUID();
        const now = Date.now();
        dorks.set(id, { id, title: str(body.title) || message.slice(0, 48), repo, branch: `dorks/${id.slice(0, 8)}`, provider, state: "creating", archived: false, lastActivityAt: now, createdAt: now, events: [],
          ...(provider === "claude" ? { model: str(body.model), effort: str(body.effort), agentModel: MOCK_MODELS.find((c) => c.model === (str(body.model) ?? "default"))?.resolved, modelChoices: MOCK_MODELS } : {}) });
        append(id, { type: "status", state: "creating" });
        broadcast({ t: "dorks" });
        later(tick, () => startTurn(id, message));
        return json(res, 200, { id });
      }
    }

    const m = /^\/api\/dorks\/([^/]+)(?:\/(messages|interrupt|archive|model|codex-model|events|subscriptions(?:\/resume)?))?$/.exec(path);
    if (m) {
      const d = dorks.get(decodeURIComponent(m[1]!));
      if (!d || d.deleting) return fail(res, "not_found", "No such session.");
      const sub = m[2];
      if (!sub) {
        if (method === "GET") return json(res, 200, view(d));
        if (method === "PATCH") {
          const title = str(body.title)?.trim();
          if (!title) return fail(res, "invalid", "title is required");
          d.title = title;
          broadcast({ t: "dork", dorkId: d.id });
          broadcast({ t: "dorks" });
          return json(res, 200, {});
        }
        if (method === "DELETE") {
          d.deleting = true;
          broadcast({ t: "dorks" });
          return json(res, 200, {});
        }
      }
      if (sub === "messages" && method === "POST") {
        const text = str(body.text)?.trim();
        if (!text) return fail(res, "invalid", "text is required");
        if (d.archived) return fail(res, "archived", "This session is archived.");
        startTurn(d.id, text);
        return json(res, 200, {});
      }
      if (sub === "interrupt" && method === "POST") {
        if (d.state === "working") {
          append(d.id, { type: "turn_complete", durationMs: 0, outcome: "stopped" });
          append(d.id, { type: "status", state: "idle" });
        }
        return json(res, 200, {});
      }
      if (sub === "archive" && method === "POST") {
        d.archived = body.archived === true;
        broadcast({ t: "dork", dorkId: d.id });
        broadcast({ t: "dorks" });
        return json(res, 200, {});
      }
      if (sub === "model" && method === "POST") {
        const model = str(body.model) || undefined;
        const effort = str(body.effort) || undefined;
        const choice = MOCK_MODELS.find((c) => c.model === (model ?? "default"));
        if ((model || effort) && (!choice || (effort && !choice.efforts.includes(effort as never)))) return fail(res, "invalid", "not offered by the agent");
        Object.assign(d, { model, effort, agentModel: choice?.resolved ?? "mock-opus-1", agentEffort: effort });
        broadcast({ t: "dork", dorkId: d.id });
        return json(res, 200, {});
      }
      if (sub === "codex-model" && method === "POST") {
        d.codexModel = { model: str(body.model) ?? "", effort: str(body.effort) ?? "" };
        broadcast({ t: "dork", dorkId: d.id });
        return json(res, 200, {});
      }
      if (sub === "events" && method === "GET") {
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
      }
      if (sub === "subscriptions") return json(res, 200, method === "GET" ? [] : {});
      if (sub === "subscriptions/resume") return json(res, 200, {});
    }

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
    if (path === "/api/settings") {
      if (method === "GET") return json(res, 200, settings);
      if (method === "PUT") {
        // Like apps/server, which checks a Boat key with Boat before saving it.
        if (typeof body.boatKey === "string" && body.boatKey.startsWith("bad")) return fail(res, "invalid", "Boat rejected that key. Check it and its access (create, use, save and delete sandboxes).");
        const set = (k: "boatKey" | "claudeToken") => {
          if (typeof body[k] === "string") settings[k] = body[k] !== "";
        };
        set("boatKey");
        set("claudeToken");
        if (typeof body.githubToken === "string") settings.github = body.githubToken ? { configured: true, login: "octocat" } : { configured: false };
        for (const k of ["boatOrg", "boatEnvironment", "baseSnapshotId"] as const) if (typeof body[k] === "string") settings[k] = body[k] || null;
        if (typeof body.sleepMinutes === "number") {
          if (!Number.isFinite(body.sleepMinutes) || body.sleepMinutes <= 0 || body.sleepMinutes > 1440) return fail(res, "invalid", "minutes must be between 0 and 1440");
          settings.sleepMinutes = body.sleepMinutes;
        }
        if (body.commentPolicy) settings.commentPolicy = body.commentPolicy as Settings["commentPolicy"];
        broadcast({ t: "settings" });
        // Like apps/server: a new Boat key starts the base-snapshot build when there is no snapshot yet.
        if (typeof body.boatKey === "string" && body.boatKey && !settings.baseSnapshotId && snap.state !== "building") startBuild();
        return json(res, 200, {});
      }
    }
    if (path === "/api/boat/check" && method === "POST") {
      const key = typeof body.boatKey === "string" ? body.boatKey.trim() : "";
      if (!key && !settings.boatKey) return fail(res, "not_configured", "Add your Boat API key first.");
      if (key.startsWith("bad")) return json(res, 200, { status: "invalid", message: "Boat rejected that key. Check it and its access (create, use, save and delete sandboxes)." });
      return json(res, 200, { status: "ok", message: "Boat accepted the key." });
    }
    if (path === "/api/snapshot" && method === "GET") return json(res, 200, snapView());
    if (path === "/api/snapshot/build" && method === "POST") {
      if (body.force !== undefined && typeof body.force !== "boolean") return fail(res, "invalid", "force must be a boolean");
      if (!settings.boatKey) return fail(res, "not_configured", "Add your Boat API key first.");
      const current = snapView();
      if (snap.state === "building" || (!body.force && snap.state !== "failed" && snap.snapshot && current.managed && !current.stale)) return json(res, 202, current);
      startBuild();
      return json(res, 202, snapView());
    }
    if (path === "/api/secrets" && method === "GET") return json(res, 200, [...secrets.keys()].sort());
    const sm = /^\/api\/secrets\/([^/]+)$/.exec(path);
    if (sm) {
      const name = decodeURIComponent(sm[1]!);
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
    }
    return fail(res, "not_found", "Unknown route.");
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
