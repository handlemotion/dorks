import type { FromBridge } from "@dorks/shared";
import { describe, expect, it, vi } from "vitest";
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
    for (let i = 1; i <= 6; i++) o.push(ev(i));
    await o.drained();
    o.rewindAfter(0); // window only holds 5,6
    await o.drained();
    expect(t.of("ack")).toHaveLength(1);
    expect(seqs(t)).toEqual([1, 2, 3, 4, 5, 6, 5, 6]);
  });

  it("a fatal error (backend refuses us) stops retrying and reports", async () => {
    const t = new FakeTransport();
    t.pushImpl = async () => {
      throw { data: { code: "forbidden" } };
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
});
