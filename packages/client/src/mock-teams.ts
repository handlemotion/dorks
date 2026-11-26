// The mock's team management (docs/mobile.md, "Desktop: Dorks Cloud"): Better Auth's organization endpoints as the local server
// forwards them (`/api/cloud/auth/organization/:action`), over the mock cloud's orgs. Members and roles, invitations (one waits for
// you, from Night owls), the fair-use member cap (MEMBER_LIMIT_REACHED, the local server's `limit`), leave, rename, delete.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudInvitation, CloudMember, CloudUser } from "./types.ts";
import type { MockOrg } from "./mock-cloud.ts";

/** Members plus open invitations an org may have: a fair-use cap, not seats. Low here so the error can be seen. */
const MEMBER_CAP = 6;
const ME = "user-1";

type Seat = { userId: string; role: string; name: string; email: string };
const person = (userId: string, name: string, email: string, role: string): Seat => ({ userId, name, email, role });
const RODRIGO = (role: string) => person("user-rodrigo", "Rodrigo Alves", "rodrigo@example.com", role);

/** Night owls invites you; accepting adds it, with its hosted server. */
const NIGHT_OWLS: MockOrg = {
  id: "org-night-owls",
  name: "Night owls",
  slug: "night-owls",
  logo: null,
  personal: false,
  plan: "teams",
  role: "member",
  servers: [
    {
      id: "hosted-night-owls",
      name: "Night owls",
      kind: "hosted",
      online: true,
      lastSeenAt: null,
      seed: [{ repo: "nightowls/site", title: "Dark mode for the blog", message: "Add a dark mode to the blog" }],
    },
  ],
};

