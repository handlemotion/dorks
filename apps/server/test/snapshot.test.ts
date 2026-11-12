import { describe, expect, it } from "vite-plus/test";
import type { Change } from "../src/app";
import { BoatError } from "../src/lib/boat";
import { readSettings, updateSettings } from "../src/services/settings";
import { buildLabel, recoverSnapshotBuild, runBuild, snapshotName, snapshotView, startBuild } from "../src/services/snapshot";
import { hasTimer } from "../src/lifecycle/dispatch";
import { harness, testAssets, type Harness } from "./harness";

// The "Prepare Boat" base-snapshot build, against a fake provider (a real Boat run is not part of the test suite).

async function ready(over: Parameters<typeof harness>[0] = {}) {
  const h = harness(over);
  await updateSettings(h.app, { boatKey: "bk" });
  return h;
}

const changes = (h: Harness) => {
  const seen: Change[] = [];
  h.app.hub.on((c) => seen.push(c));
  return seen;
};

const buildRow = (h: Harness) => h.app.db.get<{ attempt: number; build_sandbox_id: string | null }>("SELECT * FROM snapshot_build WHERE id = 1")!;

describe("starting a build", () => {
  it("needs the Boat key and the bridge bundle, and says so", async () => {
    const noKey = harness();
    await expect(startBuild(noKey.app)).rejects.toMatchObject({ error: { code: "not_configured" } });
    expect((await snapshotView(noKey.app)).canBuild).toBe(false);

    const h = await ready();
    h.app.snapshotAssets = async () => {
      throw new Error("The bridge bundle is not available.");
    };
    await expect(startBuild(h.app)).rejects.toMatchObject({ error: { code: "failed" } });
    const view = await snapshotView(h.app);
    expect(view).toMatchObject({ canBuild: false, cannotBuildReason: "The bridge bundle is not available.", state: "none" });
  });

  it("queues one job, and calling it again while it runs changes nothing", async () => {
    const h = await ready();
    const seen = changes(h);
    const first = await startBuild(h.app);
    expect(first).toMatchObject({ state: "building", step: "prepare", stepIndex: 0, stepCount: 7 });
    expect(hasTimer(h.app, "", "snapshot:build")).toBe(true);
    const attempt = buildRow(h).attempt;
    await startBuild(h.app);
    await startBuild(h.app, { force: true });
    expect(buildRow(h).attempt).toBe(attempt);
    expect(seen.filter((c) => c.t === "snapshot")).toHaveLength(1);
  });
});

