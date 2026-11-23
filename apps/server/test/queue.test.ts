import { describe, expect, it } from "vite-plus/test";
import { interrupt, queueMessage, takeQueued } from "../src/services/dorks";
import { harness } from "./harness";

// Queued messages (the composer's ⌘ Enter): held while a turn runs, released one per turn boundary, held by a Stop.

const setup = () => {
  const h = harness();
  let bseq = 0;
  const turnIdle = (id: string) => h.push(id, [{ t: "event", bseq: ++bseq, raw: { type: "system", subtype: "session_state_changed", state: "idle" } }]);
  const ackAll = (id: string) =>
    h.push(
      id,
      h
        .cmds(id)
        .filter((c) => c.kind === "user_message")
        .map((c) => ({ t: "ack", id: c.cid })),
    );
  const queue = (id: string, text: string) => queueMessage(h.app, id, text);
  const queued = (id: string) => h.app.db.all("SELECT text FROM queued_messages WHERE dork_id = ? ORDER BY created_at, rowid", id).map((r) => r.text);
  const sent = (id: string) => h.events(id).flatMap((e) => (e.body.type === "user_message" ? [e.body.text] : []));
  return { h, turnIdle, ackAll, queue, queued, sent };
};

describe("queued messages", () => {
  it("wait for the turn to end, then go out one per turn, oldest first", () => {
    const s = setup();
    const id = s.h.seed("working");
    expect(s.queue(id, "first")).toEqual({ queued: true });
    expect(s.queue(id, "second")).toEqual({ queued: true });
    expect(s.sent(id)).toEqual([]);
    expect(s.h.frames(id)).toEqual([]);

    s.turnIdle(id);
    expect(s.h.state(id)).toBe("working"); // straight into the next turn: no idle, no sleep timer
    expect(s.h.hasTimer(id, "sleep")).toBe(false);
    expect(s.sent(id)).toEqual(["first"]);
    expect(s.h.frames(id)).toEqual(["user_message"]);
    expect(s.queued(id)).toEqual(["second"]);

    s.ackAll(id);
    s.turnIdle(id);
    expect(s.sent(id)).toEqual(["first", "second"]);
    s.ackAll(id);
    s.turnIdle(id);
    expect(s.h.state(id)).toBe("idle");
  });

  it("a steered message still in flight goes first; the queue waits for its turn", () => {
    const s = setup();
    const id = s.h.seed("working");
    s.queue(id, "later");
    s.h.sendMessage(id, "steer");
    s.turnIdle(id); // the steer was not read before the turn ended: it starts the next one
    expect(s.queued(id)).toEqual(["later"]);
    s.ackAll(id);
    s.turnIdle(id);
    expect(s.sent(id)).toEqual(["later"]);
  });

  it("are sent at once when no turn is running", () => {
    const s = setup();
    const id = s.h.seed("idle");
    expect(s.queue(id, "now")).toEqual({ queued: false });
    expect(s.h.state(id)).toBe("working");
    expect(s.sent(id)).toEqual(["now"]);
  });

  it("a Stop holds the queue past the stopped turn; the next turn's end releases it", () => {
    const s = setup();
    const id = s.h.seed("working");
    s.queue(id, "after stop");
    interrupt(s.h.app, id);
    s.turnIdle(id);
    expect(s.h.state(id)).toBe("idle");
    expect(s.queued(id)).toEqual(["after stop"]);

    s.h.sendMessage(id, "go on");
    s.ackAll(id);
    s.turnIdle(id);
    expect(s.sent(id)).toEqual(["after stop"]);
  });

  it("can be sent now or removed", () => {
    const s = setup();
    const id = s.h.seed("working");
    s.queue(id, "a");
    s.queue(id, "b");
    const [a, b] = s.h.app.db.all("SELECT id FROM queued_messages WHERE dork_id = ? ORDER BY created_at, rowid", id).map((r) => r.id as string);
    takeQueued(s.h.app, id, a!, true);
    expect(s.sent(id)).toEqual(["a"]);
    takeQueued(s.h.app, id, b!, false);
    expect(s.queued(id)).toEqual([]);
    expect(() => takeQueued(s.h.app, id, b!, true)).toThrow();
  });
});