export function mockTeams(o: {
  orgs: MockOrg[];
  me: () => CloudUser | null;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  fail: (res: ServerResponse, code: string, message: string) => void;
  readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
}) {
  const { json, fail } = o;
  const seats = new Map<string, Seat[]>([
    ["org-personal", [person(ME, "", "", "owner")]],
    ["org-handlemotion", [person(ME, "", "", "admin"), RODRIGO("owner"), person("user-grace", "Grace Hopper", "grace@example.com", "member")]],
    ["org-friends", [RODRIGO("owner"), person(ME, "", "", "member")]],
  ]);
  const invites: CloudInvitation[] = [
    {
      id: "inv-linus",
      email: "linus@example.com",
      role: "member",
      status: "pending",
      organizationId: "org-handlemotion",
      organizationName: "Handlemotion",
      inviterEmail: "rodrigo@example.com",
      expiresAt: Date.now() + 5 * 86_400_000,
    },
    {
      id: "inv-night-owls",
      email: "ada@example.com",
      role: "member",
      status: "pending",
      organizationId: NIGHT_OWLS.id,
      organizationName: NIGHT_OWLS.name,
      inviterEmail: "grace@example.com",
      expiresAt: Date.now() + 6 * 86_400_000,
    },
  ];
  const rank = (role: string | undefined) => (role === "owner" ? 3 : role === "admin" ? 2 : role === "member" ? 1 : 0);
  const roleOf = (orgId: string) => seats.get(orgId)?.find((s) => s.userId === ME)?.role;
  const members = (orgId: string): CloudMember[] =>
    (seats.get(orgId) ?? []).map((s) => {
      const me = s.userId === ME ? o.me() : null;
      return { id: `m-${orgId}-${s.userId}`, userId: s.userId, role: s.role, user: { id: s.userId, name: me?.name ?? s.name, email: me?.email ?? s.email, image: null } };
    });
  const pending = (orgId: string) => invites.filter((i) => i.organizationId === orgId && i.status === "pending");
  const drop = (orgId: string) => {
    const i = o.orgs.findIndex((x) => x.id === orgId);
    if (i >= 0) o.orgs.splice(i, 1);
  };

  type Act = (b: Record<string, unknown>, res: ServerResponse) => void;
  const org = (b: Record<string, unknown>) => o.orgs.find((x) => x.id === b.organizationId);
  /** The org named in the body, when the caller's role is at least `min`; else answers the refusal. */
  const guard = (b: Record<string, unknown>, res: ServerResponse, min: number) => {
    const found = org(b);
    if (!found) return void fail(res, "not_found", "No such organization.");
    if (rank(roleOf(found.id)) < min) return void fail(res, "invalid", min === 3 ? "Only an owner can do that." : "Only an admin can do that.");
    return found;
  };
  const answer = (b: Record<string, unknown>, res: ServerResponse, accept: boolean) => {
    const inv = invites.find((i) => i.id === b.invitationId && i.status === "pending");
    if (!inv) return fail(res, "not_found", "That invitation is no longer open.");
    inv.status = accept ? "accepted" : "rejected";
    if (accept && inv.organizationId === NIGHT_OWLS.id) {
      o.orgs.push({ ...NIGHT_OWLS });
      seats.set(NIGHT_OWLS.id, [person("user-grace", "Grace Hopper", "grace@example.com", "owner"), person(ME, "", "", inv.role)]);
    }
    json(res, 200, { invitation: inv });
  };
  const posts: Record<string, Act> = {
    "invite-member": (b, res) => {
      const found = guard(b, res, 2);
      if (!found) return;
      const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return fail(res, "invalid", "Enter an email address.");
      if ((seats.get(found.id)?.length ?? 0) + pending(found.id).length >= MEMBER_CAP) return fail(res, "limit", "This organization has reached its member limit.");
      const inv: CloudInvitation = {
        id: `inv-${Date.now()}`,
        email,
        role: b.role === "admin" ? "admin" : "member",
        status: "pending",
        organizationId: found.id,
        organizationName: found.name,
        expiresAt: Date.now() + 7 * 86_400_000,
      };
      invites.push(inv);
      json(res, 200, inv);
    },
    "cancel-invitation": (b, res) => {
      const inv = invites.find((i) => i.id === b.invitationId && i.status === "pending");
      if (!inv) return fail(res, "not_found", "No such invitation.");
      if (!guard({ organizationId: inv.organizationId }, res, 2)) return;
      inv.status = "canceled";
      json(res, 200, inv);
    },
    "accept-invitation": (b, res) => answer(b, res, true),
    "reject-invitation": (b, res) => answer(b, res, false),
    "update-member-role": (b, res) => {
      const found = guard(b, res, 2);
      const seat = found && seats.get(found.id)?.find((s) => `m-${found.id}-${s.userId}` === b.memberId);
      if (!found) return;
      if (!seat) return fail(res, "not_found", "No such member.");
      if ((b.role === "owner" || seat.role === "owner") && roleOf(found.id) !== "owner") return fail(res, "invalid", "Only an owner can change an owner.");
      seat.role = String(b.role);
      json(res, 200, {});
    },
    "remove-member": (b, res) => {
      const found = guard(b, res, 2);
      if (!found) return;
      const list = seats.get(found.id) ?? [];
      const seat = list.find((s) => `m-${found.id}-${s.userId}` === b.memberIdOrEmail || s.email === b.memberIdOrEmail);
      if (!seat || seat.role === "owner") return fail(res, "invalid", seat ? "An owner cannot be removed." : "No such member.");
      seats.set(
        found.id,
        list.filter((s) => s !== seat),
      );
      json(res, 200, {});
    },
    leave: (b, res) => {
      const found = org(b);
      if (!found || found.personal) return fail(res, "invalid", "You cannot leave your personal organization.");
      drop(found.id);
      json(res, 200, {});
    },
    update: (b, res) => {
      const found = guard(b, res, 3);
      if (!found) return;
      const data = (b.data ?? {}) as { name?: unknown; logo?: unknown };
      if (typeof data.name === "string" && data.name.trim()) found.name = data.name.trim();
      if (typeof data.logo === "string") found.logo = data.logo.trim() || null;
      json(res, 200, found);
    },
    delete: (b, res) => {
      const found = guard(b, res, 3);
      if (!found) return;
      if (found.personal) return fail(res, "invalid", "A personal organization cannot be deleted.");
      drop(found.id);
      json(res, 200, {});
    },
  };

  const read = (action: string, q: URLSearchParams, res: ServerResponse) => {
    const me = o.me();
    if (action === "list-user-invitations")
      return json(
        res,
        200,
        invites.filter((i) => i.status === "pending" && i.email === me?.email),
      );
    if (action === "get-invitation") {
      const inv = invites.find((i) => i.id === q.get("id"));
      return inv ? json(res, 200, inv) : fail(res, "not_found", "No such invitation.");
    }
    const found = o.orgs.find((x) => x.id === q.get("organizationId"));
    if (action !== "get-full-organization" || !found) return fail(res, "not_found", "No such organization.");
    return json(res, 200, { id: found.id, name: found.name, slug: found.slug, logo: found.logo, members: members(found.id), invitations: pending(found.id) });
  };

  return {
    /** Your role in an org, from its members (the switcher's places show it). */
    roleOf,
    /** A new org you created: you are its owner. */
    created: (orgId: string) => void seats.set(orgId, [person(ME, "", "", "owner")]),
    async route(req: IncomingMessage, res: ServerResponse, method: string, action: string, search: string) {
      if (!o.me()) return fail(res, "not_configured", "Sign in to Dorks Cloud first.");
      if (method === "GET") return read(action, new URLSearchParams(search), res);
      const act = posts[action];
      if (method !== "POST" || !act) return fail(res, "not_found", "Unknown organization action");
      act(await o.readBody(req).catch(() => ({})), res);
    },
  };
}
