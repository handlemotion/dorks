// @vitest-environment node
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Drives infra/bridge-sim/convex-sim.mjs against an in-memory backend that enforces the push rules (see the fixture).
const sim = fileURLToPath(new URL("../../../infra/bridge-sim/convex-sim.mjs", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/sim-fake-backend.mjs", import.meta.url));

type Result = { stored: number[]; control: string[]; gaps: number; pushes: number; maxSeen: number; maxSize: number };
const run = (env: Record<string, string>) =>
  new Promise<Result>((resolve, reject) => {
    execFile("node", ["--import", fake, sim], { env: { ...process.env, DORK_ID: "abcdef123456", BRIDGE_SECRET: "x", BRIDGE_URL: "http://127.0.0.1:1", PUSH_BACKOFF_MS: "20", SIM_DELTAS: "20", SIM_DELTA_GAP_MS: "40", HEARTBEAT_MS: "60000", ...env }, timeout: 20_000, killSignal: "SIGKILL" }, (e, out, errOut) => {
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      if (!line) return reject(new Error(`no result: ${e?.message}\n${out}\n${errOut.slice(-500)}`));
      resolve(JSON.parse(line.slice(7)));
    });
  });
// everything the bridge ever numbered was stored, in order, with no holes
const dense = (r: Result) => r.stored.length >= 6 && r.stored.length === r.maxSeen && r.stored.every((s, i) => s === i + 1);

describe("bridge-sim delivery", () => {
  it("happy path: dense numbering, flushed echoes the flush command id", async () => {
    const r = await run({});
    expect(dense(r)).toBe(true);
    expect(r.gaps).toBe(0);
    expect(r.control).toContain("flushed:fl1");
  }, 30_000);

  it("transient failures never drop a batch", async () => {
    const r = await run({ FAKE_FAIL: "4" });
    expect(dense(r)).toBe(true);
  }, 30_000);

  it("a gap is repaired by replaying from expectedBseq", async () => {
    const r = await run({ FAKE_DROP: "1" });
    expect(r.gaps).toBeGreaterThan(0);
    expect(dense(r)).toBe(true);
  }, 30_000);

  it("event_too_large: the event is replaced by a stub with the same bseq, nothing wedges", async () => {
    const r = await run({ FAKE_MAX_BYTES: "100" });
    expect(dense(r)).toBe(true);
    expect(r.maxSize).toBeLessThanOrEqual(100);
    expect(r.control).toContain("flushed:fl1"); // frames queued behind the big event still got through
  }, 30_000);

  it("too_many_frames: the batch is split", async () => {
    const r = await run({ FAKE_MAX_FRAMES: "2" });
    expect(dense(r)).toBe(true);
  }, 30_000);
});
