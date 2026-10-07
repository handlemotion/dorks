import { describe, expect, it } from "vitest";
import { BoxNotFoundError } from "../../api/src/lib/box";
import { DORKS_NETWORK_POLICY, dorkLabel, execStartScript, upstashBox, UpstashBoxError } from "../convex/lib/upstash";

const KEY = "ubk_SECRET_API_KEY_123";
const DORK = "kh7abcdefghijklmnopqrstuvwxyz0123";
const OPTS = { name: DORK, initCommand: "dorks-bridge", env: { DORK_ID: DORK, BRIDGE_URL: "https://x.convex.cloud", BRIDGE_SECRET: "s3cr3t-bridge" } };

type FakeBox = { id: string; name?: string; labels: string[]; status: string; created_at: number };

/** In-memory stand-in for the Box REST API (shapes from @upstash/box 0.7.9). Records every request. */
function fake(init: Partial<{ creatingPolls: number; failWith: (method: string, path: string) => Response | undefined; refusePauseWhenPaused: boolean; refuseResumeWhenRunning: boolean }> = {}) {
  const boxes = new Map<string, FakeBox>();
  const reqs: { method: string; path: string; body?: any; key?: string }[] = [];
  let n = 0;
  let polls = 0;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const f = (async (url: string | URL | Request, o?: RequestInit) => {
    const u = new URL(String(url));
    const method = o?.method ?? "GET";
    const path = u.pathname + u.search;
    const body = o?.body ? JSON.parse(String(o.body)) : undefined;
    reqs.push({ method, path, body, key: (o?.headers as Record<string, string>)?.["X-Box-Api-Key"] });
    const forced = init.failWith?.(method, path);
    if (forced) return forced;
    if (method === "POST" && u.pathname === "/v2/box/from-snapshot") {
      const id = `box_${++n}`;
      const b: FakeBox = { id, name: body.name, labels: body.labels ?? [], status: init.creatingPolls ? "creating" : "idle", created_at: n };
      boxes.set(id, b);
      return json(b);
    }
    if (method === "GET" && u.pathname === "/v2/box") {
      const label = u.searchParams.get("label");
      return json([...boxes.values()].filter((b) => !label || b.labels.includes(label)));
    }
    const m = /^\/v2\/box\/([^/]+)(\/[a-z]+)?$/.exec(u.pathname);
    if (!m) return json({ error: "no route" }, 404);
    const b = boxes.get(m[1]);
    if (!b) return json({ error: "Box not found" }, 404);
    if (method === "GET" && !m[2]) {
      if (b.status === "creating" && ++polls >= (init.creatingPolls ?? 0)) b.status = "idle";
      return json(b);
    }
    if (method === "DELETE" && !m[2]) return boxes.delete(b.id), json({});
    if (method === "POST" && m[2] === "/pause") {
      if (b.status === "paused" && init.refusePauseWhenPaused) return json({ error: "box is already paused" }, 409);
      b.status = "paused";
      return json({});
    }
    if (method === "POST" && m[2] === "/resume") {
      if (b.status !== "paused" && init.refuseResumeWhenRunning) return json({ error: "box is not paused" }, 409);
      b.status = "running";
      return json({});
    }
    if (method === "POST" && m[2] === "/exec") return json({ exit_code: 0, output: "" });
    return json({ error: "unhandled" }, 500);
  }) as typeof fetch;
  return { fetch: f, boxes, reqs, count: (method: string, re: RegExp) => reqs.filter((r) => r.method === method && re.test(r.path)).length };
}

const make = (fk: ReturnType<typeof fake>, extra = {}) => upstashBox({ apiKey: KEY, baseUrl: "https://box.test", fetch: fk.fetch, sleep: async () => {}, ...extra });

describe("labels", () => {
  it("fit the provider's constraints (<=20 chars of [A-Za-z0-9._:-]) and differ per dork", async () => {
    const a = await dorkLabel(DORK);
    expect(a).toMatch(/^[A-Za-z0-9._:-]{1,20}$/);
    expect(a).toBe(await dorkLabel(DORK));
    expect(a).not.toBe(await dorkLabel(DORK + "x"));
  });
});

