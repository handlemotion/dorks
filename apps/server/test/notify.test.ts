import { describe, expect, it } from "vite-plus/test";
import { insert, update } from "../src/db";
import { enqueueNotification, NOTIFY_DEBOUNCE_MS } from "../src/services/notify";
import { unsubscribe } from "../src/services/subscriptions";
import { harness, NOW } from "./harness";

// Autonomy notifications through the lifecycle (docs/autonomy.md): debounce + coalesce, then delivery rules per state.

const setup = () => {
  const h = harness();
  let bseq = 0;
  const subscribeTo = (dorkId: string, number = 12, over: { ciFixAttempts?: number } = {}) => {
    insert(h.app.db, "pr_subscriptions", {
      dorkId, repo: "octo/hello", number, url: `https://github.com/octo/hello/pull/${number}`, title: "Add thing", headRef: "agent/x", baseRef: "main",
      source: "agent", status: "active", ci: "unknown", review: "none", mergeable: null, ciFixAttempts: over.ciFixAttempts ?? 0, state: "open", lastEventAt: 1,
    });
    return h.app.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  };
  const notify = (dorkId: string, subId: number, kind: Parameters<typeof enqueueNotification>[3], summary: string) => h.app.db.tx(() => enqueueNotification(h.app, dorkId, subId, kind, summary));
  const fire = (id: string) => h.timer(id, "notify");
  const notifyRows = (id: string) => h.cmds(id).filter((c) => c.kind === "notify");
  const inbox = (id: string) => h.app.db.all("SELECT kind, delivered FROM inbox WHERE dork_id = ? ORDER BY id", id).map((r) => [r.kind, r.delivered === 1]);
  const turnIdle = (id: string) => h.push(id, [{ t: "event", bseq: ++bseq, raw: { type: "system", subtype: "session_state_changed", state: "idle" } }]);
  const ack = (id: string, cid: string) => h.push(id, [{ t: "ack", id: cid }]);
  const dueAt = (id: string, name: string) => h.app.db.get<{ due_at: number }>("SELECT due_at FROM timers WHERE owner = ? AND name = ?", id, name)?.due_at;
  return { h, subscribeTo, notify, fire, notifyRows, inbox, turnIdle, ack, dueAt };
};
type S = ReturnType<typeof setup>;
const emitted = (s: S, id: string) => s.h.frames(id);

