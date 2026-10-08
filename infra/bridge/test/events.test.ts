import { describe, expect, it } from "vitest";
import { EventPipeline, prepare } from "../src/events";
import { Outbox } from "../src/outbox";
import { FakeTransport } from "./helpers";

const delta = (text: string, extra = {}) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, parent_tool_use_id: null, ...extra });
const setup = (deltaMs = 20) => {
  const t = new FakeTransport();
  const o = new Outbox(t, () => {}, { batchMs: 1, onFatal: () => {} });
  return { t, o, p: new EventPipeline(o, deltaMs) };
};

describe("EventPipeline", () => {
  it("coalesces consecutive text deltas into one event", async () => {
    const { t, o, p } = setup();
    for (const w of ["a ", "b ", "c "]) p.ingest(delta(w));
    await new Promise((r) => setTimeout(r, 60));
    await o.drained();
    const evs = t.events();
    expect(evs).toHaveLength(1);
    expect((evs[0].raw as any).event.delta.text).toBe("a b c ");
  });

  it("keeps order: pending text is emitted before the next non-delta event, with consecutive bseq", async () => {
    const { t, o, p } = setup(10_000);
    p.ingest({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } });
    p.ingest(delta("hello "));
    p.ingest(delta("world"));
    p.ingest({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hello world" }] } });
    p.control({ t: "ack", id: "x" });
    await o.drained();
    expect(t.events().map((e) => [e.bseq, (e.raw as any).type])).toEqual([[1, "stream_event"], [2, "stream_event"], [3, "assistant"]]);
    expect((t.events()[1].raw as any).event.delta.text).toBe("hello world");
  });

  it("does not merge deltas from different parents (subagent text is ignored by the backend)", async () => {
    const { t, o, p } = setup(10_000);
    p.ingest(delta("main "));
    p.ingest(delta("sub ", { parent_tool_use_id: "toolu_1" }));
    p.flushDelta();
    await o.drained();
    expect(t.events()).toHaveLength(2);
  });

  it("continues numbering from the backend's afterBridgeSeq and never goes backwards", () => {
    const { p } = setup();
    p.continueFrom(41);
    p.ingest({ type: "result", subtype: "success", is_error: false, duration_ms: 1 });
    expect(p.lastSeq).toBe(42);
    p.continueFrom(10);
    expect(p.lastSeq).toBe(42);
  });

  it("drops events the backend does not use, and slims init", () => {
    expect(prepare({ type: "system", subtype: "status", status: "requesting" })).toBeNull();
    expect(prepare({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "x" } } })).toBeNull();
    expect(prepare({ type: "stream_event", event: { type: "content_block_start" } })).toBeNull();
    expect(prepare({ type: "control_response" })).toBeNull();
    const init = prepare({ type: "system", subtype: "init", session_id: "s1", cwd: "/x", tools: ["Bash"], apiKeySource: "oauth" }) as any;
    expect(init).toEqual({ type: "system", subtype: "init", session_id: "s1" });
  });

  it("clips huge tool results but never assistant text", () => {
    const big = "x".repeat(100_000);
    const r = prepare({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: big }] } }) as any;
    expect(r.message.content[0].content.length).toBeLessThan(20_000);
    const a = prepare({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "y".repeat(20_000) }] } }) as any;
    expect(a.message.content[0].text.length).toBe(20_000);
  });

  it("drops tool_use_result (the tool's full output) and caps any single event", () => {
    const huge = "z".repeat(900_000);
    const r = prepare({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }, tool_use_result: { file: { content: huge }, originalFile: huge } }) as any;
    expect(r.tool_use_result).toBeUndefined();
    expect(JSON.stringify(r).length).toBeLessThan(2000);
    // many big blocks in one assistant message: still under the backend's per-event cap
    const a = prepare({ type: "assistant", message: { id: "m", content: Array.from({ length: 30 }, (_, i) => ({ type: "text", text: "t".repeat(60_000) + i })) } }) as any;
    expect(JSON.stringify(a).length).toBeLessThanOrEqual(200 * 1024);
    const stub = prepare({ type: "assistant", message: { id: "m", content: Array.from({ length: 400 }, () => ({ type: "tool_use", id: "x".repeat(1000), name: "n", input: {} })) } }) as any;
    expect(JSON.stringify(stub).length).toBeLessThanOrEqual(200 * 1024);
  });

  it("flushes text before it can outgrow the cap", async () => {
    const { t, o, p } = setup(10_000);
    for (let i = 0; i < 5; i++) p.ingest(delta("q".repeat(30_000)));
    p.flushDelta();
    await o.drained();
    expect(t.events().length).toBeGreaterThan(1);
    for (const e of t.events()) expect(JSON.stringify(e).length).toBeLessThan(100_000);
  });
});
