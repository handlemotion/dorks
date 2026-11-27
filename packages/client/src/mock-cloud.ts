// The mock's stand-in for Dorks Cloud (docs/mobile.md, "Desktop: Dorks Cloud"): the local server's `/api/cloud` routes, with a
// fake browser sign-in (`dorks://auth` with the mock's state and any code), the account's places (Macs, and organizations with the servers Dorks runs for them),
// and `/api/cloud/servers/:id/api/*`, answered by a separate in-memory mock server per place, so switching really re-points the app.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudEntitlements, CloudOrg, CloudServer, CloudStatus, CloudUser, Me } from "./types.ts";
import { mockTeams } from "./mock-teams.ts";

export interface MockCloudPlace extends CloudServer {
  /** The chats the place's server starts with: what makes it look like someone else's server. */
  seed: { repo: string; message: string; title: string }[];
}

export type MockOrg = Omit<CloudOrg, "servers" | "active"> & { servers: MockCloudPlace[] };

export interface MockChild {
  url: string;
  token: string;
  close(): Promise<void>;
}

type Json = (res: ServerResponse, status: number, body: unknown) => void;

/** The one sign-in state the mock hands out: `#/auth?code=any&state=mock-state-0001` signs it in. */
const MOCK_STATE = "mock-state-0001";

/** The account's orgs as `GET /v1/orgs` lists them: the personal one (with a second Mac of the owner's), then two teams. */
const ORGS: MockOrg[] = [
  {
    id: "org-personal",
    name: "Personal",
    slug: "personal-ada",
    logo: null,
    personal: true,
    plan: "local",
    role: "owner",
    servers: [
      {
        id: "mac-mini",
        name: "Ada's Mac mini",
        kind: "mac",
        online: true,
        lastSeenAt: null,
        seed: [{ repo: "ada/notes", title: "Index the notebook", message: "Build an index page for the notebook" }],
      },
    ],
  },
  {
    id: "org-handlemotion",
    name: "Handlemotion",
    slug: "handlemotion",
    logo: "https://github.com/handlemotion.png?size=64",
    personal: false,
    plan: "cloud",
    role: "owner",
    servers: [
      {
        id: "hosted-handlemotion",
        name: "Handlemotion",
        kind: "hosted",
        online: true,
        lastSeenAt: null,
        seed: [
          { repo: "handlemotion/omni", title: "Inbox: snooze until Monday", message: "Add a snooze-until-Monday action to the inbox" },
          { repo: "handlemotion/dorks", title: "Release notes for 0.40", message: "Draft the release notes for 0.40" },
        ],
      },
    ],
  },
  {
    id: "org-friends",
    name: "Weekend hacks",
    slug: "weekend-hacks",
    logo: null,
    personal: false,
    plan: "teams",
    role: "member",
    servers: [
      {
        id: "mac-rodrigo",
        name: "Rodrigo's MacBook",
        kind: "mac",
        online: true,
        lastSeenAt: null,
        seed: [{ repo: "rodrigo/dotfiles", title: "Tidy the zsh prompt", message: "Make the prompt shorter and show the git branch" }],
      },
      { id: "mac-studio", name: "Studio Mac mini", kind: "mac", online: false, lastSeenAt: null, seed: [] },
    ],
  },
];

/**
 * A team the Worker runs (Teams plan, no Macs): its UI API is one more mock server, and its realtime routes (the s2 read tokens)
 * go to a real dorks-cloud Worker as one of the org's members, so its live updates come from real s2 (docs/architecture.md, "Live
 * updates for cloud orgs"). `orgId` is the org's id on that Worker.
 */
export interface MockOrgRuntime {
  url: string;
  /** A member's Better Auth bearer token on that Worker, and their user id there (what `/api/me` answers, so presence knows you). */
  token: string;
  userId?: string;
  orgId: string;
  name?: string;
  seed?: MockCloudPlace["seed"];
}

/** The Cloud org's billing state in the mock (`MOCK_CLOUD_PLAN`): paid with hours left, at 85%, used up, on the trial, trial used up. */
export const MOCK_CLOUD_PLANS = ["paid", "warn", "used_up", "trial", "trial_used"] as const;
export type MockCloudPlan = (typeof MOCK_CLOUD_PLANS)[number];

