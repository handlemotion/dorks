import { describe, expect, it } from "vite-plus/test";
import { uiApp } from "../src/http/ui";
import type { CloudOrg, CloudPlaces, CloudView } from "../src/services/cloudAccount";
import { fakeFetch, harness } from "./harness";

// The Dorks Cloud account (services/cloudAccount.ts): this server signs in to the relay with an email code, keeps the session
// encrypted, lists the account's places and forwards the UI API of another server with the session, never with the owner token.

const CLOUD = "https://relay.test";

describe("cloud account", () => {
  it("signs in, lists places, forwards with the session and forgets an expired one", async () => {
    let live = true;
    const fetch = fakeFetch((url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (url.pathname === "/api/auth/email-otp/send-verification-otp") return Response.json({ success: true });
      if (url.pathname === "/api/auth/sign-in/email-otp")
        return Response.json({ token: "body-token", user: { id: "u1", name: "Ada", email: "ada@example.com" } }, { headers: { "set-auth-token": "sess-secret" } });
      if (auth !== "Bearer sess-secret" || !live) return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
      if (url.pathname === "/v1/orgs")
        return Response.json([
          {
            id: "o1",
            name: "Acme",
            slug: "acme",
            logo: null,
            personal: false,
            plan: "collab",
            role: "member",
            active: false,
            servers: [{ macId: "h1", name: "Acme", kind: "hosted", online: true, lastSeenAt: null }],
          },
          {
            id: "p1",
            name: "Personal",
            slug: "personal-1",
            logo: null,
            personal: true,
            plan: "free",
            role: "owner",
            active: true,
            servers: [{ macId: "m1", name: "Ada's MacBook", kind: "mac", online: true, lastSeenAt: "2026-11-01T00:00:00Z" }],
          },
        ]);
      if (url.pathname === "/api/auth/organization/create") return Response.json({ id: "o2", name: "Friends", slug: "friends-x", logo: null });
      if (url.pathname === "/v1/macs/h1/api/dorks") return Response.json([{ id: "d1" }]);
      return new Response("{}", { status: 404 });
    });
    const h = harness({ fetch, config: { cloudUrl: CLOUD } });
    const ui = uiApp(h.app);
    const call = (method: string, path: string, body?: unknown, token = h.app.cfg.ownerToken) =>
      ui.fetch(new Request(`http://127.0.0.1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));

    expect(await (await call("GET", "/api/cloud")).json()).toEqual({ cloudUrl: CLOUD, user: null });
    expect((await call("GET", "/api/cloud/places")).status).toBe(412);
    expect((await call("POST", "/api/cloud/sign-in/email", { email: "ada@example.com" })).status).toBe(200);
    const signed = (await (await call("POST", "/api/cloud/sign-in/verify", { email: "ada@example.com", code: "123 456" })).json()) as CloudView;
    expect(signed.user).toEqual({ id: "u1", name: "Ada", email: "ada@example.com", image: null });
    const row = h.app.db.get<{ cloud_session_enc: string }>("SELECT cloud_session_enc FROM settings WHERE id = 1")!;
    expect(row.cloud_session_enc).not.toContain("sess-secret");

    // Personal first, each org with the servers it owns.
    const places = (await (await call("GET", "/api/cloud/places")).json()) as CloudPlaces;
    expect(places.orgs.map((o) => [o.id, o.personal, o.plan, o.servers.map((s) => `${s.id}:${s.kind}`)])).toEqual([
      ["p1", true, "free", ["m1:mac"]],
      ["o1", false, "collab", ["h1:hosted"]],
    ]);
    expect(places.orgs[0]!.servers[0]!.lastSeenAt).toBe(Date.parse("2026-11-01T00:00:00Z"));
    const created = (await (await call("POST", "/api/cloud/orgs", { name: "Friends" })).json()) as CloudOrg;
    expect(created).toMatchObject({ id: "o2", name: "Friends", personal: false, role: "owner", servers: [] });

    // Another server's UI API: the relay sees the session, never the owner token; the owner token is still required here.
    const res = await call("GET", "/api/cloud/servers/h1/api/dorks");
    expect(await res.json()).toEqual([{ id: "d1" }]);
    const forwarded = fetch.calls.find((c) => c.url === "/v1/macs/h1/api/dorks")!;
    expect(forwarded.headers.get("authorization")).toBe("Bearer sess-secret");
    expect((await call("GET", "/api/cloud/servers/h1/api/dorks", undefined, "wrong")).status).toBe(401);
    expect((await call("GET", "/api/cloud/servers/h1/api/..%2f..%2fv1/macs")).status).toBe(400);
    expect((await call("GET", "/api/cloud/servers/h1/v1/macs")).status).toBe(400);

    // The relay ended the session: it is forgotten, and the UI is asked to sign in again.
    live = false;
    expect((await call("GET", "/api/cloud/places")).status).toBe(412);
    expect(((await (await call("GET", "/api/cloud")).json()) as CloudView).user).toBeNull();
  });
});