describe("createFromSnapshot", () => {
  it("restores from the snapshot with label, env and init command, authenticated by header only", async () => {
    const fk = fake();
    const { id } = await make(fk).createFromSnapshot("snap_1", OPTS);
    const post = fk.reqs.find((r) => r.method === "POST")!;
    expect(post.path).toBe("/v2/box/from-snapshot");
    expect(post.body).toMatchObject({ snapshot_id: "snap_1", name: DORK, labels: [await dorkLabel(DORK)], init_command: "dorks-bridge", env_vars: OPTS.env });
    expect(post.key).toBe(KEY);
    expect(post.path).not.toContain(KEY);
    expect(fk.boxes.has(id)).toBe(true);
  });

  it("is idempotent on name: a retry returns the same box and creates nothing", async () => {
    const fk = fake();
    const p = make(fk);
    const a = await p.createFromSnapshot("snap_1", OPTS);
    const b = await p.createFromSnapshot("snap_1", OPTS);
    expect(b.id).toBe(a.id);
    expect(fk.boxes.size).toBe(1);
    expect(fk.count("POST", /from-snapshot/)).toBe(1);
  });

  it("different names get different boxes", async () => {
    const fk = fake();
    const p = make(fk);
    const a = await p.createFromSnapshot("snap_1", OPTS);
    const b = await p.createFromSnapshot("snap_1", { ...OPTS, name: "other" });
    expect(a.id).not.toBe(b.id);
  });

  it("a retry that finds its box paused resumes it (nothing else would wake it)", async () => {
    const fk = fake();
    const p = make(fk);
    const a = await p.createFromSnapshot("snap_1", OPTS);
    fk.boxes.get(a.id)!.status = "paused";
    await p.createFromSnapshot("snap_1", OPTS);
    expect(fk.boxes.get(a.id)!.status).toBe("running");
  });

  it("replaces a box stuck in error state", async () => {
    const fk = fake();
    const p = make(fk);
    const a = await p.createFromSnapshot("snap_1", OPTS);
    fk.boxes.get(a.id)!.status = "error";
    const b = await p.createFromSnapshot("snap_1", OPTS);
    expect(b.id).not.toBe(a.id);
    expect(fk.boxes.has(a.id)).toBe(false);
  });

  it("waits for a creating box to become ready", async () => {
    const fk = fake({ creatingPolls: 3 });
    const { id } = await make(fk).createFromSnapshot("snap_1", OPTS);
    expect(fk.boxes.get(id)!.status).toBe("idle");
    expect(fk.count("GET", new RegExp(`/v2/box/${id}$`))).toBeGreaterThanOrEqual(3);
  });

  it("two creators racing converge on one box: the loser deletes itself", async () => {
    const fk = fake();
    const label = await dorkLabel(DORK);
    // The other creator's box appears between our empty list and our create (older created_at wins).
    let injected = false;
    const racing = (async (url: any, o?: RequestInit) => {
      const res = await fk.fetch(url, o);
      if (!injected && o?.method === "GET" && String(url).includes("/v2/box?label=")) {
        injected = true;
        fk.boxes.set("box_other", { id: "box_other", name: DORK, labels: [label], status: "idle", created_at: 0 });
        return new Response("[]"); // we saw an empty list before it landed
      }
      return res;
    }) as typeof fetch;
    const { id } = await upstashBox({ apiKey: KEY, baseUrl: "https://box.test", fetch: racing, sleep: async () => {} }).createFromSnapshot("snap_1", OPTS);
    expect(id).toBe("box_other");
    expect([...fk.boxes.keys()]).toEqual(["box_other"]);
  });

  it("deletes a half-made box when it never becomes ready", async () => {
    const fk = fake({ failWith: (m, p) => (m === "GET" && /box_1$/.test(p) ? new Response("{}", { status: 500 }) : undefined), creatingPolls: 99 });
    await expect(make(fk).createFromSnapshot("snap_1", OPTS)).rejects.toThrow(/HTTP 500/);
    expect(fk.boxes.size).toBe(0);
  });

  it("passes the network policy in the provider's snake_case wire format", async () => {
    const fk = fake();
    await make(fk, { networkPolicy: DORKS_NETWORK_POLICY }).createFromSnapshot("snap_1", OPTS);
    const body = fk.reqs.find((r) => r.method === "POST")!.body;
    expect(body.network_policy.mode).toBe("custom");
    expect(body.network_policy.allowed_domains).toEqual(expect.arrayContaining(["*.convex.cloud", "api.anthropic.com", "registry.npmjs.org", "github.com"]));
  });

  it("exec start mode: no init_command at create; starts the bridge through exec with a pidfile guard", async () => {
    const fk = fake();
    const p = make(fk, { startMode: "exec" });
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    expect(fk.reqs.find((r) => r.path === "/v2/box/from-snapshot")!.body).not.toHaveProperty("init_command");
    const exec = fk.reqs.find((r) => r.path === `/v2/box/${id}/exec`)!;
    expect(exec.body.command[0]).toBe("sh");
    expect(exec.body.command[2]).toBe(execStartScript("dorks-bridge"));
    expect(exec.body.command[2]).toContain("kill -0");
    expect(JSON.stringify(exec.body)).not.toContain("s3cr3t-bridge"); // secrets stay in env_vars, not on a command line
    fk.boxes.get(id)!.status = "paused";
    await p.resume(id);
    expect(fk.count("POST", /\/exec$/)).toBe(2);
  });

  it("init start mode: resume does not call exec (the platform re-runs init_command)", async () => {
    const fk = fake();
    const p = make(fk);
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    fk.boxes.get(id)!.status = "paused";
    await p.resume(id);
    expect(fk.count("POST", /\/exec$/)).toBe(0);
  });
});

