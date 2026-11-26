import type { Context } from "hono";
import { planOf, type PlanId } from "@dorks/shared";
import type { App } from "../app";

// Who is asking (docs/cloud.md, "This server"). The local owner holds the owner token on loopback and may do anything. Everyone else
// is a member of the server's dorks-cloud organization, reaching it through the relay, and proves it with a short-lived JWT the
// cloud signed, in the `x-dorks-actor` header of each relayed request. The server checks the signature against
// the cloud's JWKS itself (core/jwt.ts), so the relay is trusted with nothing; it then lets the request through only when the
// member's role allows it (`teamAllowed`). A relayed request without a token is the single-owner phone of docs/mobile.md, allowed only
// while this server has no organization yet, and only what the phone allowlist allows.

export type Role = "owner" | "admin" | "member";
export type Plan = PlanId;
const ROLES: readonly Role[] = ["owner", "admin", "member"];

/** A person in the organization, as their token names them. */
export interface Member {
  id: string;
  name: string;
  email: string;
  org: string;
  role: Role;
  plan: Plan;
}

export type Actor =
  /** The owner token on loopback: this computer's owner. */
  | { kind: "local" }
  /** A relayed request without an identity token: the paired owner's phone (docs/mobile.md), on the phone allowlist. */
  | { kind: "phone" }
  | { kind: "member"; member: Member };

export const LOCAL: Actor = { kind: "local" };

/** Who did something, as stored with it (a message, a dork, an automation run). Absent for the local owner. */
export type By = { id: string; name: string; email?: string };

export const byOf = (app: App, actor: Actor): By | undefined =>
  actor.kind === "member" ? { id: actor.member.id, name: actor.member.name || actor.member.email || "Someone", ...(actor.member.email ? { email: actor.member.email } : {}) } : localOwner(app);

/**
 * The local owner as the cloud knows them: who paired this server (`pairedBy` from `PATCH /v1/mac`), so teammates see their name
 * and their messages carry their user id. Undefined before the cloud said (then they show as "Owner").
 */
export function localOwner(app: App): By | undefined {
  const raw = app.db.get<{ cloud_owner: string | null }>("SELECT cloud_owner FROM settings WHERE id = 1")?.cloud_owner;
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as { id?: unknown; name?: unknown; email?: unknown };
    if (typeof o.id !== "string" || !o.id) return undefined;
    const email = typeof o.email === "string" ? o.email : "";
    return { id: o.id, name: (typeof o.name === "string" && o.name) || email || "Owner", ...(email ? { email } : {}) };
  } catch {
    return undefined;
  }
}

// ---- the actor of a request. The relay path runs the request against the UI app with the owner token and register who
// it is for here, keyed by the Request object itself: nothing a client sends can name an actor.
const actors = new WeakMap<Request, Actor>();

export function runAs(actor: Actor, req: Request): Request {
  actors.set(req, actor);
  return req;
}

export const actorOf = (c: Context): Actor => actors.get(c.req.raw) ?? LOCAL;

/** The actor's attribution, for a route. */
export const byOfRequest = (c: Context, app: App): By | undefined => byOf(app, actorOf(c));

// ---- the server's organization

/** The dorks-cloud organization this server belongs to: `DORKS_ORG_ID`, else what the cloud said when it paired or last connected. */
export function serverOrg(app: App): string | null {
  if (app.cfg.orgId) return app.cfg.orgId;
  return app.db.get<{ cloud_org_id: string | null }>("SELECT cloud_org_id FROM settings WHERE id = 1")?.cloud_org_id ?? null;
}

// ---- identity tokens

export type ActorFailure = "invalid" | "wrong_org" | "no_org";

