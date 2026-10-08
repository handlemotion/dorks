import { dorkState, type DorkState } from "@dorks/shared";
import { describe, expect, it } from "vitest";
import { reduce, type Ctx, type Input, type Effect } from "../core/machine";

const STATES = dorkState.options as DorkState[];
const INPUTS: Input["t"][] = ["start", "user_message", "agent_ready", "turn_idle", "sleep_due", "paused", "bridge_lost", "agent_exited", "op_failed", "watchdog", "archive", "unarchive", "interrupt"];
const ctx = (state: DorkState, o: Partial<Ctx> = {}): Ctx => ({ state, archived: false, hasBox: true, queued: false, ...o });
const run = (c: Ctx, t: Input["t"]) => reduce(c, { t } as Input);

describe("machine: spec behaviours", () => {
  it("message wakes a sleeping dork; delivers once ready", () => {
    expect(run(ctx("sleeping"), "user_message")).toMatchObject({ state: "waking", effects: ["resume_box", "arm_watchdog"] });
    expect(run(ctx("waking", { queued: true }), "agent_ready")).toMatchObject({ state: "working", effects: expect.arrayContaining(["deliver_outbox", "cancel_watchdog"]) });
  });
  it("idle after a turn arms the sleep timer; sleep_due pauses; paused sleeps", () => {
    expect(run(ctx("working"), "turn_idle")).toMatchObject({ state: "idle", effects: ["arm_sleep"] });
    expect(run(ctx("idle"), "sleep_due").effects).toEqual(["pause_box"]);
    expect(run(ctx("idle"), "paused").state).toBe("sleeping");
  });
  it("a new message cancels the sleep timer and any pause in progress", () => {
    expect(run(ctx("idle"), "user_message")).toMatchObject({ state: "working", effects: ["cancel_sleep", "cancel_pause", "deliver_outbox"] });
  });
  it("mid-turn messages steer without changing state", () => {
    expect(run(ctx("working"), "user_message")).toMatchObject({ state: "working", effects: ["deliver_outbox"] });
  });
  it("does not go idle while a message is in flight", () => {
    expect(run(ctx("working", { queued: true }), "turn_idle")).toMatchObject({ state: "working", effects: ["deliver_outbox"] });
  });
  it("sleep_due is ignored with a pending message", () => {
    expect(run(ctx("idle", { queued: true }), "sleep_due").effects).toEqual([]);
  });
  it("archive pauses immediately (interrupting a running turn); unarchive never wakes", () => {
    expect(run(ctx("working"), "archive")).toMatchObject({ archived: true, effects: ["interrupt_agent", "pause_box"] });
    expect(run(ctx("idle"), "archive").effects).toEqual(["cancel_sleep", "pause_box"]);
    const u = run(ctx("sleeping", { archived: true }), "unarchive");
    expect(u).toMatchObject({ state: "sleeping", archived: false, effects: [] });
  });
  it("archived dorks refuse messages in every state", () => {
    for (const s of STATES) expect(run(ctx(s, { archived: true }), "user_message").rejected).toBe("archived");
  });
  it("archive during creation pauses once the agent is ready", () => {
    const a = run(ctx("creating", { hasBox: false }), "archive");
    expect(a).toMatchObject({ state: "creating", archived: true });
    expect(reduce(ctx("creating", { archived: true }), { t: "agent_ready" }).effects).toContain("pause_box");
  });
  it("error: the next message retries (wake if a box exists, else create)", () => {
    expect(run(ctx("error"), "user_message")).toMatchObject({ state: "waking", effects: ["resume_box", "arm_watchdog"] });
    expect(run(ctx("error", { hasBox: false }), "user_message")).toMatchObject({ state: "creating", effects: ["create_box", "arm_watchdog"] });
  });
  it("failures and watchdog send awake states to error and stop timers", () => {
    for (const s of ["creating", "waking", "working", "idle"] as DorkState[])
      for (const t of ["op_failed", "watchdog", "agent_exited"] as const) {
        const r = run(ctx(s), t);
        expect(r.state).toBe("error");
        expect(r.effects).toEqual(expect.arrayContaining(["cancel_sleep", "cancel_watchdog", "cancel_gh_refresh"]));
      }
  });
  it("entering error with a box pauses it (no leaked billing); without a box there is nothing to pause", () => {
    for (const s of ["creating", "waking", "working", "idle"] as DorkState[])
      for (const t of ["op_failed", "watchdog", "agent_exited"] as const) {
        expect(run(ctx(s), t).effects).toContain("pause_box");
        expect(run(ctx(s, { hasBox: false }), t).effects).not.toContain("pause_box");
      }
  });
  it("error -> pause lands -> sleeping; the next message wakes it", () => {
    const paused = run(ctx("error"), "paused");
    expect(paused.state).toBe("sleeping");
    expect(run(ctx(paused.state), "user_message")).toMatchObject({ state: "waking", effects: ["resume_box", "arm_watchdog"] });
  });
  it("a failure while already in error does not pause again", () => {
    for (const t of ["op_failed", "watchdog", "agent_exited"] as const) expect(run(ctx("error"), t).effects).toEqual([]);
  });
  it("a lost bridge in an awake state arms the watchdog; asleep it is expected", () => {
    expect(run(ctx("working"), "bridge_lost").effects).toEqual(["arm_watchdog"]);
    expect(run(ctx("sleeping"), "bridge_lost").effects).toEqual([]);
  });
  it("start only creates when new", () => {
    expect(run(ctx("creating", { hasBox: false }), "start").effects).toEqual(["create_box", "arm_watchdog"]);
    expect(run(ctx("idle"), "start").effects).toEqual([]);
  });
});

describe("machine: totality + invariants", () => {
  it("handles every state x input x flag combination without throwing", () => {
    for (const s of STATES) for (const t of INPUTS) for (const archived of [false, true]) for (const hasBox of [false, true]) for (const queued of [false, true]) {
      const r = run({ state: s, archived, hasBox, queued }, t);
      expect(STATES).toContain(r.state);
    }
  });

  it("fuzz: random event sequences keep the invariants", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let run_ = 0; run_ < 3000; run_++) {
      let c: Ctx = { state: "creating", archived: false, hasBox: false, queued: false };
      let outbox = 0;
      for (let step = 0; step < 40; step++) {
        const t = INPUTS[Math.floor(rnd() * INPUTS.length)];
        const prev = c;
        const r = reduce(c, { t } as Input);
        if (t === "user_message" && !r.rejected) outbox++;
        const fx: Effect[] = r.effects;
        // invariants
        if (prev.archived && t === "user_message") expect(r.rejected).toBe("archived");
        if (fx.includes("resume_box")) expect(["sleeping", "error"]).toContain(prev.state);
        if (fx.includes("create_box")) expect(prev.hasBox).toBe(false);
        if (r.state === "error" && prev.state !== "error") expect(fx.includes("pause_box")).toBe(prev.hasBox); // never leave a box running under `error`
        if (t === "unarchive") expect(fx).toEqual([]); // never wakes
        if (r.state === "sleeping") expect(fx.includes("deliver_outbox")).toBe(false);
        if (prev.archived && fx.includes("resume_box")) throw new Error("archived dork woke");
        // simulate driver bookkeeping
        const hasBox = prev.hasBox || fx.includes("create_box");
        if (fx.includes("deliver_outbox") && rnd() < 0.8) outbox = 0; // acked
        c = { state: r.state, archived: r.archived, hasBox, queued: outbox > 0 };
      }
    }
  });
});
