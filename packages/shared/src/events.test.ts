import { describe, expect, it } from "vitest";
import { clientEvent } from "./events";
import type { ClientEvent } from "./events";
import { emptyView, fold } from "./client/fold";

const base = { seq: 1, dorkId: "d", ts: 1 };

// One valid example per event type. The coverage test below fails if a new type is added to the schema without one.
const samples: Record<ClientEvent["type"], object> = {
  user_message: { text: "hi" },
  assistant_delta: { messageId: "m", text: "he" },
  assistant_message: { messageId: "m", text: "hello" },
  tool_use: { toolId: "t", name: "Bash", summary: "ls" },
  tool_result: { toolId: "t", ok: true, preview: "a" },
  status: { state: "working" },
  turn_complete: { durationMs: 10, finalMessageId: "m", outcome: "done" },
  pr_opened: { url: "https://github.com/o/r/pull/1", number: 1 },
  pr_merged: { url: "https://github.com/o/r/pull/1", number: 1 },
  notify: { kinds: [], prs: [], text: "digest" },
  subscription: { repo: "o/r", number: 1, status: "active" },
  build_draft: { draftId: "dr", buildId: "b", buildName: "web", note: "adds jq" },
  build_decision: { draftId: "dr", buildId: "b", buildName: "web", approved: true },
  rate_limited: {},
  agent_exited: { message: "bye" },
  error: { message: "boom" },
};

describe("clientEvent runtime schema", () => {
  it("has a sample for every event type in the schema", () => {
    const types = clientEvent.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(samples).sort()).toEqual(types);
  });

  it.each(Object.entries(samples))("accepts a valid %s", (type, rest) => {
    expect(clientEvent.safeParse({ ...base, type, ...rest }).success).toBe(true);
  });

  it.each(Object.entries(samples).filter(([, rest]) => Object.keys(rest).length > 0))("rejects %s with a wrong field type", (type, rest) => {
    const [key] = Object.keys(rest);
    expect(clientEvent.safeParse({ ...base, type, ...rest, [key]: typeof (rest as Record<string, unknown>)[key] === "string" ? 123 : "nope" }).success).toBe(false);
  });

  it("rejects missing envelope fields, missing payload fields and unknown types", () => {
    expect(clientEvent.safeParse({ type: "user_message", text: "hi" }).success).toBe(false);
    expect(clientEvent.safeParse({ ...base, type: "user_message" }).success).toBe(false);
    expect(clientEvent.safeParse({ ...base, type: "from_the_future" }).success).toBe(false);
  });
});

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