describe("debounce and coalesce", () => {
  it("buffers events and arms one ~45s timer per dork; nothing is delivered until it fires", () => {
    const s = setup();
    const id = s.h.seed("idle");
    const sub = s.subscribeTo(id);
    s.notify(id, sub, "comment", "alice: rename it");
    s.notify(id, sub, "ci_failed", "test failed");
    expect(s.dueAt(id, "notify")! - NOW).toBe(NOTIFY_DEBOUNCE_MS);
    expect(NOTIFY_DEBOUNCE_MS).toBe(45_000);
    expect(s.h.app.db.all("SELECT 1 FROM timers WHERE owner = ? AND name = 'notify'", id)).toHaveLength(1);
    expect(s.inbox(id)).toEqual([["comment", false], ["ci_failed", false]]);
    expect(s.notifyRows(id)).toEqual([]);
  });

  it("the window does not slide: a later event does not postpone the notification", () => {
    const s = setup();
    const id = s.h.seed("idle");
    const sub = s.subscribeTo(id);
    s.notify(id, sub, "comment", "a");
    const first = s.dueAt(id, "notify");
    s.h.clock.t += 30_000;
    s.notify(id, sub, "comment", "b");
    expect(s.dueAt(id, "notify")).toBe(first);
  });

  it("folds everything pending into ONE notify command, one transcript card, and marks the rows delivered", () => {
    const s = setup();
    const id = s.h.seed("idle");
    const a = s.subscribeTo(id, 12);
    const b = s.subscribeTo(id, 13);
    s.notify(id, a, "comment", "alice: rename it");
    s.notify(id, b, "conflict", "no longer mergeable");
    s.notify(id, a, "ci_failed", "test failed");
    s.fire(id);

    const rows = s.notifyRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain('<dorks-event source="github" kinds="ci_failed,comment,conflict" prs="octo/hello#12,octo/hello#13">');
    expect(rows[0].text).toContain("gh run view --log-failed");
    expect(rows[0].meta).toEqual({ kinds: ["ci_failed", "comment", "conflict"], prs: [{ repo: "octo/hello", number: 12 }, { repo: "octo/hello", number: 13 }] });
    const cards = s.h.events(id).map((e) => e.body).filter((e) => e.type === "notify");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kinds: ["ci_failed", "comment", "conflict"], text: expect.stringContaining("## octo/hello#12: Add thing") });
    expect((cards[0] as { text: string }).text).not.toContain("dorks-event");
    expect(s.inbox(id).every(([, delivered]) => delivered)).toBe(true);
    expect(s.h.hasTimer(id, "notify")).toBe(false);
    s.notify(id, a, "review", "approved"); // a new window starts with the next event
    expect(s.h.hasTimer(id, "notify")).toBe(true);
  });

  it("the second CI failure asks for attempt 2 of 2", () => {
    const s = setup();
    const id = s.h.seed("idle");
    const sub = s.subscribeTo(id, 12, { ciFixAttempts: 1 });
    s.notify(id, sub, "ci_failed", "test failed");
    s.fire(id);
    expect(s.notifyRows(id)[0].text).toContain("ci_failed (attempt 2 of 2)");
  });

  it("an event for a PR that was unsubscribed meanwhile is dropped", () => {
    const s = setup();
    const id = s.h.seed("idle");
    const a = s.subscribeTo(id, 12);
    const b = s.subscribeTo(id, 13);
    s.notify(id, a, "comment", "for a");
    s.notify(id, b, "comment", "for b");
    s.h.app.db.tx(() => unsubscribe(s.h.app, id, "octo/hello", 12));
    s.fire(id);
    const text = s.notifyRows(id)[0].text!;
    expect(text).toContain("octo/hello#13");
    expect(text).not.toContain("for a");
  });

  it("archived and deleting dorks hear nothing", () => {
    const s = setup();
    const archived = s.h.seed("sleeping", { archived: true });
    s.notify(archived, s.subscribeTo(archived), "comment", "x");
    expect(s.inbox(archived)).toEqual([]);

    const closing = s.h.seed("idle");
    const sub = s.subscribeTo(closing);
    s.notify(closing, sub, "comment", "x");
    update(s.h.app.db, "dorks", { id: closing }, { archived: true }); // archived while the window was open
    s.fire(closing);
    expect(s.notifyRows(closing)).toEqual([]);
    expect(s.inbox(closing).every(([, delivered]) => delivered)).toBe(true);
    expect(s.h.state(closing)).toBe("idle");
  });
});