describe("resume", () => {
  it("wakes a paused box", async () => {
    const fk = fake();
    const p = make(fk);
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    fk.boxes.get(id)!.status = "paused";
    await p.resume(id);
    expect(fk.boxes.get(id)!.status).toBe("running");
  });

  it("is a no-op on an already-resumed box, even if the provider refuses the call", async () => {
    const fk = fake({ refuseResumeWhenRunning: true });
    const p = make(fk);
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    await expect(p.resume(id)).resolves.toBeUndefined(); // idle
    fk.boxes.get(id)!.status = "paused";
    await p.resume(id);
    await expect(p.resume(id)).resolves.toBeUndefined(); // running now
  });

  it("surfaces a missing box as BoxNotFoundError (404)", async () => {
    await expect(make(fake()).resume("box_gone")).rejects.toBeInstanceOf(BoxNotFoundError);
  });

  it("recognises 'not found' in the body even on a non-404 status", async () => {
    const fk = fake({ failWith: () => new Response(JSON.stringify({ error: "box not found" }), { status: 400 }) });
    await expect(make(fk).resume("box_1")).rejects.toBeInstanceOf(BoxNotFoundError);
  });

  it("still fails when a refused resume leaves the box in a bad state", async () => {
    const fk = fake({ refuseResumeWhenRunning: true });
    const p = make(fk);
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    fk.boxes.get(id)!.status = "error";
    await expect(p.resume(id)).rejects.toBeInstanceOf(UpstashBoxError);
  });
});

describe("pause", () => {
  it("pauses, and pausing a paused box is not an error even if the provider refuses", async () => {
    const fk = fake({ refusePauseWhenPaused: true });
    const p = make(fk);
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    await p.pause(id);
    expect(fk.boxes.get(id)!.status).toBe("paused");
    await expect(p.pause(id)).resolves.toBeUndefined();
  });

  it("a missing box is nothing to pause", async () => {
    await expect(make(fake()).pause("box_gone")).resolves.toBeUndefined();
  });

  it("a failing pause on a still-running box is an error", async () => {
    const fk = fake({ failWith: (m, p) => (p.endsWith("/pause") ? new Response("{}", { status: 500 }) : undefined) });
    const p = make(fk);
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    await expect(p.pause(id)).rejects.toThrow(/HTTP 500/);
  });
});

