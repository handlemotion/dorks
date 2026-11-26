import { planOf, type PlanId } from "@dorks/shared";
import { fail, OWNER, touch, type App } from "../app";
import { aad, decrypt, encrypt } from "../core/crypto";
import { update } from "../db";

// The Dorks Cloud account (docs/mobile.md, "Desktop: Dorks Cloud"): the owner signs this server in to the relay with Better Auth's
// email code, the same account the phone uses. The session token is kept encrypted in settings (`cloud_session_enc`) and never
// leaves this server: the UI reads the account's places (its Macs, its organizations and the servers Dorks runs for them) through
// `GET /api/cloud/places` (`/v1/orgs`), and talks to another server through `/api/cloud/servers/:id/api/*`, which this server forwards to the
// relay's `/v1/macs/:id/api/*` with the session. The relay and the server it reaches decide what that may do.

export interface CloudUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface CloudView {
  /** The relay's origin; null when `DORKS_CLOUD_URL` is empty (the cloud is off). */
  cloudUrl: string | null;
  /** The signed-in account; null when signed out. */
  user: CloudUser | null;
}

/** A server an organization owns (`GET /v1/orgs`): a member's Mac (`mac`) or the organization's always-on server (`hosted`). */
export interface CloudServer {
  id: string;
  name: string;
  kind: "mac" | "hosted";
  online: boolean;
  lastSeenAt: number | null;
}

/**
 * A Dorks Cloud organization (Better Auth's organization plugin, `GET /v1/orgs`). Every account has one `personal` org; teams are
 * the others. `plan` is its plan (`local`, `teams`, `cloud`; the cloud's older `free` and `collab` read as `local` and `teams`), `role` the account's role in it, `servers` what it can work on.
 */
export interface CloudOrg {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  personal: boolean;
  plan: PlanId | null;
  role: string | null;
  active: boolean;
  servers: CloudServer[];
}

export interface CloudPlaces {
  orgs: CloudOrg[];
}

interface Session {
  token: string;
  user: CloudUser;
}

const cloudOf = (app: App) => app.cfg.cloudUrl?.replace(/\/+$/, "") || null;

function needCloud(app: App): string {
  return cloudOf(app) ?? fail("not_configured", "Dorks Cloud is turned off (DORKS_CLOUD_URL is empty)");
}

async function readSession(app: App): Promise<Session | null> {
  const r = app.db.get<{ cloud_session_enc: string | null }>("SELECT cloud_session_enc FROM settings WHERE id = 1");
  if (!r?.cloud_session_enc) return null;
  try {
    return JSON.parse(await decrypt(app.ring, r.cloud_session_enc, aad.cloudSession(OWNER))) as Session;
  } catch {
    return null;
  }
}

async function saveSession(app: App, s: Session | null) {
  const enc = s ? (await encrypt(app.ring, JSON.stringify(s), aad.cloudSession(OWNER))).value : null;
  app.db.tx(() => {
    update(app.db, "settings", { id: 1 }, { cloudSessionEnc: enc });
    touch(app, { t: "settings" });
  });
}

/** A relay call; a network failure is a plain `failed` the UI can show. */
async function call(app: App, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await app.fetch(`${needCloud(app)}${path}`, init);
  } catch {
    fail("failed", "Cannot reach Dorks Cloud. Check your connection and try again.");
  }
}

const readJson = async (res: Response): Promise<unknown> => res.json().catch(() => null);

/** The relay's own error message, else a plain one with the status. */
async function refused(res: Response, what: string): Promise<never> {
  const body = (await readJson(res)) as { message?: unknown; error?: { message?: unknown } } | null;
  const msg = typeof body?.message === "string" ? body.message : typeof body?.error?.message === "string" ? body.error.message : `${what} (${res.status})`;
  fail(res.status === 429 ? "rate_limited" : res.status >= 500 ? "failed" : "invalid", msg.slice(0, 200));
}

