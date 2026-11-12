import { describe, expect, it } from "vite-plus/test";
import { GrantSource } from "../src/grants";
import { WsTransport } from "../src/transport";

// The bridge behind an embedded Wurmhol tunnel: every handshake carries a grant from the tunnel service, an expired grant
// (close 4401) is replaced before reconnecting, and a refused ticket is final.

/** A WebSocket that records its handshake headers and lets the test play the relay and the server. */
class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onerror?: () => void;
  onclose?: (ev: { code: number }) => void;
  readonly grant: string | undefined;
  constructor(_url: string, init?: { headers?: Record<string, string> }) {
    this.grant = init?.headers?.["x-wurmhol-grant"];
    FakeWs.all.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    const msg = JSON.parse(data);
    if (msg.t === "auth") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ t: "auth_ok" }) }));
    if (msg.t === "rpc") queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ t: "res", id: msg.id, ok: true, result: { afterBridgeSeq: 7 } }) }));
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function service(answers: Response[]) {
  const asked: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
    return answers.shift() ?? new Response(null, { status: 500 });
  }) as typeof fetch;
  return { f, asked };
}

const grant = (token: string, expiresAt = "2099-01-01T00:00:00Z") => Response.json({ token, expiresAt });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("grants", () => {
  it("opens with a grant, and replaces it when the relay closes the socket for expiry", async () => {
    FakeWs.all = [];
    const svc = service([grant("whg_one"), grant("whg_two")]);
    const t = new WsTransport("wss://e1.pipe.example/bridge", "d1", "secret", FakeWs as unknown as typeof WebSocket, new GrantSource("https://tunnels.example/", "dts_t.s", svc.f));
    expect(await t.connect()).toEqual({ afterBridgeSeq: 7 });
    expect(svc.asked).toEqual(["https://tunnels.example/v1/grants Bearer dts_t.s"]);
    expect(FakeWs.all[0]!.grant).toBe("whg_one");

    // A second call reuses the open socket and the grant.
    await t.connect();
    expect(FakeWs.all).toHaveLength(1);

    t.subscribeCommands(
      () => {},
      () => {},
    );
    FakeWs.all[0]!.close(4401);
    for (let i = 0; i < 200 && FakeWs.all.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    await t.connect();
    expect(FakeWs.all[1]!.grant).toBe("whg_two");
    expect(t.isFatal(undefined)).toBe(false);
    await t.close();
  });

  it("reuses a grant until it is about to expire", async () => {
    let now = Date.parse("2026-11-11T10:00:00Z");
    const svc = service([grant("whg_a", "2026-11-11T11:00:00Z"), grant("whg_b", "2026-11-11T23:00:00Z")]);
    const g = new GrantSource("https://tunnels.example", "dts_t.s", svc.f, () => now);
    expect(await g.get()).toBe("whg_a");
    now += 50 * 60_000;
    expect(await g.get()).toBe("whg_a");
    now += 6 * 60_000; // inside the margin
    expect(await g.get()).toBe("whg_b");
    expect(svc.asked).toHaveLength(2);
  });

  it("stops for good when the service refuses the ticket (the sandbox was removed)", async () => {
    FakeWs.all = [];
    const svc = service([Response.json({ error: "revoked" }, { status: 403 })]);
    const t = new WsTransport("wss://e1.pipe.example/bridge", "d1", "secret", FakeWs as unknown as typeof WebSocket, new GrantSource("https://tunnels.example", "dts_t.s", svc.f));
    const err = await t.connect().catch((e) => e);
    expect(t.isFatal(err)).toBe(true);
    await tick();
    await expect(t.connect()).rejects.toBe(err);
    expect(FakeWs.all).toHaveLength(0);
    expect(svc.asked).toHaveLength(1);
  });
});
