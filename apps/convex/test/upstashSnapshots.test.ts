// The snapshot-build calls of the Upstash provider (lib/upstash.ts), against an in-memory stand-in for the REST API.
// The real API is exercised by scripts/snapshots-e2e.mjs.
import { describe, expect, it } from "vitest";
import { BUILD_DIR } from "../core/snapshot";
import { upstashBox, UpstashBoxError } from "../convex/lib/upstash";

const KEY = "ubk_SECRET_API_KEY_123";

type Req = { method: string; path: string; body?: any; form?: Record<string, string>; key?: string };
function fake(init: { execOutput?: (cmd: string) => { exit_code: number; output?: string; error?: string }; snapshotStatuses?: string[]; failUpload?: boolean } = {}) {
  const reqs: Req[] = [];
  const boxes = new Map<string, { id: string; name: string; labels: string[]; status: string; created_at: number }>();
  const snaps: { id: string; name: string; status: string }[] = [];
  const tombstones = new Set<string>(); // deleted boxes still answer GET, with status "deleted"
  let n = 0;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const f = (async (url: string | URL | Request, o?: RequestInit) => {
    const u = new URL(String(url));
    const method = o?.method ?? "GET";
    const isForm = o?.body instanceof FormData;
    const req: Req = { method, path: u.pathname + u.search, key: (o?.headers as Record<string, string>)?.["X-Box-Api-Key"] };
    if (isForm) req.form = { paths: String((o!.body as FormData).get("paths")), content: await ((o!.body as FormData).get("files") as Blob).text() };
    else if (o?.body) req.body = JSON.parse(String(o.body));
    reqs.push(req);
    if (method === "POST" && u.pathname === "/v2/box/from-snapshot") {
      const id = `box_${++n}`;
      boxes.set(id, { id, name: req.body.name, labels: req.body.labels ?? [], status: "idle", created_at: n });
      return json(boxes.get(id));
    }
    if (method === "GET" && u.pathname === "/v2/box") return json([...boxes.values()].filter((b) => b.labels.includes(u.searchParams.get("label") ?? "")));
    if (method === "GET" && u.pathname === "/v2/box/snapshots") return json({ snapshots: snaps.length ? snaps : null });
    if (method === "DELETE" && u.pathname === "/v2/box/snapshots") {
      for (const id of req.body.ids as string[]) {
        const i = snaps.findIndex((s) => s.id === id);
        if (i >= 0) snaps.splice(i, 1);
      }
      return json({});
    }
    const del = /^\/v2\/box\/([^/]+)$/.exec(u.pathname);
    if (method === "DELETE" && del) {
      if (!boxes.delete(del[1])) return json({ error: "Box not found" }, 404);
      tombstones.add(del[1]);
      return json({});
    }
    if (method === "GET" && del) return tombstones.has(del[1]) ? json({ id: del[1], status: "deleted" }) : boxes.has(del[1]) ? json(boxes.get(del[1])) : json({ error: "Box not found" }, 404);
    const m = /^\/v2\/box\/([^/]+)\/([a-z/]+)$/.exec(u.pathname);
    if (m && boxes.has(m[1])) {
      if (method === "POST" && m[2] === "files/upload") return init.failUpload ? json({ error: "disk full: ghs_leaky" }, 500) : json({ success: true, count: 1 });
      if (method === "POST" && m[2] === "exec") return json((init.execOutput ?? (() => ({ exit_code: 0, output: "" })))(req.body.command.at(-1)));
      if (method === "POST" && m[2] === "snapshots") {
        const s = { id: `0000000${snaps.length + 1}-0000-4000-8000-000000000000`, name: req.body.name, status: "creating" };
        snaps.push(s);
        return json({ id: s.id, name: s.name, status: "creating" });
      }
      if (method === "GET" && m[2] === "snapshots") {
        for (const s of snaps) s.status = init.snapshotStatuses?.shift() ?? "ready";
        return json({ snapshots: snaps.length ? snaps : null });
      }
    }
    return json({ error: "no route" }, 404);
  }) as typeof fetch;
  return { fetch: f, reqs, boxes, snaps };
}
const make = (fk: ReturnType<typeof fake>) => upstashBox({ apiKey: KEY, baseUrl: "https://box.test", labelScope: "https://dev.convex.cloud", fetch: fk.fetch, sleep: async () => {} });
const execs = (fk: ReturnType<typeof fake>) => fk.reqs.filter((r) => r.path.endsWith("/exec")).map((r) => r.body.command.at(-1) as string);