/** Verifies an identity token and reads the member it names. Fails with why (for the 403 message, never the token). */
export async function memberFromToken(app: App, token: string): Promise<{ ok: true; actor: Actor } | { ok: false; why: ActorFailure }> {
  const jwks = app.jwks();
  if (!jwks) return { ok: false, why: "invalid" };
  let c: Record<string, unknown>;
  try {
    c = await jwks.verify(token);
  } catch {
    return { ok: false, why: "invalid" };
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  // Better Auth may name several roles, comma-separated: the strongest one counts.
  const named = str(c.role)
    .split(",")
    .map((r) => r.trim());
  const role = ROLES.find((r) => named.includes(r));
  // The cloud's older names (free, collab) read as the new ones (local, teams) until it has moved over.
  const plan = planOf(c.plan) ?? "local";
  if (!str(c.sub) || !str(c.org) || !role) return { ok: false, why: "invalid" };
  const org = serverOrg(app);
  if (!org) return { ok: false, why: "no_org" };
  if (str(c.org) !== org) return { ok: false, why: "wrong_org" };
  const member: Member = { id: str(c.sub), name: str(c.name).slice(0, 80), email: str(c.email).slice(0, 200), org: str(c.org), role, plan };
  return { ok: true, actor: { kind: "member", member } };
}

export const FAILURE_MESSAGE: Record<ActorFailure, string> = {
  invalid: "Your sign-in could not be checked. Sign in again.",
  wrong_org: "This server belongs to another team.",
  no_org: "This server is not part of a team yet.",
};

// ---- what each role may do (docs/cloud.md, "Roles"). Paths are pathnames alone; encoded slashes and dots are refused outright.

type Rule = [method: string, path: RegExp];

/** Under /api/dorks: commands on this computer, secret values and the live view of a box stay with the local owner. */
const NEVER = /^\/api\/dorks\/[^/]+\/(local|inputs|desktop)(\/|$)/;
const SNEAKY = /%2f|%2e|%5c|\/\/|\/\.\.?(\/|$)/i;

/** A member: use dorks (create, chat, merge their PRs), and view everything the app shows. */
const MEMBER: Rule[] = [
  ["GET", /^\/api\/(live|me|settings|usage|github\/repos|builds|skills|mcp-servers|composio|automations)$/],
  ["GET", /^\/api\/builds\/[^/]+(\/runs)?$/],
  ["GET", /^\/api\/automations\/[^/]+(\/runs)?$/],
  ["POST", /^\/api\/images$/],
  ["GET", /^\/api\/images\/[^/]+$/],
  ["POST", /^\/api\/presence$/],
  ["*", /^\/api\/dorks(\/.*)?$/],
];

/** An admin (and the organization's owner): also settings, secret names, automations, builds and skills. */
const ADMIN: Rule[] = [
  ...MEMBER,
  ["PUT", /^\/api\/settings$/],
  ["GET", /^\/api\/secrets$/],
  ["PUT", /^\/api\/secrets\/[^/]+$/],
  ["DELETE", /^\/api\/secrets\/[^/]+$/],
  ["*", /^\/api\/automations(\/.*)?$/],
  ["GET", /^\/api\/sentry\/projects$/],
  ["*", /^\/api\/builds(\/.*)?$/],
  ["POST", /^\/api\/skills(\/resolve)?$/],
  ["POST", /^\/api\/skills\/[^/]+\/update$/],
  ["DELETE", /^\/api\/skills\/[^/]+$/],
];

/** Whether a member with `role` may make this request. Never: local access, secret values, MCP server definitions, sign-ins, pairing. */
export function teamAllowed(role: Role, method: string, path: string): boolean {
  if (SNEAKY.test(path) || NEVER.test(path)) return false;
  const m = method.toUpperCase();
  return (role === "member" ? MEMBER : ADMIN).some(([rm, re]) => (rm === "*" || rm === m) && re.test(path));
}

/** Whether an actor moderates the team's content (deletes others' comments): the local owner, and a team's admins and owner. */
export const moderates = (actor: Actor): boolean => actor.kind !== "member" || actor.member.role !== "member";

/** The answer to `GET /api/me`: who this request is, for the UI. */
export function meView(app: App, actor: Actor) {
  if (actor.kind === "member") {
    const { id, name, email, role, org, plan } = actor.member;
    return { kind: "member" as const, id, name, email, role, org, plan };
  }
  const owner = localOwner(app);
  return { kind: actor.kind, id: owner?.id ?? null, name: owner?.name ?? null, email: owner?.email ?? null, role: "owner" as const, org: null, plan: null };
}

/** Whether a chat has a message from someone other than `id`: then it is shared, and the agent hears who writes. */
function sharedChat(app: App, dorkId: string, id: string): boolean {
  return !!app.db.get(
    "SELECT 1 AS one FROM events WHERE dork_id = ? AND json_extract(body, '$.type') = 'user_message' AND json_extract(body, '$.by.id') IS NOT NULL AND json_extract(body, '$.by.id') != ? LIMIT 1",
    dorkId,
    id,
  );
}

/**
 * Whom the agent is told wrote a message: a teammate always; the local owner only in a chat someone else has written in (a solo
 * owner's agent hears nothing new).
 */
export function speakerFor(app: App, dorkId: string, by?: By): By | undefined {
  if (!by) return undefined;
  return by.id !== localOwner(app)?.id || sharedChat(app, dorkId, by.id) ? by : undefined;
}

/**
 * What the agent reads for a teammate's message: who sent it, then the message, so in a shared chat it can address them and knows who
 * asked for what. The transcript keeps the message as written, with `by` beside it.
 */
export function forAgent(text: string, by?: By & { email?: string }): string {
  if (!by) return text;
  const who = by.email && by.email !== by.name ? `${by.name} (${by.email})` : by.name;
  return `[Message from ${who.replace(/[[\]\n]/g, " ")}]\n\n${text}`;
}
