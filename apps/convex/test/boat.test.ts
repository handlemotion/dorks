import { afterEach, describe, expect, it } from "vitest";
import { BoxNotFoundError } from "../core/box";
import { boatBox, BoatError } from "../convex/lib/boat";
import { getBox } from "../convex/lib/box";
import type { ActionCtx } from "../convex/_generated/server";

const KEY = "boat_secret_test";
const NAME = "dork-123";
const CREATE = {
  name: NAME,
  initCommand: "dorks-bridge",
  generation: 1,
  env: { DORK_ID: NAME, BRIDGE_URL: "https://dev.convex.cloud", BRIDGE_SECRET: "secret-bridge" },
};

function fake() {
  const boxes = new Map<string, { id: string; state: string; labels: Record<string, string>; dataExpiredAt?: string }>();
  const requests: { method: string; path: string; body?: any; headers: Record<string, string> }[] = [];
  const keys = new Map<string, string>();
  let next = 0;
  let fail: ((method: string, path: string) => Response | undefined) | undefined;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = `${url.pathname}${url.search}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = init?.headers as Record<string, string>;
    requests.push({ method, path, body, headers });
    const forced = fail?.(method, path);
    if (forced) return forced;
    if (url.pathname === "/api/v1/sandboxes" && method === "GET") {
      const label = url.searchParams.get("label");
      const matches = [...boxes.values()].filter((b) => !label || `dorks=${b.labels.dorks}` === label);
      return json({ ok: true, sandboxes: matches, pageInfo: { nextCursor: null } });
    }
    if (url.pathname === "/api/v1/sandboxes" && method === "POST") {
      const key = headers["Idempotency-Key"];
      const id = keys.get(key) ?? `bx_2345678${"abcdefghjkmnpqrstuvwxyz"[next++]}`;
      keys.set(key, id);
      if (!boxes.has(id)) boxes.set(id, { id, state: "provisioning", labels: body.labels });
      return json({ ok: true, sandbox: boxes.get(id) }, 202);
    }
    const match = /^\/api\/v1\/sandboxes\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return json({ ok: false, code: "not_found" }, 404);
    const box = boxes.get(match[1]);
    if (!box) return json({ ok: false, code: "not_found" }, 404);
    if (method === "GET" && !match[2]) {
      if (box.state === "provisioning" || box.state === "resuming") box.state = "idle";
      if (box.state === "archiving") box.state = "archived";
      return json({ ok: true, sandbox: box });
    }
    if (method === "POST" && match[2] === "/commands") return json(body.detached ? { ok: true, processId: "p1" } : { ok: true, exitCode: 0 });
    if (method === "POST" && match[2] === "/stop") return json({ ok: true, status: "archiving", sandbox: Object.assign(box, { state: "archiving" }) }, 202);
    if (method === "POST" && match[2] === "/resume") return json({ ok: true, sandbox: Object.assign(box, { state: "resuming" }) }, 202);
    if (method === "DELETE" && !match[2]) return boxes.delete(box.id), json({ ok: true }, 202);
    return json({ ok: false, code: "not_found" }, 404);
  }) as typeof fetch;
  const provider = boatBox({ apiKey: KEY, scope: "https://dev.convex.cloud", fetch: fetcher, sleep: async () => {} });
  return { boxes, requests, provider, fetcher, setFail: (value: typeof fail) => { fail = value; } };
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

  it("keeps boxes from another Convex deployment separate", async () => {
    const f = fake();
    const first = await f.provider.createFromSnapshot("dorks-base", CREATE);
    const other = boatBox({
      apiKey: KEY, scope: "https://prod.convex.cloud",
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
    const provider = boatBox({ apiKey: KEY, scope: "https://dev.convex.cloud", org: "team_123", fetch: f.fetcher, sleep: async () => {} });
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
    expect(() => boatBox({ apiKey: KEY, scope: "" })).toThrow(/CONVEX_CLOUD_URL/);
  });
});

describe("provider selection", () => {
  const previous = { BOX_PROVIDER: process.env.BOX_PROVIDER, BOAT_API_KEY: process.env.BOAT_API_KEY, UPSTASH_BOX_API_KEY: process.env.UPSTASH_BOX_API_KEY };
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("recommends Boat when unset and rejects a missing key without falling back to Upstash", async () => {
    delete process.env.BOX_PROVIDER;
    delete process.env.BOAT_API_KEY;
    const provider = getBox({} as ActionCtx);
    await expect(provider.resume("bx_23456789")).rejects.toThrow(/BOAT_API_KEY/);
  });

  it("retains explicitly selected Upstash and rejects unknown drivers", async () => {
    process.env.BOX_PROVIDER = "upstash";
    delete process.env.UPSTASH_BOX_API_KEY;
    await expect(getBox({} as ActionCtx).resume("box_1")).rejects.toThrow(/UPSTASH_BOX_API_KEY/);
    process.env.BOX_PROVIDER = "unsupported";
    await expect(getBox({} as ActionCtx).resume("box_1")).rejects.toThrow(/unknown box provider/);
  });
});