describe("createBuildBox", () => {
  it("restores the base snapshot with no env, init command or network policy, labelled for idempotency", async () => {
    const fk = fake();
    const { id } = await make(fk).createBuildBox("base-snap", { name: "build1" });
    const post = fk.reqs.find((r) => r.method === "POST" && r.path === "/v2/box/from-snapshot")!;
    expect(post.body).toMatchObject({ snapshot_id: "base-snap", name: "dorks-build-build1" });
    expect(post.body.labels).toHaveLength(1);
    expect(Object.keys(post.body).sort()).toEqual(["labels", "name", "snapshot_id"]); // nothing that could carry a secret
    expect(fk.boxes.has(id)).toBe(true);
  });

  it("is idempotent on the build name: a retry finds the box it made, and findBuildBox sees it", async () => {
    const fk = fake();
    const p = make(fk);
    const a = await p.createBuildBox("base", { name: "b1" });
    const b = await p.createBuildBox("base", { name: "b1" });
    expect(b.id).toBe(a.id);
    expect(fk.boxes.size).toBe(1);
    expect(await p.findBuildBox("b1")).toBe(a.id);
    expect(await p.findBuildBox("other")).toBeNull();
    expect((await p.createBuildBox("base", { name: "b2" })).id).not.toBe(a.id);
  });

  it("replaces a build box that ended in error", async () => {
    const fk = fake();
    const p = make(fk);
    const a = await p.createBuildBox("base", { name: "b1" });
    fk.boxes.get(a.id)!.status = "error";
    const b = await p.createBuildBox("base", { name: "b1" });
    expect(b.id).not.toBe(a.id);
  });
});

describe("putFiles", () => {
  it("uploads each file to its absolute path after making the directory, and chmods secrets", async () => {
    const fk = fake();
    const p = make(fk);
    const { id } = await p.createBuildBox("base", { name: "b1" });
    await p.putFiles(id, [{ path: `${BUILD_DIR}/setup.sh`, content: "echo hi\n" }, { path: `${BUILD_DIR}/gh-token`, content: "ghs_tok", secret: true }]);
    const uploads = fk.reqs.filter((r) => r.path.endsWith("/files/upload"));
    expect(uploads.map((u) => u.form)).toEqual([{ paths: `${BUILD_DIR}/setup.sh`, content: "echo hi\n" }, { paths: `${BUILD_DIR}/gh-token`, content: "ghs_tok" }]);
    expect(execs(fk)).toEqual([`mkdir -p '${BUILD_DIR}'`, `mkdir -p '${BUILD_DIR}'`, `chmod 600 '${BUILD_DIR}/gh-token'`]);
    expect(fk.reqs.every((r) => r.key === KEY)).toBe(true);
  });

  it("refuses relative or odd paths and bad box ids before sending anything", async () => {
    const fk = fake();
    const p = make(fk);
    const { id } = await p.createBuildBox("base", { name: "b1" });
    const before = fk.reqs.length;
    for (const path of ["setup.sh", "/tmp/../etc/passwd", "/tmp/a b", "/tmp/$(x)", ""]) await expect(p.putFiles(id, [{ path, content: "x" }])).rejects.toThrow(/invalid path/);
    await expect(p.putFiles("../x", [{ path: "/tmp/x", content: "x" }])).rejects.toThrow(/invalid box id/);
    expect(fk.reqs).toHaveLength(before);
  });

  it("a failed upload reports the status only, never the response body", async () => {
    const fk = fake({ failUpload: true });
    const p = make(fk);
    const { id } = await p.createBuildBox("base", { name: "b1" });
    const err = await p.putFiles(id, [{ path: "/tmp/x", content: "x" }]).catch((e) => e);
    expect(err).toBeInstanceOf(UpstashBoxError);
    expect(err.message).toBe("upstash upload: HTTP 500");
  });
});

