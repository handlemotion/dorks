// The Dorks tunnel service: the one hosted piece of Dorks, and the only holder of Wurmhol's integration key (`whk_`).
// It turns a Dorks install into a Wurmhol tenant with one private tunnel to that install's bridge port, and lets only that
// install's sandboxes reach it, with short-lived grants. See README.md and docs/desktop.md ("Tunnel").
//
// Stateless. Who is who:
// - An install proves itself with its install key (`dti_` + 64 hex, made once by the desktop shell, never sent anywhere but here).
//   Its tenant is `install-<first 40 hex of sha256(key)>`, so the key is the account and nothing is stored.
// - The tenant's subject `owner` owns the tunnel. It is never granted traffic: the owner's server is at the other end.
// - Each sandbox is a subject `dork-<dork id>` on the tunnel's access list, made when its box is created and removed (which
//   revokes its grants) when the box is deleted. It holds a ticket (`dts_…`): the tenant, tunnel and subject, signed with
//   TICKET_KEY. The ticket buys client grants for that subject only, and stops working once the subject is removed.

import { type Embed, EmbedError } from "./embed";

export interface Options {
  embed: Embed;
  /** HMAC key for sandbox tickets: at least 32 random bytes. Rotating it invalidates every ticket. */
  ticketKey: string;
  /** Per-tenant limits set on Wurmhol each time an install asks for its tunnel. */
  limits?: { activeTunnels?: number; monthlyRequests?: number | null };
  /** How long a sandbox's grant lasts. Its bridge reconnects with a new one when it runs out. */
  grantTtlSeconds?: number;
}

const CONNECTOR_TTL_SECONDS = 365 * 24 * 3600;
const DEFAULT_GRANT_TTL_SECONDS = 12 * 3600;
const INSTALL_KEY = /^dti_[0-9a-f]{64}$/;
const DORK_ID = /^[A-Za-z0-9_-]{1,100}$/;
const OWNER = "owner";

type Ticket = { t: string; u: string; s: string };

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function tenantOf(installKey: string): Promise<string> {
  return `install-${hex(await crypto.subtle.digest("SHA-256", enc.encode(installKey))).slice(0, 40)}`;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const refuse = (status: number, error: string, fix: string) => json(status, { error, fix });
const bearer = (req: Request) => req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];

