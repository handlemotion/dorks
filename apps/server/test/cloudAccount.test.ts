import { describe, expect, it } from "vite-plus/test";
import { uiApp } from "../src/http/ui";
import type { CloudAccountView, CloudOrg, CloudPlaces, CloudView } from "../src/services/cloudAccount";
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

  it("edits the profile and the org logo, and lists and signs out sessions, without ever sending a session token to the UI", async () => {
    let user = { id: "u1", name: "Ada", email: "ada@example.com", image: null as string | null };
    let sessions = [
      { id: "s-this", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-26T00:00:00Z", expiresAt: "2026-12-26T00:00:00Z", ipAddress: null, userAgent: "Bun/1.3", current: true },
      {
        id: "s-phone",
        createdAt: "2026-11-02T00:00:00Z",
        updatedAt: "2026-11-25T00:00:00Z",
        expiresAt: "2026-12-25T00:00:00Z",
        ipAddress: "1.2.3.4",
        userAgent: "Dorks/1 CFNetwork",
        current: false,
        token: "never-shown",
      },
    ];
    const uploads: { path: string; type: string | null; bytes: number }[] = [];
    const upload = (path: string, init: RequestInit | undefined) => uploads.push({ path, type: new Headers(init?.headers).get("content-type"), bytes: (init?.body as Uint8Array).length });
    // The relay's routes, by method and path.
    const routes: Record<string, (init: RequestInit | undefined) => Response> = {
      "GET /api/auth/get-session": () => Response.json({ session: {}, user }),
      "POST /api/auth/update-user": (init) => ((user = { ...user, ...(JSON.parse(init?.body as string) as { name: string }) }), Response.json({ status: true })),
      "POST /v1/me/avatar": (init) => (upload("/v1/me/avatar", init), (user = { ...user, image: "https://relay.test/v1/images/u/u1/a.webp" }), Response.json({ image: user.image })),
      "DELETE /v1/me/avatar": () => ((user = { ...user, image: null }), Response.json({ image: null })),
      "GET /v1/me/sessions": () => Response.json(sessions),
      "DELETE /v1/me/sessions/s-phone": () => ((sessions = sessions.filter((s) => s.id !== "s-phone")), Response.json({})),
      "DELETE /v1/me/sessions": () => Response.json({ signedOut: 0 }),
      "POST /v1/orgs/o1/logo": (init) => (upload("/v1/orgs/o1/logo", init), Response.json({ logo: "https://relay.test/v1/images/o/o1/l.webp" })),
      "POST /v1/orgs/o2/logo": () => Response.json({ error: { code: "forbidden", message: "Only an owner or admin can change the logo" } }, { status: 403 }),
    };
    const fetch = fakeFetch((url, init) => {
      if (url.pathname === "/v1/app-handoff/redeem") return Response.json({ token: "sess-secret", user });
      if (new Headers(init?.headers).get("authorization") !== "Bearer sess-secret") return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
      return routes[`${init?.method ?? "GET"} ${url.pathname}`]?.(init) ?? new Response("{}", { status: 404 });
    });
    const h = harness({ fetch, config: { cloudUrl: CLOUD } });
    const ui = uiApp(h.app);
    const call = (method: string, path: string, body?: unknown, type = "application/json") =>
      ui.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: { authorization: `Bearer ${h.app.cfg.ownerToken}`, "content-type": type },
          body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
        }),
      );

    expect((await call("GET", "/api/cloud/account")).status).toBe(412); // signed out
    const { url } = (await (await call("POST", "/api/cloud/sign-in")).json()) as { url: string };
    await call("POST", "/api/cloud/sign-in/finish", { code: "good-code-1", state: new URL(url).searchParams.get("state") });

    // The account and its sessions, never their tokens.
    const view = (await (await call("GET", "/api/cloud/account")).json()) as CloudAccountView;
    expect(view.user.name).toBe("Ada");
    expect(view.sessions.map((s) => [s.id, s.current])).toEqual([
      ["s-this", true],
      ["s-phone", false],
    ]);
    expect(JSON.stringify(view)).not.toContain("never-shown");

    // Renaming updates the kept account, so the switcher and attribution read the new name at once.
    expect(((await (await call("PATCH", "/api/cloud/account", { name: "  Ada King " })).json()) as { name: string }).name).toBe("Ada King");
    expect(((await (await call("GET", "/api/cloud")).json()) as CloudView).user?.name).toBe("Ada King");
    expect((await call("PATCH", "/api/cloud/account", { name: "" })).status).toBe(400);

    // The picture: the bytes go to the relay as they are, with their type; a wrong type or a big file never leaves this server.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const set = (await (await call("PUT", "/api/cloud/account/avatar", png, "image/png")).json()) as { image: string };
    expect(set.image).toBe("https://relay.test/v1/images/u/u1/a.webp");
    expect(((await (await call("GET", "/api/cloud")).json()) as CloudView).user?.image).toBe(set.image);
    expect((await call("PUT", "/api/cloud/account/avatar", png, "image/gif")).status).toBe(400);
    expect((await call("PUT", "/api/cloud/account/avatar", new Uint8Array(2 * 1024 * 1024 + 1), "image/png")).status).toBe(400);
    expect(uploads).toEqual([{ path: "/v1/me/avatar", type: "image/png", bytes: png.length }]);
    expect(((await (await call("DELETE", "/api/cloud/account/avatar")).json()) as { image: string | null }).image).toBeNull();

    // Sessions: one signed out by id; ids that are not ids are refused here.
    expect((await call("DELETE", "/api/cloud/account/sessions/s-phone")).status).toBe(200);
    expect(((await (await call("GET", "/api/cloud/account")).json()) as CloudAccountView).sessions.map((s) => s.id)).toEqual(["s-this"]);
    expect((await call("DELETE", "/api/cloud/account/sessions/a%2Fb")).status).toBe(400);
    expect(await (await call("DELETE", "/api/cloud/account/sessions")).json()).toEqual({ signedOut: 0 });

    // The org logo; the relay decides who may (its refusal comes back as an AppError, not a 401).
    expect(await (await call("PUT", "/api/cloud/orgs/o1/logo", png, "image/webp")).json()).toEqual({ logo: "https://relay.test/v1/images/o/o1/l.webp" });
    const refused = await call("PUT", "/api/cloud/orgs/o2/logo", png, "image/png");
    expect([refused.status, ((await refused.json()) as { error: { message: string } }).error.message]).toEqual([400, "Only an owner or admin can change the logo"]);
  });
});