describe("runner calls", () => {
  it("startRunner and pollRunner run the shared commands; poll redacts the log", async () => {
    const fk = fake({ execOutput: (cmd) => (cmd.includes("STATE:") ? { exit_code: 0, output: `STATE:done:0\nfinished ghs_${"a".repeat(30)}\n` } : { exit_code: 0, output: "" }) });
    const p = make(fk);
    const { id } = await p.createBuildBox("base", { name: "b1" });
    await p.startRunner(id);
    expect(execs(fk).at(-1)).toContain(`${BUILD_DIR}/run.sh`);
    expect(await p.pollRunner(id)).toEqual({ state: "done", exitCode: 0, log: "finished [redacted]\n" });
  });

  it("a failing start command is an error; check returns the exit code and a redacted tail", async () => {
    const fk = fake({ execOutput: (cmd) => (cmd.includes("run.sh") ? { exit_code: 1, output: "" } : { exit_code: 1, output: `bad token ghp_${"b".repeat(30)}` }) });
    const p = make(fk);
    const { id } = await p.createBuildBox("base", { name: "b1" });
    await expect(p.startRunner(id)).rejects.toThrow(/start: command exited with 1/);
    expect(await p.check(id, "verify")).toEqual({ exitCode: 1, output: "bad token [redacted]" });
  });
});

describe("deleting boxes", () => {
  it("deleting a box that is already deleted succeeds (the provider answers 404, then GET says status deleted)", async () => {
    const fk = fake();
    const p = make(fk);
    const { id } = await p.createBuildBox("base", { name: "b1" });
    await p.delete(id);
    await p.delete(id); // second call: DELETE 404, GET shows "deleted"
    expect(fk.boxes.has(id)).toBe(false);
  });

  it("deleting a box that never existed succeeds too", async () => {
    const fk = fake();
    const p = make(fk);
    await expect(p.delete("box_999")).resolves.toBeUndefined();
  });
});

describe("snapshots", () => {
  it("startSnapshot is idempotent on the name; snapshotStatus follows the provider; unknown ids are 'missing'", async () => {
    const fk = fake({ snapshotStatuses: ["creating", "ready"] });
    const p = make(fk);
    const { id } = await p.createBuildBox("base", { name: "b1" });
    const a = await p.startSnapshot(id, "dorks-env-1");
    const again = await p.startSnapshot(id, "dorks-env-1"); // lists first (status 'creating'), finds it
    expect(again.id).toBe(a.id);
    expect(fk.snaps).toHaveLength(1);
    expect(await p.snapshotStatus(id, a.id)).toBe("ready");
    expect(await p.snapshotStatus(id, "00000000-0000-4000-8000-0000000000ff")).toBe("missing");
  });

  it("an errored snapshot with the same name is replaced by a fresh one", async () => {
    const fk = fake({ snapshotStatuses: ["error"] });
    const p = make(fk);
    const { id } = await p.createBuildBox("base", { name: "b1" });
    const a = await p.startSnapshot(id, "dorks-env-1");
    const b = await p.startSnapshot(id, "dorks-env-1"); // lists first: the first one is now 'error'
    expect(b.id).not.toBe(a.id);
  });

  it("snapshotReady is true only for a snapshot that exists and is ready", async () => {
    const fk = fake({ snapshotStatuses: ["ready"] });
    const p = make(fk);
    const { id } = await p.createBuildBox("base", { name: "b1" });
    const snap = await p.startSnapshot(id, "dorks-env-1");
    expect(await p.snapshotReady(snap.id)).toBe(false); // listed, but still being made
    expect(await p.snapshotStatus(id, snap.id)).toBe("ready"); // the provider finishes it
    expect(await p.snapshotReady(snap.id)).toBe(true);
    expect(await p.snapshotReady("00000000-0000-4000-8000-0000000000ff")).toBe(false); // unknown
    await p.deleteSnapshot(snap.id);
    expect(await p.snapshotReady(snap.id)).toBe(false); // deleted
  });

  it("deleteSnapshot sends explicit ids only, validates them, and tolerates a missing one", async () => {
    const fk = fake();
    const p = make(fk);
    const { id } = await p.createBuildBox("base", { name: "b1" });
    const snap = await p.startSnapshot(id, "dorks-env-1");
    await p.deleteSnapshot(snap.id);
    await p.deleteSnapshot(snap.id); // already gone: not an error
    const dels = fk.reqs.filter((r) => r.method === "DELETE" && r.path.startsWith("/v2/box/snapshots"));
    expect(dels.map((d) => d.path)).toEqual(["/v2/box/snapshots", "/v2/box/snapshots"]); // never ?all=true
    expect(dels.every((d) => d.body.ids.length === 1)).toBe(true);
    for (const bad of ["", "../x", "a/b", "x".repeat(200)]) await expect(p.deleteSnapshot(bad)).rejects.toThrow(/invalid snapshot id/);
    expect(fk.snaps).toHaveLength(0);
  });
});