export function createHandler(opts: Options): (req: Request) => Promise<Response> {
  const { embed } = opts;
  const grantTtl = opts.grantTtlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
  if (!opts.ticketKey || opts.ticketKey.length < 32) throw new Error("TICKET_KEY must be at least 32 characters");
  const hmacKey = crypto.subtle.importKey("raw", enc.encode(opts.ticketKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

  async function signTicket(ticket: Ticket): Promise<string> {
    const body = b64url(enc.encode(JSON.stringify(ticket)));
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey, enc.encode(body)));
    return `dts_${body}.${b64url(sig)}`;
  }

  async function readTicket(value: string | undefined): Promise<Ticket | null> {
    const m = value?.match(/^dts_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!m) return null;
    try {
      if (!(await crypto.subtle.verify("HMAC", await hmacKey, fromB64url(m[2]!), enc.encode(m[1]!)))) return null;
      const t = JSON.parse(new TextDecoder().decode(fromB64url(m[1]!))) as Ticket;
      return typeof t.t === "string" && typeof t.u === "string" && typeof t.s === "string" && t.s.startsWith("dork-") ? t : null;
    } catch {
      return null;
    }
  }

  /** The install's live tunnel, made on first use. `connector` is set only when it was just made. */
  async function tunnelOf(tenant: string) {
    const existing = (await embed.listTunnels(tenant)).find((t) => t.state !== "ended" && t.owner === OWNER);
    if (existing) return { tunnel: existing, connector: undefined };
    return embed.createTunnel({ tenant, owner: OWNER, connectorTtlSeconds: CONNECTOR_TTL_SECONDS });
  }

  async function install(req: Request) {
    const key = bearer(req);
    return key && INSTALL_KEY.test(key) ? tenantOf(key) : null;
  }

  // The desktop shell: this install's tunnel and a fresh connector for it (365 days; any older one is revoked).
  async function postTunnel(req: Request): Promise<Response> {
    const tenant = await install(req);
    if (!tenant) return refuse(401, "unauthorized", "Send this install's key as `Authorization: Bearer dti_…`.");
    await embed.putTenant(tenant, { activeTunnels: opts.limits?.activeTunnels ?? 1, ...(opts.limits?.monthlyRequests !== undefined ? { monthlyRequests: opts.limits.monthlyRequests } : {}) });
    await embed.putSubject(tenant, OWNER, "user");
    const made = await tunnelOf(tenant);
    const connector = made.connector ?? (await embed.connector(made.tunnel.id, { rotate: true, ttlSeconds: CONNECTOR_TTL_SECONDS }));
    return json(200, { tunnel: { id: made.tunnel.id, url: made.tunnel.url }, connector: { connector: connector.connector, expiresAt: connector.expiresAt } });
  }

  // The owner's server: let a new sandbox reach the tunnel (and get its ticket), or forget a deleted one.
  async function sandboxAccess(req: Request, rawId: string): Promise<Response> {
    const tenant = await install(req);
    if (!tenant) return refuse(401, "unauthorized", "Send this install's key as `Authorization: Bearer dti_…`.");
    const dorkId = decodeURIComponent(rawId);
    if (!DORK_ID.test(dorkId)) return refuse(400, "invalid", "A dork id is 1 to 100 letters, digits, - or _.");
    const subject = `dork-${dorkId}`;
    if (req.method === "DELETE") {
      await embed.removeSubject(tenant, subject);
      return new Response(null, { status: 204 });
    }
    const { tunnel } = await tunnelOf(tenant);
    await embed.putSubject(tenant, subject, "service");
    await embed.allow(tunnel.id, subject);
    return json(200, { ticket: await signTicket({ t: tenant, u: tunnel.id, s: subject }) });
  }

  // A sandbox's bridge: a client grant for its own subject on its owner's tunnel, sent as `x-wurmhol-grant`.
  async function postGrant(req: Request): Promise<Response> {
    const ticket = await readTicket(bearer(req));
    if (!ticket) return refuse(401, "unauthorized", "Send the sandbox's ticket as `Authorization: Bearer dts_…`.");
    try {
      const grant = await embed.issueClientGrant({ tunnel: ticket.u, subject: ticket.s, ttlSeconds: grantTtl });
      if (!grant.token) throw new EmbedError(502, "wurmhol returned no grant token");
      return json(200, { token: grant.token, expiresAt: grant.expiresAt });
    } catch (e) {
      // The subject was removed (its dork deleted) or the tunnel is gone: this ticket is finished.
      if (e instanceof EmbedError && [403, 404, 409, 410].includes(e.status)) return refuse(403, "revoked", "This sandbox no longer has access to its owner's tunnel.");
      throw e;
    }
  }

  async function route(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (req.method === "GET" && path === "/health") return json(200, { ok: true });
    if (req.method === "POST" && path === "/v1/tunnel") return postTunnel(req);
    const sandbox = path.match(/^\/v1\/sandboxes\/([^/]+)$/);
    if (sandbox && (req.method === "PUT" || req.method === "DELETE")) return sandboxAccess(req, sandbox[1]!);
    if (req.method === "POST" && path === "/v1/grants") return postGrant(req);
    return refuse(404, "not_found", "No such route.");
  }

  return async (req) => {
    try {
      return await route(req);
    } catch (e) {
      if (e instanceof EmbedError) {
        console.error("wurmhol refused", e.status, e.message.slice(0, 200));
        return refuse(502, "upstream", e.status === 404 ? "Wurmhol's embedded API is not available on this server yet." : e.message);
      }
      console.error("tunnel service failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
      return refuse(500, "internal", "Try again in a moment.");
    }
  };
}