describe("a successful build", () => {
  it("builds from the assets, saves, points the app at the snapshot and deletes the build sandbox", async () => {
    const h = await ready();
    const d = h.snapshotDriver;
    const seen = changes(h);
    await startBuild(h.app);
    await h.settle();

    const name = snapshotName(h.app);
    expect(name).toMatch(/^dorks-base-[0-9a-f]{8}$/);
    expect(d.calls.filter((c) => c !== "getSnapshot")).toEqual(["list", "create", "waitReady", "writeFile", "writeFile", "run", "run", "save", "delete"]);
    expect(Buffer.from(d.files.get("/home/user/dorks-bridge.mjs")!, "base64").toString()).toBe("bridge-v1");
    expect(d.files.get("/home/user/boat-install.sh")).toBe("installer-v1");
    expect(d.commands[0]).toContain(h.assets.current.bridgeSha256); // the upload is checked before anything runs
    expect(d.commands[0]).toContain("sha256sum -c -");
    expect(d.commands[1]).toBe(`cd /home/user && DORKS_BUNDLE_ID=${h.assets.current.bundleId} bash boat-install.sh`);
    expect(d.boxes.size).toBe(0);
    expect(d.saved.get(name)?.status).toBe("ready");

    expect(readSettings(h.app).baseSnapshotId).toBe(name);
    expect(await snapshotView(h.app)).toMatchObject({ state: "ready", snapshot: name, managed: true, stale: false, step: null, error: null, builtBundleId: h.assets.current.bundleId });
    expect(buildRow(h).build_sandbox_id).toBeNull();
    expect(seen.some((c) => c.t === "settings")).toBe(true);
    expect(seen.filter((c) => c.t === "snapshot").length).toBeGreaterThan(5); // progress is published per step
  });

  it("is a no-op when the snapshot is in use and current, rebuilds with force, and calls an older bridge stale", async () => {
    const h = await ready();
    await startBuild(h.app);
    await h.settle();
    const attempt = buildRow(h).attempt;

    expect((await startBuild(h.app)).state).toBe("ready"); // nothing queued
    expect(buildRow(h).attempt).toBe(attempt);

    h.assets.current = testAssets("bridge-v2", "installer-v1"); // this app now carries a newer bridge
    expect(await snapshotView(h.app)).toMatchObject({ stale: true, state: "ready" });
    await startBuild(h.app); // stale: rebuilds without force
    expect(buildRow(h).attempt).toBe(attempt + 1);
    await h.settle();
    expect(await snapshotView(h.app)).toMatchObject({ stale: false, builtBundleId: h.assets.current.bundleId });

    await startBuild(h.app, { force: true });
    expect(buildRow(h).attempt).toBe(attempt + 2);
    await h.settle();
    expect(h.snapshotDriver.boxes.size).toBe(0);
  });

  it("ignores the old artifact while a re-save is still running, and waits for its own", async () => {
    const h = await ready();
    const d = h.snapshotDriver;
    const name = snapshotName(h.app);
    d.saved.set(name, { name, status: "ready", sourceSandboxId: "bx_old00000" }); // a previous build's snapshot
    d.savingPolls = 3;
    await startBuild(h.app);
    await h.settle();
    expect(d.calls.filter((c) => c === "getSnapshot").length).toBe(4); // 3 x saving, then ready
    expect(await snapshotView(h.app)).toMatchObject({ state: "ready" });
  });

  it("leaves a snapshot the user named by hand alone: not managed, never stale", async () => {
    const h = await ready();
    await startBuild(h.app);
    await h.settle();
    await updateSettings(h.app, { baseSnapshotId: "bsh_somecode" });
    h.assets.current = testAssets("other", "other");
    expect(await snapshotView(h.app)).toMatchObject({ managed: false, stale: false });
  });
});

describe("failures", () => {
  it("an installer failure is reported, the build sandbox is deleted, and the previous snapshot stays in use", async () => {
    const h = await ready();
    await startBuild(h.app);
    await h.settle();
    const good = readSettings(h.app).baseSnapshotId;

    h.snapshotDriver.installExit = 100;
    h.snapshotDriver.installStderr = "E: Unable to locate package\nnpm ERR! network";
    await startBuild(h.app, { force: true });
    await h.settle();

    const view = await snapshotView(h.app);
    expect(view.state).toBe("failed");
    expect(view.error).toContain("The installer failed (exit 100)");
    expect(view.error).toContain("npm ERR! network");
    expect(view.snapshot).toBe(good); // the last good one is remembered
    expect(readSettings(h.app).baseSnapshotId).toBe(good);
    expect(h.snapshotDriver.boxes.size).toBe(0);
    expect(h.snapshotDriver.calls.filter((c) => c === "save")).toHaveLength(1); // no save after a failed install

    h.snapshotDriver.installExit = 0;
    await startBuild(h.app); // a failed attempt is retried without force
    await h.settle();
    expect((await snapshotView(h.app)).state).toBe("ready");
  });

  it("a timed-out installer, a failed save and provider errors each fail with a clear message and still clean up", async () => {
    const cases: [(h: Harness) => void, RegExp][] = [
      [(h) => void (h.snapshotDriver.installTimedOut = true), /did not finish in 10 minutes/],
      [(h) => void ((h.snapshotDriver.saveResult = "failed"), (h.snapshotDriver.savingPolls = 1)), /could not save the snapshot: disk full/],
      [(h) => h.snapshotDriver.failNext.set("save", new BoatError("boat save snapshot: HTTP 402", 402, "credit_required")), /wallet to save another snapshot/],
      [(h) => h.snapshotDriver.failNext.set("create", new BoatError("boat create: HTTP 401; check", 401)), /rejected the API key/],
      [(h) => h.snapshotDriver.failNext.set("waitReady", new BoatError("boat: the build sandbox entered an error state")), /error state/],
    ];
    for (const [arrange, message] of cases) {
      const h = await ready();
      arrange(h);
      await startBuild(h.app);
      await h.settle();
      const view = await snapshotView(h.app);
      expect([view.state, view.error]).toEqual(["failed", expect.stringMatching(message)]);
      expect(h.snapshotDriver.boxes.size).toBe(0);
      expect(readSettings(h.app).baseSnapshotId).toBeUndefined();
    }
  });

  it("a build sandbox Boat will not delete is retried in the background, not forgotten", async () => {
    const h = await ready();
    h.snapshotDriver.deleteFails = true;
    await startBuild(h.app);
    await h.settle();
    expect((await snapshotView(h.app)).state).toBe("ready"); // the snapshot itself is fine
    const [id] = [...h.snapshotDriver.boxes.keys()];
    expect(hasTimer(h.app, "", `orphan:${id}`)).toBe(true);
    // The orphan job deletes through the box provider (the same Boat call for any sandbox id).
    await h.advance(20_000);
    expect(h.box.calls).toContain("delete");
  });
});

