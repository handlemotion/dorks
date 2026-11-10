import { describe, expect, it } from "vitest";
import { update } from "../src/db";
import { boxCreated, boxPaused, boxResumed, opFailed } from "../src/lifecycle/lifecycle";
import { ev, harness, NOW } from "./harness";

// Lifecycle driver over the real SQLite code paths: state machine + effects + durable timers + box jobs, with a fake clock and a fake sandbox provider.

describe("H1: a bridge blip must not kill a healthy dork", () => {
  const seen = {
    push: (h: ReturnType<typeof harness>, id: string) => h.push(id, []),
    heartbeat: (h: ReturnType<typeof harness>, id: string) => h.heartbeat(id),
    connect: (h: ReturnType<typeof harness>, id: string) => h.connect(id),
  };
  for (const state of ["working", "idle"] as const)
    for (const [name, call] of Object.entries(seen))
      it(`${name} after bridge_watch lost it cancels the watchdog (${state})`, async () => {
        const h = harness();
        const id = h.seed(state, { bridgeSeenAt: NOW - 200_000 });
        h.timer(id, "bridge_watch");
        expect(h.rt(id).bridgeLost).toBe(true);
        expect(h.hasTimer(id, "watchdog")).toBe(true); // armed by bridge_lost
        call(h, id);
        expect(h.rt(id).bridgeLost).toBe(false);
        expect(h.hasTimer(id, "watchdog")).toBe(false);
        await h.settle();
        expect(h.state(id)).toBe(state);
      });

  it("a bridge that never went missing leaves the watchdog alone (no spurious agent_ready)", () => {
    const h = harness();
    const id = h.seed("waking");
    h.input(id, { t: "bridge_lost" }); // arms the watchdog; waking is not working/idle
    h.push(id, []);
    expect(h.hasTimer(id, "watchdog")).toBe(true); // only the `ready` frame ends the wait in waking
  });
});