describe("delivery by state", () => {
  it("idle: delivers now and the dork starts working; acked like a user message", () => {
    const s = setup();
    const id = s.h.seed("idle");
    s.notify(id, s.subscribeTo(id), "comment", "alice: hi");
    s.fire(id);
    expect(s.h.state(id)).toBe("working");
    const [row] = s.notifyRows(id);
    expect(s.h.cmds(id).filter((c) => c.kind === "notify")).toHaveLength(1);
    expect(emitted(s, id)).toEqual(["notify"]);
    s.ack(id, row.cid);
    expect(emitted(s, id)).toEqual([]);
    expect(s.h.app.db.get("SELECT acked FROM commands WHERE cid = ?", row.cid)?.acked).toBe(1); // kept (not deleted) like an acked user message
    s.turnIdle(id);
    expect(s.h.state(id)).toBe("idle");
  });

  it("sleeping: wakes the box; the notify survives the resume and goes out once the agent is ready", async () => {
    const s = setup();
    const id = s.h.seed("sleeping");
    s.notify(id, s.subscribeTo(id), "ci_failed", "test failed");
    s.fire(id);
    expect(s.h.state(id)).toBe("waking");
    await s.h.settle();
    expect(s.h.box.calls).toEqual(["resume"]);
    expect(s.notifyRows(id)).toHaveLength(1); // clearControlRows must not eat it
    s.h.connect(id);
    expect(emitted(s, id)).toEqual(["fetch_configure"]); // waking: not before ready
    s.h.push(id, [{ t: "ready" }]);
    expect(s.h.state(id)).toBe("working");
    expect(emitted(s, id)).toEqual(["notify", "fetch_configure"]);
  });

  it("error: wakes the dork like a message", () => {
    const s = setup();
    const id = s.h.seed("error");
    s.notify(id, s.subscribeTo(id), "comment", "x");
    s.fire(id);
    expect(s.h.state(id)).toBe("waking");
  });

  it("creating/waking: delivered on ready", () => {
    const s = setup();
    const id = s.h.seed("waking");
    s.notify(id, s.subscribeTo(id), "comment", "x");
    s.fire(id);
    expect(s.h.state(id)).toBe("waking");
    expect(emitted(s, id)).toEqual([]);
    s.h.push(id, [{ t: "ready" }]);
    expect(s.h.state(id)).toBe("working");
    expect(emitted(s, id)).toEqual(["notify"]);
  });

  it("working: held, never emitted mid-turn, then delivered at turn_idle", () => {
    const s = setup();
    const id = s.h.seed("working");
    s.notify(id, s.subscribeTo(id), "comment", "alice: hi");
    s.fire(id);
    const [row] = s.notifyRows(id);
    expect(row.released).toBe(false);
    expect(s.h.state(id)).toBe("working");
    expect(emitted(s, id)).toEqual([]);
    s.h.push(id, []); // heartbeats/pushes mid-turn don't release it either
    expect(emitted(s, id)).toEqual([]);

    s.turnIdle(id); // the turn boundary
    expect(s.h.state(id)).toBe("working"); // the notify starts the next turn: no idle (and no sleep timer) in between
    expect(s.h.hasTimer(id, "sleep")).toBe(false);
    expect(emitted(s, id)).toEqual(["notify"]);
    s.ack(id, row.cid);
    s.turnIdle(id); // the notify's own turn ends
    expect(s.h.state(id)).toBe("idle");
    expect(emitted(s, id)).toEqual([]);
  });

  it("an unreleased notify is withheld while working even if it is the only thing queued (safe default)", () => {
    const s = setup();
    const id = s.h.seed("working");
    insert(s.h.app.db, "commands", { dorkId: id, kind: "notify", cid: "n1", text: "x", meta: { kinds: ["comment"], prs: [] }, acked: false });
    expect(emitted(s, id)).toEqual([]);
  });

  it("two notifies in a row: the second waits for the first one's turn", () => {
    const s = setup();
    const id = s.h.seed("idle");
    const sub = s.subscribeTo(id);
    s.notify(id, sub, "comment", "first");
    s.fire(id);
    expect(emitted(s, id)).toEqual(["notify"]); // working on the first
    s.notify(id, sub, "comment", "second");
    s.fire(id);
    const [first, second] = s.notifyRows(id);
    expect(second.released).toBe(false);
    expect(emitted(s, id)).toEqual(["notify"]); // only the first
    s.ack(id, first.cid);
    expect(emitted(s, id)).toEqual([]); // still mid-turn
    s.turnIdle(id);
    expect(emitted(s, id)).toEqual(["notify"]);
    expect(s.h.app.db.get("SELECT cid FROM commands WHERE kind = 'notify' AND acked = 0 AND dork_id = ?", id)?.cid).toBe(second.cid);
  });
});

