import { describe, expect, it } from "vitest";
import { uiApp } from "../src/http/ui";
import { updateSettings } from "../src/services/settings";
import { harness } from "./harness";

const TOKEN = "owner-token-for-tests";

function api(h: ReturnType<typeof harness>) {
  const app = uiApp(h.app);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) => {
    const res = await app.request(path, { method, headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return call;
}

describe("snapshot API", () => {
  it("needs the owner token", async () => {
    const call = api(harness());
    expect((await call("GET", "/api/snapshot", undefined, {})).status).toBe(401);
    expect((await call("POST", "/api/snapshot/build", {}, {})).status).toBe(401);
  });

  it("reports why it cannot build, then builds and reports progress to the end", async () => {
    const h = harness();
    const call = api(h);

    expect((await call("GET", "/api/snapshot")).json).toMatchObject({ state: "none", canBuild: false, cannotBuildReason: "Add your Boat API key first.", snapshot: null });
    const refused = await call("POST", "/api/snapshot/build", {});
    expect(refused.status).toBe(412);
    expect(refused.json.error.code).toBe("not_configured");

    await updateSettings(h.app, { boatKey: "bk" });
    const started = await call("POST", "/api/snapshot/build", {});
    expect(started.status).toBe(202);
    expect(started.json).toMatchObject({ state: "building", step: "prepare", canBuild: true });
    expect(JSON.stringify(started.json)).not.toContain("bk"); // never any secret

    await h.settle();
    const done = (await call("GET", "/api/snapshot")).json;
    expect(done).toMatchObject({ state: "ready", managed: true, stale: false, error: null, step: null });
    expect((await call("GET", "/api/settings")).json.baseSnapshotId).toBe(done.snapshot);
  });

  it("reports a failure with its message, and rejects a malformed body", async () => {
    const h = harness();
    const call = api(h);
    await updateSettings(h.app, { boatKey: "bk" });
    h.snapshotDriver.installExit = 1;
    h.snapshotDriver.installStderr = "boom";
    await call("POST", "/api/snapshot/build", { force: true });
    await h.settle();
    expect((await call("GET", "/api/snapshot")).json).toMatchObject({ state: "failed", error: expect.stringContaining("The installer failed (exit 1)") });
    const bad = await call("POST", "/api/snapshot/build", { force: "yes" });
    expect(bad.status).toBe(400);
  });
});
