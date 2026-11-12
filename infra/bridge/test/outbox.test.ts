import type { FromBridge } from "@dorks/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import { Outbox } from "../src/outbox";
import { FakeTransport, waitFor } from "./helpers";

const ev = (bseq: number): FromBridge => ({ t: "event", bseq, raw: { n: bseq } });
const mk = (t: FakeTransport, extra = {}) => new Outbox(t, () => {}, { batchMs: 1, backoffBaseMs: 5, backoffCapMs: 20, onFatal: () => {}, ...extra });
const seqs = (t: FakeTransport) => t.events().map((e) => e.bseq);

describe("Outbox", () => {
  it("delivers in order, batching a burst into few pushes", async () => {
    const t = new FakeTransport();
    const o = mk(t);
    for (let i = 1; i <= 50; i++) o.push(ev(i));
    o.push({ t: "ready" });
    await o.drained();
    expect(seqs(t)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(t.frames.at(-1)).toEqual({ t: "ready" });
    expect(t.pushes.length).toBeLessThan(5);
  });

  it("never drops a batch: retries failures with backoff until it lands, keeping order", async () => {
    const t = new FakeTransport();
    let fails = 4;
    t.pushImpl = async () => {
      if (fails-- > 0) throw new Error("network down: SECRET-ECHO");
    };
    const o = mk(t);
    o.push(ev(1));
    o.push(ev(2));
    await waitFor(() => t.pushes.length > 0, "eventual delivery");
    o.push(ev(3));
    await o.drained();
    expect(seqs(t)).toEqual([1, 2, 3]);
    expect(fails).toBeLessThan(0);
  });

  it("does not log the error message of a failed push", async () => {
    const t = new FakeTransport();
    let n = 0;
    t.pushImpl = async () => {
      if (n++ < 1) throw new Error("echoes sk-ant-oat01-LEAK");
    };
    const lines: string[] = [];
    const o = new Outbox(t, (...a) => lines.push(a.join(" ")), { batchMs: 1, backoffBaseMs: 2, onFatal: () => {} });
    o.push(ev(1));
    await o.drained();
    expect(lines.join("\n")).not.toContain("LEAK");
    expect(lines.length).toBeGreaterThan(0);
  });

  it("replays from expectedBseq when the backend reports a gap (feature-detected)", async () => {
    const t = new FakeTransport();
    let gapOnce = true;
    t.pushImpl = async (frames) => {
      const first = frames.find((f) => f.t === "event") as Extract<FromBridge, { t: "event" }> | undefined;
      if (gapOnce && first && first.bseq === 4) {
        gapOnce = false;
        return { expectedBseq: 2 };
      }
    };
    const o = mk(t);
    o.push(ev(1));
    o.push(ev(2));
    o.push(ev(3));
    await o.drained();
    expect(seqs(t)).toEqual([1, 2, 3]);
    o.push(ev(4)); // backend says it is missing 2 and 3
    o.push(ev(5));
    await o.drained();
    expect(seqs(t)).toEqual([1, 2, 3, 2, 3, 4, 5]);
  });

  it("treats a plain (undefined) push result as success: no replay on old backends", async () => {
    const t = new FakeTransport();
    const o = mk(t);
    o.push(ev(1));
    o.push(ev(2));
    await o.drained();
    expect(seqs(t)).toEqual([1, 2]);
  });

  it("after a reconnect, resends only events above afterBridgeSeq", async () => {
    const t = new FakeTransport();
    const o = mk(t);
    for (let i = 1; i <= 5; i++) o.push(ev(i));
    await o.drained();
    o.rewindAfter(3); // backend only stored 1..3
    await o.drained();
    expect(seqs(t)).toEqual([1, 2, 3, 4, 5, 4, 5]);
  });

  it("delivers control frames once, and keeps events above the replay window only", async () => {
    const t = new FakeTransport();
    const o = mk(t, { retainEvents: 2 });
    o.push({ t: "ack", id: "c1" });
    for (let i = 1; i <= 6; i++) {
      o.push(ev(i));
      if (i === 5) o.push({ t: "ack", id: "c-mid" }); // between retained events
    }
    await o.drained();
    o.rewindAfter(0); // window only holds 5,6
    await o.drained();
    expect(t.of("ack").map((a) => a.id)).toEqual(["c1", "c-mid"]);
    expect(seqs(t)).toEqual([1, 2, 3, 4, 5, 6, 5, 6]);
  });

  it("a fatal error (backend refuses us) stops retrying and reports", async () => {
    const t = new FakeTransport();
    t.pushImpl = async () => {
      throw { data: { code: "forbidden", message: "forbidden" } };
    };
    const onFatal = vi.fn();
    const o = mk(t, { onFatal });
    o.push(ev(1));
    await waitFor(() => onFatal.mock.calls.length > 0, "fatal");
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it("a backend that keeps reporting a gap is retried with backoff, not a hot loop", async () => {
    const t = new FakeTransport();
    let calls = 0;
    t.pushImpl = async () => {
      calls++;
      return { expectedBseq: 1 };
    };
    const o = mk(t, { backoffBaseMs: 20, backoffCapMs: 20 });
    o.push(ev(1));
    await new Promise((r) => setTimeout(r, 200));
    o.stop();
    expect(calls).toBeLessThan(30);
  });

  it("a gap replay resends events only: control frames between events are not repeated", async () => {
    const t = new FakeTransport();
    const o = mk(t);
    o.push(ev(1));
    o.push(ev(2));
    o.push({ t: "agent_exited", code: 1, stderrTail: "" });
    o.push({ t: "flushed" });
    o.push(ev(3));
    await o.drained();
    // backend (rejecting a gapped batch whole) asks for 2 again
    let once = true;
    t.pushImpl = async (frames) => {
      if (once && frames.some((f) => f.t === "event" && f.bseq === 4)) {
        once = false;
        return { ok: false, expectedBseq: 2 };
      }
      return { ok: true };
    };
    o.push(ev(4));
    await o.drained();
    expect(seqs(t)).toEqual([1, 2, 3, 2, 3, 4]);
    expect(t.of("agent_exited")).toHaveLength(1);
    expect(t.of("flushed")).toHaveLength(1);
  });

  it("control frames in a rejected (gapped) batch are not lost: they go out with the replay", async () => {
    const t = new FakeTransport();
    const o = mk(t);
    o.push(ev(1));
    await o.drained();
    let once = true;
    t.pushImpl = async () => {
      if (once) {
        once = false;
        return { ok: false, expectedBseq: 1 };
      }
      return { ok: true };
    };
    o.push(ev(2));
    o.push({ t: "ack", id: "m1" }); // same batch as ev(2): rejected as a whole, so never applied
    await o.drained();
    expect(seqs(t)).toEqual([1, 1, 2]);
    expect(t.of("ack")).toHaveLength(1);
  });

  it("when the backend's expected seq predates the replay window it renumbers instead of retrying forever", async () => {
    const t = new FakeTransport();
    const renumbered: number[] = [];
    let stored = 0; // a tiny backend: accepts exactly the next seq
    t.pushImpl = async (frames) => {
      for (const f of frames) {
        if (f.t !== "event") continue;
        if (f.bseq !== stored + 1) return { ok: false, expectedBseq: stored + 1 };
        stored = f.bseq;
      }
      return { ok: true };
    };
    const o = mk(t, { retainEvents: 2, onRenumbered: (n: number) => renumbered.push(n) });
    for (let i = 1; i <= 6; i++) o.push(ev(i));
    await o.drained();
    expect(stored).toBe(6);
    // the backend loses 4..6 (restored from a snapshot at seq 3); the window only holds 5,6
    stored = 3;
    const before = t.pushes.length;
    o.push(ev(7));
    await o.drained();
    expect(stored).toBe(6); // 5,6,7 renumbered to 4,5,6
    expect(renumbered).toEqual([6]);
    expect(t.pushes.length - before).toBeLessThan(10);
  });

  it("a backend that is ahead of everything we hold moves our numbering up instead of looping", async () => {
    const t = new FakeTransport();
    const ahead: number[] = [];
    let first = true;
    t.pushImpl = async () => {
      if (first) {
        first = false;
        return { ok: false, expectedBseq: 50 };
      }
      return { ok: true };
    };
    const o = mk(t, { onBackendAhead: (n: number) => ahead.push(n) });
    o.push(ev(1));
    await o.drained();
    expect(ahead).toEqual([49]);
  });

  it("event_too_large: the offending event is replaced by a stub with the same bseq, and the stream moves on", async () => {
    const t = new FakeTransport();
    t.pushImpl = async (frames) => {
      for (const f of frames) if (f.t === "event" && JSON.stringify(f.raw).length > 1000) throw { data: { code: "event_too_large", message: "event_too_large" } };
    };
    const o = mk(t);
    o.push(ev(1));
    o.push({ t: "event", bseq: 2, raw: { type: "user", blob: "x".repeat(5000) } });
    o.push(ev(3));
    await o.drained();
    expect(seqs(t)).toEqual([1, 2, 3]);
    expect(t.events()[1].raw).toEqual({ type: "user", truncated: true });
  });

  it("too_many_frames: the batch is split until the backend accepts it, nothing dropped", async () => {
    const t = new FakeTransport();
    t.pushImpl = async (frames) => {
      if (frames.length > 7) throw { data: { code: "too_many_frames", message: "too_many_frames" } };
    };
    const o = mk(t);
    for (let i = 1; i <= 40; i++) o.push(ev(i));
    await o.drained();
    expect(seqs(t)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(Math.max(...t.pushes.map((p) => p.length))).toBeLessThanOrEqual(7);
  });

  it("{ok:false} without expectedBseq is retried with backoff, never treated as delivered", async () => {
    const t = new FakeTransport();
    let n = 0;
    t.pushImpl = async () => (n++ < 3 ? { ok: false } : { ok: true });
    const o = mk(t);
    o.push(ev(1));
    await o.drained();
    expect(seqs(t)).toEqual([1]);
    expect(n).toBe(4);
  });
});