const jsonPost = (body: unknown, token?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

const str = (v: unknown) => (typeof v === "string" ? v : null);

function userOf(v: unknown): CloudUser | null {
  const u = v as Record<string, unknown> | null;
  const id = str(u?.id);
  if (!id) return null;
  const email = str(u?.email) ?? "";
  return { id, email, name: str(u?.name) || email, image: str(u?.image) };
}

function serverOf(v: unknown): CloudServer | null {
  const m = v as Record<string, unknown> | null;
  const id = str(m?.macId) ?? str(m?.id);
  if (!id) return null;
  const seen = m?.lastSeenAt;
  const lastSeenAt = typeof seen === "number" ? seen : typeof seen === "string" ? Date.parse(seen) || null : null;
  return { id, name: str(m?.name) || "Mac", kind: m?.kind === "hosted" ? "hosted" : "mac", online: m?.online === true, lastSeenAt };
}

function orgOf(v: unknown): CloudOrg | null {
  const o = v as Record<string, unknown> | null;
  const id = str(o?.id);
  if (!id) return null;
  return {
    id,
    name: str(o?.name) || "Organization",
    slug: str(o?.slug),
    logo: str(o?.logo),
    personal: o?.personal === true,
    plan: planOf(o?.plan),
    role: str(o?.role),
    active: o?.active === true,
    servers: list(o?.servers, serverOf),
  };
}

/** A relay without `/v1/orgs` yet: its Macs, grouped by the org each names, else all in one personal org. */
function orgsFromMacs(macs: unknown): CloudOrg[] {
  const orgs = new Map<string, CloudOrg>();
  for (const m of Array.isArray(macs) ? macs : []) {
    const server = serverOf(m);
    if (!server) continue;
    const org = (m as { org?: Record<string, unknown> }).org;
    const id = str(org?.id) ?? "personal";
    const personal = org ? org.personal === true : true;
    const entry = orgs.get(id) ?? {
      id,
      name: str(org?.name) || "Personal",
      slug: null,
      logo: str(org?.logo),
      personal,
      plan: null,
      role: str((m as { role?: unknown }).role),
      active: false,
      servers: [],
    };
    entry.servers.push(server);
    orgs.set(id, entry);
  }
  return [...orgs.values()];
}

const list = <T>(v: unknown, f: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v.map(f).filter((x): x is T => x !== null) : []);

/**
 * The relay said the session is over: forget it, so the UI asks to sign in again. `not_configured`, never `forbidden`: that one is
 * a 401, which the UI reads as this server rejecting its owner token.
 */
async function expired(app: App): Promise<never> {
  await saveSession(app, null);
  fail("not_configured", "Your Dorks Cloud session ended. Sign in again.");
}

async function signedIn(app: App): Promise<Session> {
  return (await readSession(app)) ?? fail("not_configured", "Sign in to Dorks Cloud first.");
}

/** Better Auth's organization endpoints the UI may call through this server, by method. */
const ORG_ACTIONS: Record<string, "GET" | "POST"> = {
  "get-full-organization": "GET",
  "list-user-invitations": "GET",
  "get-invitation": "GET",
  "invite-member": "POST",
  "cancel-invitation": "POST",
  "accept-invitation": "POST",
  "reject-invitation": "POST",
  "update-member-role": "POST",
  "remove-member": "POST",
  leave: "POST",
  update: "POST",
  delete: "POST",
};

export const cloudAccount = {
  async view(app: App): Promise<CloudView> {
    const cloudUrl = cloudOf(app);
    return { cloudUrl, user: cloudUrl ? ((await readSession(app))?.user ?? null) : null };
  },

  /** Emails a six-digit sign-in code (Better Auth `emailOTP`). */
  async sendCode(app: App, email: string): Promise<void> {
    const res = await call(app, "/api/auth/email-otp/send-verification-otp", jsonPost({ email, type: "sign-in" }));
    if (!res.ok) await refused(res, "Dorks Cloud could not send a code");
  },

  /** Signs in with the emailed code and keeps the session (the bearer plugin's `set-auth-token`, else the body's token). */
  async verifyCode(app: App, email: string, otp: string): Promise<CloudView> {
    const res = await call(app, "/api/auth/sign-in/email-otp", jsonPost({ email, otp }));
    if (!res.ok) await refused(res, "That code did not work");
    const body = (await readJson(res)) as { token?: unknown; user?: unknown } | null;
    const token = res.headers.get("set-auth-token") || str(body?.token);
    const user = userOf(body?.user);
    if (!token || !user) fail("failed", "Dorks Cloud answered without a session");
    await saveSession(app, { token, user });
    return { cloudUrl: cloudOf(app), user };
  },

  async signOut(app: App): Promise<void> {
    const s = await readSession(app);
    await saveSession(app, null);
    // Best effort: the session is forgotten here either way.
    if (s && cloudOf(app)) await app.fetch(`${cloudOf(app)}/api/auth/sign-out`, jsonPost({}, s.token)).catch(() => {});
  },

  /** The account's organizations (personal first) with the servers each owns. */
  async places(app: App): Promise<CloudPlaces> {
    const s = await signedIn(app);
    const auth = { headers: { authorization: `Bearer ${s.token}` } };
    let res = await call(app, "/v1/orgs", auth);
    if (res.status === 401) await expired(app);
    const fromMacs = res.status === 404;
    if (fromMacs) res = await call(app, "/v1/macs", auth);
    if (!res.ok) await refused(res, "Dorks Cloud could not list your organizations");
    const orgs = fromMacs ? orgsFromMacs(await readJson(res)) : list(await readJson(res), orgOf);
    return { orgs: orgs.toSorted((a, b) => Number(b.personal) - Number(a.personal)) };
  },

  /** A new team (Better Auth `organization/create`), owned by the account; it becomes the session's active org. */
  async createOrg(app: App, name: string): Promise<CloudOrg> {
    const s = await signedIn(app);
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "team";
    const slug = `${base}-${app.uuid().replace(/-/g, "").slice(0, 6)}`;
    const res = await call(app, "/api/auth/organization/create", jsonPost({ name, slug }, s.token));
    if (res.status === 401) await expired(app);
    if (!res.ok) await refused(res, "Dorks Cloud could not create the organization");
    const org = orgOf({ ...((await readJson(res)) as object), role: "owner", active: true });
    if (!org) fail("failed", "Dorks Cloud answered without an organization");
    return org;
  },

  /**
   * One of Better Auth's organization endpoints (team management, docs/cloud.md), as the signed-in account: members, invitations,
   * roles, leaving, renaming, deleting. Only the actions below; the relay decides who may do what. Its refusals come back as AppErrors
   * (`limit` for MEMBER_LIMIT_REACHED), never as a 401, which the UI would read as this server rejecting its owner token.
   */
  async orgAction(app: App, action: string, method: string, search: string, body: unknown): Promise<unknown> {
    const allowed = ORG_ACTIONS[action];
    if (!allowed || allowed !== method) fail("not_found", "Unknown organization action");
    const s = await signedIn(app);
    const init: RequestInit = method === "GET" ? { headers: { authorization: `Bearer ${s.token}` } } : jsonPost(body ?? {}, s.token);
    const res = await call(app, `/api/auth/organization/${action}${search}`, init);
    if (res.status === 401) await expired(app);
    const out = await readJson(res);
    if (!res.ok) {
      const b = out as { code?: unknown; message?: unknown } | null;
      const message = (typeof b?.message === "string" && b.message) || `Dorks Cloud refused (${res.status})`;
      fail(b?.code === "MEMBER_LIMIT_REACHED" ? "limit" : res.status === 404 ? "not_found" : res.status === 429 ? "rate_limited" : res.status >= 500 ? "failed" : "invalid", message.slice(0, 200));
    }
    return out ?? {};
  },

  /**
   * Forwards one UI API request to a server through the relay (`/v1/macs/:id/${rest}`), streaming the answer back (`/api/live`
   * included). `rest` is `api/...` or `api/images/:id`; anything else, or a path that tries to climb out, is refused.
   */
  async forward(app: App, serverId: string, rest: string, req: Request): Promise<Response> {
    if (!/^[\w-]{1,128}$/.test(serverId) || !/^api\/[\w./-]*$/.test(rest) || /(^|\/)\.\.?(\/|$)|\/\//.test(rest)) fail("invalid", "Not a server path");
    return relay(app, `/v1/macs/${encodeURIComponent(serverId)}/${rest}`, req);
  },

  /**
   * Forwards one request for an org the Worker runs (Teams, Cloud; docs/architecture.md, "Live updates for cloud orgs"): its UI API
   * (`api/...` to `/v1/orgs/:id/api/...`) or its realtime routes, which issue the s2 read tokens (`realtime/...` to
   * `/v1/realtime/orgs/:id/...`). Anything else, or a path that tries to climb out, is refused.
   */
  async forwardOrg(app: App, orgId: string, rest: string, req: Request): Promise<Response> {
    if (!/^[\w-]{1,128}$/.test(orgId) || !/^(api|realtime)\/[\w./-]*$/.test(rest) || /(^|\/)\.\.?(\/|$)|\/\//.test(rest)) fail("invalid", "Not an organization path");
    const id = encodeURIComponent(orgId);
    return relay(app, rest.startsWith("realtime/") ? `/v1/realtime/orgs/${id}/${rest.slice("realtime/".length)}` : `/v1/orgs/${id}/${rest}`, req);
  },
};

/** One request to Dorks Cloud as the signed-in account, its answer streamed back. */
async function relay(app: App, path: string, req: Request): Promise<Response> {
  const s = await signedIn(app);
  const url = new URL(req.url);
  const headers: Record<string, string> = { authorization: `Bearer ${s.token}` };
  for (const k of ["content-type", "accept"]) {
    const v = req.headers.get(k);
    if (v) headers[k] = v;
  }
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();
  let res: Response;
  try {
    res = await app.fetch(`${needCloud(app)}${path}${url.search}`, { method, headers, body, signal: req.signal });
  } catch {
    fail("failed", "Cannot reach Dorks Cloud. Check your connection and try again.");
  }
  const out = new Headers();
  for (const k of ["content-type", "cache-control"]) {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}
