import { describe, expect, it } from "vitest";
import { type Embed, EmbedError, type EmbedTunnel } from "../src/embed";
import { createHandler, tenantOf } from "../src/handler";

/** Wurmhol's embedded rules that matter here: grants only for enabled subjects on the tunnel's list, of the tunnel's tenant. */
function fakeWurmhol() {
  const tunnels: EmbedTunnel[] = [];
  const subjects = new Map<string, boolean>(); // `${tenant}/${id}` -> enabled
  const access = new Map<string, Set<string>>();
  const connectors: { tunnel: string; connector: string; revoked: boolean }[] = [];
  let n = 0;
  const connector = (tunnel: string) => {
    const c = { tunnel, connector: `whc_${++n}`, revoked: false };
    connectors.push(c);
    return { id: `c${n}`, connector: c.connector, expiresAt: "2027-11-11T00:00:00Z" };
  };
  const embed: Embed = {
    putTenant: async () => {},
    putSubject: async (tenant, id) => void subjects.set(`${tenant}/${id}`, true),
    removeSubject: async (tenant, id) => {
      subjects.set(`${tenant}/${id}`, false);
      for (const t of tunnels.filter((t) => t.tenant === tenant)) access.get(t.id)?.delete(id);
    },
    listTunnels: async (tenant) => tunnels.filter((t) => t.tenant === tenant),
    createTunnel: async ({ tenant, owner }) => {
      const tunnel: EmbedTunnel = { id: `t${++n}`, url: `https://e${n}.pipe.example`, tenant, owner, state: "never" };
      tunnels.push(tunnel);
      access.set(tunnel.id, new Set([owner]));
      return { tunnel, connector: connector(tunnel.id) };
    },
    connector: async (tunnel, { rotate }) => {
      if (rotate) for (const c of connectors.filter((c) => c.tunnel === tunnel)) c.revoked = true;
      return connector(tunnel);
    },
    allow: async (tunnel, subject) => void access.get(tunnel)!.add(subject),
    issueClientGrant: async ({ tunnel, subject }) => {
      const t = tunnels.find((x) => x.id === tunnel)!;
      if (!subjects.get(`${t.tenant}/${subject}`) || !access.get(tunnel)?.has(subject)) throw new EmbedError(403, "not on the access list");
      return { id: `g${++n}`, token: `whg_${subject}`, expiresAt: "2026-11-11T12:00:00Z" };
    },
  };
  return { embed, tunnels, connectors };
}

const KEY_A = `dti_${"a".repeat(64)}`;
const KEY_B = `dti_${"b".repeat(64)}`;

function setup() {
  const wurmhol = fakeWurmhol();
  const handle = createHandler({ embed: wurmhol.embed, ticketKey: "k".repeat(32) });
  const call = async (method: string, path: string, auth?: string) => {
    const res = await handle(new Request(`https://tunnels.example${path}`, { method, headers: auth ? { authorization: `Bearer ${auth}` } : {} }));
    return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) };
  };
  return { ...wurmhol, call };
}

describe("tunnel service", () => {
  it("gives each install one tunnel of its own, and rotates its connector on every ask", async () => {
    const s = setup();
    expect((await s.call("POST", "/v1/tunnel")).status).toBe(401);
    expect((await s.call("POST", "/v1/tunnel", "dti_short")).status).toBe(401);
    const first = await s.call("POST", "/v1/tunnel", KEY_A);
    const again = await s.call("POST", "/v1/tunnel", KEY_A);
    const other = await s.call("POST", "/v1/tunnel", KEY_B);
    expect(first.status).toBe(200);
    expect(again.body.tunnel).toEqual(first.body.tunnel);
    expect(again.body.connector.connector).not.toBe(first.body.connector.connector);
    expect(s.connectors.find((c) => c.connector === first.body.connector.connector)!.revoked).toBe(true);
    expect(other.body.tunnel.id).not.toBe(first.body.tunnel.id);
    expect(s.tunnels.map((t) => t.tenant)).toEqual([await tenantOf(KEY_A), await tenantOf(KEY_B)]);
  });

  it("lets a registered sandbox get grants for its own subject only, until it is forgotten", async () => {
    const s = setup();
    await s.call("POST", "/v1/tunnel", KEY_A);
    const { body } = await s.call("PUT", "/v1/sandboxes/d1", KEY_A);
    const grant = await s.call("POST", "/v1/grants", body.ticket);
    expect(grant).toEqual({ status: 200, body: { token: "whg_dork-d1", expiresAt: "2026-11-11T12:00:00Z" } });

    // A ticket is bound to its signature: changing the subject, or signing with another key, gets nothing.
    const [, payload] = body.ticket.match(/^dts_([^.]+)\./)!;
    const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
    forged.s = "dork-d2";
    expect((await s.call("POST", "/v1/grants", `dts_${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${body.ticket.split(".")[1]}`)).status).toBe(401);
    expect((await s.call("POST", "/v1/grants", KEY_A)).status).toBe(401);

    // Another install cannot forget this one's sandbox.
    expect((await s.call("DELETE", "/v1/sandboxes/d1", KEY_B)).status).toBe(204);
    expect((await s.call("POST", "/v1/grants", body.ticket)).status).toBe(200);

    expect((await s.call("DELETE", "/v1/sandboxes/d1", KEY_A)).status).toBe(204);
    expect((await s.call("POST", "/v1/grants", body.ticket)).body.error).toBe("revoked");
  });

  it("never issues a ticket for the owner subject", async () => {
    const s = setup();
    expect((await s.call("PUT", "/v1/sandboxes/a%2Fb", KEY_A)).status).toBe(400);
    expect((await s.call("POST", "/v1/grants", `dts_${Buffer.from(JSON.stringify({ t: "x", u: "t1", s: "owner" })).toString("base64url")}.AAAA`)).status).toBe(401);
  });
});