const DAY = 86_400_000;
/** Dorks Cloud's entitlements for an org of the mock, as `GET /v1/orgs/:id/entitlements` answers them (PLAN_CONFIG's numbers). */
export function mockEntitlements(plan: CloudOrg["plan"], cloud: MockCloudPlan = "paid"): CloudEntitlements {
  const base = { memberLimit: 50, members: 3, overage: { enabled: false, capCents: 2000, spentCents: 0 }, trial: null };
  if (plan === "teams") return { ...base, plan: "teams", orgRuntime: true, cloudCredit: false, includedMinutes: 0, usedMinutes: 0, periodEnd: Date.now() + 12 * DAY, maxConcurrentSandboxes: 0 };
  if (plan !== "cloud")
    return { ...base, plan: "local", memberLimit: 1, members: 1, orgRuntime: false, cloudCredit: false, includedMinutes: 0, usedMinutes: 0, periodEnd: null, maxConcurrentSandboxes: 0 };
  const cloudOrg = { ...base, plan: "cloud" as const, orgRuntime: true, cloudCredit: true, maxConcurrentSandboxes: 3 };
  if (cloud === "trial" || cloud === "trial_used") {
    const usedMinutes = cloud === "trial" ? 210 : 600;
    const trial = { kind: "cloud_hours" as const, minutes: 600, usedMinutes, minutesLeft: 600 - usedMinutes, fallbackPlan: "local" as const };
    // Used up, the org is back on Local, and the trial stays visible with no minutes left.
    if (cloud === "trial_used") return { ...base, plan: "local", orgRuntime: false, cloudCredit: false, includedMinutes: 0, usedMinutes: 0, periodEnd: null, maxConcurrentSandboxes: 0, trial };
    return { ...cloudOrg, includedMinutes: trial.minutesLeft, usedMinutes, periodEnd: null, trial };
  }
  const usedMinutes = { paid: 2_520, warn: 10_200, used_up: 12_000 }[cloud];
  return { ...cloudOrg, includedMinutes: 12_000, usedMinutes, periodEnd: Date.now() + 9 * DAY };
}

