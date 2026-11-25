import { describe, expect, it } from "vite-plus/test";
import { uiApp } from "../src/http/ui";
import { relayAllowed, startPhoneLink, type Dial } from "../src/services/phoneLink";
import { fakeFetch, harness } from "./harness";

// The phone link (docs/mobile.md): the Mac pairs with the cloud relay, dials it, and runs relayed requests against its own UI API,
// only those the allowlist lets through.

const CLOUD = "https://relay.test";

describe("relay allowlist", () => {
  it("lets the phone's API through and keeps the Mac's own controls on the Mac", () => {
    for (const [m, p] of [
      ["GET", "/api/dorks"],
      ["POST", "/api/dorks"],
      ["POST", "/api/dorks/d1/messages"],
      ["POST", "/api/dorks/d1/pr/merge"],
      ["GET", "/api/live"],
      ["GET", "/api/builds/b1"],
      ["POST", "/api/images"],
      ["POST", "/api/skills/resolve"],
    ])
      expect(relayAllowed(m!, p!), `${m} ${p}`).toBe(true);
    for (const [m, p] of [
      ["PUT", "/api/settings"],
      ["GET", "/api/secrets"],
      ["PUT", "/api/local-access"],
      ["POST", "/api/dorks/d1/local/r1"],
      ["POST", "/api/dorks/d1/inputs/r1"],
      ["POST", "/api/dorks/d1/desktop"],
      ["PUT", "/api/mcp-servers/x"],
      ["POST", "/api/dorks/d1/%2e%2e/%2e%2e/settings"],
      ["GET", "/api/dorks//../secrets"],
      ["POST", "/mcp"],
    ])
      expect(relayAllowed(m!, p!), `${m} ${p}`).toBe(false);
  });
});

type Sent = { t: string; id?: string; status?: number; data?: string };

function fakeRelay() {
  const r = { sent: [] as Sent[], dials: [] as { url: string; auth: string }[], sock: undefined as undefined | ReturnType<typeof makeSock> };
  function makeSock() {
    const s = {
      readyState: 0,
      onopen: null as ((e: unknown) => void) | null,
      onmessage: null as ((m: { data: unknown }) => void) | null,
      onclose: null as ((e: { code?: number }) => void) | null,
      onerror: null as ((e: unknown) => void) | null,
      send: (d: string) => void r.sent.push(JSON.parse(d) as Sent),
      close: () => void (s.readyState = 3),
      open() {
        s.readyState = 1;
        s.onopen?.({});
      },
      frame: (o: object) => s.onmessage?.({ data: JSON.stringify(o) }),
    };
    return s;
  }
  const dial: Dial = (url, headers) => {
    r.dials.push({ url, auth: headers.authorization! });
    r.sock = makeSock();
    queueMicrotask(() => r.sock!.open());
    return r.sock;
  };
  return { r, dial };
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((ok) => setTimeout(ok, 5));
  expect(f()).toBe(true);
};
const body = (sent: Sent[], id: string) =>
  sent
    .filter((s) => s.id === id && s.t === "chunk")
    .map((s) => Buffer.from(s.data!, "base64").toString())
    .join("");

describe("phone link", () => {
  it("pairs, relays allowed requests, refuses the rest, streams live, and forgets a revoked pairing", async () => {
    let claimed = false;
    const fetch = fakeFetch((url) => {
      if (url.pathname === "/v1/pair/start") return Response.json({ pairId: "p1", pollToken: "pt", code: "ABCD2345", expiresAt: Date.now() + 600_000 });
      if (url.pathname === "/v1/pair/poll") return Response.json(claimed ? { status: "claimed", macId: "mac1", macToken: "mac-secret" } : { status: "pending" });
      return new Response("{}", { status: 404 });
    });
    const h = harness({ fetch, config: { cloudUrl: CLOUD } });
    const { r, dial } = fakeRelay();
    const ui = uiApp(h.app);
    const link = startPhoneLink(h.app, (q) => ui.fetch(q), dial, 5);

    const p = await link.pair("Studio");
    expect(p).toMatchObject({ code: "ABCD-2345", url: `dorks://pair?code=ABCD2345&cloud=${encodeURIComponent(CLOUD)}` });
    expect(link.view()).toMatchObject({ paired: false, link: "off", pairing: { code: "ABCD-2345" } });

    claimed = true;
    await until(() => link.view().link === "online");
    expect(r.dials).toEqual([{ url: "wss://relay.test/v1/mac/connect", auth: "Bearer mac-secret" }]);
    expect(link.view()).toMatchObject({ paired: true, macId: "mac1", pairing: null });
    const row = h.app.db.get<{ cloud_mac_token_enc: string }>("SELECT cloud_mac_token_enc FROM settings WHERE id = 1")!;
    expect(row.cloud_mac_token_enc).not.toContain("mac-secret"); // stored encrypted

    r.sock!.frame({ t: "req", id: "1", method: "GET", path: "/api/dorks", headers: { accept: "application/json" } });
    r.sock!.frame({ t: "req", id: "2", method: "GET", path: "/api/secrets" });
    r.sock!.frame({ t: "req", id: "3", method: "GET", path: "/api/live" });
    await until(() => r.sent.some((s) => s.id === "1" && s.t === "end") && r.sent.some((s) => s.id === "2" && s.t === "end"));
    expect(r.sent.find((s) => s.id === "1" && s.t === "head")?.status).toBe(200);
    expect(JSON.parse(body(r.sent, "1"))).toEqual([]);
    expect(r.sent.find((s) => s.id === "2" && s.t === "head")?.status).toBe(403);
    expect(JSON.parse(body(r.sent, "2")).error.code).toBe("forbidden");

    // /api/live stays open and streams; a cancel ends it without an "end" frame.
    await until(() => body(r.sent, "3").includes('"t":"hello"'));
    h.app.hub.emit({ t: "dorks" });
    await until(() => body(r.sent, "3").includes('"t":"dorks"'));
    r.sock!.frame({ t: "cancel", id: "3" });
    r.sock!.frame({ t: "ping" });
    await until(() => r.sent.some((s) => s.t === "pong"));
    expect(r.sent.some((s) => s.id === "3" && s.t === "end")).toBe(false);

    // The relay revokes the Mac token: the pairing is forgotten.
    r.sock!.onclose?.({ code: 4401 });
    expect(link.view()).toMatchObject({ paired: false, link: "off" });
    expect(h.app.db.get<{ cloud_mac_id: string | null }>("SELECT cloud_mac_id FROM settings WHERE id = 1")!.cloud_mac_id).toBeNull();
    link.stop();
  });
});
