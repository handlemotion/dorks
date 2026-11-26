// The mock's stand-in for Dorks Cloud (docs/mobile.md, "Desktop: Dorks Cloud"): the local server's `/api/cloud` routes, with a
// fake email-code sign-in (any address, any six digits), the account's places (Macs, and organizations with the servers Dorks runs for them),
// and `/api/cloud/servers/:id/api/*`, answered by a separate in-memory mock server per place, so switching really re-points the app.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudOrg, CloudServer, CloudStatus, CloudUser, Me } from "./types.ts";
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
    role: "admin",
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

export function mockCloud(opts: {
  signedIn?: boolean;
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
  const orgs = ORGS.map((o) => ({ ...o }));
  const teams = mockTeams({ orgs, me: () => user, json, fail, readBody: opts.readBody });
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
  const findPlace = (id: string) => orgs.flatMap((o) => o.servers).find((s) => s.id === id);
  const child = (place: MockCloudPlace) => {
    let c = children.get(place.id);
    if (!c) {
      // It answers `GET /api/me` as you, a teammate with your role in the org that owns it.
      const owner = orgs.find((o) => o.servers.some((s) => s.id === place.id));
      const role = ((owner && teams.roleOf(owner.id)) ?? "member") as Me["role"];
      c = opts.startChild(place.seed, {
        kind: "member",
        id: "user-1",
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

  const signIn = async (req: IncomingMessage, res: ServerResponse, verify: boolean) => {
    const body = await opts.readBody(req).catch(() => ({}) as Record<string, unknown>);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return fail(res, "invalid", "Enter your email");
    if (!verify) return json(res, 200, {});
    const code = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : "";
    if (!/^\d{6}$/.test(code)) return fail(res, "invalid", "That code did not work");
    user = { ...DEMO, email, name: email.split("@")[0]! };
    opts.broadcast({ t: "settings" });
    return json(res, 200, status());
  };

  /** Answers a cloud route; false for anything else. */
  const route = async (req: IncomingMessage, res: ServerResponse, method: string, path: string, search: string): Promise<boolean> => {
    const fwd = /^\/api\/cloud\/servers\/([\w-]+)\/(api\/.*)$/.exec(path) ?? (method === "GET" ? /^\/cloud\/servers\/([\w-]+)\/(images\/[\w-]+)$/.exec(path) : null);
    if (fwd) {
      await forward(req, res, fwd[1]!, fwd[2]!.startsWith("images/") ? `api/${fwd[2]}` : fwd[2]!, search);
      return true;
    }
    const team = /^\/api\/cloud\/auth\/organization\/([\w-]+)$/.exec(path);
    if (team) {
      await teams.route(req, res, method, team[1]!, search);
      return true;
    }
    const route = `${method} ${path}`;
    if (route === "GET /api/cloud") json(res, 200, status());
    else if (route === "POST /api/cloud/sign-in/email") await signIn(req, res, false);
    else if (route === "POST /api/cloud/sign-in/verify") await signIn(req, res, true);
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
