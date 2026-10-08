import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { BoxNotFoundError } from "../../api/src/lib/box";
import { DORKS_NETWORK_POLICY, dorkLabel, execStartScript, upstashBox, UpstashBoxError } from "../convex/lib/upstash";

const KEY = "ubk_SECRET_API_KEY_123";
const DORK = "kh7abcdefghijklmnopqrstuvwxyz0123";
const SCOPE = "https://dev-1.convex.cloud";
const OPTS = { name: DORK, initCommand: "dorks-bridge", env: { DORK_ID: DORK, BRIDGE_URL: "https://x.convex.cloud", BRIDGE_SECRET: "s3cr3t-bridge" } };

type FakeBox = { id: string; name?: string; labels: string[]; status: string; created_at: number };

/** In-memory stand-in for the Box REST API (shapes from @upstash/box 0.7.9). Records every request. */
function fake(init: Partial<{ resumeLag: number; creatingPolls: number; failWith: (method: string, path: string) => Response | undefined; refusePauseWhenPaused: boolean; refuseResumeWhenRunning: boolean }> = {}) {
  const boxes = new Map<string, FakeBox>();
  const reqs: { method: string; path: string; body?: any; key?: string }[] = [];
  let n = 0;
  let polls = 0;
  let lag = 0; // GETs left before a resumed box reports running
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
      if (lag > 0 && --lag === 0) b.status = "running";
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
      if (init.resumeLag && b.status === "paused") lag = init.resumeLag;
      else b.status = "running";
      return json({});
    }
    if (method === "POST" && m[2] === "/exec") {
      if (b.status !== "running" && b.status !== "idle") return json({ error: "box is not running" }, 409);
      return json({ exit_code: 0, output: "" });
    }
    return json({ error: "unhandled" }, 500);
  }) as typeof fetch;
  return { fetch: f, boxes, reqs, count: (method: string, re: RegExp) => reqs.filter((r) => r.method === method && re.test(r.path)).length };
}

const make = (fk: ReturnType<typeof fake>, extra = {}) => upstashBox({ apiKey: KEY, baseUrl: "https://box.test", labelScope: SCOPE, fetch: fk.fetch, sleep: async () => {}, ...extra });

describe("labels", () => {
  it("fit the provider's constraints (<=20 chars of [A-Za-z0-9._:-]) and differ per dork", async () => {
    const a = await dorkLabel(SCOPE, DORK);
    expect(a).toMatch(/^[A-Za-z0-9._:-]{1,20}$/);
    expect(a).toBe(await dorkLabel(SCOPE, DORK));
    expect(a).not.toBe(await dorkLabel(SCOPE, DORK + "x"));
  });

  it("are scoped per deployment: the same dork id in dev and prod gets different labels", async () => {
    expect(await dorkLabel("https://prod-9.convex.cloud", DORK)).not.toBe(await dorkLabel(SCOPE, DORK));
  });

  it("a deployment never adopts or deletes another deployment's box", async () => {
    const fk = fake();
    const prod = await make(fk, { labelScope: "https://prod-9.convex.cloud" }).createFromSnapshot("snap_1", OPTS);
    fk.boxes.get(prod.id)!.status = "error"; // the thing a dev create would otherwise sweep away
    const dev = await make(fk).createFromSnapshot("snap_1", OPTS);
    expect(dev.id).not.toBe(prod.id);
    expect(fk.boxes.has(prod.id)).toBe(true);
  });

  it("the provider refuses to run without a scope", () => {
    expect(() => upstashBox({ apiKey: KEY, labelScope: "" })).toThrow(/labelScope/);
  });
});