describe("user messages always go first", () => {
  it("a user message that arrives behind a ready notify goes out first; the notify follows once that turn ends", () => {
    const s = setup();
    const id = s.h.seed("idle");
    s.notify(id, s.subscribeTo(id), "comment", "x");
    s.fire(id); // idle -> working, notify released
    s.h.sendMessage(id, "also this"); // arrives before the bridge took the notify
    expect(emitted(s, id)).toEqual(["user_message"]); // the notify is withheld behind it
    const msg = s.h.cmds(id).find((c) => c.kind === "user_message")!;
    s.ack(id, msg.cid);
    expect(emitted(s, id)).toEqual([]); // the message's turn is running: the notify waits for its boundary
    s.turnIdle(id);
    expect(emitted(s, id)).toEqual(["notify"]);
  });

  it("a message that arrives while the dork sleeps goes out before the notify that woke it", () => {
    const s = setup();
    const id = s.h.seed("sleeping");
    s.notify(id, s.subscribeTo(id), "comment", "x");
    s.fire(id); // wakes
    s.h.sendMessage(id, "me first");
    s.h.connect(id);
    s.h.push(id, [{ t: "ready" }]);
    expect(s.h.state(id)).toBe("working");
    expect(emitted(s, id)).toEqual(["user_message", "fetch_configure"]);
    const msg = s.h.cmds(id).find((c) => c.kind === "user_message")!;
    s.ack(id, msg.cid);
    // The message's turn is running: the notify (queued behind it) is held until that turn ends.
    expect(emitted(s, id)).toEqual(["fetch_configure"]);
    s.turnIdle(id);
    expect(emitted(s, id)).toEqual(["notify", "fetch_configure"]);
  });

  it("a notify folded while a user message is unacked is held even though the dork is idle-or-waking", () => {
    const s = setup();
    const id = s.h.seed("waking");
    s.h.sendMessage(id, "first");
    s.notify(id, s.subscribeTo(id), "comment", "x");
    s.fire(id);
    expect(s.notifyRows(id)[0].released).toBe(false);
  });

  it("a user message sent mid-turn does not release a held notify", () => {
    const s = setup();
    const id = s.h.seed("working");
    s.notify(id, s.subscribeTo(id), "comment", "x");
    s.fire(id);
    s.h.sendMessage(id, "steer");
    expect(emitted(s, id)).toEqual(["user_message"]);
    expect(s.notifyRows(id)[0].released).toBe(false);
  });
});

describe("pause and flush interactions", () => {
  it("notify during a sleep flush cancels the pause and delivers (idle -> working)", async () => {
    const s = setup();
    const id = s.h.seed("idle");
    s.h.timer(id, "sleep");
    expect(s.h.kinds(id)).toEqual(["flush"]);
    s.notify(id, s.subscribeTo(id), "comment", "x");
    s.fire(id);
    expect(s.h.state(id)).toBe("working");
    expect(s.h.kinds(id)).toEqual(["notify"]); // flush row deleted
    expect(s.h.rt(id).pause).toBeUndefined();
    s.h.push(id, [{ t: "flushed" }]);
    await s.h.settle();
    expect(s.h.state(id)).toBe("working");
    expect(s.h.box.calls).toEqual([]);
  });

  it("notify after the pause's box call is in flight: withheld, the pause lands, the dork wakes and then delivers", async () => {
    const s = setup();
    const id = s.h.seed("idle");
    s.h.timer(id, "sleep");
    s.h.push(id, [{ t: "flushed" }]); // the pause job is scheduled
    s.notify(id, s.subscribeTo(id), "ci_failed", "x");
    s.fire(id);
    expect(s.h.rt(id).pause?.phase).toBe("cancelled");
    expect(emitted(s, id)).toEqual([]); // would be lost with the box
    await s.h.settle();
    expect(s.h.box.calls).toEqual(["pause", "resume"]);
    expect(s.h.state(id)).toBe("waking");
    expect(s.notifyRows(id)).toHaveLength(1);
    s.h.connect(id);
    s.h.push(id, [{ t: "ready" }]);
    expect(emitted(s, id)).toContain("notify");
  });

  it("an unacked notify survives the pause and wakes the dork again when the pause lands (like a queued message)", async () => {
    const s = setup();
    const id = s.h.seed("idle", { bridgeSeenAt: 0 }); // silent bridge: paused directly
    s.h.timer(id, "sleep");
    insert(s.h.app.db, "commands", { dorkId: id, kind: "notify", cid: "n1", text: "x", meta: { kinds: ["comment"], prs: [] }, released: true, acked: false });
    await s.h.settle();
    expect(s.h.box.calls).toEqual(["pause", "resume"]);
    expect(s.h.state(id)).toBe("waking");
  });

  it("a held notify is released by a fresh agent, not stranded across a restart", async () => {
    const s = setup();
    const id = s.h.seed("working");
    s.notify(id, s.subscribeTo(id), "comment", "x");
    s.fire(id);
    s.h.push(id, [{ t: "agent_exited", code: 1, stderrTail: "" }]);
    expect(s.h.state(id)).toBe("error");
    await s.h.settle();
    s.h.sendMessage(id, "wake up"); // error/sleeping -> waking
    s.h.connect(id);
    s.h.push(id, [{ t: "ready" }]);
    const msg = s.h.cmds(id).find((c) => c.kind === "user_message")!;
    s.ack(id, msg.cid);
    s.turnIdle(id);
    expect(emitted(s, id)).toContain("notify");
  });
});

