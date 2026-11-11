// The part of Wurmhol's embedded API (`/v1/embed`, Wurmhol ADR 0032) this service uses, over plain `fetch` so it runs on a
// Cloudflare Worker and on Bun with no dependency. `WurmholEmbed` in `@wurmhol/sdk` has the same calls; this stays small
// until that package is published and runs on Workers.

export interface EmbedTunnel {
  id: string;
  /** Stable across the agent's reconnects and reopens. */
  url: string;
  tenant: string;
  owner: string;
  state: "never" | "live" | "away" | "stopped" | "ended";
}

export interface EmbedConnector {
  id: string;
  /** `whc_…`, shown once. */
  connector: string;
  expiresAt: string;
}

export interface EmbedGrant {
  id: string;
  expiresAt: string;
  /** A client grant's `whg_…` token. */
  token?: string;
}

/** What the handler needs from Wurmhol. `EmbedClient` is the real one; tests use an in-memory fake. */
export interface Embed {
  putTenant(id: string, change: { activeTunnels?: number; monthlyRequests?: number | null }): Promise<void>;
  putSubject(tenant: string, id: string, kind: "user" | "service"): Promise<void>;
  /** Disables the subject, takes it off every access list and revokes its grants. Idempotent. */
  removeSubject(tenant: string, id: string): Promise<void>;
  listTunnels(tenant: string): Promise<EmbedTunnel[]>;
  createTunnel(input: { tenant: string; owner: string; connectorTtlSeconds: number }): Promise<{ tunnel: EmbedTunnel; connector: EmbedConnector }>;
  /** A new connector; `rotate` revokes the others. */
  connector(tunnel: string, options: { rotate: boolean; ttlSeconds: number }): Promise<EmbedConnector>;
  allow(tunnel: string, subject: string): Promise<void>;
  issueClientGrant(input: { tunnel: string; subject: string; ttlSeconds: number }): Promise<EmbedGrant>;
}

/** A refusal from Wurmhol: its HTTP status and the `fix` sentence it sent. */
export class EmbedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const seg = (...parts: string[]) => parts.map(encodeURIComponent).join("/");

export class EmbedClient implements Embed {
  readonly #key: string;
  readonly #server: string;
  readonly #fetch: typeof fetch;

  /** `key` is the application's integration key (`whk_…`). Keep it in this service only. */
  constructor(options: { key: string; server?: string; fetch?: typeof fetch }) {
    if (!/^whk_[A-Za-z0-9_-]{43}$/.test(options.key ?? "")) throw new Error("WURMHOL_KEY must be the application's integration key (whk_…)");
    this.#key = options.key;
    this.#server = (options.server ?? "https://api.wurmhol.com").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
  }

  async #call<T>(method: string, route: string, json?: unknown): Promise<T> {
    const res = await this.#fetch(`${this.#server}/v1/embed/${route}`, {
      method,
      headers: { authorization: `Bearer ${this.#key}`, ...(json === undefined ? {} : { "content-type": "application/json" }), "user-agent": "dorks-tunnels" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : {}) as T;
    let fix = "";
    try {
      const body = JSON.parse(text) as { fix?: string; error?: string };
      fix = body.fix || body.error || "";
    } catch {
      /* not JSON */
    }
    throw new EmbedError(res.status, fix || `wurmhol answered ${res.status}`);
  }

  putTenant = async (id: string, change: object) => {
    await this.#call("PUT", `tenants/${seg(id)}`, change);
  };

  putSubject = async (tenant: string, id: string, kind: "user" | "service") => {
    await this.#call("PUT", `tenants/${seg(tenant, "subjects", id)}`, { kind });
  };

  removeSubject = async (tenant: string, id: string) => {
    try {
      await this.#call("DELETE", `tenants/${seg(tenant, "subjects", id)}`);
    } catch (e) {
      if (!(e instanceof EmbedError && e.status === 404)) throw e;
    }
  };

  listTunnels = async (tenant: string) => (await this.#call<{ tunnels: EmbedTunnel[] }>("GET", `tunnels?${new URLSearchParams({ tenant })}`)).tunnels;

  createTunnel = (input: { tenant: string; owner: string; connectorTtlSeconds: number }) =>
    this.#call<{ tunnel: EmbedTunnel; connector: EmbedConnector }>("POST", "tunnels", input);

  connector = async (tunnel: string, options: { rotate: boolean; ttlSeconds: number }) =>
    (await this.#call<{ connector: EmbedConnector }>("POST", `tunnels/${seg(tunnel, "connectors")}`, options)).connector;

  allow = async (tunnel: string, subject: string) => {
    await this.#call("PUT", `tunnels/${seg(tunnel, "access", subject)}`);
  };

  issueClientGrant = async (input: { tunnel: string; subject: string; ttlSeconds: number }) =>
    (await this.#call<{ grant: EmbedGrant }>("POST", "grants", { ...input, kind: "client" })).grant;
}