describe("createFromSnapshot", () => {
  it("restores from the snapshot with label, env and init command, authenticated by header only", async () => {
    const fk = fake();
    const { id } = await make(fk).createFromSnapshot("snap_1", OPTS);
    const post = fk.reqs.find((r) => r.method === "POST")!;
    expect(post.path).toBe("/v2/box/from-snapshot");
    expect(post.body).toMatchObject({ snapshot_id: "snap_1", name: DORK, labels: [await dorkLabel(SCOPE, DORK)], init_command: "dorks-bridge", env_vars: OPTS.env });
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
    const label = await dorkLabel(SCOPE, DORK);
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
    const { id } = await upstashBox({ apiKey: KEY, baseUrl: "https://box.test", labelScope: SCOPE, fetch: racing, sleep: async () => {} }).createFromSnapshot("snap_1", OPTS);
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

  it("'not found' text on a non-404 status is NOT a missing box (5xx pages, 'image not found', 400s)", async () => {
    for (const status of [400, 500, 502, 503]) {
      for (const text of [JSON.stringify({ error: "runtime image not found" }), "<html>upstream service not found</html>", JSON.stringify({ error: "box does not exist" })]) {
        const fk = fake({ failWith: () => new Response(text, { status }) });
        const err = await make(fk).resume("box_1").then(() => null, (e) => e);
        expect(err, `${status} ${text}`).toBeInstanceOf(UpstashBoxError);
        expect(err).not.toBeInstanceOf(BoxNotFoundError);
        expect(err.message).toMatch(/^upstash \w+: HTTP \d+$/);
      }
    }
  });

  it("a 404 is only 'gone' if the box itself is confirmed missing while the API answers", async () => {
    // Wrong base URL / renamed route: every path 404s, including the list endpoint -> configuration error, not a missing box.
    const everything404 = fake({ failWith: () => new Response("<html>Cannot POST</html>", { status: 404 }) });
    const err = await make(everything404).resume("box_1").then(() => null, (e) => e);
    expect(err).toBeInstanceOf(UpstashBoxError);
    expect(err).not.toBeInstanceOf(BoxNotFoundError);
    expect(err.message).toMatch(/UPSTASH_BOX_BASE_URL/);
    // The same for pause and delete: a misconfigured URL must not read as "already gone" (silent leak).
    await expect(make(everything404).delete("box_1")).rejects.toThrow(/UPSTASH_BOX_BASE_URL/);
    await expect(make(everything404).pause("box_1")).rejects.toThrow(/UPSTASH_BOX_BASE_URL/);
  });

  it("a 404 on the resume POST while the box exists is not 'gone'", async () => {
    const fk = fake({ failWith: (m, p) => (m === "POST" && p.endsWith("/resume") ? new Response("{}", { status: 404 }) : undefined) });
    const p = make(fk);
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    fk.boxes.get(id)!.status = "paused";
    const err = await p.resume(id).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(UpstashBoxError);
    expect(err).not.toBeInstanceOf(BoxNotFoundError);
    expect(fk.boxes.has(id)).toBe(true);
  });

  it("410 and a deleted-status box count as gone", async () => {
    const fk = fake({ failWith: (m, p) => (m === "POST" && p.endsWith("/resume") ? new Response("{}", { status: 410 }) : undefined) });
    const p = make(fk);
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    fk.boxes.delete(id);
    await expect(p.resume(id)).rejects.toBeInstanceOf(BoxNotFoundError);
    const fk2 = fake({ refuseResumeWhenRunning: true });
    const p2 = make(fk2);
    const b = await p2.createFromSnapshot("snap_1", OPTS);
    fk2.boxes.get(b.id)!.status = "deleted";
    await expect(p2.resume(b.id)).rejects.toBeInstanceOf(BoxNotFoundError);
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
    const err = await upstashBox({ apiKey: KEY, labelScope: SCOPE, fetch: boom }).delete("box_1").then(() => null, (e) => e);
    expect(err.message).toBe("upstash delete: network error (Error)");
  });

  it("rate limits are reported as such", async () => {
    const fk = fake({ failWith: () => new Response("{}", { status: 429 }) });
    await expect(make(fk).resume("box_1")).rejects.toThrow(/rate limited/);
  });
});

describe("exec start mode", () => {
  const exec = { startMode: "exec" as const };

  it("a retry that finds its box idle (crashed before the first start) still starts the bridge", async () => {
    const fk = fake();
    const p = make(fk, exec);
    const a = await p.createFromSnapshot("snap_1", OPTS);
    fk.reqs.length = 0; // pretend the process died right after the first create; the start never happened
    const b = await p.createFromSnapshot("snap_1", OPTS);
    expect(b.id).toBe(a.id);
    expect(fk.count("POST", /from-snapshot/)).toBe(0);
    expect(fk.count("POST", new RegExp(`/${a.id}/exec$`))).toBe(1);
  });

  it("waits until the box reports running before it execs after a resume", async () => {
    const fk = fake({ resumeLag: 3 }); // exec answers 409 while the box is still paused
    const p = make(fk, exec);
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    fk.boxes.get(id)!.status = "paused";
    await p.resume(id);
    const order = fk.reqs.filter((r) => new RegExp(`/${id}(/exec|/resume)?$`).test(r.path)).map((r) => `${r.method} ${r.path.split(id)[1] || "/"}`);
    expect(order.indexOf("POST /resume")).toBeGreaterThan(-1);
    expect(order.lastIndexOf("GET /")).toBeGreaterThan(order.indexOf("POST /resume"));
    expect(order.at(-1)).toBe("POST /exec");
    expect(fk.boxes.get(id)!.status).toBe("running");
  });

  it("gives up if the box never comes up after resume", async () => {
    const fk = fake({ resumeLag: 1_000_000 });
    let t = 0;
    const p = make(fk, { ...exec, now: () => t, sleep: async (ms: number) => void (t += ms) });
    const { id } = await p.createFromSnapshot("snap_1", OPTS);
    fk.boxes.get(id)!.status = "paused";
    await expect(p.resume(id)).rejects.toThrow(/not running/);
    expect(fk.count("POST", /\/exec$/)).toBe(1); // only the create-time start
  });
});

describe("ready deadline", () => {
  it("is wall-clock: slow polls cannot stretch it, and the half-made box is deleted", async () => {
    let t = 0;
    const fk = fake({ creatingPolls: 1_000_000 });
    // every request "takes" 20s of wall clock, on top of the 2s sleeps
    const slow = (async (u: any, o?: RequestInit) => {
      t += 20_000;
      return fk.fetch(u, o);
    }) as typeof fetch;
    const p = upstashBox({ apiKey: KEY, baseUrl: "https://box.test", labelScope: SCOPE, fetch: slow, now: () => t, sleep: async (ms) => void (t += ms) });
    await expect(p.createFromSnapshot("snap_1", OPTS)).rejects.toThrow(/still creating after 240s/);
    expect(fk.count("GET", /\/v2\/box\/box_1$/)).toBeLessThan(15); // ~240s / (20s request + 2s sleep); a count-only loop would poll 120 times
    expect(fk.boxes.size).toBe(0);
  });
});

describe("execStartScript (run for real with sh)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    execFileSync("sh", ["-c", "pkill -f '[s]leep 31337' || true"]);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const run = (script: string) => execFileSync("sh", ["-c", script], { stdio: "pipe" });
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const pidOf = (dir: string) => readFileSync(`${dir}/dorks-start.pid`, "utf8").trim();
  const cmdline = (pid: string) => readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  // Not counting processes: how many wrapper shells exist differs between dash and bash. A second launch always rewrites the pidfile.

  it.skipIf(process.platform !== "linux")("is idempotent: a second run does not start a second process", async () => {
    const dir = mkdtempSync(`${tmpdir()}/dorks-start-`);
    dirs.push(dir);
    const script = execStartScript("sleep 31337", dir);
    run(script);
    await settle();
    const pid = pidOf(dir);
    expect(cmdline(pid)).toContain("sleep 31337");
    run(script);
    run(script);
    await settle();
    expect(pidOf(dir)).toBe(pid); // unchanged: nothing was relaunched
    expect(cmdline(pid)).toContain("sleep 31337"); // and the original is still the live one
  });

  it.skipIf(process.platform !== "linux")("a stale pidfile pointing at an unrelated live process does not block the start", async () => {
    const dir = mkdtempSync(`${tmpdir()}/dorks-start-`);
    dirs.push(dir);
    writeFileSync(`${dir}/dorks-start.pid`, String(process.pid)); // alive, but not our command (PID reuse after a pause)
    run(execStartScript("sleep 31337", dir));
    await settle();
    const pid = pidOf(dir);
    expect(pid).not.toBe(String(process.pid));
    expect(cmdline(pid)).toContain("sleep 31337");
  });
});
