import { planOf, type PlanId } from "@dorks/shared";
import { rememberPlan } from "./plan";
import { fail, OWNER, touch, type App } from "../app";
import { aad, decrypt, encrypt } from "@dorks/core/crypto";
import { update } from "../db";
import { randomBytes } from "node:crypto";

// The Dorks Cloud account (docs/mobile.md, "Desktop: Dorks Cloud"): the owner signs this server in to the relay in the browser, with
// the same account the phone uses. The app opens the site's sign-in with a one-time `state` from here; the site hands back a
// `dorks://auth?code&state` link, and this server checks the state and redeems the code for a session (`/v1/app-handoff/redeem`). The session token is kept encrypted in settings (`cloud_session_enc`) and never
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

/** One signed-in session of the account (`GET /v1/me/sessions`, never its token); `current` is this server's own. */
export interface CloudSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Settings › Account: the account, read fresh from the relay, and where it is signed in. */
export interface CloudAccountView {
  user: CloudUser;
  sessions: CloudSession[];
}

/** Profile pictures and org logos: what the relay accepts (it checks again, and crops them to a square). */
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_PICTURE_BYTES = 2 * 1024 * 1024;

interface Session {
  token: string;
  user: CloudUser;
}

const cloudOf = (app: App) => app.cfg.cloudUrl?.replace(/\/+$/, "") || null;

/** How long a browser sign-in may take, from opening the page to the `dorks://auth` link (onboarding included). */
const HANDOFF_TTL_MS = 30 * 60_000;
/** Open browser sign-ins (their `state`, by app): in memory, so a restart only means pressing Sign in again. A few at most. */
const handoffs = new WeakMap<App, Map<string, number>>();

