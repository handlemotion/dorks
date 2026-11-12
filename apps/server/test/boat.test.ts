import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { BoxNotFoundError } from "../src/core/box";
import { boatBox, BoatError, desktopUrl, type BoatCall } from "../src/lib/boat";

const KEY = "boat_secret_test";
const NAME = "dork-123";
const CREATE = {
  name: NAME,
  initCommand: "dorks-bridge",
  generation: 1,
  env: { DORK_ID: NAME, BRIDGE_URL: "wss://dorks.example/bridge", BRIDGE_SECRET: "secret-bridge" },
};

function fake() {
  const boxes = new Map<string, { id: string; state: string; labels: Record<string, string>; dataExpiredAt?: string }>();
  const environments: { name: string; safeForThirdParties: boolean; proxyAiCredentials: boolean; passAgentsCredentials: boolean; passGithub: boolean; passSecrets: boolean; passSandboxCredentials: boolean; credentialProfileId: string | null }[] = [];
  const requests: { method: string; path: string; body?: any; headers: Record<string, string> }[] = [];
  const keys = new Map<string, string>();
  let next = 0;
  let fail: ((method: string, path: string) => Response | undefined) | undefined;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  type Req = { method: string; url: URL; body?: any; headers: Record<string, string> };
  const collection = ({ method, url, body, headers }: Req) => {
    if (method === "GET") {
      const label = url.searchParams.get("label");
      const matches = [...boxes.values()].filter((b) => !label || `dorks=${b.labels.dorks}` === label);
      return json({ ok: true, sandboxes: matches, pageInfo: { nextCursor: null } });
    }
    const key = headers["Idempotency-Key"];
    const id = keys.get(key) ?? `bx_2345678${"abcdefghjkmnpqrstuvwxyz"[next++]}`;
    keys.set(key, id);
    if (!boxes.has(id)) boxes.set(id, { id, state: "provisioning", labels: body.labels });
    return json({ ok: true, sandbox: boxes.get(id) }, 202);
  };
  const get = (box: { state: string }) => {
    if (box.state === "provisioning" || box.state === "resuming") box.state = "idle";
    if (box.state === "archiving") box.state = "archived";
    return json({ ok: true, sandbox: box });
  };
  const actions: Record<string, (box: { id: string; state: string }, body: any) => Response> = {
    "GET ": get,
    "POST /commands": (_box, body) => json(body.detached ? { ok: true, processId: "p1" } : { ok: true, exitCode: 0 }),
    "POST /stop": (box) => json({ ok: true, status: "archiving", sandbox: Object.assign(box, { state: "archiving" }) }, 202),
    "POST /resume": (box) => json({ ok: true, sandbox: Object.assign(box, { state: "resuming" }) }, 202),
    "POST /host": (box, body) => json({ url: `https://dk${box.id.slice(3)}-${body.port}.on.boat.dev${body.public ? "" : "?_token=tok_secret"}`, access: body.public ? "public" : "protected" }),
    "DELETE ": (box) => (boxes.delete(box.id), json({ ok: true }, 202)),
  };
  const notFound = () => json({ ok: false, code: "not_found" }, 404);
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = `${url.pathname}${url.search}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = init?.headers as Record<string, string>;
    requests.push({ method, path, body, headers });
    const forced = fail?.(method, path);
    if (forced) return forced;
    if (url.pathname === "/api/v1/environments" && method === "GET") return json({ ok: true, environments });
    if (url.pathname === "/api/v1/sandboxes") return collection({ method, url, body, headers });
    const match = /^\/api\/v1\/sandboxes\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const box = match && boxes.get(match[1]);
    const action = box && actions[`${method} ${match[2] ?? ""}`];
    return action ? action(box, body) : notFound();
  }) as typeof fetch;
  const provider = boatBox({ apiKey: KEY, scope: "wss://dorks.example/bridge", fetch: fetcher, sleep: async () => {} });
  return { boxes, requests, provider, fetcher, environments, setFail: (value: typeof fail) => { fail = value; } };
}

describe("Boat sandbox provider", () => {
  it("creates from a saved snapshot without account secrets or an auto-stop, and starts the bridge without putting secrets in commands", async () => {
    const f = fake();
    const { id } = await f.provider.createFromSnapshot("dorks-base", CREATE);
    const post = f.requests.find((r) => r.method === "POST" && r.path === "/api/v1/sandboxes")!;
    expect(post.body).toEqual({
      from: "dorks-base", name: NAME, labels: { dorks: expect.stringMatching(/^[a-f0-9]{64}$/) },
      env: CREATE.env, noEnv: true, ttlSeconds: null,
    });
    expect(post.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(post.headers["Idempotency-Key"]).toBeTruthy();
    expect(f.requests.find((r) => r.method === "POST" && r.path.endsWith("/commands") && r.body.detached)?.body.command)
      .toBe("flock -n /tmp/dorks-bridge.lock dorks-bridge");
    expect(f.requests.filter((r) => r.path.endsWith("/commands")).map((r) => r.body.command).join(" ")).not.toContain(CREATE.env.BRIDGE_SECRET);
    expect(f.boxes.has(id)).toBe(true);
  });

  it("uses a per-account Boat environment that passes only its dedicated ChatGPT profile", async () => {
    const f = fake();
    f.environments.push({ name: "dorks-codex", safeForThirdParties: false, proxyAiCredentials: false,
      passAgentsCredentials: true, passGithub: false, passSecrets: false, passSandboxCredentials: false, credentialProfileId: "codex-only" });
    await f.provider.createFromSnapshot("dorks-base", { ...CREATE, boatEnvironment: "dorks-codex" });
    expect(f.requests.find((r) => r.method === "POST" && r.path === "/api/v1/sandboxes")?.body)
      .toMatchObject({ environment: "dorks-codex", noEnv: false, env: CREATE.env });
  });

  it("refuses a Boat environment that could expose other account credentials", async () => {
    const f = fake();
    f.environments.push({ name: "unsafe", safeForThirdParties: false, proxyAiCredentials: false,
      passAgentsCredentials: true, passGithub: true, passSecrets: false, passSandboxCredentials: false, credentialProfileId: "codex-only" });
    await expect(f.provider.createFromSnapshot("dorks-base", { ...CREATE, boatEnvironment: "unsafe" })).rejects.toThrow("disable other credentials");
    expect(f.requests.some((r) => r.method === "POST" && r.path === "/api/v1/sandboxes")).toBe(false);
  });

  it("does not mistake a proxy-only or default-profile environment for direct account access", async () => {
    const f = fake();
    f.environments.push({ name: "proxy-only", safeForThirdParties: true, proxyAiCredentials: true,
      passAgentsCredentials: true, passGithub: false, passSecrets: false, passSandboxCredentials: false, credentialProfileId: "codex-only" });
    f.environments.push({ name: "default-profile", safeForThirdParties: false, proxyAiCredentials: false,
      passAgentsCredentials: true, passGithub: false, passSecrets: false, passSandboxCredentials: false, credentialProfileId: null });
    for (const boatEnvironment of ["proxy-only", "default-profile"])
      await expect(f.provider.createFromSnapshot("dorks-base", { ...CREATE, boatEnvironment })).rejects.toThrow("named AI credential profile");
    expect(f.requests.some((r) => r.method === "POST" && r.path === "/api/v1/sandboxes")).toBe(false);
  });

  it("checks an organization environment in the same wallet used to create the box", async () => {
    const f = fake();
    f.environments.push({ name: "dorks-codex", safeForThirdParties: false, proxyAiCredentials: false,
      passAgentsCredentials: true, passGithub: false, passSecrets: false, passSandboxCredentials: false, credentialProfileId: "codex-only" });
    const provider = boatBox({ apiKey: KEY, scope: "wss://dorks.example/bridge", org: "my team", fetch: f.fetcher, sleep: async () => {} });
    await provider.createFromSnapshot("dorks-base", { ...CREATE, boatEnvironment: "dorks-codex" });
    expect(f.requests.some((r) => r.path === "/api/v1/environments?org=my%20team")).toBe(true);
    expect(f.requests.find((r) => r.method === "POST" && r.path === "/api/v1/sandboxes")?.headers["X-Boat-Org"]).toBe("my team");
  });

  it("adopts a box after a lost create response rather than billing another one", async () => {
    const f = fake();
    const first = await f.provider.createFromSnapshot("dorks-base", CREATE);
    const second = await f.provider.createFromSnapshot("dorks-base", CREATE);
    expect(second).toEqual(first);
    expect(f.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/sandboxes")).toHaveLength(1);
  });

  it("retries an in-progress create with the same key and body", async () => {
    const f = fake();
    let first = true;
    f.setFail((method, path) => {
      if (method === "POST" && path === "/api/v1/sandboxes" && first) {
        first = false;
        return new Response(JSON.stringify({ code: "idempotency_in_progress" }), { status: 409 });
      }
    });
    await f.provider.createFromSnapshot("dorks-base", CREATE);
    const attempts = f.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/sandboxes");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].headers["Idempotency-Key"]).toBe(attempts[1].headers["Idempotency-Key"]);
    expect(attempts[0].body).toEqual(attempts[1].body);
  });

  it("keeps boxes from another Dorks installation separate", async () => {
    const f = fake();
    const first = await f.provider.createFromSnapshot("dorks-base", CREATE);
    const other = boatBox({
      apiKey: KEY, scope: "instance-b",
      fetch: f.fetcher, sleep: async () => {},
    });
    const second = await other.createFromSnapshot("dorks-base", CREATE);
    expect(second.id).not.toBe(first.id);
    expect(f.boxes.get(second.id)?.labels.dorks).not.toBe(f.boxes.get(first.id)?.labels.dorks);
    expect(f.boxes.has(first.id)).toBe(true);
  });

  it("stops, resumes, and restarts the guarded bridge, even when resumed twice", async () => {
    const f = fake();
    const { id } = await f.provider.createFromSnapshot("dorks-base", CREATE);
    await f.provider.pause(id);
    expect(f.boxes.get(id)?.state).toBe("archived");
    await f.provider.pause(id);
    expect(f.requests.filter((r) => r.path.endsWith("/stop"))).toHaveLength(1);
    await f.provider.resume(id);
    await f.provider.resume(id);
    expect(f.requests.filter((r) => r.path.endsWith("/resume"))).toHaveLength(1);
    expect(f.requests.filter((r) => r.path.endsWith("/commands") && r.body.detached)).toHaveLength(3);
  });

  it("uses a new creation key after the prior box is deleted", async () => {
    const f = fake();
    const first = await f.provider.createFromSnapshot("dorks-base", CREATE);
    await f.provider.delete(first.id);
    const second = await f.provider.createFromSnapshot("dorks-base", { ...CREATE, generation: 2 });
    expect(second.id).not.toBe(first.id);
    expect(f.requests.find((r) => r.method === "DELETE")?.headers["X-Ascii-Confirm-Delete"]).toBe(first.id);
    await expect(f.provider.delete(first.id)).resolves.toBeUndefined();
  });

  it("replaces an expired stopped sandbox instead of adopting it forever", async () => {
    const f = fake();
    const first = await f.provider.createFromSnapshot("dorks-base", CREATE);
    Object.assign(f.boxes.get(first.id)!, { state: "archived", dataExpiredAt: "2026-11-01T00:00:00Z" });
    const second = await f.provider.createFromSnapshot("dorks-base", { ...CREATE, generation: 2 });
    expect(second.id).not.toBe(first.id);
    expect(f.boxes.has(first.id)).toBe(false);
  });

  it("deletes a new sandbox when its bridge cannot start, so it cannot bill indefinitely", async () => {
    const f = fake();
    f.setFail((method, path) => method === "POST" && path.endsWith("/commands")
      ? new Response(JSON.stringify({ ok: true, exitCode: 127 }))
      : undefined);
    await expect(f.provider.createFromSnapshot("dorks-base", CREATE)).rejects.toThrow(/missing flock or dorks-bridge/);
    expect(f.boxes.size).toBe(0);
    expect(f.requests.find((r) => r.method === "DELETE")?.headers["X-Ascii-Confirm-Delete"]).toMatch(/^bx_/);
  });

  it("sends every request to the pinned organization wallet", async () => {
    const f = fake();
    const provider = boatBox({ apiKey: KEY, scope: "wss://dorks.example/bridge", org: "team_123", fetch: f.fetcher, sleep: async () => {} });
    const { id } = await provider.createFromSnapshot("dorks-base", CREATE);
    await provider.pause(id);
    expect(f.requests.every((r) => r.headers["X-Boat-Org"] === "team_123")).toBe(true);
  });

  it("treats expired snapshot data as a missing box, but not arbitrary conflicts", async () => {
    const f = fake();
    const { id } = await f.provider.createFromSnapshot("dorks-base", CREATE);
    f.boxes.get(id)!.state = "archived";
    f.setFail((method, path) => method === "POST" && path.endsWith("/resume")
      ? new Response(JSON.stringify({ code: "snapshot_data_expired" }), { status: 409 })
      : undefined);
    await expect(f.provider.resume(id)).rejects.toBeInstanceOf(BoxNotFoundError);
    f.setFail((method, path) => method === "POST" && path.endsWith("/resume")
      ? new Response(JSON.stringify({ code: "sandbox_stopping" }), { status: 409 })
      : undefined);
    await expect(f.provider.resume(id)).rejects.toBeInstanceOf(BoatError);
  });

  it("reports a deleted sandbox as missing and leaves stopping an already-deleted sandbox idempotent", async () => {
    const f = fake();
    await expect(f.provider.resume("bx_23456789")).rejects.toBeInstanceOf(BoxNotFoundError);
    await expect(f.provider.pause("bx_23456789")).resolves.toBeUndefined();
    await expect(f.provider.delete("bx_23456789")).resolves.toBeUndefined();
  });

  it("does not turn auth failures or a 500 into a missing box", async () => {
    const f = fake();
    f.setFail(() => new Response(JSON.stringify({ code: "unauthorized", message: KEY }), { status: 401 }));
    const error = await f.provider.resume("bx_23456789").then(() => { throw new Error("expected auth failure"); }, (e: BoatError) => e);
    expect(error.message).not.toContain(KEY);
    f.setFail(() => new Response(JSON.stringify({ code: "not_found", message: CREATE.env.BRIDGE_SECRET }), { status: 500 }));
    await expect(f.provider.resume("bx_23456789")).rejects.toBeInstanceOf(BoatError);
  });

  it("rejects path traversal ids and an unscoped deployment", async () => {
    const f = fake();
    await expect(f.provider.delete("../sandboxes")).rejects.toThrow(/invalid sandbox id/);
    expect(f.requests).toHaveLength(0);
    expect(() => boatBox({ apiKey: KEY, scope: "" })).toThrow(/scope/);
  });

  it("hosts a port publicly, so the Browser tab's iframe needs no third-party cookie, and never keeps a token", async () => {
    const f = fake();
    const { id } = await f.provider.createFromSnapshot("snap", CREATE);
    expect(await f.provider.hostPort!(id, 3000, { title: "Web app" })).toEqual({ url: `https://dk${id.slice(3)}-3000.on.boat.dev/` });
    expect(f.requests.at(-1)).toMatchObject({ method: "POST", path: `/api/v1/sandboxes/${id}/host`, body: { port: 3000, public: true, title: "Web app" } });
    expect(f.requests.at(-1)!.body).not.toHaveProperty("localhost");
    f.setFail((method, path) => (path.endsWith("/host") ? new Response(JSON.stringify({ url: "https://x-3000.on.boat.dev?_token=tok_secret" })) : undefined));
    expect((await f.provider.hostPort!(id, 3000, { localhost: true })).url).not.toContain("tok_secret");
  });
});