describe("H2: a message during a sleep pause must not pause the box under a live turn", () => {
  const userFrames = (h: ReturnType<typeof harness>, id: string) => h.frames(id).filter((t) => t === "user_message");
  const sleepFlush = (h: ReturnType<typeof harness>) => {
    const id = h.seed("idle");
    h.timer(id, "sleep");
    expect(h.state(id)).toBe("idle");
    expect(h.kinds(id)).toEqual(["flush"]); // the flush is enqueued, the state stays idle
    return id;
  };

  it("`flushed` after a message does not pause", async () => {
    const h = harness();
    const id = sleepFlush(h);
    h.sendMessage(id);
    expect(h.state(id)).toBe("working");
    expect(h.kinds(id)).toEqual(["user_message"]); // pending flush deleted
    expect(h.hasTimer(id, "flush")).toBe(false);
    h.push(id, [{ t: "flushed" }]);
    await h.settle();
    expect(h.state(id)).toBe("working");
    expect(h.box.calls).toEqual([]);
  });

  it("the flush timeout after a message does not pause", async () => {
    const h = harness();
    const id = sleepFlush(h);
    h.sendMessage(id);
    await h.advance(20_000); // well past FLUSH_TIMEOUT_MS
    h.timer(id, "flush"); // even if a stale timer run did slip through
    await h.settle();
    expect(h.state(id)).toBe("working");
    expect(h.box.calls).toEqual([]);
  });

  it("an uninterrupted sleep still pauses (control)", async () => {
    const h = harness();
    const id = sleepFlush(h);
    h.push(id, [{ t: "flushed" }]);
    await h.settle();
    expect(h.box.calls).toEqual(["pause"]);
    expect(h.state(id)).toBe("sleeping");
  });

  it("a message after `flushed` but before the box call lands: the pause lands, then the dork wakes with the message queued", async () => {
    const h = harness();
    const id = sleepFlush(h);
    h.push(id, [{ t: "flushed" }]); // the pause job is now scheduled
    h.sendMessage(id);
    expect(h.rt(id).pause?.phase).toBe("cancelled");
    // The box is about to go down: the bridge must not be handed (and ack) the message now, or the turn dies with the box.
    expect(userFrames(h, id)).toEqual([]);
    await h.settle();
    expect(h.box.calls).toEqual(["pause", "resume"]);
    expect(h.state(id)).toBe("waking");
    expect(h.kinds(id)).toContain("user_message");
    h.connect(id);
    h.push(id, [{ t: "ready" }]); // the fresh bridge comes up: now it gets the message
    expect(h.state(id)).toBe("working");
    expect(userFrames(h, id)).toContain("user_message");
  });

  it("messages are held back while the pause's box call is in flight (not only after a cancel)", () => {
    const h = harness();
    const id = sleepFlush(h);
    h.enqueue(id, "user_message", "unacked"); // sent before the pause, never delivered
    h.push(id, [{ t: "flushed" }]);
    expect(h.rt(id).pause?.phase).toBe("pausing");
    expect(userFrames(h, id)).toEqual([]);
  });

  it("queued work found when a pause lands wakes the dork again", async () => {
    const h = harness();
    const id = h.seed("idle", { bridgeSeenAt: 0 }); // silent bridge: paused directly
    h.timer(id, "sleep");
    h.enqueue(id, "user_message", "late"); // persisted but never dispatched
    await h.settle();
    expect(h.box.calls).toEqual(["pause", "resume"]);
    expect(h.state(id)).toBe("waking");
  });

  it("archiving during a sleep flush still pauses exactly once", async () => {
    const h = harness();
    const id = sleepFlush(h);
    h.input(id, { t: "archive" });
    expect(h.kinds(id)).toEqual(["flush"]);
    h.push(id, [{ t: "flushed" }]);
    await h.settle();
    expect(h.box.calls).toEqual(["pause"]);
    const d = h.dork(id);
    expect([d.state, d.archived]).toEqual(["sleeping", true]);
  });

  it("a message to an archived dork is rejected and does not cancel the archive pause", async () => {
    const h = harness();
    const id = h.seed("idle");
    h.input(id, { t: "archive" });
    expect(h.input(id, { t: "user_message" })?.rejected).toBe("archived");
    h.push(id, [{ t: "flushed" }]);
    await h.settle();
    expect(h.state(id)).toBe("sleeping");
  });
});

describe("R1: error pauses the box", () => {
  it("watchdog -> error -> box paused -> sleeping; the next message wakes it", async () => {
    const h = harness();
    const id = h.seed("working", { bridgeSeenAt: 0 });
    h.timer(id, "watchdog");
    expect(h.state(id)).toBe("error");
    await h.settle();
    expect(h.box.calls).toEqual(["pause"]);
    expect(h.state(id)).toBe("sleeping");
    h.sendMessage(id);
    await h.settle();
    expect(h.box.calls).toEqual(["pause", "resume"]);
    expect(h.state(id)).toBe("waking");
  });

  it("agent_exited with a live bridge flushes, then pauses", async () => {
    const h = harness();
    const id = h.seed("working");
    h.push(id, [{ t: "agent_exited", code: 1, stderrTail: "" }]);
    expect(h.state(id)).toBe("error");
    expect(h.kinds(id)).toEqual(["flush"]);
    h.push(id, [{ t: "flushed" }]);
    await h.settle();
    expect(h.box.calls).toEqual(["pause"]);
    expect(h.state(id)).toBe("sleeping");
  });

  it("a failed create (no box yet) has nothing to pause", async () => {
    const h = harness();
    const id = h.seed("creating", { boxId: null });
    h.app.db.tx(() => opFailed(h.app, id, "x"));
    await h.settle();
    expect(h.state(id)).toBe("error");
    expect(h.box.calls).toEqual([]);
  });

  it("a failing pause from error does not loop", async () => {
    const h = harness();
    const id = h.seed("working", { bridgeSeenAt: 0 });
    h.box.failPauses = 5;
    h.timer(id, "watchdog");
    await h.settle();
    expect(h.box.calls).toEqual(["pause"]);
    expect(h.state(id)).toBe("error");
  });
});

