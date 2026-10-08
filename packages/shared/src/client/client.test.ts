import { describe, expect, it } from "vitest";
import type { ClientEvent } from "../events";
import { emptyView, fold } from "./fold";

const ev = (seq: number, rest: object): ClientEvent => ({ seq, dorkId: "c", ts: 0, ...rest }) as ClientEvent;

describe("fold", () => {
  it("builds a transcript, streaming then completing a message", () => {
    const events = [
      ev(1, { type: "user_message", text: "hi" }),
      ev(2, { type: "assistant_delta", messageId: "m", text: "Hel" }),
      ev(3, { type: "assistant_delta", messageId: "m", text: "lo" }),
      ev(4, { type: "tool_use", toolId: "t", name: "Bash", summary: "ls" }),
      ev(5, { type: "tool_result", toolId: "t", ok: true, preview: "a b" }),
      ev(6, { type: "assistant_message", messageId: "m", text: "Hello!" }),
      ev(7, { type: "pr_opened", url: "https://github.com/o/r/pull/1", number: 1 }),
    ];
    const v = events.reduce(fold, emptyView());
    expect(v.blocks.map((b) => b.kind)).toEqual(["user", "assistant", "tool", "notice"]);
    expect(v.blocks[1]).toMatchObject({ text: "Hello!", streaming: false });
    expect(v.blocks[2]).toMatchObject({ status: "ok", preview: "a b" });
    expect(v.prUrl).toContain("/pull/1");
  });

  it("is idempotent under replay", () => {
    const events = [ev(1, { type: "user_message", text: "a" }), ev(2, { type: "user_message", text: "b" })];
    const once = events.reduce(fold, emptyView());
    const twice = [...events, ...events].reduce(fold, emptyView());
    expect(twice).toEqual(once);
  });
});
