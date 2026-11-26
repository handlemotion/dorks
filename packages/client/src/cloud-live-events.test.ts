import { describe, expect, it } from "vite-plus/test";
import { messageEvents, sessionEvents, SEQ_PER_RECORD } from "./cloud-live.ts";
import { Assembler } from "./s2.ts";

describe("cloud transcript rows", () => {
  it("numbers each event of a record: seq_num * 1000 + index, ts from the record", () => {
    const rows = sessionEvents(
      "d1",
      7,
      1234,
      JSON.stringify([
        { type: "assistant_delta", messageId: "m", text: "a" },
        { type: "assistant_message", messageId: "m", text: "ab" },
      ]),
    );
    expect(rows.map((e) => [e.seq, e.type, e.dorkId, e.ts])).toEqual([
      [7 * SEQ_PER_RECORD, "assistant_delta", "d1", 1234],
      [7 * SEQ_PER_RECORD + 1, "assistant_message", "d1", 1234],
    ]);
  });
  it("reads a single object as one event and skips what is not an event", () => {
    expect(sessionEvents("d1", 1, 0, JSON.stringify({ type: "error", message: "x" })).map((e) => e.type)).toEqual(["error"]);
    expect(sessionEvents("d1", 1, 0, "not json")).toEqual([]);
    expect(sessionEvents("d1", 1, 0, JSON.stringify([{ nope: 1 }]))).toEqual([]);
  });
  it("turns a person's message echo into their user_message, and nothing else", () => {
    const [m] = messageEvents("d1", 3, 9, JSON.stringify({ t: "user_message", id: "c", text: "hi", by: { id: "u1", name: "Ada" } }));
    expect(m).toMatchObject({ type: "user_message", text: "hi", by: { id: "u1", name: "Ada" }, seq: 3000, ts: 9 });
    expect(messageEvents("d1", 3, 9, JSON.stringify({ t: "interrupt", id: "c" }))).toEqual([]);
    expect(messageEvents("d1", 3, 9, JSON.stringify({ t: "notify", id: "c", text: "x", kinds: [], prs: [] }))).toEqual([]);
  });
});

describe("Assembler and note records", () => {
  it("yields a note record (a card the bridge added) without touching the bseq dedupe, and keeps a command's sender", () => {
    const a = new Assembler();
    const ev = a.push({
      seq_num: 0,
      timestamp: 0,
      headers: [
        ["k", "ev"],
        ["b", "1"],
      ],
      body: "[]",
    });
    const note = a.push({
      seq_num: 1,
      timestamp: 0,
      headers: [
        ["k", "note"],
        ["b", "1"],
      ],
      body: '[{"type":"input_request"}]',
    });
    const cmd = a.push({
      seq_num: 2,
      timestamp: 0,
      headers: [
        ["k", "cmd"],
        ["b", "1"],
        ["id", "x"],
        ["by", "worker"],
      ],
      body: "{}",
    });
    const next = a.push({
      seq_num: 3,
      timestamp: 0,
      headers: [
        ["k", "ev"],
        ["b", "2"],
      ],
      body: "[]",
    });
    expect([ev[0]?.kind, note[0]?.kind, cmd[0]?.kind, next[0]?.kind]).toEqual(["event", "note", "command", "event"]);
    expect(cmd[0]).toMatchObject({ by: "worker" });
    expect(a.lastBseq).toBe(2);
  });
});