describe("R2: stale control rows do not replay into the next wake", () => {
  it("a flush row that survived a flush timeout is not re-emitted while waking", async () => {
    const h = harness();
    const id = h.seed("idle");
    h.timer(id, "sleep");
    h.timer(id, "flush"); // the bridge never answered: timeout pauses the box
    await h.settle();
    expect(h.state(id)).toBe("sleeping");
    expect(h.kinds(id)).toEqual([]);
    h.sendMessage(id);
    expect(h.state(id)).toBe("waking");
    h.connect(id); // new bridge dials in
    expect(h.frames(id)).toEqual(["fetch_configure"]);
    h.push(id, [{ t: "ready" }]);
    expect(h.state(id)).toBe("working");
    expect(h.frames(id)).toEqual(["user_message", "fetch_configure"]);
  });

  it("leftover interrupt rows do not hit the first turn after a wake", async () => {
    const h = harness();
    const id = h.seed("idle", { bridgeSeenAt: 0 });
    h.enqueue(id, "interrupt");
    h.timer(id, "sleep");
    await h.settle();
    expect(h.state(id)).toBe("sleeping");
    expect(h.kinds(id)).toEqual([]);
  });

  it("rows left in `sleeping` by any path are cleared when the wake starts; messages are kept", () => {
    const h = harness();
    const id = h.seed("sleeping");
    h.enqueue(id, "interrupt");
    h.enqueue(id, "flush");
    h.enqueue(id, "configure");
    h.sendMessage(id, "keep me");
    expect(h.kinds(id)).toEqual(["user_message"]);
  });

  it("an unacked message survives the pause", () => {
    const h = harness();
    const id = h.seed("idle", { bridgeSeenAt: 0 });
    h.enqueue(id, "user_message", "pending");
    h.enqueue(id, "flush");
    h.input(id, { t: "paused" });
    expect(h.kinds(id)).toEqual(["user_message"]);
  });
});

