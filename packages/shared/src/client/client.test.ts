import { describe, expect, it, vi } from "vitest";
import type { ClientEvent } from "../events";
import { emptyView, fold } from "./fold";
import { openDorkStream, type WebSocketLike } from "./stream";

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

class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.onclose?.();
  }
  push(e: ClientEvent) {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

describe("openDorkStream", () => {
  it("resumes from the last seq after a drop, with no gaps or duplicates", async () => {
    FakeSocket.all = [];
    const got: number[] = [];
    const urls: string[] = [];
    const s = openDorkStream({
      connectUrl: async (after) => {
        urls.push(`after=${after}`);
        return `ws://x?after=${after}`;
      },
      onEvent: (e) => {
        got.push(e.seq);
      },
      createSocket: (u) => new FakeSocket(u),
      backoffMs: () => 0,
    });
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(1));
    const a = FakeSocket.all[0];
    a.onopen?.();
    [1, 2, 2, 3].forEach((n) => a.push(ev(n, { type: "user_message", text: "x" }))); // dupe of 2 dropped
    a.close(); // network drop
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(2));
    const b = FakeSocket.all[1];
    expect(urls).toEqual(["after=0", "after=3"]);
    b.onopen?.();
    [4, 5].forEach((n) => b.push(ev(n, { type: "user_message", text: "x" })));
    expect(got).toEqual([1, 2, 3, 4, 5]);
    expect(s.lastSeq).toBe(5);
    s.close();
  });

  it("reconnects when it detects a gap", async () => {
    FakeSocket.all = [];
    const got: number[] = [];
    const s = openDorkStream({
      connectUrl: async (a) => `ws://x?after=${a}`,
      onEvent: (e) => {
        got.push(e.seq);
      },
      createSocket: (u) => new FakeSocket(u),
      backoffMs: () => 0,
    });
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(1));
    const a = FakeSocket.all[0];
    a.push(ev(1, { type: "user_message", text: "x" }));
    a.push(ev(3, { type: "user_message", text: "x" })); // seq 2 missing
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(2));
    expect(got).toEqual([1]);
    expect(FakeSocket.all[1].url).toBe("ws://x?after=1");
    s.close();
  });
});
