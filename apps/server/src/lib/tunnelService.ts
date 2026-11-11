import type { App } from "../app";

// The owner's side of the Dorks tunnel service (infra/tunnels, docs/desktop.md "Tunnel"). The public URL is this install's
// private Wurmhol tunnel, which only the subjects on its access list can reach. Each sandbox is one of them: registered
// before its box is created (its bridge gets the ticket and trades it for grants), and removed when its box is deleted, which
// revokes its grants. The per-dork HMAC on the bridge socket stays the authentication; this decides who reaches the relay.

const TIMEOUT_MS = 15_000;

async function call(app: App, method: "PUT" | "DELETE", dorkId: string): Promise<Response> {
  const svc = app.cfg.tunnelService!;
  const res = await app.fetch(`${svc.url}/v1/sandboxes/${encodeURIComponent(dorkId)}`, {
    method,
    headers: { authorization: `Bearer ${svc.installKey}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) {
    const fix = await res.json().then((b) => (b as { fix?: string }).fix, () => undefined);
    throw new Error(`tunnel service: ${fix ?? `answered ${res.status}`}`);
  }
  return res;
}

/** The sandbox env its bridge needs to reach the tunnel; empty when the public URL is not an embedded tunnel. */
export async function sandboxTunnelEnv(app: App, dorkId: string): Promise<Record<string, string>> {
  if (!app.cfg.tunnelService) return {};
  const { ticket } = (await (await call(app, "PUT", dorkId)).json()) as { ticket?: string };
  if (!ticket?.startsWith("dts_")) throw new Error("tunnel service: no ticket");
  return { DORKS_TUNNEL_SERVICE: app.cfg.tunnelService.url, DORKS_TUNNEL_TICKET: ticket };
}

/** Takes a deleted dork's sandbox off the tunnel. Best effort: a deleted dork's bridge is refused by the server anyway. */
export async function forgetSandbox(app: App, dorkId: string): Promise<void> {
  if (!app.cfg.tunnelService) return;
  try {
    await call(app, "DELETE", dorkId);
  } catch (e) {
    console.error("forget_sandbox failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
  }
}