export function mockCloud(opts: {
  signedIn?: boolean;
  /** The Cloud org's billing state (`MOCK_CLOUD_PLAN`); `PUT /api/cloud/orgs/:id/entitlements {scenario}` changes it while it runs. */
  cloudPlan?: MockCloudPlan;
  orgRuntime?: MockOrgRuntime;
  json: Json;
  fail: (res: ServerResponse, code: string, message: string) => void;
  readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  broadcast: (m: Record<string, unknown>) => void;
  /** This server's own id in the cloud (the phone link's `macId`), listed among the Macs once paired. */
  thisMac: () => { id: string | null; name: string | null };
  startChild: (seed: MockCloudPlace["seed"], me: Partial<Me>) => Promise<MockChild>;
}) {
  const { json, fail } = opts;
  const DEMO: CloudUser = { id: "user-1", name: "Ada Lovelace", email: "ada@example.com", image: null };
  let user: CloudUser | null = opts.signedIn ? DEMO : null;
  const children = new Map<string, Promise<MockChild>>();
  const status = (): CloudStatus => ({ cloudUrl: "https://dorks-cloud.example", user });
  const runtime = opts.orgRuntime;
  const orgs = ORGS.map((o) => ({ ...o }));
  if (runtime) orgs.push({ id: runtime.orgId, name: runtime.name ?? "Cloud team", slug: "cloud-team", logo: null, personal: false, plan: "teams", role: "member", servers: [] });
  const runtimePlace: MockCloudPlace | null = runtime
    ? { id: `runtime-${runtime.orgId}`, name: runtime.name ?? "Cloud team", kind: "hosted", online: true, lastSeenAt: null, seed: runtime.seed ?? [] }
    : null;
  const teams = mockTeams({ orgs, me: () => user, json, fail, readBody: opts.readBody });
  let cloudPlan: MockCloudPlan = opts.cloudPlan ?? "paid";
  const view = (o: MockOrg): CloudOrg => ({
    ...o,
    role: teams.roleOf(o.id) ?? o.role,
    active: o.personal,
    servers: [
      // This server, once paired (the phone link's macId), is one of the personal org's Macs.
      ...(o.personal && opts.thisMac().id ? [{ id: opts.thisMac().id!, name: opts.thisMac().name ?? "This Mac", kind: "mac" as const, online: true, lastSeenAt: Date.now() }] : []),
      ...o.servers.map(({ seed: _seed, ...s }) => ({ ...s, lastSeenAt: s.online ? Date.now() : Date.now() - 3 * 86_400_000 })),
    ],
  });
  const findPlace = (id: string) => (runtimePlace?.id === id ? runtimePlace : orgs.flatMap((o) => o.servers).find((s) => s.id === id));
  const child = (place: MockCloudPlace) => {
    let c = children.get(place.id);
    if (!c) {
      // It answers `GET /api/me` as you, a teammate with your role in the org that owns it.
      const owner = place === runtimePlace ? orgs.find((o) => o.id === runtime?.orgId) : orgs.find((o) => o.servers.some((s) => s.id === place.id));
      const role = ((owner && teams.roleOf(owner.id)) ?? "member") as Me["role"];
      c = opts.startChild(place.seed, {
        kind: "member",
        id: (place === runtimePlace && runtime?.userId) || "user-1",
        name: user?.name ?? null,
        email: user?.email ?? null,
        role,
        org: owner?.id ?? null,
        plan: owner?.plan ?? "local",
        serverOrg: owner?.id ?? null,
      });
      children.set(place.id, c);
    }
    return c;
  };

  /** One place's request, forwarded to its own mock server (images too) and streamed back, `/api/live` included. */
  const forward = async (req: IncomingMessage, res: ServerResponse, id: string, rest: string, search: string) => {
    if (!user) return fail(res, "not_configured", "Sign in to Dorks Cloud first.");
    const place = findPlace(id);
    if (!place) return fail(res, "not_found", "No such server.");
    // What the relay answers while the server's socket is down.
    if (!place.online) return json(res, 503, { error: { code: "offline", message: `${place.name} is offline.` } });
    const c = await child(place);
    const path = rest.startsWith("api/images/") && req.method === "GET" ? rest.slice(4) : rest;
    const chunks: Buffer[] = [];
    if (req.method !== "GET" && req.method !== "HEAD") for await (const chunk of req) chunks.push(chunk as Buffer);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const headers: Record<string, string> = { authorization: `Bearer ${c.token}` };
    for (const k of ["content-type", "accept"]) if (typeof req.headers[k] === "string") headers[k] = req.headers[k];
    const up = await fetch(`${c.url}/${path}${search}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, signal: abort.signal }).catch(() => null);
    if (!up) return fail(res, "failed", "The server did not answer.");
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
    if (!up.body) return void res.end();
    try {
      for await (const part of up.body) res.write(part);
    } catch {
      // The page went away (an SSE stream closed).
    }
    res.end();
  };

  /** The `dorks://auth` link's code and state: any code, the state the mock handed out. */
  const signIn = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await opts.readBody(req).catch(() => ({}) as Record<string, unknown>);
    if (body.state !== MOCK_STATE || typeof body.code !== "string" || !body.code) return fail(res, "invalid", "This sign-in link is not from this app, or it expired. Press Sign in again.");
    user = { ...DEMO };
    opts.broadcast({ t: "settings" });
    return json(res, 200, status());
  };

  /** The Worker-run org's realtime routes, as the member (what the home server's `/api/cloud/orgs/:id/realtime/*` does). */
  const realtime = async (req: IncomingMessage, res: ServerResponse, rest: string) => {
    if (!runtime) return fail(res, "not_found", "No such organization.");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const up = await fetch(`${runtime.url}/v1/realtime/orgs/${encodeURIComponent(runtime.orgId)}/${rest}`, {
      method: req.method,
      headers: { authorization: `Bearer ${runtime.token}`, "content-type": "application/json" },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    }).catch(() => null);
    if (!up) return fail(res, "failed", "Dorks Cloud did not answer.");
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await up.arrayBuffer()));
  };

  /** A route of the Worker-run org's UI API, on the real Worker (`/v1/orgs/:id/<rest>`), as the member. */
  const worker = async (req: IncomingMessage, res: ServerResponse, rest: string, search: string) => {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await opts.readBody(req).catch(() => undefined);
    const up = await fetch(`${runtime!.url}/v1/orgs/${encodeURIComponent(runtime!.orgId)}/${rest}${search}`, {
      method: req.method,
      headers: { authorization: `Bearer ${runtime!.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
    res.end(await up.text());
  };

  /** The Worker-run org's UI API (its own mock server) and realtime routes; false for any other path. */
  const orgRoute = async (req: IncomingMessage, res: ServerResponse, path: string, search: string) => {
    const image = req.method === "GET" ? /^\/cloud\/orgs\/([\w-]+)\/images\/([\w-]+)$/.exec(path) : null;
    const org = image ? [path, image[1], `api/images/${image[2]}`, "api"] : /^\/api\/cloud\/orgs\/([\w-]+)\/((api|realtime)\/.*)$/.exec(path);
    if (!org || !runtime || org[1] !== runtime.orgId) return false;
    if (!user) fail(res, "not_configured", "Sign in to Dorks Cloud first.");
    else if (org[3] === "realtime") await realtime(req, res, org[2]!.slice("realtime/".length));
    // The Twin Engine's routes only the Worker has: to the real one, as the member (Settings › Twin Engine, live).
    else if (/^api\/(prodlike|data-source)(\/|$)/.test(org[2]!)) await worker(req, res, org[2]!, search);
    else await forward(req, res, runtimePlace!.id, org[2]!, search);
    return true;
  };

  /** An org's entitlements (and, mock only, `PUT` to switch the Cloud org's state) and its Stripe pages; false for an unknown method. */
  const billingRoute = async (req: IncomingMessage, res: ServerResponse, method: string, orgId: string, page: string): Promise<boolean> => {
    const org = orgs.find((o) => o.id === orgId);
    if (!user) fail(res, "not_configured", "Sign in to Dorks Cloud first.");
    else if (!org) fail(res, "not_found", "No such organization");
    else if (page === "entitlements" && method === "GET") json(res, 200, mockEntitlements(org.plan, cloudPlan));
    else if (page === "entitlements" && method === "PUT") {
      // Mock only: switch the Cloud org's billing state (screenshots, demos).
      const body = await opts.readBody(req).catch(() => ({}) as Record<string, unknown>);
      if (!(MOCK_CLOUD_PLANS as readonly unknown[]).includes(body.scenario)) fail(res, "invalid", `scenario is one of ${MOCK_CLOUD_PLANS.join(", ")}`);
      else {
        cloudPlan = body.scenario as MockCloudPlan;
        json(res, 200, mockEntitlements(org.plan, cloudPlan));
      }
    } else if (method !== "POST") return false;
    else if (teams.roleOf(org.id) !== "owner" && org.role !== "owner") fail(res, "forbidden", "Only the owner of this team can change its billing");
    else json(res, 200, { url: `https://billing.stripe.com/mock/${page === "billing/portal" ? "portal" : "checkout"}?org=${org.id}` });
    return true;
  };

  /** The mock's sessions of the account (Settings › Account): this computer and a phone, until it is signed out. */
  let sessions = [
    { id: "mock-this", createdAt: "2026-11-01T09:00:00Z", updatedAt: new Date().toISOString(), expiresAt: "2026-12-31T00:00:00Z", ipAddress: null, userAgent: "Bun/1.3", current: true },
    {
      id: "mock-phone",
      createdAt: "2026-11-02T09:00:00Z",
      updatedAt: "2026-11-20T18:00:00Z",
      expiresAt: "2026-12-31T00:00:00Z",
      ipAddress: "192.0.2.10",
      userAgent: "Dorks/1 CFNetwork Darwin",
      current: false,
    },
  ];
  /** A picture upload, kept as a data URL (the real cloud crops it and serves it from R2). */
  const picture = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return `data:${req.headers["content-type"] ?? "image/png"};base64,${Buffer.concat(chunks).toString("base64")}`;
  };
  /** The profile routes (services/cloudAccount.ts cloudProfile); false for anything else. */
  const accountRoute = async (req: IncomingMessage, res: ServerResponse, method: string, path: string): Promise<boolean> => {
    const logo = /^\/api\/cloud\/orgs\/([\w-]+)\/logo$/.exec(path);
    if (!logo && !path.startsWith("/api/cloud/account")) return false;
    if (!user) return (fail(res, "not_configured", "Sign in to Dorks Cloud first."), true);
    const changed = (body: unknown) => (opts.broadcast({ t: "settings" }), json(res, 200, body));
    const r = `${method} ${logo ? "/api/cloud/orgs/:id/logo" : path}`;
    if (r === "GET /api/cloud/account") json(res, 200, { user, sessions });
    else if (r === "PATCH /api/cloud/account") {
      const body = await opts.readBody(req).catch(() => ({}) as Record<string, unknown>);
      if (typeof body.name !== "string" || !body.name.trim()) fail(res, "invalid", "Enter a name");
      else changed((user = { ...user, name: body.name.trim() }));
    } else if (r === "PUT /api/cloud/account/avatar") changed((user = { ...user, image: await picture(req) }));
    else if (r === "DELETE /api/cloud/account/avatar") changed((user = { ...user, image: null }));
    else if (r === "DELETE /api/cloud/account/sessions") (json(res, 200, { signedOut: sessions.length - 1 }), (sessions = sessions.filter((s) => s.current)));
    else if (method === "DELETE" && path.startsWith("/api/cloud/account/sessions/")) (json(res, 200, {}), (sessions = sessions.filter((s) => s.id !== path.split("/").pop())));
    else if (logo) {
      const org = orgs.find((o) => o.id === logo[1]);
      if (!org) fail(res, "not_found", "No such organization");
      else changed({ logo: (org.logo = method === "PUT" ? await picture(req) : null) });
    } else fail(res, "not_found", "Not found");
    return true;
  };

  /** Answers a cloud route; false for anything else. */
  const route = async (req: IncomingMessage, res: ServerResponse, method: string, path: string, search: string): Promise<boolean> => {
    if (await orgRoute(req, res, path, search)) return true;
    if (await accountRoute(req, res, method, path)) return true;
    const fwd = /^\/api\/cloud\/servers\/([\w-]+)\/(api\/.*)$/.exec(path) ?? (method === "GET" ? /^\/cloud\/servers\/([\w-]+)\/(images\/[\w-]+)$/.exec(path) : null);
    if (fwd) {
      await forward(req, res, fwd[1]!, fwd[2]!.startsWith("images/") ? `api/${fwd[2]}` : fwd[2]!, search);
      return true;
    }
    // The org's plan (Dorks Cloud's entitlements) and its Stripe pages, as the home server forwards them.
    const billing = /^\/api\/cloud\/orgs\/([\w-]+)\/(entitlements|billing\/portal|billing\/checkout)$/.exec(path);
    if (billing) return billingRoute(req, res, method, billing[1]!, billing[2]!);
    const team = /^\/api\/cloud\/auth\/organization\/([\w-]+)$/.exec(path);
    if (team) {
      await teams.route(req, res, method, team[1]!, search);
      return true;
    }
    const route = `${method} ${path}`;
    if (route === "GET /api/cloud") json(res, 200, status());
    else if (route === "POST /api/cloud/sign-in") json(res, 200, { url: `https://dorks.build/login?next=%2Fonboarding&app=1&state=${MOCK_STATE}` });
    else if (route === "POST /api/cloud/sign-in/finish") await signIn(req, res);
    else if (route === "DELETE /api/cloud/session") {
      user = null;
      opts.broadcast({ t: "settings" });
      json(res, 200, {});
    } else if (route === "GET /api/cloud/places") {
      if (!user) fail(res, "not_configured", "Sign in to Dorks Cloud first.");
      else json(res, 200, { orgs: orgs.map(view) });
    } else if (route === "POST /api/cloud/orgs") {
      const body = await opts.readBody(req).catch(() => ({}) as Record<string, unknown>);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!user) fail(res, "not_configured", "Sign in to Dorks Cloud first.");
      else if (!name) fail(res, "invalid", "Name the organization");
      else {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const org: MockOrg = { id: `org-${slug}-${orgs.length}`, name, slug, logo: null, personal: false, plan: "local", role: "owner", servers: [] };
        orgs.push(org);
        teams.created(org.id);
        json(res, 200, view(org));
      }
    } else return false;
    return true;
  };
  return {
    route,
    /** Closes every place's server. */
    async close() {
      for (const c of children.values()) await (await c).close();
    },
  };
}