describe("delete", () => {
  it("deletes, and 404 is success (idempotent)", async () => {
    const fk = fake();
    const p = make(fk);
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    await p.delete(id);
    expect(fk.boxes.size).toBe(0);
    await expect(p.delete(id)).resolves.toBeUndefined();
    await expect(p.delete("box_never_existed")).resolves.toBeUndefined();
  });

  it("uses the single-box endpoint, never the bulk one", async () => {
    const fk = fake();
    const p = make(fk);
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    await p.delete(id);
    expect(fk.reqs.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`/v2/box/${id}`]);
  });

  it("refuses ids that could change the request path", async () => {
    const fk = fake();
    for (const bad of ["", "../snapshots", "a/b", "a?all=true", "a b"]) await expect(make(fk).delete(bad)).rejects.toThrow(/invalid box id/);
    expect(fk.reqs).toEqual([]);
  });

  it("5xx on delete is an error, not silent success", async () => {
    const fk = fake({ failWith: () => new Response("{}", { status: 503 }) });
    await expect(make(fk).delete("box_1")).rejects.toThrow(/HTTP 503/);
  });
});

describe("errors", () => {
  const unauthorized = () => new Response(JSON.stringify({ error: `bad key ${KEY}` }), { status: 401 });

  it("auth failures are errors on every operation (never treated as not-found/success) and name the env var, not the key", async () => {
    const fk = fake({ failWith: unauthorized });
    const p = make(fk);
    const ops: [string, () => Promise<unknown>][] = [
      ["create", () => p.createFromSnapshot("snap_1", OPTS)],
      ["resume", () => p.resume("box_1")],
      ["pause", () => p.pause("box_1")],
      ["delete", () => p.delete("box_1")],
    ];
    for (const [, run] of ops) {
      const err = await run().then(() => null, (e) => e);
      expect(err).toBeInstanceOf(UpstashBoxError);
      expect(err).not.toBeInstanceOf(BoxNotFoundError);
      expect(err.status).toBe(401);
      expect(err.message).toMatch(/UPSTASH_BOX_API_KEY/);
      expect(err.message).not.toContain(KEY);
    }
  });

  it("403 is also an auth error", async () => {
    const fk = fake({ failWith: () => new Response("{}", { status: 403 }) });
    await expect(make(fk).delete("box_1")).rejects.toMatchObject({ status: 403 });
  });

  it("error messages never contain response bodies, env values, or the key", async () => {
    const echo = () => new Response(JSON.stringify({ error: `invalid env_vars: BRIDGE_SECRET=s3cr3t-bridge key=${KEY}` }), { status: 400 });
    for (const failWith of [echo, () => new Response(`<html>${KEY} s3cr3t-bridge</html>`, { status: 502 })]) {
      const err = await make(fake({ failWith })).createFromSnapshot("snap_1", OPTS).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/^upstash \w+: HTTP \d+$/);
      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toMatch(/s3cr3t|SECRET_API_KEY/);
    }
  });

  it("network failures do not leak the underlying error text", async () => {
    const boom = (async () => {
      throw new Error(`connect failed for ${KEY}`);
    }) as typeof fetch;
    const err = await upstashBox({ apiKey: KEY, fetch: boom }).delete("box_1").then(() => null, (e) => e);
    expect(err.message).toBe("upstash delete: network error (Error)");
  });

  it("rate limits are reported as such", async () => {
    const fk = fake({ failWith: () => new Response("{}", { status: 429 }) });
    await expect(make(fk).resume("box_1")).rejects.toThrow(/rate limited/);
  });
});