describe("restarts", () => {
  it("a build the process died in the middle of is cleaned up and run again as a new attempt", async () => {
    const h = await ready();
    const d = h.snapshotDriver;
    await startBuild(h.app);
    h.app.db.run("DELETE FROM timers WHERE name = 'snapshot:build'"); // the job row was claimed, then the process died
    // The dead attempt had created a sandbox and recorded its id.
    const recorded = await d.createBuildSandbox({ label: "any", name: "n", key: "k" });
    h.app.db.run("UPDATE snapshot_build SET build_sandbox_id = ? WHERE id = 1", recorded.id);
    const attemptBefore = buildRow(h).attempt;

    recoverSnapshotBuild(h.app);
    expect(buildRow(h).attempt).toBe(attemptBefore + 1);
    expect(hasTimer(h.app, "", "snapshot:build")).toBe(true);
    await h.settle();

    expect((await snapshotView(h.app)).state).toBe("ready");
    expect(d.boxes.has(recorded.id)).toBe(false); // the recorded leftover was removed before the new build started
    expect(d.boxes.size).toBe(0);
  });

  it("sweeps unrecorded build sandboxes by label, and recovery does nothing when no build was running", async () => {
    const h = await ready();
    recoverSnapshotBuild(h.app);
    expect(hasTimer(h.app, "", "snapshot:build")).toBe(false);

    await startBuild(h.app);
    // Boat's list shows a leftover carrying this install's build label that was never recorded.
    const label = buildLabel(h.app);
    h.snapshotDriver.boxes.set("bx_leftover", { label });
    await h.settle();
    expect(h.snapshotDriver.boxes.has("bx_leftover")).toBe(false);
  });

  it("a Boat key saved before its build was queued starts one on the next start, but a failed build is not retried by itself", async () => {
    const h = await ready({ config: { baseSnapshotId: undefined } }); // the key is saved; the process died before queueing
    recoverSnapshotBuild(h.app);
    await h.settle();
    expect((await snapshotView(h.app)).state).toBe("ready");

    const failed = await ready({ config: { baseSnapshotId: undefined } });
    failed.app.db.run("UPDATE snapshot_build SET status = 'failed', attempt = 1 WHERE id = 1");
    recoverSnapshotBuild(failed.app);
    await failed.settle();
    expect((await snapshotView(failed.app)).state).toBe("failed"); // retrying a failure is the owner's call (it may cost money)

    const preset = await ready(); // BASE_SNAPSHOT_ID is set: nothing to build
    recoverSnapshotBuild(preset.app);
    await preset.settle();
    expect((await snapshotView(preset.app)).state).toBe("none");
  });

  it("a stale job from an earlier attempt does nothing", async () => {
    const h = await ready();
    await startBuild(h.app);
    h.app.db.run("DELETE FROM timers");
    await runBuild(h.app, buildRow(h).attempt - 1);
    expect(h.snapshotDriver.calls).toEqual([]);
    expect((await snapshotView(h.app)).state).toBe("building");
  });
});

describe("the simulator", () => {
  it("builds instantly without Boat, so the app can be exercised end to end", async () => {
    const h = harness({ config: { boxProvider: "sim", simHostKey: "k" } });
    process.env.SIM_BUILD_STEP_MS = "0";
    try {
      const { getSnapshotDriver } = await import("../src/lib/box");
      h.app.getSnapshotDriver = () => getSnapshotDriver(h.app);
      await startBuild(h.app); // no Boat key needed in sim mode
      await h.settle();
      expect(await snapshotView(h.app)).toMatchObject({ state: "ready", managed: true });
    } finally {
      delete process.env.SIM_BUILD_STEP_MS;
    }
  });
});