describe("R4: strict bseq", () => {
  const stored = (h: ReturnType<typeof harness>, id: string) => h.events(id).filter((e) => e.body.type === "assistant_message").length;

  it("in order frames are accepted", () => {
    const h = harness();
    const id = h.seed("working");
    expect(h.push(id, [ev(1), ev(2), ev(3)])).toEqual({ ok: true });
    expect(h.rt(id).bridgeSeq).toBe(3);
    expect(stored(h, id)).toBe(3);
  });

  it("a call containing a gap applies nothing; the bridge resends from expectedBseq and nothing is lost or doubled", () => {
    const h = harness();
    const id = h.seed("working");
    expect(h.push(id, [ev(1), ev(2), ev(5), ev(6), { t: "ready" }])).toEqual({ ok: false, expectedBseq: 1 });
    expect(h.rt(id).bridgeSeq).toBe(0);
    expect(stored(h, id)).toBe(0);
    expect(h.push(id, [ev(1), ev(2), ev(3), ev(4), ev(5), ev(6)])).toEqual({ ok: true });
    expect(stored(h, id)).toBe(6);
    expect(h.events(id).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("a gap after already-stored events reports bridgeSeq + 1, and control frames before the gap are not applied twice", () => {
    const h = harness();
    const id = h.seed("working", { bridgeSeq: 2 });
    const exited = { t: "agent_exited", code: 1, stderrTail: "" };
    expect(h.push(id, [exited, ev(2), ev(3), ev(5)])).toEqual({ ok: false, expectedBseq: 3 });
    expect(h.events(id).filter((e) => e.body.type === "agent_exited")).toHaveLength(0);
    expect(h.state(id)).toBe("working");
    expect(h.push(id, [exited, ev(3), ev(4), ev(5)])).toEqual({ ok: true }); // the bridge resends the whole tail
    expect(h.events(id).filter((e) => e.body.type === "agent_exited")).toHaveLength(1);
  });

  it("a truncation stub in place of an oversized event keeps the numbering moving", () => {
    const h = harness();
    const id = h.seed("working");
    expect(h.push(id, [ev(1), { t: "event", bseq: 2, raw: { type: "truncated", truncated: true, was: "user" } }, ev(3)])).toEqual({ ok: true });
    expect(h.rt(id).bridgeSeq).toBe(3);
    expect(stored(h, id)).toBe(2);
  });

  it("a hostile bseq cannot mute the dork", () => {
    const h = harness();
    const id = h.seed("working");
    expect(h.push(id, [ev(2 ** 53 - 1)])).toEqual({ ok: false, expectedBseq: 1 });
    expect(h.rt(id).bridgeSeq).toBe(0);
    expect(h.push(id, [ev(1)])).toEqual({ ok: true });
    expect(stored(h, id)).toBe(1);
  });

  it("replayed frames (<= bridgeSeq) are ignored without error", () => {
    const h = harness();
    const id = h.seed("working", { bridgeSeq: 4 });
    expect(h.push(id, [ev(3), ev(4), ev(5)])).toEqual({ ok: true });
    expect(stored(h, id)).toBe(1);
    expect(h.rt(id).bridgeSeq).toBe(5);
  });

  describe("H9: size caps", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
        return null;
      } catch (e) {
        return (e as { error?: { code?: string } }).error?.code ?? null;
      }
    };

    it("rejects more than 500 frames per push, accepts 500", () => {
      const h = harness();
      const id = h.seed("working");
      const many = Array.from({ length: 501 }, (_, i) => ev(i + 1));
      expect(code(() => h.push(id, many))).toBe("too_many_frames");
      expect(h.rt(id).bridgeSeq).toBe(0);
      expect(h.push(id, many.slice(0, 500))).toEqual({ ok: true });
      expect(h.rt(id).bridgeSeq).toBe(500);
    });

    it("rejects an event over 256KB and stores nothing from that call", () => {
      const h = harness();
      const id = h.seed("working");
      const big = { t: "event", bseq: 2, raw: { type: "assistant", message: { id: "m", content: [{ type: "text", text: "x".repeat(256 * 1024) }] } } };
      expect(code(() => h.push(id, [ev(1), big]))).toBe("event_too_large");
      expect(stored(h, id)).toBe(0);
      const ok = { t: "event", bseq: 1, raw: { type: "assistant", message: { id: "m", content: [{ type: "text", text: "x".repeat(200 * 1024) }] } } };
      expect(h.push(id, [ok])).toEqual({ ok: true });
    });
  });
});

describe("R5: box results are tied to the operation that produced them", () => {
  it("a failure from a superseded resume does not flip the newer attempt to error", async () => {
    const h = harness();
    const id = h.seed("sleeping", { opGen: 0 });
    h.box.failResumes = 1; // the first resume attempt fails, slowly
    h.sendMessage(id); // waking, resume gen 1 scheduled
    expect(h.rt(id).opGen).toBe(1);
    // before it runs: the attempt is abandoned and retried (watchdog -> error -> message -> waking), so gen 1 is superseded
    h.input(id, { t: "watchdog" });
    h.sendMessage(id, "again");
    expect(h.rt(id).opGen).toBe(3);
    await h.settle(); // resume#1 never runs (replaced by #3's job); pause#2 lands stale
    expect(h.state(id)).toBe("waking");
    expect(h.events(id).filter((e) => e.body.type === "error").map((e) => (e.body as { message: string }).message)).not.toContain("resume_box failed");
  });

  it("the current attempt's failure still moves the dork to error", async () => {
    const h = harness();
    const id = h.seed("sleeping");
    h.box.failResumes = 1;
    h.sendMessage(id);
    await h.settle();
    expect(h.state(id)).toBe("error");
  });

  it("opFailed / boxPaused with a stale generation are no-ops", () => {
    const h = harness();
    const id = h.seed("waking", { opGen: 7 });
    h.app.db.tx(() => opFailed(h.app, id, "x", 6));
    h.app.db.tx(() => boxPaused(h.app, id, 6));
    expect(h.state(id)).toBe("waking");
    h.app.db.tx(() => opFailed(h.app, id, "x", 7));
    expect(h.state(id)).toBe("error");
  });

  it("a duplicate result for the same operation is ignored once it has been consumed", async () => {
    const h = harness();
    const id = h.seed("idle", { bridgeSeenAt: 0 });
    h.timer(id, "sleep");
    const gen = h.rt(id).opGen;
    await h.settle();
    expect(h.state(id)).toBe("sleeping");
    h.sendMessage(id);
    expect(h.state(id)).toBe("waking");
    const before = h.rt(id);
    h.app.db.tx(() => boxPaused(h.app, id, gen)); // late duplicate of the old pause
    expect(h.rt(id)).toEqual(before);
    expect(h.state(id)).toBe("waking");
    expect(h.box.calls).toEqual(["pause"]); // and it did not trigger a second wake
  });

  it("a stale create that finishes after a newer one recorded a different box is orphaned", () => {
    const h = harness();
    const id = h.seed("creating", { boxId: "box-new", opGen: 2 });
    expect(h.app.db.tx(() => boxCreated(h.app, id, "box-old", 5, 1))).toBe("orphaned");
    expect(h.dork(id).boxId).toBe("box-new");
    expect(h.app.db.tx(() => boxCreated(h.app, id, "box-new", 5, 2))).toBe("ok");
  });
});

