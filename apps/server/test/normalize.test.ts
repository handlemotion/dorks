import { describe, expect, it } from "vite-plus/test";
import { createNormalizer } from "../src/core/normalize";

const bodies = (n: ReturnType<ReturnType<typeof createNormalizer>>) => n.flatMap((x) => (x.kind === "event" ? [x.body] : []));

describe("normalize", () => {
  it("captures the session id and idle", () => {
    const n = createNormalizer();
    expect(n({ type: "system", subtype: "init", session_id: "s1" })).toEqual([{ kind: "session", sessionId: "s1" }]);
    expect(n({ type: "system", subtype: "session_state_changed", state: "idle" })).toEqual([{ kind: "idle" }]);
  });

  it("streams text deltas under the in-flight message id", () => {
    const n = createNormalizer();
    n({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    expect(bodies(n({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } }))).toEqual([
      { type: "assistant_delta", messageId: "m1", text: "Hi" },
    ]);
  });

  it("maps assistant text + tool_use, and tool_result with truncation", () => {
    const n = createNormalizer();
    const a = bodies(n({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }] } }));
    expect(a).toEqual([
      { type: "assistant_message", messageId: "m1", text: "ok" },
      { type: "tool_use", toolId: "t1", name: "Bash", summary: "ls -la" },
    ]);
    const r = bodies(n({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "x".repeat(5000) }] } }));
    expect(r[0]).toMatchObject({ type: "tool_result", toolId: "t1", ok: false });
    expect((r[0] as { preview: string }).preview.length).toBeLessThanOrEqual(2049);
  });

  it("ignores subagent chatter and unknown events", () => {
    const n = createNormalizer();
    expect(n({ type: "assistant", parent_tool_use_id: "x", message: { id: "m", content: [{ type: "text", text: "sub" }] } })).toEqual([]);
    expect(n({ type: "weird" })).toEqual([]);
    expect(n("garbage")).toEqual([]);
  });

  it("maps result and rate limits (seconds -> ms)", () => {
    const n = createNormalizer();
    expect(bodies(n({ type: "result", duration_ms: 1234, is_error: false }))).toEqual([{ type: "turn_complete", durationMs: 1234, outcome: "done" }]);
    expect(bodies(n({ type: "result", is_error: true, result: "boom" })).map((b) => b.type)).toEqual(["turn_complete", "error"]);
    expect(bodies(n({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000 } }))).toEqual([{ type: "rate_limited", resetsAt: 1_800_000_000_000 }]);
    expect(bodies(n({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }))).toEqual([]);
  });
});

describe("normalize output matches the shared event schema", () => {
  it("produces bodies that clientEvent accepts", async () => {
    const { clientEvent } = await import("@dorks/shared");
    const n = createNormalizer();
    n({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    const out = [
      ...bodies(n({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } })),
      ...bodies(n({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } })),
      ...bodies(n({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "x" }] } })),
    ];
    expect(out.length).toBeGreaterThan(0);
    for (const body of out) expect(clientEvent.safeParse({ seq: 1, dorkId: "d", ts: 1, ...body }).success).toBe(true);
  });
});
