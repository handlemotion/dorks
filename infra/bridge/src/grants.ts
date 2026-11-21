// Wurmhol grants for this sandbox (Wurmhol ADR 0032). The owner's public URL is a private embedded tunnel: the relay lets a
// client through only with a grant, sent as `x-wurmhol-grant` on the WebSocket handshake. The box was created with a ticket
// for the Dorks tunnel service (infra/tunnels), which trades it for a short-lived grant for this sandbox's own subject.
// The grant decides who reaches the relay; the per-dork secret on the socket stays the authentication.

/** Refresh this long before a grant runs out, so a new connection never starts with one about to expire. */
const MARGIN_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;

/** The service refused the ticket (bad, or this sandbox was removed): no grant will ever come. */
export class TicketRefused extends Error {}

export class GrantSource {
  private current?: { token: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(
    private readonly service: string,
    private readonly ticket: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** A grant good for at least a few more minutes, fetched when there is none. */
  get(): Promise<string> {
    if (this.current && this.current.expiresAt - MARGIN_MS > this.now()) return Promise.resolve(this.current.token);
    this.pending ??= this.fetch().finally(() => (this.pending = undefined));
    return this.pending;
  }

  /** Forget the grant (it expired, or the relay refused it): the next `get` fetches a new one. */
  drop() {
    this.current = undefined;
  }

  private async fetch(): Promise<string> {
    const res = await this.fetchImpl(`${this.service.replace(/\/+$/, "")}/v1/grants`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.ticket}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) throw new TicketRefused("the tunnel service refused this sandbox's ticket");
    if (!res.ok) throw new Error(`the tunnel service answered ${res.status}`);
    const body = (await res.json()) as { token?: string; expiresAt?: string };
    const expiresAt = Date.parse(body.expiresAt ?? "");
    if (!body.token?.startsWith("whg_") || !Number.isFinite(expiresAt)) throw new Error("the tunnel service sent no grant");
    this.current = { token: body.token, expiresAt };
    return body.token;
  }
}
