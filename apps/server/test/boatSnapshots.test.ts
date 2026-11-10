import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BoatError } from "../src/lib/boat";
import { boatBuildFailureMessage, boatSnapshotDriver } from "../src/lib/boatSnapshots";
import { loadAssets, makeAssets } from "../src/snapshot/assets";

// The driver against a fake of the Boat HTTP API (https://docs.boat.dev/api/v1), checking exactly what is sent. No real Boat run.

const ID = "bx_23456789";
type Req = { method: string; path: string; body?: any; headers: Record<string, string> };

function fakeBoat(handler: (r: Req) => Response | undefined) {
  const requests: Req[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const r: Req = { method: init?.method ?? "GET", path: `${url.pathname.replace("/api/v1", "")}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> };
    requests.push(r);
    return handler(r) ?? Response.json({ ok: false, code: "not_found" }, { status: 404 });
  }) as typeof fetch;
  return { requests, driver: boatSnapshotDriver({ apiKey: "boat_test_key", fetch: fetcher, sleep: async () => {} }) };
}

describe("boat snapshot driver requests", () => {
  it("creates a build sandbox with no credentials, a lifetime limit, a label and an idempotency key", async () => {
    const { requests, driver } = fakeBoat((r) => (r.method === "POST" && r.path === "/sandboxes" ? Response.json({ ok: true, sandbox: { id: ID, state: "provisioning" } }, { status: 202 }) : undefined));
    expect(await driver.createBuildSandbox({ name: "dorks-base-build", label: "abc", key: "k1" })).toEqual({ id: ID });
    expect(requests[0].body).toEqual({ name: "dorks-base-build", labels: { "dorks-build": "abc" }, noEnv: true, ttlSeconds: 7200 });
    expect(requests[0].headers["Idempotency-Key"]).toBe("k1");
    expect(requests[0].headers.Authorization).toBe("Bearer boat_test_key");
  });

  it("retries a create while the same key is still in flight", async () => {
    let n = 0;
    const { requests, driver } = fakeBoat(() => (n++ < 2 ? Response.json({ ok: false, code: "idempotency_in_progress" }, { status: 409 }) : Response.json({ ok: true, sandbox: { id: ID } }, { status: 202 })));
    expect(await driver.createBuildSandbox({ name: "n", label: "l", key: "k" })).toEqual({ id: ID });
    expect(requests).toHaveLength(3);
  });

  it("lists this install's build sandboxes by label and ignores other, cancelled and expired ones", async () => {
    const { requests, driver } = fakeBoat((r) =>
      r.path.startsWith("/sandboxes?")
        ? Response.json({
            ok: true,
            pageInfo: { nextCursor: null },
            sandboxes: [
              { id: "bx_23456789", state: "idle", labels: { "dorks-build": "mine" } },
              { id: "bx_3456789a", state: "cancelled", labels: { "dorks-build": "mine" } },
              { id: "bx_456789ab", state: "idle", labels: { "dorks-build": "mine" }, dataExpiredAt: "2026-01-01" },
              { id: "bx_56789abc", state: "idle", labels: { "dorks-build": "someone-else" } },
              { id: "not-an-id", state: "idle", labels: { "dorks-build": "mine" } },
            ],
          })
        : undefined,
    );
    expect(await driver.listBuildSandboxes("mine")).toEqual([{ id: "bx_23456789" }]);
    expect(decodeURIComponent(requests[0].path)).toBe("/sandboxes?label=dorks-build=mine&limit=200");
  });

  it("waits for ready through provisioning, and fails on error, disappearance or timeout", async () => {
    const states = ["provisioning", "provisioning", "idle"];
    const ok = fakeBoat(() => Response.json({ ok: true, sandbox: { id: ID, state: states.shift() ?? "idle" } }));
    await ok.driver.waitReady(ID);
    expect(ok.requests).toHaveLength(3);

    await expect(fakeBoat(() => Response.json({ ok: true, sandbox: { id: ID, state: "error" } })).driver.waitReady(ID)).rejects.toThrow(/error state/);
    await expect(fakeBoat(() => undefined).driver.waitReady(ID)).rejects.toThrow(/disappeared/);
  });

  it("writes files and runs commands with the documented shapes, and a long timeout for the command", async () => {
    const { requests, driver } = fakeBoat((r) => {
      if (r.method === "PUT") return Response.json({ ok: true, success: true, path: r.body.path });
      if (r.path.endsWith("/commands")) return Response.json({ ok: true, exitCode: 3, stdout: "out", stderr: "err", timedOut: false });
    });
    await driver.writeFile(ID, "/home/user/x.mjs", "QUJD", "base64");
    expect(requests[0]).toMatchObject({ method: "PUT", path: `/sandboxes/${ID}/files`, body: { path: "/home/user/x.mjs", content: "QUJD", encoding: "base64" } });
    expect(await driver.run(ID, "bash x.sh", 600)).toEqual({ exitCode: 3, stdout: "out", stderr: "err", timedOut: false });
    expect(requests[1]).toMatchObject({ method: "POST", path: `/sandboxes/${ID}/commands`, body: { command: "bash x.sh", timeoutSeconds: 600 } });
    await expect(driver.writeFile("not-an-id", "/home/user/x", "x", "utf8")).rejects.toThrow(/invalid sandbox id/);
  });

  it("saves a snapshot (202), treats an already-running save as fine, and reads the status", async () => {
    let conflict = false;
    const { requests, driver } = fakeBoat((r) => {
      if (r.method === "POST" && r.path === "/saved-snapshots") return conflict ? Response.json({ ok: false, code: "save_in_progress" }, { status: 409 }) : Response.json({ ok: true, status: "saving", snapshot: { name: r.body.name, status: "saving" } }, { status: 202 });
      if (r.path === "/saved-snapshots/dorks-base-1234abcd") return Response.json({ ok: true, snapshot: { name: "dorks-base-1234abcd", status: "failed", error: "disk full", sourceSandboxId: ID } });
    });
    await driver.saveSnapshot(ID, "dorks-base-1234abcd");
    expect(requests[0].body).toEqual({ sandboxId: ID, name: "dorks-base-1234abcd" });
    conflict = true;
    await driver.saveSnapshot(ID, "dorks-base-1234abcd"); // no throw
    expect(await driver.getSnapshot("dorks-base-1234abcd")).toEqual({ name: "dorks-base-1234abcd", status: "failed", error: "disk full", sourceSandboxId: ID });
    expect(await driver.getSnapshot("missing")).toBeNull();
  });

  it("other save errors surface with their status and code", async () => {
    const { driver } = fakeBoat(() => Response.json({ ok: false, code: "credit_required" }, { status: 402 }));
    await expect(driver.saveSnapshot(ID, "x")).rejects.toMatchObject({ status: 402, code: "credit_required" });
  });

  it("deletes with the confirmation header and treats a missing sandbox as deleted", async () => {
    const { requests, driver } = fakeBoat((r) => (r.method === "DELETE" ? Response.json({ ok: true }, { status: 202 }) : undefined));
    await driver.deleteSandbox(ID);
    expect(requests[0]).toMatchObject({ method: "DELETE", path: `/sandboxes/${ID}` });
    expect(requests[0].headers["X-Ascii-Confirm-Delete"]).toBe(ID);
    await expect(fakeBoat(() => undefined).driver.deleteSandbox(ID)).resolves.toBeUndefined();
  });

  it("sends the organization header when one is set", async () => {
    const requests: Req[] = [];
    const driver = boatSnapshotDriver({ apiKey: "k", org: "team_1", sleep: async () => {}, fetch: (async (_u: unknown, init?: RequestInit) => {
      requests.push({ method: "GET", path: "", headers: init?.headers as Record<string, string> });
      return Response.json({ ok: true, snapshot: { name: "n", status: "ready" } });
    }) as typeof fetch });
    await driver.getSnapshot("n");
    expect(requests[0].headers["X-Boat-Org"]).toBe("team_1");
  });
});

describe("failure messages", () => {
  it("explain the cause without echoing responses", () => {
    expect(boatBuildFailureMessage(new BoatError("x", 401))).toMatch(/rejected the API key/);
    expect(boatBuildFailureMessage(new BoatError("x", 402, "credit_required"))).toMatch(/wallet/);
    expect(boatBuildFailureMessage(new BoatError("x", 429))).toMatch(/rate limiting/);
    expect(boatBuildFailureMessage(new BoatError("boat get: HTTP 500", 500, "boom"))).toBe("boat get: HTTP 500 (boom)");
    expect(boatBuildFailureMessage(new Error("secret detail"))).toBe("The snapshot build failed.");
  });
});

describe("snapshot assets", () => {
  it("identify the bridge and installer pair, and change when either changes", () => {
    const a = makeAssets(new TextEncoder().encode("bridge"), "installer");
    expect(a.bundleId).toMatch(/^[0-9a-f]{12}$/);
    expect(a.bridgeSha256).toBe(createHash("sha256").update("bridge").digest("hex"));
    expect(makeAssets(new TextEncoder().encode("bridge"), "installer").bundleId).toBe(a.bundleId);
    expect(makeAssets(new TextEncoder().encode("bridge2"), "installer").bundleId).not.toBe(a.bundleId);
    expect(makeAssets(new TextEncoder().encode("bridge"), "installer2").bundleId).not.toBe(a.bundleId);
    // "ab" + "c" and "a" + "bc" must not collide: the parts are separated.
    expect(makeAssets(new TextEncoder().encode("ab"), "c").bundleId).not.toBe(makeAssets(new TextEncoder().encode("a"), "bc").bundleId);
  });

  it("load from an explicit bundle path, with the repository installer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dorks-assets-"));
    const bundle = join(dir, "cli.mjs");
    writeFileSync(bundle, "console.log('bridge')");
    const a = await loadAssets({ DORKS_BRIDGE_BUNDLE: bundle });
    expect(Buffer.from(a.bridge).toString()).toBe("console.log('bridge')");
    expect(a.installer).toContain("boat-install"); // infra/snapshot/boat-install.sh
    expect(a.installer).toContain("sha256sum -c -");
    await expect(loadAssets({ DORKS_BRIDGE_BUNDLE: join(dir, "missing.mjs") })).rejects.toThrow();
  });
});