describe("review fixes", () => {
  const errors = (h: ReturnType<typeof harness>, id: string) => h.events(id).filter((e) => e.body.type === "error");

  describe("error with a queued message does not loop resume/pause", () => {
    it("a wake that never produces a bridge ends in sleeping, once", async () => {
      const h = harness();
      const id = h.seed("sleeping");
      h.sendMessage(id); // waking, the message stays queued (the bridge never comes up)
      await h.settle();
      h.timer(id, "watchdog"); // -> error -> flush (nobody answers) -> pause -> sleeping, message still queued
      await h.advance(11_000);
      expect(h.state(id)).toBe("sleeping");
      await h.advance(600_000);
      expect(h.box.calls).toEqual(["resume", "pause"]); // not resume, pause, resume, pause, ...
      expect(errors(h, id)).toHaveLength(1);
      expect(h.kinds(id)).toEqual(["user_message"]); // still there for the next wake
      h.sendMessage(id, "again");
      expect(h.state(id)).toBe("waking"); // the next message wakes it
    });
  });

  describe("a lost pause does not block later ones", () => {
    it("a `pausing` intent older than the stuck window is replaced", async () => {
      const h = harness();
      const id = h.seed("idle");
      update(h.app.db, "dork_runtime", { dorkId: id }, { opGen: 3, pause: { gen: 3, phase: "pausing", since: h.clock.t } }); // the pause job died silently
      h.timer(id, "sleep");
      await h.settle();
      expect(h.box.calls).toEqual([]); // still within the window: trusted
      h.clock.t = NOW + 121_000;
      h.timer(id, "sleep");
      await h.settle();
      expect(h.box.calls).toEqual(["pause"]);
      expect(h.state(id)).toBe("sleeping");
    });
  });

  describe("a failed pause from error is retried with backoff, capped", () => {
    it("retries until the box pauses", async () => {
      const h = harness();
      const id = h.seed("working", { bridgeSeenAt: 0 });
      h.box.failPauses = 3;
      h.timer(id, "watchdog");
      await h.settle();
      expect(h.box.calls).toEqual(["pause"]);
      expect(h.hasTimer(id, "pause_retry")).toBe(true);
      for (const wait of [15_000, 30_000, 60_000]) await h.advance(wait);
      expect(h.box.calls).toEqual(["pause", "pause", "pause", "pause"]);
      expect(h.state(id)).toBe("sleeping");
      expect(h.hasTimer(id, "pause_retry")).toBe(false);
    });

    it("gives up after the cap and leaves error visible", async () => {
      const h = harness();
      const id = h.seed("working", { bridgeSeenAt: 0 });
      h.box.failPauses = 1000;
      h.timer(id, "watchdog");
      await h.settle();
      for (let i = 0; i < 12; i++) await h.advance(15 * 60_000);
      expect(h.box.calls).toHaveLength(1 + 6); // the first attempt + MAX_PAUSE_RETRIES
      expect(h.state(id)).toBe("error");
    });

    it("a message cancels the pending retry (it starts a wake instead)", async () => {
      const h = harness();
      const id = h.seed("working", { bridgeSeenAt: 0 });
      h.box.failPauses = 1;
      h.timer(id, "watchdog");
      await h.settle();
      expect(h.hasTimer(id, "pause_retry")).toBe(true);
      h.sendMessage(id);
      expect(h.state(id)).toBe("waking");
      expect(h.hasTimer(id, "pause_retry")).toBe(false);
    });
  });

  describe("a box that lands after the dork gave up is paused", () => {
    it("a create that finishes after the watchdog (error, no box yet)", async () => {
      const h = harness();
      const id = h.seed("creating", { boxId: null, opGen: 1, bridgeSeenAt: 0 });
      h.timer(id, "watchdog");
      expect(h.state(id)).toBe("error");
      expect(h.app.db.tx(() => boxCreated(h.app, id, "box-late", 5, 1))).toBe("ok");
      await h.settle();
      expect(h.box.calls).toEqual(["pause"]);
      expect(h.dork(id).boxId).toBe("box-late");
      expect(h.state(id)).toBe("sleeping");
    });

    it("a resume that finishes after the dork went to error, even after its pause already landed", async () => {
      const h = harness();
      const id = h.seed("waking", { opGen: 1, bridgeSeenAt: 0 });
      h.timer(id, "watchdog"); // error + pause (gen 2)
      await h.settle();
      expect(h.state(id)).toBe("sleeping"); // the pause beat the slow resume
      h.app.db.tx(() => boxResumed(h.app, id)); // now the resume lands: the box is running again
      await h.settle();
      expect(h.box.calls).toEqual(["pause", "pause"]);
      expect(h.state(id)).toBe("sleeping");
    });

    it("a resume that lands while the dork's own pause is still in flight pauses again (the old one may finish first)", async () => {
      const h = harness();
      const id = h.seed("waking", { opGen: 1, bridgeSeenAt: 0 });
      h.timer(id, "watchdog"); // error + pause (gen 2), job scheduled but not run yet
      expect(h.rt(id).pause?.phase).toBe("pausing");
      h.app.db.tx(() => boxResumed(h.app, id));
      await h.settle();
      expect(h.box.calls).toEqual(["pause", "pause"]); // one issued after the resume landed, so it is ordered after it
      expect(h.state(id)).toBe("sleeping");
    });

    it("a resume the dork is still waiting for just queues configure", async () => {
      const h = harness();
      const id = h.seed("waking");
      h.app.db.tx(() => boxResumed(h.app, id));
      await h.settle();
      expect(h.box.calls).toEqual([]);
      expect(h.kinds(id)).toEqual(["configure"]);
    });
  });

  describe("`flushed` names the flush it answers", () => {
    it("a straggler from a cancelled flush cannot end the next one early", async () => {
      const h = harness();
      const id = h.seed("idle");
      h.timer(id, "sleep");
      const first = h.cmds(id).find((c) => c.kind === "flush")!.cid;
      h.sendMessage(id); // cancels
      h.input(id, { t: "archive" }); // a new pause, a new flush
      const second = h.cmds(id).find((c) => c.kind === "flush")!.cid;
      expect(second).not.toBe(first);
      h.push(id, [{ t: "flushed", cid: first }]);
      await h.settle();
      expect(h.box.calls).toEqual([]);
      expect(h.rt(id).pause?.phase).toBe("flushing");
      h.push(id, [{ t: "flushed", cid: second }]);
      await h.settle();
      expect(h.box.calls).toEqual(["pause"]);
    });

    it("a `flushed` without a cid (older bridge) still answers the current flush", async () => {
      const h = harness();
      const id = h.seed("idle");
      h.timer(id, "sleep");
      h.push(id, [{ t: "flushed" }]);
      await h.settle();
      expect(h.box.calls).toEqual(["pause"]);
    });
  });
});
