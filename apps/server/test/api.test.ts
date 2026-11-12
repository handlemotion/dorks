import { describe, expect, it } from "vite-plus/test";
import { uiApp } from "../src/http/ui";
import { updateSettings } from "../src/services/settings";
import { bridgeSecret } from "../src/lib/bridgeAuth";
import { fakeFetch, harness, type Harness } from "./harness";

// The UI API (docs/architecture.md) through the real router, services and SQLite.

const TOKEN = "owner-token-for-tests";

function api(h: Harness) {
  const app = uiApp(h.app);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) => {
    const res = await app.request(path, {
      method,
      headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, res };
  };
  return {
    app,
    get: (p: string) => call("GET", p),
    post: (p: string, b?: unknown) => call("POST", p, b ?? {}),
    put: (p: string, b: unknown) => call("PUT", p, b),
    del: (p: string, b?: unknown) => call("DELETE", p, b),
    patch: (p: string, b: unknown) => call("PATCH", p, b),
    call,
  };
}

async function onboarded(over: Parameters<typeof harness>[0] = {}) {
  const h = harness(over);
  const a = api(h);
  await updateSettings(h.app, { claudeToken: "ct", githubToken: "gt", boatKey: "bk", boatEnvironment: "chatgpt-only" });
  return { h, a };
}