describe("desktop stream URL", () => {
  const noSleep = () => Effect.void;
  const run = (e: Parameters<typeof Effect.runPromise>[0]) => Effect.runPromise(e);
  it("waits out provisioning and hides the viewer chrome without touching the token fragment", async () => {
    const answers = [{ ok: true, provisioning: true }, { ok: true, desktopUrl: "https://box-desktop.on.boat.dev/stream.html?theme=light#token=t0k" }];
    const paths: string[] = [];
    const call: BoatCall = (_op, _method, path) => Effect.sync(() => (paths.push(path), answers.shift()));
    const url = await run(desktopUrl(call, "/sandboxes/bx_23456789/desktop", { theme: "light" }, noSleep));
    expect(url).toBe("https://box-desktop.on.boat.dev/stream.html?theme=light&overlay=0#token=t0k");
    expect(paths).toEqual(["/sandboxes/bx_23456789/desktop?theme=light", "/sandboxes/bx_23456789/desktop?theme=light"]);
  });
  it("gives up on a stream that never starts with a retryable code", async () => {
    const call: BoatCall = () => Effect.succeed({ ok: true, provisioning: true });
    await expect(run(desktopUrl(call, "/sandboxes/bx_23456789/desktop", { theme: "dark" }, noSleep, 0))).rejects.toMatchObject({ code: "provisioning" });
  });
  it("refuses a non-https URL", async () => {
    const bad: BoatCall = () => Effect.succeed({ ok: true, desktopUrl: "javascript:alert(1)" });
    await expect(run(desktopUrl(bad, "/sandboxes/bx_23456789/desktop", { theme: "dark" }, noSleep))).rejects.toBeInstanceOf(BoatError);
  });
});
