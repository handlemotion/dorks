import { describe, expect, it } from "vite-plus/test";
import { uiApp } from "../src/http/ui";
import type { CloudOrg, CloudPlaces, CloudView } from "../src/services/cloudAccount";
import { fakeFetch, harness } from "./harness";

// The Dorks Cloud account (services/cloudAccount.ts): this server signs in to the relay through the browser handoff, keeps the session
// encrypted, lists the account's places and forwards the UI API of another server with the session, never with the owner token.

const CLOUD = "https://relay.test";

describe("cloud account", () => {
  it("signs in, lists places, forwards with the session and forgets an expired one", async () => {
    let live = true;
    const redeemed: string[] = [];
    const fetch = fakeFetch((url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (url.pathname === "/v1/app-handoff/redeem") {
        const b = JSON.parse(init?.body as string) as { code: string; state: string };
        redeemed.push(b.state);
        return b.code === "good-code-1" ? Response.json({ token: "sess-secret" }) : Response.json({ message: "That sign-in code expired" }, { status: 400 });
      }
      if (url.pathname === "/api/auth/get-session" && auth === "Bearer sess-secret") return Response.json({ session: {}, user: { id: "u1", name: "Ada", email: "ada@example.com" } });
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
      if (url.pathname === "/api/auth/organization/invite-member") return Response.json({ code: "MEMBER_LIMIT_REACHED", message: "This organization has reached its member limit" }, { status: 403 });
      if (url.pathname === "/api/auth/organization/get-full-organization") return Response.json({ id: url.searchParams.get("organizationId"), members: [] });
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
    // The browser sign-in: the site's URL with a one-time state; only that state, once, finishes it.
    const { url } = (await (await call("POST", "/api/cloud/sign-in")).json()) as { url: string };
    const opened = new URL(url);
    expect([opened.origin, opened.pathname, opened.searchParams.get("next"), opened.searchParams.get("app")]).toEqual(["https://dorks.build", "/login", "/onboarding", "1"]);
    const state = opened.searchParams.get("state")!;
    expect((await call("POST", "/api/cloud/sign-in/finish", { code: "good-code-1", state: "not-our-state" })).status).toBe(400);
    expect(redeemed).toEqual([]); // a state this server never opened is not even sent
    const signed = (await (await call("POST", "/api/cloud/sign-in/finish", { code: "good-code-1", state })).json()) as CloudView;
    expect(redeemed).toEqual([state]);
    expect((await call("POST", "/api/cloud/sign-in/finish", { code: "good-code-1", state })).status).toBe(400); // used once
    expect(signed.user).toEqual({ id: "u1", name: "Ada", email: "ada@example.com", image: null });
    const row = h.app.db.get<{ cloud_session_enc: string }>("SELECT cloud_session_enc FROM settings WHERE id = 1")!;
    expect(row.cloud_session_enc).not.toContain("sess-secret");

    // Personal first, each org with the servers it owns.
    const places = (await (await call("GET", "/api/cloud/places")).json()) as CloudPlaces;
    expect(places.orgs.map((o) => [o.id, o.personal, o.plan, o.servers.map((s) => `${s.id}:${s.kind}`)])).toEqual([
      // The relay's older plan names read as the new ones.
      ["p1", true, "local", ["m1:mac"]],
      ["o1", false, "teams", ["h1:hosted"]],
    ]);
    expect(places.orgs[0]!.servers[0]!.lastSeenAt).toBe(Date.parse("2026-11-01T00:00:00Z"));
    const created = (await (await call("POST", "/api/cloud/orgs", { name: "Friends" })).json()) as CloudOrg;
    expect(created).toMatchObject({ id: "o2", name: "Friends", personal: false, role: "owner", servers: [] });

    // Team management goes to Better Auth's organization endpoints, an allowlist; its refusals are AppErrors, never a 401.
    expect(await (await call("GET", "/api/cloud/auth/organization/get-full-organization?organizationId=o1")).json()).toEqual({ id: "o1", members: [] });
    const limited = await call("POST", "/api/cloud/auth/organization/invite-member", { email: "b@x.test", role: "member", organizationId: "o1" });
    expect([limited.status, ((await limited.json()) as { error: { code: string } }).error.code]).toEqual([429, "limit"]);
    expect((await call("POST", "/api/cloud/auth/organization/set-active", {})).status).toBe(404);
    expect((await call("GET", "/api/cloud/auth/organization/delete")).status).toBe(404);

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