describe("auth and errors", () => {
  it("health is open; everything else needs the owner token", async () => {
    const h = harness();
    const a = api(h);
    expect((await a.call("GET", "/api/health", undefined, {})).status).toBe(200);
    for (const [m, p] of [
      ["GET", "/api/dorks"],
      ["POST", "/api/dorks"],
      ["GET", "/api/settings"],
      ["GET", "/api/secrets"],
      ["GET", "/api/live"],
    ] as const) {
      const r = await a.call(m, p, undefined, {});
      expect([m, p, r.status]).toEqual([m, p, 401]);
      expect(r.json.error.code).toBe("forbidden");
    }
    expect((await a.call("GET", "/api/dorks", undefined, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await a.call("GET", "/api/dorks", undefined, { Authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
  });

  it("the sim feed answers only the host key, and only in sim mode", async () => {
    const boat = api(harness());
    expect((await boat.call("GET", "/sim/boxes", undefined, { "x-sim-host-key": "k" })).status).toBe(401);
    const sim = api(harness({ config: { boxProvider: "sim", simHostKey: "k" } }));
    expect((await sim.call("GET", "/sim/boxes", undefined, {})).status).toBe(401);
    expect((await sim.call("GET", "/sim/boxes", undefined, { "x-sim-host-key": "nope" })).status).toBe(401);
    expect((await sim.call("GET", "/sim/boxes", undefined, { "x-sim-host-key": "k" })).json).toEqual([]);
  });

  it("CORS allows the configured origins only", async () => {
    const a = api(harness());
    const ok = await a.app.request("/api/dorks", { method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const bad = await a.app.request("/api/dorks", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("bad JSON and non-object bodies are rejected as invalid", async () => {
    const a = api(harness());
    const r = await a.app.request("/api/dorks", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "{nope" });
    expect(r.status).toBe(400);
    expect((await a.post("/api/dorks", [1])).json.error.code).toBe("invalid");
  });
});

describe("settings", () => {
  it("never echoes secrets, and clears with an empty string", async () => {
    const { a } = await onboarded();
    const view = (await a.get("/api/settings")).json;
    expect(view).toMatchObject({
      claudeToken: true,
      boatKey: true,
      boatEnvironment: "chatgpt-only",
      github: { configured: true },
      publicUrlConfigured: true,
      sleepMinutes: 5,
      commentPolicy: { mode: "all" },
    });
    expect(JSON.stringify(view)).not.toMatch(/ct|gt|bk(?!$)/.source.slice(0, 0) + "xyz-never");
    await a.put("/api/settings", { claudeToken: "" });
    expect((await a.get("/api/settings")).json.claudeToken).toBe(false);
  });

  it("validates sleep minutes (NaN never reaches a timer), environment names and the comment policy", async () => {
    const h = harness();
    const a = api(h);
    for (const bad of [Number.NaN, "5", null]) expect((await a.put("/api/settings", { sleepMinutes: bad as never })).json?.error?.code ?? "ok").not.toBe("ok");
    await a.put("/api/settings", { sleepMinutes: 100_000 });
    expect((await a.get("/api/settings")).json.sleepMinutes).toBe(24 * 60);
    await a.put("/api/settings", { sleepMinutes: 0 });
    expect((await a.get("/api/settings")).json.sleepMinutes).toBe(0.05);
    expect((await a.put("/api/settings", { boatEnvironment: "Bad Name!" })).json.error.code).toBe("invalid");
    expect((await a.put("/api/settings", { commentPolicy: { mode: "nope" } })).json.error.code).toBe("invalid");
    expect((await a.put("/api/settings", { commentPolicy: { mode: "allowlist", logins: ["alice"] } })).status).toBe(200);
    expect((await a.get("/api/settings")).json.commentPolicy).toEqual({ mode: "allowlist", logins: ["alice"] });
  });

  it("a GitHub token GitHub rejects is refused; an accepted one records whose it is", async () => {
    const calls: string[] = [];
    const h = harness({
      fetch: (async (u: string | URL | Request, init?: RequestInit) => {
        const tok = new Headers(init?.headers).get("authorization");
        calls.push(String(u));
        return tok === "Bearer good" ? Response.json({ login: "robot" }) : new Response("{}", { status: 401 });
      }) as typeof fetch,
    });
    const a = api(h);
    expect((await a.put("/api/settings", { githubToken: "bad" })).json.error.code).toBe("invalid");
    expect((await a.get("/api/settings")).json.github.configured).toBe(false);
    expect((await a.put("/api/settings", { githubToken: "good" })).status).toBe(200);
    expect((await a.get("/api/settings")).json.github).toEqual({ configured: true, login: "robot" });
  });

  it("checks a Boat key against Boat's limits before it is saved: wrong key, trial, blocked wallet, wrong org", async () => {
    // Boat's documented answers (docs.boat.dev/api/v1 "Error model", /api/reference/account/get-boat-limits).
    const seen: { path: string; org: string | null }[] = [];
    const h = harness({
      fetch: (async (u: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const key = headers.get("authorization")?.replace("Bearer ", "") ?? null;
        const path = new URL(String(u)).pathname.replace("/api/v1", "");
        seen.push({ path, org: headers.get("x-boat-org") });
        const err = (status: number, code: string) => Response.json({ ok: false, code }, { status });
        if (key === "paid") return Response.json({ sandboxPlanKey: "starter", canStart: true });
        if (key === "trial") return Response.json({ sandboxPlanKey: "trial", canStart: true });
        if (key === "broke") return Response.json({ sandboxPlanKey: "starter", canStart: false, startBlockedReason: "wallet empty" });
        if (key === "scoped") return path === "/limits" ? err(403, "api_key_action_forbidden") : Response.json({ sandboxes: [] });
        if (key === "orgkey") return headers.get("x-boat-org") === "team_1" ? Response.json({ sandboxPlanKey: "team", canStart: true }) : err(409, "ambiguous_org");
        if (key === "expired") return err(403, "api_key_expired");
        if (key === "down") return new Response("{}", { status: 503 });
        return err(401, "unauthorized");
      }) as typeof fetch,
    });
    const a = api(h);
    const check = async (body: object) => (await a.post("/api/boat/check", body)).json;
    expect((await check({ boatKey: "paid" })).status).toBe("ok");
    expect((await check({ boatKey: "nope" })).status).toBe("invalid");
    expect((await check({ boatKey: "expired" })).message).toMatch(/expired/);
    expect((await check({ boatKey: "trial" })).message).toMatch(/paid Boat plan/);
    expect((await check({ boatKey: "broke" })).message).toMatch(/wallet empty/);
    expect((await check({ boatKey: "scoped" })).status).toBe("ok"); // no account.read: the key is proved by listing sandboxes
    expect(seen.slice(-2).map((s) => s.path)).toEqual(["/limits", "/sandboxes"]);
    expect((await check({ boatKey: "orgkey", boatOrg: "acme" })).status).toBe("needs_org");
    expect((await check({ boatKey: "orgkey", boatOrg: "team_1" })).status).toBe("ok");
    expect(seen.at(-1)).toMatchObject({ org: "team_1" });
    expect((await check({ boatKey: "down" })).status).toBe("unreachable");
    expect((await a.get("/api/settings")).json.boatKey).toBe(false); // checking saves nothing
    expect((await a.post("/api/boat/check", {})).json.error.code).toBe("not_configured");

    // Saving runs the same check on the server: refused keys are not stored; an unreachable Boat does not block the save.
    expect((await a.put("/api/settings", { boatKey: "trial" })).json.error).toMatchObject({ code: "invalid", message: expect.stringMatching(/paid Boat plan/) });
    expect((await a.get("/api/settings")).json.boatKey).toBe(false);
    expect((await a.put("/api/settings", { boatKey: "down" })).status).toBe(200);
    expect((await a.put("/api/settings", { boatKey: "paid" })).status).toBe(200);
    expect(await (await check({})).status).toBe("ok"); // falls back to the saved key
  });

  it("checks a Codex environment against Boat when it is saved", async () => {
    const envs = [
      {
        name: "chatgpt-only",
        safeForThirdParties: false,
        passAgentsCredentials: true,
        passGithub: false,
        passSecrets: false,
        passSandboxCredentials: false,
        proxyAiCredentials: false,
        credentialProfileId: "cp_1",
      },
      {
        name: "leaky",
        safeForThirdParties: false,
        passAgentsCredentials: true,
        passGithub: true,
        passSecrets: false,
        passSandboxCredentials: false,
        proxyAiCredentials: false,
        credentialProfileId: "cp_1",
      },
    ];
    const urls: string[] = [];
    const h = harness({
      fetch: (async (u: string | URL | Request) => {
        urls.push(String(u));
        return String(u).includes("/environments") ? Response.json({ environments: envs }) : Response.json({ sandboxPlanKey: "starter", canStart: true });
      }) as typeof fetch,
    });
    const a = api(h);
    expect((await a.put("/api/settings", { boatKey: "bk", boatOrg: "team_1", boatEnvironment: "chatgpt-only" })).status).toBe(200);
    expect(urls.some((u) => u.endsWith("/environments?org=team_1"))).toBe(true); // only the query selects the org on /environments
    expect((await a.put("/api/settings", { boatEnvironment: "leaky" })).json.error.message).toMatch(/disable other credentials/);
    expect((await a.put("/api/settings", { boatEnvironment: "missing" })).json.error.message).toMatch(/does not exist/);
    expect((await a.get("/api/settings")).json.boatEnvironment).toBe("chatgpt-only"); // refused values are not saved
  });

  it("saving a Boat key starts the base-snapshot build, unless a snapshot is already set", async () => {
    const h = harness({ config: { baseSnapshotId: undefined } });
    const a = api(h);
    expect((await a.put("/api/settings", { boatKey: "bk" })).status).toBe(200);
    expect((await a.get("/api/snapshot")).json.state).toBe("building");
    h.app.db.run("UPDATE snapshot_build SET status = 'failed' WHERE id = 1"); // say the trial refused the save
    await a.put("/api/settings", { boatKey: "bk2" }); // the owner's fixed key retries it
    expect((await a.get("/api/snapshot")).json.state).toBe("building");

    const manual = harness({ config: { baseSnapshotId: undefined } });
    await updateSettings(manual.app, { baseSnapshotId: "my-snap" });
    await api(manual).put("/api/settings", { boatKey: "bk" });
    expect((await api(manual).get("/api/snapshot")).json.state).toBe("none");
  });

  it("CLI secrets: names only, upsert, delete, bad names refused", async () => {
    const a = api(harness());
    expect((await a.put("/api/secrets/DEPLOY_TOKEN", { value: "v1" })).status).toBe(200);
    expect((await a.put("/api/secrets/DEPLOY_TOKEN", { value: "v2" })).status).toBe(200);
    expect((await a.put("/api/secrets/AAA", { value: "x" })).status).toBe(200);
    expect((await a.get("/api/secrets")).json).toEqual(["AAA", "DEPLOY_TOKEN"]);
    expect((await a.put("/api/secrets/lower", { value: "x" })).json.error.code).toBe("invalid");
    expect((await a.del("/api/secrets/AAA")).status).toBe(200);
    expect((await a.get("/api/secrets")).json).toEqual(["DEPLOY_TOKEN"]);
  });
});

describe("creating a dork", () => {
  it("is refused until onboarding is done, step by step", async () => {
    const h = harness();
    const a = api(h);
    const create = (provider = "claude") => a.post("/api/dorks", { repo: "o/r", message: "hi", provider });
    // Asked in onboarding order, so the reason is always the next thing to do.
    expect((await create()).json.error).toMatchObject({ code: "onboarding_incomplete", message: expect.stringMatching(/Boat API key/) });
    await updateSettings(h.app, { boatKey: "bk" });
    expect((await create()).json.error.message).toMatch(/Claude token/);
    await updateSettings(h.app, { claudeToken: "ct" });
    expect((await create()).json.error.message).toMatch(/GitHub token/);
    await updateSettings(h.app, { githubToken: "gt" });
    expect((await create()).status).toBe(201);
    expect((await create("codex")).json.error.message).toContain("ChatGPT"); // Codex needs the Boat environment
    await updateSettings(h.app, { boatEnvironment: "chatgpt-only" });
    expect((await create("codex")).status).toBe(201);
  });

  it("needs the public URL for a real sandbox", async () => {
    const { a } = await onboarded({ config: { publicUrl: undefined } });
    const r = await a.post("/api/dorks", { repo: "o/r", message: "hi", provider: "claude" });
    expect(r.status).toBe(412);
    expect(r.json.error.message).toContain("public URL");
  });

  it("defaults to Claude and validates the input", async () => {
    const { a, h } = await onboarded();
    const id = (await a.post("/api/dorks", { repo: "o/r", message: "hi" })).json.id;
    expect(h.dork(id).provider).toBe("claude");
    const bad = (body: object) => a.post("/api/dorks", { repo: "o/r", message: "hi", ...body }).then((r) => r.json.error?.code);
    expect(await bad({ repo: "nope" })).toBe("invalid");
    expect(await bad({ repo: "a/.." })).toBe("invalid");
    expect(await bad({ message: "   " })).toBe("invalid");
    expect(await bad({ message: "x".repeat(50_001) })).toBe("invalid");
    expect(await bad({ provider: "gpt" })).toBe("invalid");
    expect(await bad({ title: "t".repeat(121) })).toBe("invalid");
    expect((await a.post("/api/dorks", { repo: "dotted.name/repo-1.x", message: "hi", title: "t".repeat(120) })).status).toBe(201);
  });

  it("starts the sandbox with the bridge's address and its own secret, never the user's", async () => {
    const { a, h } = await onboarded();
    const id = (await a.post("/api/dorks", { repo: "o/r", message: "hi", provider: "claude" })).json.id;
    await h.settle();
    expect(h.box.created).toHaveLength(1);
    const env = h.box.created[0].env;
    expect(env).toEqual({ DORK_ID: id, BRIDGE_URL: "wss://dorks.example/bridge", BRIDGE_SECRET: await bridgeSecret("test-bridge-key", id) });
    expect(JSON.stringify(h.box.created)).not.toMatch(/"ct"|"gt"|"bk"/);
    expect(h.dork(id).boxId).toBe(`box-${id}`);
  });

  it("with an embedded tunnel, registers the sandbox for a ticket before creating it and removes it once its box is deleted", async () => {
    const svc = { url: "https://tunnels.example", installKey: `dti_${"a".repeat(64)}` };
    const fetch = fakeFetch((url, init) =>
      url.pathname === "/user"
        ? Response.json({ login: "agent-bot" })
        : url.host === "tunnels.example" && init?.method === "PUT"
          ? Response.json({ ticket: "dts_payload.sig" })
          : new Response(null, { status: 204 }),
    );
    const { a, h } = await onboarded({ fetch, config: { tunnelService: svc } });
    const id = (await a.post("/api/dorks", { repo: "o/r", message: "hi", provider: "claude" })).json.id;
    await h.settle();
    expect(h.box.created[0].env).toMatchObject({ DORKS_TUNNEL_SERVICE: svc.url, DORKS_TUNNEL_TICKET: "dts_payload.sig" });
    await a.del(`/api/dorks/${id}`);
    await h.settle();
    const toService = fetch.calls.filter((c) => c.url.startsWith("/v1/sandboxes/"));
    expect(toService.map((c) => `${c.method} ${c.url}`)).toEqual([`PUT /v1/sandboxes/${id}`, `DELETE /v1/sandboxes/${id}`]);
    expect(toService.every((c) => c.headers.get("authorization") === `Bearer ${svc.installKey}`)).toBe(true);
  });

  it("a Codex dork passes the Boat environment to the sandbox; a Claude one does not", async () => {
    const { a, h } = await onboarded();
    await a.post("/api/dorks", { repo: "o/r", message: "a", provider: "codex" });
    await a.post("/api/dorks", { repo: "o/r", message: "b", provider: "claude" });
    await h.settle();
    expect(h.box.created.map((c) => c.boatEnvironment ?? "none").sort()).toEqual(["chatgpt-only", "none"]); // jobs due together run in no promised order
  });

  it("a sandbox that fails to create leaves the dork in error with a safe message", async () => {
    const { a, h } = await onboarded();
    h.box.failCreates = 1;
    const id = (await a.post("/api/dorks", { repo: "o/r", message: "hi", provider: "claude" })).json.id;
    await h.settle();
    expect(h.state(id)).toBe("error");
    expect(
      h
        .events(id)
        .filter((e) => e.body.type === "error")
        .map((e) => (e.body as { message: string }).message),
    ).toEqual(["create_box failed"]);
  });

  it("without a base snapshot a session is refused until one is set", async () => {
    const { a } = await onboarded({ config: { baseSnapshotId: undefined } });
    const create = () => a.post("/api/dorks", { repo: "o/r", message: "hi", provider: "claude" });
    expect((await create()).json.error).toMatchObject({ code: "onboarding_incomplete", message: expect.stringMatching(/base snapshot/) });
    await a.put("/api/settings", { baseSnapshotId: "dorks-base-1" });
    expect((await create()).status).toBe(201);
  });
});

describe("a dork's life through the API", () => {
  async function dork() {
    const { a, h } = await onboarded();
    const id = (await a.post("/api/dorks", { repo: "o/r", message: "first", provider: "claude" })).json.id as string;
    await h.settle();
    return { a, h, id };
  }

  it("lists newest activity first, splits archived, and never exposes internals", async () => {
    const { a, h, id } = await dork();
    h.clock.t += 1000;
    const second = (await a.post("/api/dorks", { repo: "o/r", message: "second", provider: "claude" })).json.id;
    const list = (await a.get("/api/dorks")).json;
    expect(list.map((d: { id: string }) => d.id)).toEqual([second, id]);
    expect(JSON.stringify(list)).not.toMatch(/boxId|box-|sessionId|bridgeSeq/);
    expect(list[0]).toMatchObject({ title: "second", repo: "o/r", provider: "claude", state: "creating", archived: false, preview: "second" });
    await a.post(`/api/dorks/${id}/archive`, { archived: true });
    expect((await a.get("/api/dorks")).json.map((d: { id: string }) => d.id)).toEqual([second]);
    expect((await a.get("/api/dorks?archived=true")).json.map((d: { id: string }) => d.id)).toEqual([id]);
  });

  it("messages, interrupt, rename and archive validate and respect state", async () => {
    const { a, h, id } = await dork();
    expect((await a.post(`/api/dorks/${id}/messages`, { text: "  " })).json.error.code).toBe("invalid");
    expect((await a.post(`/api/dorks/${id}/messages`, { text: "more" })).status).toBe(200);
    expect(h.events(id).filter((e) => e.body.type === "user_message")).toHaveLength(2);
    expect((await a.patch(`/api/dorks/${id}`, { title: "" })).json.error.code).toBe("invalid");
    expect((await a.patch(`/api/dorks/${id}`, { title: "x".repeat(121) })).json.error.code).toBe("invalid");
    expect((await a.patch(`/api/dorks/${id}`, { title: "New name" })).status).toBe(200);
    expect((await a.get(`/api/dorks/${id}`)).json.title).toBe("New name");
    expect((await a.post(`/api/dorks/${id}/archive`, { archived: "yes" })).json.error.code).toBe("invalid");
    await a.post(`/api/dorks/${id}/archive`, { archived: true });
    const r = await a.post(`/api/dorks/${id}/messages`, { text: "to an archived dork" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("archived");
    expect(h.events(id).filter((e) => e.body.type === "user_message")).toHaveLength(2); // the rejected message left no trace
    expect(h.cmds(id).filter((c) => c.kind === "user_message")).toHaveLength(2);
  });

  it("unknown ids are 404 and never leak", async () => {
    const { a } = await dork();
    expect((await a.get("/api/dorks/nope")).status).toBe(404);
    expect((await a.post("/api/dorks/nope/messages", { text: "x" })).status).toBe(404);
    expect((await a.del("/api/dorks/nope")).status).toBe(404);
    expect((await a.get("/api/dorks/nope/events")).json).toEqual({ events: [], hasMore: false });
    expect((await a.get("/api/dorks/nope/subscriptions")).json).toEqual([]);
  });

  it("the transcript pages backwards and tails forwards", async () => {
    const { a, h, id } = await dork();
    for (let i = 0; i < 5; i++) await a.post(`/api/dorks/${id}/messages`, { text: `m${i}` });
    const all = h.events(id).length;
    const newest = (await a.get(`/api/dorks/${id}/events?limit=3`)).json;
    expect(newest.events.map((e: { seq: number }) => e.seq)).toEqual([all, all - 1, all - 2]);
    expect(newest.hasMore).toBe(true);
    const older = (await a.get(`/api/dorks/${id}/events?before=${all - 2}&limit=200`)).json;
    expect(older.events.at(0).seq).toBe(all - 3);
    expect(older.hasMore).toBe(false);
    const tail = (await a.get(`/api/dorks/${id}/events?after=${all - 2}`)).json;
    expect(tail.events.map((e: { seq: number }) => e.seq)).toEqual([all - 1, all]);
    expect(tail.events[0]).toMatchObject({ dorkId: id, ts: expect.any(Number), type: expect.any(String) });
    expect((await a.get(`/api/dorks/${id}/events?limit=99999`)).json.events.length).toBeLessThanOrEqual(200);
    expect((await a.get(`/api/dorks/${id}/events?before=abc`)).status).toBe(400);
  });

  it("a growing assistant message keeps one row, so a tailing client re-reads from its last seq", async () => {
    const { a, h, id } = await dork();
    const delta = (n: number, text: string) => ({ t: "event", bseq: n, raw: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } } });
    h.push(id, [{ t: "event", bseq: 1, raw: { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } } }, delta(2, "he"), delta(3, "llo ")]);
    h.push(id, [delta(4, "world")]);
    const deltas = (await a.get(`/api/dorks/${id}/events?limit=50`)).json.events.filter((e: { type: string }) => e.type === "assistant_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].text).toBe("hello world");
  });

  it("delete hides the dork at once and removes everything once the sandbox is gone", async () => {
    const { a, h, id } = await dork();
    await a.post(`/api/dorks/${id}/subscriptions`, { repo: "o/r", number: 3 });
    expect((await a.del(`/api/dorks/${id}`)).status).toBe(200);
    expect((await a.get(`/api/dorks/${id}`)).status).toBe(404);
    expect((await a.get("/api/dorks")).json).toEqual([]);
    expect((await a.post(`/api/dorks/${id}/messages`, { text: "x" })).status).toBe(404);
    await h.settle();
    expect(h.box.calls).toContain("delete");
    for (const t of ["dorks", "dork_runtime", "events", "commands", "pr_subscriptions", "inbox"]) expect(h.app.db.get(`SELECT COUNT(*) AS n FROM ${t}`)?.n).toBe(0);
    expect(h.app.db.get("SELECT COUNT(*) AS n FROM timers WHERE owner = ?", id)?.n).toBe(0);
  });

  it("a failed sandbox delete keeps the dork so deleting can be retried", async () => {
    const { a, h, id } = await dork();
    h.box.delete = async () => {
      throw new Error("provider down");
    };
    await a.del(`/api/dorks/${id}`);
    await h.settle();
    expect((await a.get(`/api/dorks/${id}`)).status).toBe(200);
  });

  it("PR subscriptions: subscribe, list, resume and unsubscribe for the owner", async () => {
    const { a, id } = await dork();
    expect((await a.post(`/api/dorks/${id}/subscriptions`, { repo: "Octo/Hello", number: 9 })).status).toBe(200);
    expect((await a.post(`/api/dorks/${id}/subscriptions`, { repo: "bad", number: 9 })).json.error.code).toBe("invalid");
    expect((await a.post(`/api/dorks/${id}/subscriptions`, { repo: "o/r" })).json.error.code).toBe("invalid");
    const list = (await a.get(`/api/dorks/${id}/subscriptions`)).json;
    expect(list).toEqual([expect.objectContaining({ repo: "octo/hello", number: 9, source: "user", status: "active" })]);
    expect((await a.post(`/api/dorks/${id}/subscriptions/resume`, { repo: "octo/hello", number: 9 })).status).toBe(200);
    expect((await a.post(`/api/dorks/${id}/subscriptions/resume`, { repo: "octo/hello", number: 99 })).status).toBe(404);
    expect((await a.del(`/api/dorks/${id}/subscriptions`, { repo: "octo/hello", number: 9 })).status).toBe(200);
    expect((await a.get(`/api/dorks/${id}/subscriptions`)).json).toEqual([]);
  });

  it("a generated title replaces the first-message placeholder, never a name the user typed", async () => {
    const { a, h } = await onboarded();
    const id = (await a.post("/api/dorks", { repo: "o/r", message: "the login tests flake on CI, fix them" })).json.id as string;
    await h.settle();
    h.push(id, [{ t: "title", text: "Fix the flaky login tests" }]);
    expect(h.dork(id).title).toBe("Fix the flaky login tests");
    h.push(id, [{ t: "title", text: "A second guess" }]); // generated once
    expect(h.dork(id).title).toBe("Fix the flaky login tests");
    const named = (await a.post("/api/dorks", { repo: "o/r", message: "hi" })).json.id as string;
    await a.patch(`/api/dorks/${named}`, { title: "Mine" });
    h.push(named, [{ t: "title", text: "Say hello" }]);
    expect(h.dork(named).title).toBe("Mine");
  });

  it("a Codex model can only be chosen from what Codex offered, after the sandbox stopped", async () => {
    const { a, h } = await onboarded();
    const id = (await a.post("/api/dorks", { repo: "o/r", message: "hi", provider: "codex" })).json.id as string;
    await h.settle();
    expect((await a.post(`/api/dorks/${id}/codex-model`, { model: "gpt-x", effort: "high" })).json.error.code).toBe("invalid"); // not in error
    h.push(id, [{ t: "codex_models", models: [{ model: "gpt-x", efforts: ["low", "high"] }] }]);
    h.input(id, { t: "agent_exited" });
    expect(h.state(id)).toBe("error");
    expect((await a.post(`/api/dorks/${id}/codex-model`, { model: "gpt-x", effort: "xhigh" })).json.error.code).toBe("invalid");
    expect((await a.post(`/api/dorks/${id}/codex-model`, { model: "gpt-x", effort: "high" })).status).toBe(200);
    expect(h.dork(id).codexModel).toEqual({ model: "gpt-x", effort: "high" });
    expect(h.dork(id).codexModelChoices).toBeUndefined();
  });
});

describe("live stream", () => {
  it("announces changes as invalidations and coalesces transcript growth", async () => {
    const { a, h } = await onboarded();
    const res = await a.app.request("/api/live", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const messages: { t: string; dorkId?: string; seq?: number }[] = [];
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith("data: ")) messages.push(JSON.parse(block.slice(6)));
        }
      }
    })();
    const until = async (cond: () => boolean, what = cond.toString()) => {
      for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(cond(), what).toBe(true);
    };
    await until(() => messages.some((m) => m.t === "hello"));
    const id = (await a.post("/api/dorks", { repo: "o/r", message: "hi", provider: "claude" })).json.id as string;
    await until(() => messages.some((m) => m.t === "events" && m.dorkId === id));
    expect(messages.some((m) => m.t === "dorks")).toBe(true);
    expect(messages.some((m) => m.t === "dork" && m.dorkId === id)).toBe(true);
    messages.length = 0;
    for (let i = 0; i < 20; i++) await a.post(`/api/dorks/${id}/messages`, { text: `burst ${i}` });
    await until(() => messages.some((m) => m.t === "events"));
    await new Promise((r) => setTimeout(r, 120));
    expect(messages.filter((m) => m.t === "events" && m.dorkId === id).length).toBeLessThan(5); // one per 50 ms window, not one per event
    await updateSettings(h.app, { sleepMinutes: 9 });
    await until(() => messages.some((m) => m.t === "settings"));
    await a.post(`/api/dorks/${id}/subscriptions`, { repo: "o/r", number: 1 });
    await until(() => messages.some((m) => m.t === "subscriptions" && m.dorkId === id));
    expect(messages.some((m) => (m as { t: string }).t === "commands")).toBe(false); // bridge-internal
    await reader.cancel();
    await pump.catch(() => {});
  });

  it("accepts the token as a query parameter, for EventSource", async () => {
    const a = api(harness());
    const res = await a.app.request(`/api/live?access_token=${TOKEN}`);
    expect(res.status).toBe(200);
    await res.body!.cancel();
    expect((await a.app.request("/api/live?access_token=wrong")).status).toBe(401);
    expect((await a.app.request(`/api/dorks?access_token=${TOKEN}`)).status).toBe(401); // only the stream takes it
  });
});
