import { describe, expect, it } from "vite-plus/test";
import type { ClientEvent } from "./events";
import { emptyView, fold } from "./client/fold";

const base = { seq: 1, dorkId: "d", ts: 1 };

describe("unknown events", () => {
  it("fold ignores an unknown event type but still advances lastSeq", () => {
    const start = fold(emptyView(), { ...base, type: "user_message", text: "hi" });
    const unknown = { seq: 2, dorkId: "d", ts: 2, type: "from_the_future", payload: 1 } as unknown as ClientEvent;
    const next = fold(start, unknown);
    expect(next.blocks).toEqual(start.blocks);
    expect(next.state).toBe(start.state);
    expect(next.lastSeq).toBe(2);
  });
});