function openHandoffs(app: App): Map<string, number> {
  let m = handoffs.get(app);
  if (!m) handoffs.set(app, (m = new Map()));
  for (const [state, expiresAt] of m) if (expiresAt <= app.now()) m.delete(state);
  return m;
}

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
    ...(o?.runtime === "cloud" || o?.runtime === "mac" ? { runtime: o.runtime } : {}),
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
  /** One request to Dorks Cloud as the signed-in account (the import API of services/cloudMove.ts). An ended session fails here. */
  async request(app: App, path: string, init: RequestInit): Promise<Response> {
    const s = await signedIn(app);
    const res = await call(app, path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${s.token}` } });
    if (res.status === 401) await expired(app);
    return res;
  },

  async view(app: App): Promise<CloudView> {
    const cloudUrl = cloudOf(app);
    return { cloudUrl, user: cloudUrl ? ((await readSession(app))?.user ?? null) : null };
  },

  /**
   * Starts a browser sign-in: the site's sign-in page (then onboarding for a new account) with a fresh one-time `state`, which the
   * `dorks://auth` link must bring back. The app opens the URL in the default browser.
   */
  startSignIn(app: App): { url: string } {
    needCloud(app);
    const open = openHandoffs(app);
    // Only the newest few stay open: an old tab cannot sign this app in long after.
    for (const state of [...open.keys()].slice(0, Math.max(0, open.size - 4))) open.delete(state);
    const state = randomBytes(24).toString("base64url");
    open.set(state, app.now() + HANDOFF_TTL_MS);
    const site = (app.cfg.siteUrl || "https://dorks.build").replace(/\/+$/, "");
    const url = new URL(`${site}/login`);
    url.search = new URLSearchParams({ next: "/onboarding", app: "1", state }).toString();
    return { url: url.toString() };
  },

  /**
   * Finishes it with the `dorks://auth` link's `code` and `state`: the state must be one this server opened (used once), and the
   * relay trades the code for a Better Auth session token (`POST /v1/app-handoff/redeem`), kept encrypted like before.
   */
  async finishSignIn(app: App, code: string, state: string): Promise<CloudView> {
    needCloud(app);
    const open = openHandoffs(app);
    if (!open.delete(state)) fail("invalid", "This sign-in link is not from this app, or it expired. Press Sign in again.");
    const res = await call(app, "/v1/app-handoff/redeem", jsonPost({ code, state }));
    if (!res.ok) await refused(res, "Dorks Cloud did not accept the sign-in");
    const body = (await readJson(res)) as { token?: unknown; user?: unknown } | null;
    const token = str(body?.token);
    if (!token) fail("failed", "Dorks Cloud answered without a session");
    const user = userOf(body?.user) ?? (await sessionUser(app, token));
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
    rememberPlan(app, orgs);
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
   * `/v1/realtime/orgs/:id/...`). Also its plan, for any org of the account: `entitlements` (GET, `/v1/orgs/:id/entitlements`), and
   * the browser pages that change it, `billing/portal` and `billing/checkout` (POST, `/v1/billing/orgs/:id/...`, answering `{url}`).
   * Anything else, or a path that tries to climb out, is refused.
   */
  async forwardOrg(app: App, orgId: string, rest: string, req: Request): Promise<Response> {
    const id = encodeURIComponent(orgId);
    if (/^[\w-]{1,128}$/.test(orgId) && req.method === "GET" && rest === "entitlements") return relay(app, `/v1/orgs/${id}/entitlements`, req);
    if (/^[\w-]{1,128}$/.test(orgId) && req.method === "POST" && /^billing\/(portal|checkout)$/.test(rest)) return relay(app, `/v1/billing/orgs/${id}/${rest.slice("billing/".length)}`, req);
    if (!/^[\w-]{1,128}$/.test(orgId) || !/^(api|realtime)\/[\w./-]*$/.test(rest) || /(^|\/)\.\.?(\/|$)|\/\//.test(rest)) fail("invalid", "Not an organization path");
    return relay(app, rest.startsWith("realtime/") ? `/v1/realtime/orgs/${id}/${rest.slice("realtime/".length)}` : `/v1/orgs/${id}/${rest}`, req);
  },
};

/** A picture for the relay: its type and size checked here first, so a wrong file fails without a round trip. */
function picture(bytes: Uint8Array, type: string): RequestInit {
  if (!(PICTURE_TYPES as readonly string[]).includes(type)) fail("invalid", "Choose a PNG, JPEG or WebP picture");
  if (bytes.length > MAX_PICTURE_BYTES) fail("invalid", "Pictures can be at most 2 MB");
  if (bytes.length === 0) fail("invalid", "That file is empty");
  return { method: "POST", headers: { "content-type": type }, body: bytes };
}

/** One account call; a refusal becomes the relay's own message. */
async function accountCall(app: App, path: string, init: RequestInit, what: string): Promise<unknown> {
  const res = await cloudAccount.request(app, path, init);
  if (!res.ok) await refused(res, what);
  return readJson(res);
}

/** Reads the account again and keeps it, so the switcher and attribution show a new name or picture at once. */
async function refreshUser(app: App): Promise<CloudUser> {
  const s = await signedIn(app);
  const res = await call(app, "/api/auth/get-session", { headers: { authorization: `Bearer ${s.token}` } });
  if (res.status === 401) await expired(app);
  if (!res.ok) await refused(res, "Dorks Cloud could not read your account");
  const user = userOf(((await readJson(res)) as { user?: unknown } | null)?.user);
  if (!user) await expired(app);
  if (JSON.stringify(user) !== JSON.stringify(s.user)) await saveSession(app, { ...s, user: user! });
  return user!;
}

function sessionOf(v: unknown): CloudSession | null {
  const s = v as Record<string, unknown> | null;
  const id = str(s?.id);
  if (!id) return null;
  return {
    id,
    createdAt: str(s?.createdAt) ?? "",
    updatedAt: str(s?.updatedAt) ?? "",
    expiresAt: str(s?.expiresAt) ?? "",
    ipAddress: str(s?.ipAddress),
    userAgent: str(s?.userAgent),
    current: s?.current === true,
  };
}

/**
 * Settings › Account (docs/cloud.md): the profile is edited here, in the app, never in a browser page. The name goes to Better Auth's
 * `update-user`; the picture and org logos are uploaded to the relay (`/v1/me/avatar`, `/v1/orgs/:id/logo`), which crops them to a
 * square and serves them; sessions are listed and signed out by id (`/v1/me/sessions`), the tokens never leaving the relay.
 */
export const cloudProfile = {
  async view(app: App): Promise<CloudAccountView> {
    const user = await refreshUser(app);
    const sessions = list(await accountCall(app, "/v1/me/sessions", {}, "Dorks Cloud could not list your sessions"), sessionOf);
    return { user, sessions };
  },

  async rename(app: App, name: string): Promise<CloudUser> {
    await accountCall(app, "/api/auth/update-user", jsonPost({ name }), "Dorks Cloud could not rename your account");
    return refreshUser(app);
  },

  async setAvatar(app: App, bytes: Uint8Array, type: string): Promise<CloudUser> {
    await accountCall(app, "/v1/me/avatar", picture(bytes, type), "Dorks Cloud did not take the picture");
    return refreshUser(app);
  },

  async removeAvatar(app: App): Promise<CloudUser> {
    await accountCall(app, "/v1/me/avatar", { method: "DELETE" }, "Dorks Cloud could not remove the picture");
    return refreshUser(app);
  },

  /** Signs one of the account's other sessions out (a phone, a browser, another Mac). This server's own is Sign out. */
  async signOutSession(app: App, id: string): Promise<void> {
    if (!/^[\w-]{1,128}$/.test(id)) fail("invalid", "Not a session");
    await accountCall(app, `/v1/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }, "Dorks Cloud could not sign that session out");
  },

  async signOutOthers(app: App): Promise<{ signedOut: number }> {
    const out = (await accountCall(app, "/v1/me/sessions", { method: "DELETE" }, "Dorks Cloud could not sign the other sessions out")) as { signedOut?: unknown } | null;
    return { signedOut: typeof out?.signedOut === "number" ? out.signedOut : 0 };
  },

  /** The org's logo (owners and admins; the relay decides). Returns its URL, null once removed. */
  async setOrgLogo(app: App, orgId: string, bytes: Uint8Array | null, type = ""): Promise<{ logo: string | null }> {
    if (!/^[\w-]{1,128}$/.test(orgId)) fail("invalid", "Not an organization");
    const path = `/v1/orgs/${encodeURIComponent(orgId)}/logo`;
    const out = (await accountCall(app, path, bytes ? picture(bytes, type) : { method: "DELETE" }, "Dorks Cloud did not take the logo")) as { logo?: unknown } | null;
    return { logo: str(out?.logo) };
  },
};

/** The account behind a fresh session token (Better Auth `get-session`, with the bearer plugin). */
async function sessionUser(app: App, token: string): Promise<CloudUser> {
  const res = await call(app, "/api/auth/get-session", { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) await refused(res, "Dorks Cloud did not accept the sign-in");
  return userOf(((await readJson(res)) as { user?: unknown } | null)?.user) ?? fail("failed", "Dorks Cloud answered without an account");
}

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
